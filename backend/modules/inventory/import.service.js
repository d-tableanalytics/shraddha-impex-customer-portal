import fs from 'fs';
import crypto from 'crypto';
import mongoose from 'mongoose';

import ImportJob, { JOB_TRANSITIONS } from '../../models/ImportJob.js';
import ImportRow from '../../models/ImportRow.js';
import ImportError from '../../models/ImportError.js';
import StockMovement from '../../models/StockMovement.js';
import StockBalance from '../../models/StockBalance.js';
import Location from '../../models/Location.js';
import { Product, createProductModel } from '../../models/Product.js';
import ProductDetail from '../../models/ProductDetail.js';
import { nextSequence } from '../../models/Counter.js';

import { IMPORT_TEMPLATES, matchHeaders, coerce } from './import.templates.js';
import { suppliesBoxNo, boxRowKey, boxNumberChanges } from './boxNumber.rules.js';
import {
  NEW_SKU_FIELD_NAMES, parseNewSkuDetails, incompleteNewSkus,
} from './newSku.rules.js';
import { parseDescription, parseVideos } from './productDetail.rules.js';
import { readerFor, MAX_ROWS } from './import.parser.js';
import { postBatch } from './ledger.service.js';
import { applyMovements, syncLegacyStock } from './balance.service.js';
import { recomputeHealthForSkus } from './health.service.js';
import { processAvailableIndents } from './indentAvailability.service.js';
import { resolveConfig } from './config.service.js';
import { DEFAULT_REASON_CODE } from './adjustment.service.js';
import { recordAudit } from '../../utils/auditLog.js';
import { emitStockUpdated } from '../../utils/stockEvents.js';
import { allowedBrands, ALL_BRANDS } from '../../utils/brandAccess.js';
import { hasPermission, PERMISSIONS } from '../../middlewares/rbac.js';
import { normaliseSeason, normaliseStatus } from '../../utils/productFields.js';

/**
 * Import service (IMS Module M9).
 *
 * AN INTEGRATION LAYER. It reads files, checks them, and hands the rows to the
 * services that already own the rules. It calculates no balance, no band and no
 * target, and it writes to no projection — every stock-affecting row goes
 * through LedgerService exactly as a manual transaction does, and the balance
 * and health projections update from the movements the ledger produced.
 *
 * The pipeline the blueprint requires:
 *
 *   Upload → Template → Headers → Data → Preview → Confirm → Process → Summary
 *
 * Nothing is written to inventory before Confirm. Upload stages the parsed rows
 * into `importrows`, which is a workspace, not inventory — no product, movement,
 * balance or count exists until someone confirms.
 */

const fail = (message, status = 400, code = 'IMPORT_ERROR') => {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
};

/** Marks a SKU that resolves to more than one brand — reported, never guessed. */
const AMBIGUOUS = Symbol('ambiguous-brand');

const assertTransition = (from, to) => {
  const allowed = JOB_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    fail(
      `An import in "${from}" cannot move to "${to}".` +
      (allowed.length ? ` Allowed: ${allowed.join(', ')}.` : ' It is finished.'),
      409, 'INVALID_STATE',
    );
  }
};

/** Rows handed to the approved services in one go. */
const CHUNK_SIZE = 500;
/** Rows staged into Mongo per write while the file streams. */
const STAGE_BATCH = 500;
/** A processing claim older than this belonged to a process that died. */
const LOCK_STALE_MS = 15 * 60 * 1000;
/** Attempts per chunk when Mongo reports a retryable conflict. */
const MAX_CHUNK_ATTEMPTS = 3;

/**
 * Is this a conflict Mongo expects the caller to retry?
 *
 * Two importers, or an importer and a booking, touching the same SKU inside
 * overlapping transactions produce a write conflict. Mongo labels these
 * transient precisely because retrying is the correct response — failing the
 * rows instead would reject a perfectly good file for a timing collision.
 */
const isRetryable = (error) =>
  error?.errorLabels?.includes('TransientTransactionError')
  || error?.errorLabels?.includes('UnknownTransactionCommitResult')
  || error?.code === 112            // WriteConflict
  || error?.code === 251            // NoSuchTransaction
  || /transient|write conflict|please retry/i.test(error?.message || '');

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ─── Reference data ──────────────────────────────────────────────────────────

/**
 * Everything the row validator needs to check a reference, loaded ONCE.
 *
 * Validating "does this SKU exist" with a query per row is 8,000 round trips
 * for an 8,000-row file. The sets below are built from one query each and
 * answered in memory.
 */
const buildContext = async (importType, { user, jobBrand = null }) => {
  const template = IMPORT_TEMPLATES[importType];
  const context = {
    brands: new Set(ALL_BRANDS),
    // Brand isolation: a file may only touch brands this user can see. Enforced
    // per row rather than per file, because one bad row must not fail the rest.
    allowedBrands: new Set(allowedBrands(user)),
    skus: null,
    // The Brand chosen on the upload form. A sheet with no Brand column relies
    // on it to create a SKU the catalogue does not have yet.
    jobBrand,
    locations: new Map(),
    reasonCodes: new Set(),
    // Whether this uploader may CHANGE a box number. The sheet carries the
    // column for everyone, because an Inventory Manager routinely edits an
    // exported file that already has box numbers in it and must not have every
    // row rejected for leaving them alone. Only a row that actually moves a SKU
    // to a different box needs the permission — the same rule the single-SKU
    // editor applies. See the inventory-master template's validate().
    canSetBoxNo: hasPermission(user, PERMISSIONS.MANAGE_BOX_NUMBER),
  };

  if (template.requireExistingSku || template.resolveBrandFromSku
      || template.verifyMsil || template.resolveSkuFromMsil) {
    // skuCode::brand, so the same code under two brands stays two SKUs.
    const needsMsil = Boolean(template.verifyMsil || template.resolveSkuFromMsil);
    const needsBox = Boolean(template.tracksBoxNo);
    const rows = await Product.find(
      {},
      `skuCode brand${needsMsil ? ' msilCode' : ''}${needsBox ? ' boxNo' : ''}`,
    ).lean();
    context.skus = new Set(rows.map((p) => `${p.skuCode}::${p.brand}`));

    // Current mapping, so a row can be told apart from one that merely repeats
    // what is already on file. Without it there is no way to distinguish "the
    // user is moving this SKU to a new box" from "the user re-uploaded the
    // export they downloaded", and the two need different answers.
    if (needsBox) {
      context.skuToBoxNo = new Map(rows.map((p) => [`${p.skuCode}::${p.brand}`, p.boxNo || null]));
    }

    // A sheet with no Brand column resolves it from the SKU. Built only when
    // the template asks for it, and it deliberately records AMBIGUITY rather
    // than picking a winner — if a code ever did exist under two brands,
    // guessing would post stock against the wrong one in silence.
    if (template.resolveBrandFromSku) {
      context.skuToBrand = new Map();
      for (const p of rows) {
        if (!p.skuCode) continue;
        context.skuToBrand.set(p.skuCode, context.skuToBrand.has(p.skuCode) ? AMBIGUOUS : p.brand);
      }
    }

    if (needsMsil) {
      context.skuToMsil = new Map();
      for (const p of rows) if (p.skuCode && p.msilCode) context.skuToMsil.set(p.skuCode, p.msilCode);
    }

    // The reverse lookup, for a sheet where the MSIL Code may be the only
    // identifier given. Uppercased so a code typed in either case still finds
    // its part. AMBIGUOUS is recorded rather than resolved for the same reason
    // skuToBrand does it: one MSIL code against two SKUs cannot be guessed, and
    // guessing here would restate the stock of the wrong part in silence.
    if (template.resolveSkuFromMsil) {
      context.msilToSku = new Map();
      for (const p of rows) {
        if (!p.msilCode || !p.skuCode) continue;
        const key = String(p.msilCode).toUpperCase();
        const known = context.msilToSku.get(key);
        context.msilToSku.set(key, known && known !== p.skuCode ? AMBIGUOUS : p.skuCode);
      }
    }
  }

  // Which SKUs already hold stock, for a template that must refuse them.
  if (template.refuseIfStocked) {
    const rows = await StockBalance.find({ onHand: { $gt: 0 } }, 'skuCode brand onHand').lean();
    context.stocked = new Map(rows.map((b) => [`${b.skuCode}::${b.brand}`, b.onHand]));
  }

  if (template.requireLocation) {
    const rows = await Location.find({}, 'code active isDefault').lean();
    for (const l of rows) context.locations.set(l.code, l);
    context.defaultLocation = rows.find((l) => l.isDefault)?.code || null;
  }

  if (template.requireReasonCode) {
    const config = await resolveConfig({});
    for (const r of (config?.reasonCodes || [])) if (r.active) context.reasonCodes.add(r.code);
  }

  return context;
};

// ─── Row validation ──────────────────────────────────────────────────────────

/**
 * Validate one row against its template.
 *
 * EVERY problem in the row is collected. Returning on the first one means a
 * user fixes one cell, re-uploads, and meets the next — which on a 3,000-row
 * sheet is a week of round trips instead of one pass.
 */
const validateRow = (template, mapping, values, context, seenKeys) => {
  const errors = [];
  const data = {};

  // ── Coercion and per-column rules ────────────────────────────────────────
  for (const col of template.columns) {
    const index = mapping[col.field];
    const raw = index === undefined ? null : values[index];
    const result = coerce(col, raw);

    if (!result.ok) {
      errors.push({ category: 'format', column: col.header, message: `${col.header}: ${result.error}`, value: raw });
      continue;
    }
    const value = result.value;

    const empty = value === null || value === undefined || (Array.isArray(value) && value.length === 0);
    if (col.required && empty) {
      errors.push({ category: 'required', column: col.header, message: `${col.header} is required.`, value: raw });
      continue;
    }

    if (!empty && col.enumOf && !col.enumOf.includes(value)) {
      errors.push({
        category: 'enum', column: col.header,
        message: `${col.header}: "${value}" is not one of ${col.enumOf.join(', ')}.`,
        value: raw,
      });
      continue;
    }

    data[col.field] = value;
  }

  // ── SKU resolved from the MSIL Code ──────────────────────────────────────
  // FIRST, because everything below identifies the row by its SKU: the brand is
  // resolved from it, existence is checked on it, and the duplicate key is built
  // from it. A row that names its part only by MSIL Code has to become a row
  // with a SKU before any of that can run.
  //
  // A stated SKU always wins. The MSIL Code is then a cross-check (verifyMsil),
  // never a second opinion about which part is meant — silently re-badging a row
  // onto a different SKU is how a quantity lands on the wrong part.
  if (template.resolveSkuFromMsil && !data.skuCode && data.msilCode) {
    const resolved = context.msilToSku?.get(String(data.msilCode).toUpperCase());
    if (!resolved) {
      errors.push({
        category: 'reference', column: 'MSIL Code',
        message: `MSIL Code ${data.msilCode} is not in the catalogue.`,
        value: data.msilCode,
      });
    } else if (resolved === AMBIGUOUS) {
      errors.push({
        category: 'reference', column: 'MSIL Code',
        message: `MSIL Code ${data.msilCode} belongs to more than one SKU, so this row cannot say `
          + 'which is meant. Give the SKU Code instead.',
        value: data.msilCode,
      });
    } else {
      data.skuCode = resolved;
      // Recorded so the summary can say the row was matched by its MSIL Code —
      // an operator checking a rejected file needs to know which code was used.
      data.matchedBy = 'msilCode';
    }
  }

  // ── Brand resolved from the SKU ──────────────────────────────────────────
  // Runs BEFORE the brand checks below, so a resolved brand goes through the
  // same access and existence rules as one typed into a sheet.
  if (template.resolveBrandFromSku && data.skuCode && !data.brand) {
    const resolved = context.skuToBrand?.get(data.skuCode);
    if (!resolved) {
      // Not an error when the sheet may create SKUs — it just means this row is
      // a new one, and a new one has no brand to resolve from, so it must say.
      if (template.brandFromJobForNewSku) {
        /**
         * A NEW SKU. Its brand comes from the upload form when one was chosen,
         * and OTHERWISE IS LEFT UNSET FOR THE PROMPT TO ASK.
         *
         * This used to reject the row — "choose a Brand on the upload form
         * first" — and that was the wrong shape of answer twice over. A
         * rejected row creates nothing, so the new-SKU prompt never saw it and
         * the file imported everything except the part the user was adding,
         * quietly. And a brand is a per-SKU fact rather than a per-file one: a
         * sheet can carry new parts for two brands at once, which one dropdown
         * on the upload form cannot express.
         *
         * So the row stays VALID with no brand, and the brand is collected
         * alongside the SKU's other mandatory details before the import runs.
         * Nothing is created without one: confirmJob() refuses while any new
         * SKU is unanswered, and `brand` is one of the answers.
         */
        if (context.jobBrand) data.brand = context.jobBrand;
      } else if (template.brandRequiredForNewSku) {
        errors.push({
          category: 'required', column: 'Brand',
          message: `${data.skuCode} is not in the catalogue yet, so it will be created — `
            + 'which needs a Brand.',
          value: null,
        });
      } else {
        errors.push({
          category: 'reference', column: 'SKU Code',
          message: `${data.skuCode} is not in the catalogue.`,
          value: data.skuCode,
        });
      }
    } else if (resolved === AMBIGUOUS) {
      errors.push({
        category: 'reference', column: 'SKU Code',
        message: `${data.skuCode} exists under more than one brand, so this sheet cannot say which one is meant. Use the Stock Movements template, which has a Brand column.`,
        value: data.skuCode,
      });
    } else {
      data.brand = resolved;
    }
  }

  // Whether this SKU already exists, decided ONCE here and carried on the row.
  // Deciding it again at processing time would be wrong: by then the earlier
  // chunks of this very file may have created it.
  if ((template.brandRequiredForNewSku || template.brandFromJobForNewSku) && data.skuCode) {
    data.isNewSku = !context.skuToBrand?.has(data.skuCode);
  }

  // ── MSIL cross-check ─────────────────────────────────────────────────────
  // Never used to FIND the product — only to confirm the row describes the SKU
  // the uploader thought it did. A blank cell, or a product with no MSIL on
  // file, is not an error; only a stated code that contradicts the catalogue.
  if (template.verifyMsil && data.msilCode && data.skuCode) {
    const onFile = context.skuToMsil?.get(data.skuCode);
    if (onFile && String(onFile).toUpperCase() !== String(data.msilCode).toUpperCase()) {
      errors.push({
        category: 'reference', column: 'MSIL Code',
        message: `${data.skuCode} is MSIL ${onFile} in the catalogue, not ${data.msilCode}. Check the row is aligned.`,
        value: data.msilCode,
      });
    }
  }

  // ── Brand ────────────────────────────────────────────────────────────────
  if (data.brand !== undefined && data.brand !== null) {
    // Case-normalised against the canonical list, so "koken" is accepted and
    // "Kokken" is not.
    const canonical = ALL_BRANDS.find((b) => b.toLowerCase() === String(data.brand).toLowerCase());
    if (!canonical) {
      errors.push({ category: 'reference', column: 'Brand', message: `Unknown brand "${data.brand}". Expected ${ALL_BRANDS.join(', ')}.`, value: data.brand });
    } else {
      data.brand = canonical;
      if (!context.allowedBrands.has(canonical)) {
        errors.push({ category: 'permission', column: 'Brand', message: `You do not have access to ${canonical}.`, value: canonical });
      }
    }
  }

  // ── SKU ──────────────────────────────────────────────────────────────────
  if (template.requireExistingSku && data.skuCode && data.brand) {
    if (context.skus && !context.skus.has(`${data.skuCode}::${data.brand}`)) {
      errors.push({
        category: 'reference', column: 'SKU Code',
        message: `${data.skuCode} does not exist under ${data.brand}. Import it into the master first.`,
        value: data.skuCode,
      });
    }
  }

  // ── Location ─────────────────────────────────────────────────────────────
  if (template.requireLocation) {
    const code = data.locationCode || context.defaultLocation;
    if (!code) {
      errors.push({ category: 'reference', column: 'Location Code', message: 'No location given and no default location is configured.' });
    } else {
      const location = context.locations.get(code);
      if (!location) {
        errors.push({ category: 'reference', column: 'Location Code', message: `Unknown location "${code}".`, value: code });
      } else if (!location.active) {
        errors.push({ category: 'reference', column: 'Location Code', message: `Location ${code} is inactive.`, value: code });
      } else {
        data.locationCode = code;
      }
    }
  }

  // ── Reason code ──────────────────────────────────────────────────────────
  if (template.requireReasonCode && data.reasonCode) {
    if (!context.reasonCodes.has(data.reasonCode)) {
      errors.push({
        category: 'reference', column: 'Reason Code',
        message: `"${data.reasonCode}" is not an active reason code.`,
        value: data.reasonCode,
      });
    }
  }

  // ── Already holding stock ────────────────────────────────────────────────
  if (template.refuseIfStocked && data.skuCode && data.brand) {
    const held = context.stocked?.get(`${data.skuCode}::${data.brand}`);
    if (held) {
      errors.push({
        category: 'reference', column: 'Quantity',
        message: `${data.skuCode} already holds ${held} in stock, so it has no opening position to set. `
          + 'Use the Inventory Master sheet to set a stock figure.',
        value: data.quantity,
      });
    }
  }

  // ── Duplicates within the file ───────────────────────────────────────────
  // Two rows for the same key mean the second silently overwrites the first,
  // and the user has no way to know which value survived.
  if (template.keyFields) {
    const key = template.keyFields.map((f) => data[f] ?? '').join('::');
    if (key.replace(/:/g, '') !== '') {
      if (seenKeys.has(key)) {
        errors.push({
          category: 'duplicate',
          message: `Duplicate of row ${seenKeys.get(key)} — ${template.keyFields.map((f) => data[f]).join(' / ')} appears more than once.`,
          value: key,
        });
      } else {
        seenKeys.set(key, null); // row number filled in by the caller
      }
    }
  }

  // ── Type-specific rules ──────────────────────────────────────────────────
  // `context` is passed as well as the row: a rule like "may this uploader move
  // this SKU's box" needs both the value and what is currently on file.
  if (errors.length === 0 && typeof template.validate === 'function') {
    errors.push(...template.validate(data, context));
  }

  const valid = errors.length === 0;
  return {
    valid,
    errors,
    data: valid && typeof template.transform === 'function' ? template.transform(data) : (valid ? data : null),
  };
};

// ─── Upload → stage → validate ───────────────────────────────────────────────

const hashFile = (filePath) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('end', () => resolve(hash.digest('hex')));
  stream.on('error', reject);
});

const removeFile = (filePath) => {
  // The file has no further use once its rows are staged, and keeping uploaded
  // spreadsheets on disk is a retention liability nobody asked for.
  fs.promises.unlink(filePath).catch(() => {});
};

/**
 * Receive a file, stage it, and validate every row.
 *
 * Writes nothing to inventory. On return the job sits at Validated (or Failed)
 * and the caller can preview it.
 */
export const createImportJob = async ({
  filePath, fileName, fileType, fileSize, importType,
  brand = null, locationCode = null, options = null, force = false,
  actor, req,
}) => {
  const template = IMPORT_TEMPLATES[importType];
  if (!template) fail(`Unknown import type "${importType}".`, 400, 'UNKNOWN_IMPORT_TYPE');

  const fileHash = await hashFile(filePath);

  // ── Re-upload detection ──────────────────────────────────────────────────
  // The ledger's idempotency key is per batch, so a second upload of the same
  // file posts a second set of movements under new keys and the ledger has no
  // way to know. This is the only place that can catch it.
  if (!force) {
    const twin = await ImportJob.findOne({
      fileHash, importType,
      status: { $in: ['Validated', 'Processing', 'Completed', 'Partial'] },
    }).lean();
    if (twin) {
      removeFile(filePath);
      fail(
        `This exact file was already uploaded as ${twin.jobId} on ` +
        `${new Date(twin.createdAt).toLocaleDateString('en-IN')} (${twin.status}). ` +
        'Re-import it only if you intend to apply it a second time.',
        409, 'DUPLICATE_FILE',
      );
    }
  }

  const year = new Date().getFullYear();
  const seq = await nextSequence(`importjob-${year}`);
  const jobId = `IMP-${year}-${String(seq).padStart(6, '0')}`;

  const job = await ImportJob.create({
    jobId, importType, fileName, fileType, fileSize, fileHash,
    brand, locationCode, options,
    status: 'Pending', chunkSize: CHUNK_SIZE,
    startedBy: actor._id,
  });

  const fileErrors = [];
  let totalRows = 0, validRows = 0, invalidRows = 0;

  try {
    const context = await buildContext(importType, { user: actor, jobBrand: brand });
    const read = readerFor(fileType);

    let mapping = null;
    const seenKeys = new Map();
    let staged = [];
    const errorDocs = [];
    /**
     * The SKUs this file will CREATE, keyed by code so the list is one entry per
     * SKU rather than one per row.
     *
     * Collected here, at validation, because that is where "is this SKU already
     * in the catalogue" is answered — and answered against the catalogue as it
     * stands BEFORE the file runs, which is the only moment the question has a
     * stable answer.
     */
    const newSkus = new Map();

    const flush = async () => {
      if (staged.length) {
        // Unordered: a row that collides with an existing one (a retried stage)
        // is skipped rather than aborting the batch.
        await ImportRow.insertMany(staged, { ordered: false }).catch((e) => {
          if (e.code !== 11000) throw e;
        });
        staged = [];
      }
      if (errorDocs.length) {
        await ImportError.insertMany(errorDocs.splice(0), { ordered: false });
      }
    };

    for await (const row of read(filePath)) {
      // ── Template + header validation ────────────────────────────────────
      if (row.header) {
        const match = matchHeaders(importType, row.values);
        if (match.missing.length) {
          fileErrors.push(
            `The file is missing required column(s): ${match.missing.join(', ')}. ` +
            `Download the ${template.label} template and use its header row.`,
          );
          errorDocs.push({
            jobId, category: 'template',
            message: `Missing required column(s): ${match.missing.join(', ')}.`,
            value: row.values.join(' | '),
          });
          break;
        }
        if (match.unexpected.length) {
          // Tolerated, not fatal — sheets carry working columns, and refusing a
          // file over a stray "Checked By" helps nobody.
          errorDocs.push({
            jobId, category: 'template',
            message: `Ignored unrecognised column(s): ${match.unexpected.join(', ')}.`,
            value: match.unexpected.join(', '),
          });
        }
        mapping = match.mapping;
        continue;
      }

      if (!mapping) {
        fileErrors.push('The file has no header row.');
        break;
      }

      totalRows += 1;
      const result = validateRow(template, mapping, row.values, context, seenKeys);

      // Fill in the row number for the duplicate message of the FIRST occurrence.
      if (template.keyFields && result.data) {
        const key = template.keyFields.map((f) => result.data[f] ?? '').join('::');
        if (seenKeys.get(key) === null) seenKeys.set(key, row.rowNumber);
      }

      if (result.valid) validRows += 1; else invalidRows += 1;

      // ── New SKUs, queued for their mandatory details ─────────────────────
      // Only rows that will actually import: a rejected row creates nothing, so
      // asking for its planning figures would be asking about a SKU that is
      // never going to exist.
      if (result.valid && template.requiresNewSkuDetails && result.data?.isNewSku
          && !newSkus.has(result.data.skuCode)) {
        // Every field the upload already knows is PREFILLED rather than left
        // blank, so the prompt is usually a confirmation rather than a form.
        // What it does not know stays null, which is what makes it get asked.
        const sheetQuantity = result.data.quantity;
        newSkus.set(result.data.skuCode, {
          skuCode: result.data.skuCode,
          description: result.data.description || null,
          msilCode: result.data.msilCode || null,
          rowNumber: row.rowNumber,
          // From the Brand chosen on the upload form, when one was.
          brand: result.data.brand || null,
          /**
           * From the sheet's Quantity column, when it carries one.
           *
           * `null` — not zero — when the cell is blank, because the two mean
           * different things: a blank cell is "nobody has said", which the
           * prompt must ask about, and a zero is "the part exists, the stock
           * has not arrived", which is an answer. A negative figure is a
           * DEDUCTION on this sheet and cannot be an opening stock, so it is
           * left unanswered for the prompt to correct rather than carried in.
           */
          availableStock: (sheetQuantity === null || sheetQuantity === undefined || sheetQuantity < 0)
            ? null
            : Number(sheetQuantity),
          moq: null,
          leadTime: null,
          safetyFactor: null,
          // A sheet that already carries a Box No for the new SKU has answered
          // that field — it is prefilled to be confirmed, not retyped.
          boxNo: suppliesBoxNo(result.data) ? result.data.boxNo : null,
        });
      }

      staged.push({
        jobId,
        rowNumber: row.rowNumber,
        chunkIndex: Math.floor((validRows - 1) / CHUNK_SIZE),
        raw: row.values,
        data: result.data,
        valid: result.valid,
        validationErrors: result.errors.map((e) => e.message),
        // An invalid row is never processed, so it starts life skipped rather
        // than pending — the processing sweep then has nothing to filter.
        status: result.valid ? 'pending' : 'skipped',
      });

      for (const e of result.errors) {
        errorDocs.push({
          jobId, rowNumber: row.rowNumber, column: e.column ?? null,
          category: e.category, message: e.message, value: e.value ?? null,
        });
      }

      if (staged.length >= STAGE_BATCH) await flush();
    }

    await flush();

    if (totalRows === 0 && fileErrors.length === 0) {
      fileErrors.push('The file has a header but no data rows.');
    }
    if (totalRows >= MAX_ROWS) {
      fileErrors.push(`Only the first ${MAX_ROWS.toLocaleString()} rows were read. Split the file and import it in parts.`);
    }

    // ── Chunking ────────────────────────────────────────────────────────────
    // Fixed now and never recomputed. The ledger idempotency key is built from
    // the chunk index, so re-chunking a resumed job would mint new keys and let
    // the same movements post twice.
    const chunksTotal = Math.ceil(validRows / CHUNK_SIZE);

    job.status = fileErrors.length ? 'Failed' : 'Validated';
    job.totalRows = totalRows;
    job.validRows = validRows;
    job.invalidRows = invalidRows;
    job.chunksTotal = chunksTotal;
    job.fileErrors = fileErrors;
    // A failed file imports nothing, so there is no new SKU to configure — and
    // listing some would prompt for details that could never be used.
    job.newSkus = fileErrors.length ? [] : [...newSkus.values()];
    if (fileErrors.length) job.completedAt = new Date();
    await job.save();
  } catch (error) {
    job.status = 'Failed';
    job.fileErrors = [...fileErrors, error.message];
    job.completedAt = new Date();
    await job.save().catch(() => {});
    removeFile(filePath);
    throw error;
  }

  removeFile(filePath);

  await recordAudit(actor, 'Inventory Import Uploaded',
    `${template.label} file "${fileName}" uploaded as ${jobId}: ` +
    `${totalRows} row(s), ${validRows} valid, ${invalidRows} rejected` +
    (job.newSkus.length ? `, ${job.newSkus.length} new SKU(s) awaiting details.` : '.'),
    req, {
      meta: {
        jobId, importType, fileName, fileHash, totalRows, validRows, invalidRows, fileErrors,
        newSkus: job.newSkus.map((s) => s.skuCode),
      },
    });

  return job.toObject();
};

// ─── Preview ─────────────────────────────────────────────────────────────────

export const previewJob = async (jobId, { page = 1, limit = 50, invalidOnly = false } = {}) => {
  const job = await ImportJob.findOne({ jobId }).lean();
  if (!job) fail(`Import ${jobId} not found.`, 404, 'NOT_FOUND');

  const filter = { jobId };
  if (invalidOnly) filter.valid = false;

  const [rows, total] = await Promise.all([
    ImportRow.find(filter).sort({ rowNumber: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    ImportRow.countDocuments(filter),
  ]);

  return {
    job,
    columns: IMPORT_TEMPLATES[job.importType].columns.map((c) => ({ header: c.header, field: c.field })),
    rows,
    pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
  };
};

export const errorReport = async (jobId, { page = 1, limit = 100, category = null } = {}) => {
  const job = await ImportJob.findOne({ jobId }).lean();
  if (!job) fail(`Import ${jobId} not found.`, 404, 'NOT_FOUND');

  const filter = { jobId };
  if (category) filter.category = category;

  const [errors, total, byCategory] = await Promise.all([
    ImportError.find(filter).sort({ rowNumber: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    ImportError.countDocuments(filter),
    // Grouped, so 400 rows missing the same column read as one problem.
    ImportError.aggregate([{ $match: { jobId } }, { $group: { _id: '$category', n: { $sum: 1 } } }]),
  ]);

  return {
    job, errors,
    byCategory: Object.fromEntries(byCategory.map((c) => [c._id, c.n])),
    pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
  };
};

// ─── Processors ──────────────────────────────────────────────────────────────
//
// One per import type. Each receives a chunk of validated rows and hands them
// to the service that owns the rule. A processor returns
// { successes: [{ rowNumber, result }], failures: [{ rowNumber, reason }], refs }
// and NEVER writes to a projection itself.

/**
 * Write the sheet's box numbers onto the product master, for rows that landed.
 *
 * Shared by the two sheets that carry the column. It is applied AFTER the rest
 * of the row has succeeded and only to rows in `landed`, so a row rejected for
 * its quantity does not quietly re-box the SKU anyway.
 *
 * A blank cell leaves the existing mapping alone rather than clearing it, like
 * every other optional field on these sheets — there is no way to unmap a box
 * through an import, which is deliberate: a cleared cell is far more often an
 * empty column than an instruction.
 *
 * Validation has already refused any row where a non-admin tried to CHANGE a
 * box number, so anything reaching here is either an admin's edit or a value
 * that already matches what is on file.
 */
const applyBoxNumbers = async ({ rows, landed, job, chunkIndex, actor, req }) => {
  // suppliesBoxNo() is the shared definition of "this row supplies one" — a
  // blank cell, or a file with no Box No column, leaves the existing mapping
  // untouched rather than clearing it.
  const carrying = rows.filter((r) => suppliesBoxNo(r.data) && landed.has(r.rowNumber));
  if (carrying.length === 0) return;

  // Read the CURRENT values rather than reusing the validation context: an
  // earlier chunk of this same file may already have moved one, and the audit
  // trail has to show what each chunk actually changed.
  const prior = await Product.find(
    { skuCode: { $in: [...new Set(carrying.map((r) => r.data.skuCode))] } },
    'skuCode brand boxNo',
  ).lean();
  const before = new Map(prior.map((p) => [boxRowKey(p.skuCode, p.brand), p.boxNo || null]));

  // A supplied box number REPLACES what is on file. boxNumberChanges() filters
  // out the rows supplying the value already stored, so re-uploading an
  // exported sheet is not recorded as having re-boxed the whole catalogue.
  const changes = boxNumberChanges(carrying, before);
  if (changes.length === 0) return;

  // Grouped by brand: the discriminator model scopes the write to its own
  // brand, exactly as M1 does.
  const byBrand = new Map();
  for (const c of changes) {
    if (!byBrand.has(c.brand)) byBrand.set(c.brand, []);
    byBrand.get(c.brand).push({
      updateOne: { filter: { skuCode: c.skuCode }, update: { $set: { boxNo: c.to } } },
    });
  }
  for (const [brand, ops] of byBrand) {
    await createProductModel(brand).bulkWrite(ops, { ordered: false });
  }

  // Box numbers that actually MOVED get their own trail entry, matching what
  // the single-SKU editor records. A box change is quoted on every PO raised
  // afterwards, so "which SKUs moved box, when, and on whose authority" has to
  // be answerable without reconstructing it from an import file.
  await recordAudit(
    actor,
    'Box Number Updated',
    `${changes.length} box number(s) changed by import ${job.jobId} (chunk ${chunkIndex + 1}). `
    + 'Subsequent POs will quote the new box numbers.',
    req,
    { meta: { jobId: job.jobId, chunkIndex, changes } },
  );
};

/**
 * Answers that describe the SKU but are not columns on the product document.
 * See the note where this is used in processMaster().
 */
const NON_PRODUCT_NEW_SKU_FIELDS = new Set(['boxNo', 'brand', 'availableStock']);

/** Products are the master itself — written directly, with M1's own normalisers. */
const processMaster = async ({ rows, job, chunkIndex, actor, req }) => {
  const successes = [];
  const failures = [];
  const ops = new Map(); // brand → bulk ops, so each discriminator writes once

  /**
   * The mandatory details answered for the SKUs this file creates, keyed by
   * code. Empty for every other import type, and for a job created before this
   * prompt existed — both of which fall through to the old behaviour of leaving
   * the schema defaults and queueing the SKU for MOQ afterwards.
   */
  const newSkuDetails = new Map((job.newSkus || []).map((s) => [s.skuCode, s]));

  /**
   * The answers are written ONTO THE ROW before anything below reads it.
   *
   * Everything downstream — the master upsert, applyBoxNumbers(), the ledger
   * posting in postQuantities() — already knows how to read a row's brand, box
   * number and quantity. Overlaying the prompt's answers here means none of
   * them needs a second code path for "a SKU being created", and the box number
   * in particular lands through the same writer, with the same audit entry,
   * rather than a second quieter one.
   *
   * The BRAND is the important one: the row is staged with no brand when the
   * upload form did not name one, and this is where the prompt's answer becomes
   * the row's. Without it the upsert would have nothing to file the product
   * under.
   */
  for (const row of rows) {
    if (!row.data?.isNewSku) continue;
    const answered = newSkuDetails.get(row.data.skuCode);
    if (!answered) continue;

    if (answered.brand) row.data.brand = answered.brand;
    if (answered.boxNo) row.data.boxNo = answered.boxNo;
    /**
     * The ANSWER is the opening stock, and it wins.
     *
     * That is not a contradiction of "use the Excel value when it has one": the
     * prompt is PREFILLED from the sheet, so leaving it alone imports exactly
     * what the file said. What it also allows is correcting an obviously wrong
     * figure at the point of confirming it, without going back to the
     * spreadsheet — and the value the user last looked at and approved is the
     * one that should land.
     */
    if (answered.availableStock !== null && answered.availableStock !== undefined) {
      row.data.quantity = answered.availableStock;
    }
  }

  for (const row of rows) {
    const d = row.data;
    const season = normaliseSeason(d.currentSeason);
    if (!season.ok) {
      failures.push({ rowNumber: row.rowNumber, reason: `Invalid season "${season.raw}".` });
      continue;
    }

    const set = {
      ...(d.msilCode !== undefined && d.msilCode !== null ? { msilCode: d.msilCode } : {}),
      // boxNo is deliberately NOT set here. applyBoxNumbers() below is the sole
      // writer, and it has to read the PREVIOUS value to know what changed —
      // writing it here too would mean it read back its own write, find nothing
      // changed, and never record the audit entry.
      ...(d.description !== undefined && d.description !== null ? { description: d.description } : {}),
      ...(d.category?.length ? { category: d.category } : {}),
      ...(d.uom ? { uom: d.uom } : {}),
      ...(d.status !== undefined && d.status !== null ? { status: normaliseStatus(d.status) } : {}),
      ...(d.currentSeason !== undefined ? { currentSeason: season.value } : {}),
      // Written per season, as dotted sub-paths, so a sheet that fills in only
      // the Normal column leaves Low and Peak alone.
      //
      // NOT as `dailyAvgConsumption: <number>`. That path is a nested object,
      // and $set-ing a bare number over it REPLACES the whole object. Mongoose
      // raises no error; the field simply becomes a scalar, every season lookup
      // then reads undefined, and the SKU drops to Unknown with its band and
      // Max Level gone. A silent corruption reported as a successful import.
      ...(d.dacLow !== null && d.dacLow !== undefined ? { 'dailyAvgConsumption.low': d.dacLow } : {}),
      ...(d.dacNormal !== null && d.dacNormal !== undefined ? { 'dailyAvgConsumption.normal': d.dacNormal } : {}),
      ...(d.dacPeak !== null && d.dacPeak !== undefined ? { 'dailyAvgConsumption.peak': d.dacPeak } : {}),
      ...(d.leadTime !== null && d.leadTime !== undefined ? { leadTime: d.leadTime } : {}),
      ...(d.safetyFactor !== null && d.safetyFactor !== undefined ? { safetyFactor: d.safetyFactor } : {}),
    };

    /**
     * The planning figures the uploader gave for a SKU this row CREATES.
     *
     * Written with $setOnInsert, never $set, for two reasons. They describe a
     * SKU being created, so they must not touch one that already exists — if
     * the catalogue gained this code between validation and here, whoever
     * created it owns its planning figures. And boxNo is deliberately absent:
     * applyBoxNumbers() is the sole writer of that field, because it has to
     * read the previous value to record what changed.
     *
     * Keys already in `set` are dropped rather than duplicated: Mongo rejects
     * an update naming the same path in both operators, and the sheet's own
     * column is the more specific answer.
     */
    const details = d.isNewSku ? newSkuDetails.get(d.skuCode) : null;
    const onInsert = {};
    if (details) {
      for (const field of NEW_SKU_FIELD_NAMES) {
        // Three of the six answers are NOT product fields and must not be
        // written as though they were:
        //   boxNo         — applyBoxNumbers() is its sole writer, because it
        //                   has to read the previous value to record the change
        //   brand         — the discriminator stamps it on write; setting it
        //                   here would fight the model for the same path
        //   availableStock— stock, not master data. It goes through the ledger
        //                   in postQuantities() like every other quantity
        if (NON_PRODUCT_NEW_SKU_FIELDS.has(field)) continue;
        const value = details[field];
        if (value !== null && value !== undefined && !(field in set)) onInsert[field] = value;
      }
    }

    if (!ops.has(d.brand)) ops.set(d.brand, []);
    ops.get(d.brand).push({
      rowNumber: row.rowNumber,
      op: {
        updateOne: {
          filter: { skuCode: d.skuCode },
          // Upsert: the same import creates new SKUs and updates existing ones,
          // which is what "master import" means to the people running it.
          update: { $set: set, $setOnInsert: { skuCode: d.skuCode, ...onInsert } },
          // Upsert: a SKU the catalogue does not have is CREATED. Validation has
          // already insisted such a row carries a Brand, so the discriminator
          // model below writes it into the right brand.
          upsert: true,
        },
      },
    });
  }

  const affectedSkus = [];
  for (const [brand, entries] of ops) {
    // The brand discriminator stamps `brand` on write, so the correct model
    // must be used rather than the base one — exactly as M1 does.
    const Model = createProductModel(brand);
    try {
      await Model.bulkWrite(entries.map((e) => e.op), { ordered: false });
      for (const e of entries) {
        successes.push({ rowNumber: e.rowNumber, result: { brand } });
        affectedSkus.push(rows.find((r) => r.rowNumber === e.rowNumber).data.skuCode);
      }
    } catch (error) {
      // A partial bulkWrite reports which indexes failed; everything else in
      // the batch did land.
      const failedIndexes = new Set((error.writeErrors || []).map((w) => w.index));
      entries.forEach((e, i) => {
        if (failedIndexes.has(i)) {
          failures.push({ rowNumber: e.rowNumber, reason: error.writeErrors?.find((w) => w.index === i)?.errmsg || error.message });
        } else {
          successes.push({ rowNumber: e.rowNumber, result: { brand } });
          affectedSkus.push(rows.find((r) => r.rowNumber === e.rowNumber).data.skuCode);
        }
      });
    }
  }

  // Planning inputs changed, so health must be recomputed — for these SKUs
  // only. Never a full rebuild. This is also what raises or clears the Planning
  // alerts in M8, through the event the health service emits.
  if (affectedSkus.length) await recomputeHealthForSkus(affectedSkus);

  const landedRows = new Set(successes.map((s) => s.rowNumber));

  // NEW SKUs this chunk created that were NOT configured before the import ran.
  // `isNewSku` was decided during validation, against the catalogue as it stood
  // BEFORE the file ran — deciding it here would be wrong, because an earlier
  // chunk of this same file may already have created the SKU. Only rows that
  // actually landed are offered for MOQ.
  //
  // A job that collected the mandatory details up front leaves nothing here:
  // the SKU was created WITH its MOQ, so prompting for one again would ask a
  // question that has already been answered. The list still fills for jobs
  // uploaded before that prompt existed, which is what keeps them finishable.
  const created = rows
    .filter((r) => r.data?.isNewSku && landedRows.has(r.rowNumber)
      && !newSkuDetails.get(r.data.skuCode)?.moq)
    .map((r) => ({
      skuCode: r.data.skuCode,
      brand: r.data.brand,
      description: r.data.description || null,
      msilCode: r.data.msilCode || null,
      quantity: Number(r.data.quantity) || 0,
    }));

  if (created.length) {
    // $addToSet, not $push: a resumed or re-run chunk must not queue the same
    // SKU for MOQ twice.
    await ImportJob.updateOne(
      { jobId: job.jobId },
      { $addToSet: { pendingMoqSkus: { $each: created } } },
    );
  }

  // Box numbers, for the rows whose master write landed.
  await applyBoxNumbers({ rows, landed: landedRows, job, chunkIndex, actor, req });

  // Quantity, where the sheet carries one, is a STOCK figure and cannot be
  // written to the product — it goes through the ledger like any other stock
  // change. Rows without one are untouched by this step.
  const stock = await postQuantities({ rows, job, chunkIndex, actor, req });
  successes.push(...stock.successes);
  failures.push(...stock.failures);

  return { successes, failures, refs: stock.refs };
};

/**
 * Post the sheet's Quantity — as an opening balance for a SKU this import just
 * created, or as stock received for one that already existed.
 *
 * The figure is an amount COMING IN, not the level stock should end at: a SKU
 * holding 444 with a sheet saying 10 finishes at 454. Each row therefore posts
 * its quantity directly — no difference is calculated, because the uploader is
 * describing an intake rather than correcting a count.
 *
 * The consequence is worth stating plainly: this import is CUMULATIVE. Running
 * the same file twice adds the quantities twice. The duplicate-file check
 * catches a byte-identical re-upload, but a sheet re-saved in Excel is a
 * different file, so it will not catch every case.
 *
 * To correct a figure rather than add to it, use Update stock on the Inventory
 * Master row, which sets the level and posts the difference.
 */
const postQuantities = async ({ rows, job, chunkIndex, actor, req }) => {
  const successes = [];
  const failures = [];
  // A blank cell means "leave stock alone"; a zero means "nothing received".
  // Neither is a movement.
  const wanted = rows.filter((r) => {
    const q = r.data.quantity;
    return q !== null && q !== undefined && q !== 0;
  });
  if (wanted.length === 0) return { successes, failures, refs: [] };

  const balances = await StockBalance.find({
    $or: wanted.map((r) => ({
      skuCode: r.data.skuCode, brand: r.data.brand, locationCode: r.data.locationCode,
    })),
  }).lean();
  const byKey = new Map(balances.map((b) => [`${b.skuCode}::${b.brand}::${b.locationCode}`, b]));

  // A negative quantity DEDUCTS. Rows that cannot legally reduce stock are
  // rejected individually and the rest of the file still posts — one bad line
  // in a thousand-row sheet should not cost the operator the whole upload.
  const lines = [];
  const posting = [];

  for (const row of wanted) {
    const d = row.data;
    const balance = byKey.get(`${d.skuCode}::${d.brand}::${d.locationCode}`);
    const before = balance?.onHand ?? 0;
    const reserved = balance?.reserved ?? 0;
    const after = before + d.quantity;

    if (d.quantity < 0) {
      // A SKU this file just created holds nothing, so there is nothing to take.
      if (d.isNewSku === true && before === 0) {
        failures.push({
          rowNumber: row.rowNumber,
          reason: `${d.skuCode} is new and holds no stock, so ${d.quantity} cannot be deducted.`,
        });
        continue;
      }
      // Physical stock cannot go negative.
      if (after < 0) {
        failures.push({
          rowNumber: row.rowNumber,
          reason: `Deducting ${Math.abs(d.quantity)} would take ${d.skuCode} to ${after}. `
            + `Only ${before} on hand.`,
        });
        continue;
      }
      // Reserved units are committed to live bookings. Cutting on-hand below
      // them does not un-commit anything — it just creates an oversell that
      // surfaces at dispatch, so it is refused here where it is still visible.
      if (after < reserved) {
        failures.push({
          rowNumber: row.rowNumber,
          reason: `${reserved} unit${reserved === 1 ? ' is' : 's are'} reserved against live bookings for `
            + `${d.skuCode}, so on hand cannot drop to ${after}.`,
        });
        continue;
      }
    }

    // A SKU this file CREATED has no prior position, so its quantity is an
    // OPENING balance — the same movement type the go-live load used. One that
    // already existed is receiving stock on top of what it holds, which is a
    // RECEIPT. Filing the first as a receipt would say goods arrived when what
    // actually happened is that a starting position was recorded.
    //
    // A reduction is neither. It is filed as an ADJUSTMENT, the same type the
    // Update Stock dialog posts for "Adjust by -5", so a correction made by
    // hand and one made by spreadsheet are indistinguishable in the ledger.
    // ISSUE was the other candidate and was rejected: it asserts goods left the
    // building, which a negative cell does not actually say.
    const isNew = d.isNewSku === true && before === 0;
    const movementType = d.quantity < 0 ? 'ADJUSTMENT' : (isNew ? 'OPENING' : 'RECEIPT');

    lines.push({
      movementType,
      skuCode: d.skuCode,
      brand: d.brand,
      locationCode: d.locationCode,
      quantity: d.quantity,
      beforeQuantity: before,
      afterQuantity: after,
      reasonCode: d.quantity < 0 ? 'MANUAL_ADJUSTMENT' : undefined,
      note: d.quantity < 0
        ? `Deducted via ${job.fileName}`
        : (isNew ? `Opening stock from ${job.fileName}` : `Received via ${job.fileName}`),
    });
    posting.push(row);
  }

  if (lines.length === 0) return { successes, failures, refs: [] };

  let result;
  try {
    result = await postBatch({
      idempotencyKey: `import-${job.jobId}-${chunkIndex}-qty`,
      workflowType: 'import',
      referenceType: 'import',
      referenceId: job.jobId,
      actor,
      note: `${IMPORT_TEMPLATES[job.importType].label} import ${job.jobId} (chunk ${chunkIndex + 1})`,
      lines,
    }, req);
  } catch (error) {
    if (isRetryable(error)) throw error;
    // Only the rows that were actually in this batch — rows already rejected
    // above have their own, more specific reason and must not be overwritten.
    for (const row of posting) failures.push({ rowNumber: row.rowNumber, reason: error.message });
    return { successes, failures, refs: [] };
  }

  const posted = await StockMovement.find({ batchId: result.batch.batchId }).lean();
  if (!result.replayed && posted.length) await applyMovements(posted);
  const touched = [...new Set(posting.map((r) => r.data.skuCode))];
  await recomputeHealthForSkus(touched);
  await syncLegacyStock(touched);
  // Goods received by spreadsheet are still goods received. Only the RECEIPT /
  // OPENING lines count as inward — a negative cell is filed as an ADJUSTMENT
  // and nothing arrived for it. The batch id is the replay guard: reprocessing
  // a chunk must not announce the same delivery to the customer a second time.
  const inwardBySku = new Map();
  for (const line of lines) {
    if (line.quantity > 0) {
      inwardBySku.set(line.skuCode, (inwardBySku.get(line.skuCode) || 0) + line.quantity);
    }
  }
  await processAvailableIndents(touched, inwardBySku.size
    ? { event: 'material-inward', reference: result.batch.batchId, inwardBySku }
    : {});
  emitStockUpdated(req, touched, { source: 'import', jobId: job.jobId });

  return {
    successes, failures,
    refs: [{ kind: 'ledgerBatch', id: result.batch.batchId, chunkIndex }],
  };
};

/** Planning carries no Quantity column, so no stock step ever runs for it. */
const processPlanning = (args) => processMaster(args);

/**
 * Fresh Inventory Import — set stock TO the sheet's figure.
 *
 * The opposite of postQuantities(), and deliberately a separate processor
 * rather than a flag on it. There the sheet describes an intake and the figure
 * is ADDED: 444 on hand plus a row of 10 finishes at 454. Here the sheet
 * describes the shelf itself, so 5 on hand with a row of 155 finishes at 155.
 * Two behaviours that differ on every row do not belong behind a conditional in
 * one function — the reason the wrong one gets used is that they looked alike.
 *
 * The DIFFERENCE is what gets posted, not the target. Writing the level
 * straight onto the balance would leave the ledger unable to explain how stock
 * got there, and every projection in the system is a sum of movements. Posting
 * the delta as a COUNT keeps "what the shelf holds" and "what the ledger says"
 * the same number, and makes the restatement visible in the stock card next to
 * every other movement.
 *
 * Being absolute, this import is IDEMPOTENT in a way the master sheet is not:
 * running the same file twice lands on the same figure both times.
 *
 * Nothing else about the product is touched — not planning data, not any other
 * master field, not any other location's balance. The ONE exception is the box
 * number, applied by the wrapper below rather than here, so that this function
 * remains purely a stock restatement.
 */
const restateStock = async ({ rows, job, chunkIndex, actor, req }) => {
  const successes = [];
  const failures = [];
  if (rows.length === 0) return { successes, failures, refs: [] };

  const balances = await StockBalance.find({
    $or: rows.map((r) => ({
      skuCode: r.data.skuCode, brand: r.data.brand, locationCode: r.data.locationCode,
    })),
  }).lean();
  const byKey = new Map(balances.map((b) => [`${b.skuCode}::${b.brand}::${b.locationCode}`, b]));

  const lines = [];
  const posting = [];

  for (const row of rows) {
    const d = row.data;
    const balance = byKey.get(`${d.skuCode}::${d.brand}::${d.locationCode}`);
    const before = balance?.onHand ?? 0;
    const reserved = balance?.reserved ?? 0;
    const target = d.quantity;
    const delta = target - before;

    // Already at the figure. Reported as a success — the sheet asked for a state
    // and the state holds — but no movement is written: a zero-quantity line is
    // refused by the ledger, and rightly so, as nothing moved.
    if (delta === 0) {
      successes.push({
        rowNumber: row.rowNumber,
        result: { skuCode: d.skuCode, before, after: target, changed: false },
      });
      continue;
    }

    // Reserved units are committed to live bookings. Restating stock below them
    // does not un-commit anything — it just creates an oversell that surfaces at
    // dispatch, so it is refused here where it is still visible and fixable.
    if (target < reserved) {
      failures.push({
        rowNumber: row.rowNumber,
        reason: `${reserved} unit${reserved === 1 ? ' is' : 's are'} reserved against live bookings `
          + `for ${d.skuCode}, so its stock cannot be set to ${target}.`,
      });
      continue;
    }

    lines.push({
      // A restatement from a fresh count IS a count variance, which is what the
      // type means and what puts it in the right place on the stock card.
      movementType: 'COUNT',
      skuCode: d.skuCode,
      brand: d.brand,
      locationCode: d.locationCode,
      quantity: delta,
      beforeQuantity: before,
      afterQuantity: target,
      reasonCode: delta > 0 ? 'COUNT_SURPLUS' : 'COUNT_SHORTAGE',
      note: `Fresh inventory import from ${job.fileName}: set to ${target} (was ${before})`
        + (d.matchedBy === 'msilCode' ? `, matched by MSIL ${d.msilCode}` : ''),
    });
    posting.push(row);
  }

  if (lines.length === 0) return { successes, failures, refs: [] };

  let result;
  try {
    result = await postBatch({
      idempotencyKey: `import-${job.jobId}-${chunkIndex}-fresh`,
      workflowType: 'import',
      referenceType: 'import',
      referenceId: job.jobId,
      actor,
      note: `${IMPORT_TEMPLATES[job.importType].label} ${job.jobId} (chunk ${chunkIndex + 1})`,
      lines,
    }, req);
  } catch (error) {
    if (isRetryable(error)) throw error;
    for (const row of posting) failures.push({ rowNumber: row.rowNumber, reason: error.message });
    return { successes, failures, refs: [] };
  }

  const posted = await StockMovement.find({ batchId: result.batch.batchId }).lean();
  if (!result.replayed && posted.length) await applyMovements(posted);

  const touched = [...new Set(posting.map((r) => r.data.skuCode))];
  await recomputeHealthForSkus(touched);
  // Without this the portal keeps showing the old figure: availableForSale on
  // the product is what customers book against, and it is derived from the
  // ledger rather than written by it.
  await syncLegacyStock(touched);

  // A restatement UPWARDS puts units on the shelf that customers may be waiting
  // for, so indents are reconsidered exactly as they are for a goods receipt. A
  // downward one cannot fulfil anything, so only the surplus is announced — and
  // the batch id is the replay guard, so reprocessing a chunk cannot tell the
  // same customer about the same stock twice.
  const inwardBySku = new Map();
  for (const line of lines) {
    if (line.quantity > 0) {
      inwardBySku.set(line.skuCode, (inwardBySku.get(line.skuCode) || 0) + line.quantity);
    }
  }
  await processAvailableIndents(touched, inwardBySku.size
    ? { event: 'material-inward', reference: result.batch.batchId, inwardBySku }
    : {});
  emitStockUpdated(req, touched, { source: 'import', jobId: job.jobId });

  for (const row of posting) {
    const line = lines.find((l) => l.skuCode === row.data.skuCode
      && l.locationCode === row.data.locationCode);
    successes.push({
      rowNumber: row.rowNumber,
      result: {
        skuCode: row.data.skuCode,
        before: line?.beforeQuantity ?? null,
        after: line?.afterQuantity ?? null,
        changed: true,
      },
    });
  }

  return {
    successes, failures,
    refs: [{ kind: 'ledgerBatch', id: result.batch.batchId, chunkIndex }],
  };
};

/**
 * Fresh Inventory = restate the stock, then apply any box numbers the sheet
 * carried.
 *
 * Wrapped rather than folded into restateStock() because that function returns
 * from three different places — early when every row is already at its figure,
 * early again when the ledger batch fails, and at the end on the normal path.
 * A box write placed inside it would be skipped by two of the three, and the
 * skip that matters most is the first: a sheet whose quantities are all
 * unchanged is precisely the one being uploaded to correct box numbers.
 *
 * `landed` is taken from the successes, so a row rejected for its quantity —
 * reserved stock, a failed batch — does not re-box the SKU anyway.
 */
const processFreshInventory = async (args) => {
  const outcome = await restateStock(args);
  await applyBoxNumbers({
    ...args,
    landed: new Set(outcome.successes.map((s) => s.rowNumber)),
  });
  return outcome;
};

/**
 * Product descriptions and video links.
 *
 * THE ONE PROCESSOR THAT TOUCHES NO INVENTORY AT ALL. It writes to the
 * `productdetails` collection and nowhere else: no product row, no movement, no
 * balance, no projection. A description landing on the wrong SKU is a wrong
 * description — never a wrong stock figure — and keeping that true is why this
 * content lives in its own collection rather than as more fields on the master.
 *
 * BLANK MEANS "LEAVE ALONE", for the same reason it does on the Box No column:
 * a sheet is uploaded to change the rows it fills in, and an empty cell is far
 * more often an empty cell than an instruction to erase. So a blank Description
 * keeps the stored one, and three blank video columns keep the stored links.
 *
 * Videos are REPLACED rather than merged when any column carries a link. Three
 * fixed columns are how this sheet says "these are the videos for this SKU";
 * merging would make the sheet incapable of ever removing one.
 */
const processProductDetails = async ({ rows, actor }) => {
  const successes = [];
  const failures = [];
  const ops = [];

  for (const row of rows) {
    const d = row.data;

    const set = {};
    if (d.productDescription) {
      const parsed = parseDescription(d.productDescription);
      if (parsed.problem) {
        failures.push({ rowNumber: row.rowNumber, reason: parsed.problem });
        continue;
      }
      set.description = parsed.value;
    }

    const supplied = [d.video1, d.video2, d.video3];
    if (supplied.some((v) => v !== null && v !== undefined && String(v).trim() !== '')) {
      // Every link was already checked against the template's validator, so a
      // problem here would be a rule that had changed underneath a staged file.
      const { values, problems } = parseVideos(supplied);
      if (problems.length) {
        failures.push({ rowNumber: row.rowNumber, reason: problems.join(' ') });
        continue;
      }
      set.videos = values;
    }

    if (Object.keys(set).length === 0) {
      // Validation refuses an empty row, so reaching here means the sheet
      // changed shape between staging and processing.
      failures.push({ rowNumber: row.rowNumber, reason: 'The row supplies nothing to save.' });
      continue;
    }

    set.brand = d.brand ?? null;
    set.updatedBy = actor?._id ?? null;

    ops.push({
      rowNumber: row.rowNumber,
      op: {
        updateOne: {
          filter: { skuCode: d.skuCode },
          // Upsert: most SKUs have no content row until the first sheet
          // describes them.
          update: { $set: set, $setOnInsert: { skuCode: d.skuCode } },
          upsert: true,
        },
      },
    });
  }

  if (ops.length) {
    try {
      await ProductDetail.bulkWrite(ops.map((o) => o.op), { ordered: false });
      for (const o of ops) successes.push({ rowNumber: o.rowNumber, result: { saved: true } });
    } catch (error) {
      // A partial bulkWrite reports which indexes failed; the rest did land.
      const failedIndexes = new Set((error.writeErrors || []).map((w) => w.index));
      ops.forEach((o, i) => {
        if (failedIndexes.has(i)) {
          failures.push({
            rowNumber: o.rowNumber,
            reason: error.writeErrors?.find((w) => w.index === i)?.errmsg || error.message,
          });
        } else {
          successes.push({ rowNumber: o.rowNumber, result: { saved: true } });
        }
      });
    }
  }

  return { successes, failures, refs: [] };
};

const PROCESSORS = {
  'inventory-master': processMaster,
  'fresh-inventory': processFreshInventory,
  planning: processPlanning,
  'product-details': processProductDetails,
};

// ─── Confirm and process ─────────────────────────────────────────────────────

/**
 * Set the MOQ for SKUs an import created, and clear them from its pending list.
 *
 * THE AFTER-THE-FACT PATH. A master import now collects MOQ, lead time, safety
 * factor and box number BEFORE it runs — see setNewSkuDetails() — so a job
 * staged today creates its SKUs already configured and queues nothing here.
 * This remains for the jobs that were already staged, or already finished, when
 * that prompt did not exist: their SKUs are in the catalogue on the defaults,
 * and this is what still lets them be answered.
 *
 * WHY IT EXISTS SEPARATELY. A SKU created by an import lands with the schema
 * default MOQ of 0, which reads as "no minimum" and is indistinguishable from a
 * deliberate 0. That is fine for a SKU nobody has thought about, and wrong for
 * one that has just entered the catalogue — so the import records what it
 * created and the admin is asked, rather than a figure being invented.
 *
 * ONLY the SKUs this job created can be set here. The endpoint cannot be used
 * to rewrite the MOQ of an established SKU: that is what the inventory master
 * is for, and it has its own audit trail.
 *
 * Partial answers are allowed. Ten new SKUs can be answered three at a time;
 * each accepted entry leaves the pending list and the rest stay queued.
 */
export const setImportMoq = async ({ jobId, entries, actor, req }) => {
  const job = await ImportJob.findOne({ jobId });
  if (!job) fail(`Import ${jobId} not found.`, 404, 'NOT_FOUND');

  if (!Array.isArray(entries) || entries.length === 0) {
    fail('Send an entries array of { skuCode, moq }.', 400);
  }

  const pending = new Map((job.pendingMoqSkus || []).map((p) => [p.skuCode, p]));
  const applied = [];
  const errors = [];

  for (const raw of entries) {
    const skuCode = String(raw?.skuCode ?? '').trim();
    if (!skuCode) { errors.push('A row was sent with no SKU code.'); continue; }

    const queued = pending.get(skuCode);
    if (!queued) {
      // Not one of ours. Refused rather than applied, so this endpoint can
      // never become a back door onto an established SKU's MOQ.
      errors.push(`${skuCode} was not created by this import, so its MOQ cannot be set here.`);
      continue;
    }

    // A minimum order quantity is a whole number of units, at least 1. Zero is
    // rejected on purpose: the whole point of asking is that 0 is what we are
    // trying not to leave behind.
    const moq = Number(raw.moq);
    if (!Number.isFinite(moq) || !Number.isInteger(moq) || moq < 1) {
      errors.push(`${skuCode}: MOQ must be a whole number of 1 or more.`);
      continue;
    }

    applied.push({ skuCode, brand: queued.brand, moq });
  }

  if (applied.length) {
    // Grouped by brand so the discriminator scopes each write, as M1 does.
    const byBrand = new Map();
    for (const a of applied) {
      if (!byBrand.has(a.brand)) byBrand.set(a.brand, []);
      byBrand.get(a.brand).push({
        updateOne: { filter: { skuCode: a.skuCode }, update: { $set: { moq: a.moq } } },
      });
    }
    for (const [brand, ops] of byBrand) {
      await createProductModel(brand).bulkWrite(ops, { ordered: false });
    }

    await ImportJob.updateOne(
      { jobId },
      { $pull: { pendingMoqSkus: { skuCode: { $in: applied.map((a) => a.skuCode) } } } },
    );

    // MOQ feeds the low-stock threshold, so the health projection must follow.
    await recomputeHealthForSkus(applied.map((a) => a.skuCode));

    await recordAudit(
      actor,
      'Inventory Planning Updated',
      `MOQ set for ${applied.length} SKU(s) created by import ${jobId}: `
      + applied.map((a) => `${a.skuCode}=${a.moq}`).join(', ') + '.',
      req,
      { meta: { jobId, applied } },
    );
  }

  const fresh = await ImportJob.findOne({ jobId }, 'pendingMoqSkus').lean();
  return {
    applied,
    errors,
    pendingMoqSkus: fresh?.pendingMoqSkus || [],
  };
};

/**
 * Answer the mandatory details for the NEW SKUs a staged import will create.
 *
 * WHY THIS RUNS BEFORE THE IMPORT, not after. A SKU created by an import lands
 * on the schema defaults — MOQ 0, lead time 0, safety factor 0, no box number —
 * and each of those reads as a deliberate answer while being nothing of the
 * kind. Its Max Level is DAC x LeadTime x SafetyFactor, so it computes to zero:
 * the SKU is permanently "over-stocked", never reorders, and the warehouse has
 * nowhere to pick it from. Asking afterwards means the catalogue holds SKUs in
 * that state for as long as it takes someone to come back, so the import is
 * held at the gate instead — confirmJob() refuses while anything is unanswered.
 *
 * ONLY the SKUs this file will create can be set here, and only while the job
 * is still awaiting confirmation. This is not a back door onto an established
 * SKU's planning figures: that is the inventory master's job, and it has its
 * own permissions and audit trail.
 *
 * Partial answers are accepted and saved. Ten new SKUs can be answered three at
 * a time — nothing is lost by closing the prompt, because the list and the
 * answers live on the job, not in the browser.
 */
export const setNewSkuDetails = async ({ jobId, entries, actor, req }) => {
  const job = await ImportJob.findOne({ jobId });
  if (!job) fail(`Import ${jobId} not found.`, 404, 'NOT_FOUND');

  if (!Array.isArray(entries) || entries.length === 0) {
    fail('Send an entries array of { skuCode, moq, leadTime, safetyFactor, boxNo }.', 400);
  }

  // Answers are an input to the import, so they close when the import starts.
  // Afterwards the SKU is a real product and the inventory master owns it.
  if (job.status !== 'Validated') {
    fail(
      `Import ${jobId} is ${job.status} — new SKU details can only be given while it is `
      + 'awaiting confirmation. Edit the SKU in the inventory master instead.',
      409, 'INVALID_STATE',
    );
  }

  const queued = new Map((job.newSkus || []).map((s) => [s.skuCode, s]));
  const applied = [];
  const errors = [];

  for (const raw of entries) {
    const skuCode = String(raw?.skuCode ?? '').trim();
    if (!skuCode) { errors.push('A row was sent with no SKU code.'); continue; }

    const target = queued.get(skuCode);
    if (!target) {
      errors.push(`${skuCode} is not a new SKU in this import, so its details cannot be set here.`);
      continue;
    }

    // Every field is checked, and a SKU is taken whole or not at all — a half
    // saved row would sit on the list looking answered and still block confirm.
    const { values, problems, ok } = parseNewSkuDetails(raw);
    if (!ok) {
      errors.push(`${skuCode}: ${Object.values(problems).join('; ')}.`);
      continue;
    }

    /**
     * The brand has to be a REAL brand this uploader may write to.
     *
     * newSku.rules.js only knows the answer is non-empty — it is a leaf and has
     * no business knowing the brand list or who may see which. Checking it here
     * is what lets confirmJob() treat "brand is filled in" as sufficient: a bad
     * one can never have been stored.
     */
    const canonical = ALL_BRANDS.find(
      (b) => b.toLowerCase() === String(values.brand).toLowerCase(),
    );
    if (!canonical) {
      errors.push(`${skuCode}: "${values.brand}" is not a brand. Expected ${ALL_BRANDS.join(', ')}.`);
      continue;
    }
    if (!allowedBrands(actor).includes(canonical)) {
      errors.push(`${skuCode}: you do not have access to ${canonical}.`);
      continue;
    }
    values.brand = canonical;

    Object.assign(target, values);
    applied.push({ skuCode, ...values });
  }

  if (applied.length) {
    job.markModified('newSkus');
    await job.save();

    await recordAudit(
      actor,
      'Inventory Planning Updated',
      `Details set for ${applied.length} new SKU(s) on import ${jobId}: `
      + applied.map((a) => `${a.skuCode} (MOQ ${a.moq}, lead ${a.leadTime}d, `
        + `safety ${a.safetyFactor}, box ${a.boxNo})`).join(', ') + '.',
      req,
      { meta: { jobId, applied } },
    );
  }

  const newSkus = (job.newSkus || []).map((s) => (typeof s.toObject === 'function' ? s.toObject() : s));
  return {
    applied,
    errors,
    newSkus,
    // What the screen needs to know: may the import be confirmed yet?
    ready: incompleteNewSkus(newSkus).length === 0,
  };
};

/**
 * Confirm an import and start processing.
 *
 * Returns as soon as the job is marked Processing. The work runs detached and
 * reports through the job counters, because a 40,000-row import through the
 * ledger takes minutes and holding an HTTP request open for it would time out
 * with the work half done and no way to tell how far it got.
 */
export const confirmJob = async ({ jobId, actor, req }) => {
  const job = await ImportJob.findOne({ jobId });
  if (!job) fail(`Import ${jobId} not found.`, 404, 'NOT_FOUND');
  assertTransition(job.status, 'Processing');
  if (job.validRows === 0) fail('There are no valid rows to import.', 400, 'NOTHING_TO_IMPORT');

  /**
   * New SKUs must be fully described before anything is written.
   *
   * The gate is here rather than only in the browser because this is the
   * request that creates the SKUs — a screen check alone would be one
   * hand-written POST away from a catalogue full of unconfigured parts.
   */
  const incomplete = incompleteNewSkus(job.newSkus || []);
  if (incomplete.length) {
    const named = incomplete.slice(0, 5).map((s) => s.skuCode).join(', ');
    fail(
      `${incomplete.length} new SKU(s) in this file still need an MOQ, Lead Time, Safety Factor `
      + `and Box Number: ${named}${incomplete.length > 5 ? ', …' : ''}. `
      + 'Fill them in before importing.',
      400, 'NEW_SKU_DETAILS_REQUIRED',
    );
  }

  job.status = 'Processing';
  job.confirmedBy = actor._id;
  job.confirmedAt = new Date();
  await job.save();

  await recordAudit(actor, 'Inventory Import Confirmed',
    `Import ${jobId} confirmed: ${job.validRows} row(s) queued for processing.`,
    req, { meta: { jobId, importType: job.importType, validRows: job.validRows } });

  // Detached. A failure inside is recorded on the job, never thrown at the
  // caller, who has already been told the import started.
  runJob(jobId, actor, req).catch((error) =>
    console.error(`[Import] ${jobId} failed:`, error.message));

  return job.toObject();
};

/**
 * Process every pending chunk.
 *
 * RESUME-SAFE. The unit of work is a chunk of rows still marked `pending`, and
 * a row is flipped to `processed` in the same write that records its result. A
 * process that dies mid-import leaves the remaining rows pending and nothing
 * else, so resuming continues from exactly where it stopped — and the ledger
 * keys, fixed at staging time, mean a chunk that was already posted replays
 * instead of posting again.
 */
export const runJob = async (jobId, actor, req = null) => {
  const started = Date.now();

  // ── Claim the job ────────────────────────────────────────────────────────
  // Atomic, so exactly one processor can hold it. Without this, confirming and
  // then resuming — or a double-clicked button, or two server instances —
  // would run the same chunk twice at the same moment: the ledger's
  // transactions collide as write conflicts, and an upsert-based import can
  // insert the same row twice because both runs look, find nothing, and write.
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS);
  const job = await ImportJob.findOneAndUpdate(
    {
      jobId,
      status: 'Processing',
      // Free, or abandoned by a process that died mid-run.
      $or: [{ lockedAt: null }, { lockedAt: { $lt: staleBefore } }],
    },
    { $set: { lockedAt: new Date() } },
    { new: true },
  );
  // Not claimable: already finished, or another processor holds it. Either way
  // there is nothing for this call to do, and saying so is not an error.
  if (!job) return null;

  const processor = PROCESSORS[job.importType];
  const chunkSize = job.chunkSize || CHUNK_SIZE;

  try {
    for (;;) {
      // The next pending chunk, in file order. Re-queried each pass rather than
      // held in memory, so a 40,000-row job never materialises more than one
      // chunk at a time.
      const rows = await ImportRow.find({ jobId, status: 'pending' })
        .sort({ chunkIndex: 1, rowNumber: 1 })
        .limit(chunkSize)
        .lean();
      if (rows.length === 0) break;

      const chunkIndex = rows[0].chunkIndex;
      const chunk = rows.filter((r) => r.chunkIndex === chunkIndex);

      // Retried on a transient conflict rather than failed. The chunk's ledger
      // idempotency key is fixed, so a retry after a partial commit replays the
      // original batch instead of posting a second one — the retry is safe for
      // exactly the reason the key is deterministic.
      let outcome = null;
      for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
        try {
          outcome = await processor({ rows: chunk, job, chunkIndex, actor, req });
          break;
        } catch (error) {
          if (!isRetryable(error) || attempt === MAX_CHUNK_ATTEMPTS) throw error;
          console.warn(`[Import] ${jobId} chunk ${chunkIndex} conflicted (attempt ${attempt}); retrying.`);
          await pause(150 * attempt);
        }
      }
      const { successes, failures, refs } = outcome;

      const now = new Date();
      const ops = [
        ...successes.map((s) => ({
          updateOne: {
            filter: { jobId, rowNumber: s.rowNumber, status: 'pending' },
            update: { $set: { status: 'processed', result: s.result, processedAt: now } },
          },
        })),
        ...failures.map((f) => ({
          updateOne: {
            filter: { jobId, rowNumber: f.rowNumber, status: 'pending' },
            update: { $set: { status: 'failed', failureReason: f.reason, processedAt: now } },
          },
        })),
      ];
      // Filtered on `status: 'pending'`, so a row already processed by a
      // concurrent run is not written twice.
      if (ops.length) await ImportRow.bulkWrite(ops, { ordered: false });

      if (failures.length) {
        await ImportError.insertMany(
          failures.map((f) => ({ jobId, rowNumber: f.rowNumber, category: 'processing', message: f.reason })),
          { ordered: false },
        ).catch(() => {});
      }

      await ImportJob.updateOne({ jobId }, {
        $inc: {
          processedRows: successes.length + failures.length,
          successfulRows: successes.length,
          failedRows: failures.length,
          chunksDone: 1,
        },
        ...(refs.length ? { $push: { producedRefs: { $each: refs } } } : {}),
      });

      // Every row in the chunk was attempted; if none moved, the processor is
      // not making progress and looping would spin forever.
      if (successes.length + failures.length === 0) {
        await ImportRow.updateMany(
          { jobId, rowNumber: { $in: chunk.map((r) => r.rowNumber) }, status: 'pending' },
          { $set: { status: 'failed', failureReason: 'The processor returned no result for this row.', processedAt: now } },
        );
      }
    }

    // ── Finish ────────────────────────────────────────────────────────────
    const fresh = await ImportJob.findOne({ jobId });

    // Partial covers rows rejected at VALIDATION as well as rows the services
    // refused. A file where 7 of 8 rows never made it reporting "Completed"
    // would be true only in the narrowest sense and misleading in every useful
    // one — the whole reason this status exists is that "1,200 of 1,240
    // imported" is not success.
    fresh.status = (fresh.failedRows > 0 || fresh.invalidRows > 0) ? 'Partial' : 'Completed';
    fresh.completedAt = new Date();
    fresh.processingMs = Date.now() - started;
    fresh.lockedAt = null;
    await fresh.save();

    await recordAudit(actor, 'Inventory Import Processed',
      `Import ${jobId} finished: ${fresh.successfulRows} imported, ${fresh.failedRows} failed, ` +
      `${fresh.invalidRows} rejected at validation.`,
      req, {
        meta: {
          jobId, importType: fresh.importType, status: fresh.status,
          successfulRows: fresh.successfulRows, failedRows: fresh.failedRows,
          invalidRows: fresh.invalidRows, processingMs: fresh.processingMs,
          producedRefs: fresh.producedRefs,
        },
      });

    return fresh.toObject();
  } catch (error) {
    await ImportJob.updateOne({ jobId }, {
      // Lock released alongside the failure, so a corrected retry is possible
      // immediately rather than after the stale-lock window.
      $set: { status: 'Failed', completedAt: new Date(), processingMs: Date.now() - started, lockedAt: null },
      $push: { fileErrors: `Processing stopped: ${error.message}` },
    });
    throw error;
  }
};

/** Restart a job that stopped mid-flight. Picks up the still-pending rows. */
export const resumeJob = async ({ jobId, actor, req }) => {
  const job = await ImportJob.findOne({ jobId });
  if (!job) fail(`Import ${jobId} not found.`, 404, 'NOT_FOUND');
  if (job.status !== 'Processing') {
    fail(`Only an import left in "Processing" can be resumed (this one is "${job.status}").`, 409, 'INVALID_STATE');
  }
  const pending = await ImportRow.countDocuments({ jobId, status: 'pending' });
  if (pending === 0) fail('There is nothing left to process.', 400, 'NOTHING_PENDING');

  await recordAudit(actor, 'Inventory Import Resumed',
    `Import ${jobId} resumed with ${pending} row(s) outstanding.`, req, { meta: { jobId, pending } });

  runJob(jobId, actor, req).catch((error) => console.error(`[Import] ${jobId} resume failed:`, error.message));
  return { jobId, pending };
};

export const cancelJob = async ({ jobId, reason, actor, req }) => {
  const job = await ImportJob.findOne({ jobId });
  if (!job) fail(`Import ${jobId} not found.`, 404, 'NOT_FOUND');
  // Cancelling mid-processing is deliberately refused. Rows already handed to
  // the ledger are posted and immutable; stopping halfway would leave a job
  // labelled Cancelled that had in fact changed stock.
  assertTransition(job.status, 'Cancelled');

  job.status = 'Cancelled';
  job.cancelledBy = actor._id;
  job.cancelReason = reason || null;
  job.completedAt = new Date();
  await job.save();

  // The staged rows were a workspace, never inventory. Nothing downstream
  // referenced them, so they go with the job.
  await ImportRow.deleteMany({ jobId });

  await recordAudit(actor, 'Inventory Import Cancelled',
    `Import ${jobId} cancelled${reason ? `: ${reason}` : ''}. Nothing was written.`,
    req, { meta: { jobId, reason: reason ?? null } });

  return job.toObject();
};

export const getJob = async (jobId) => {
  const job = await ImportJob.findOne({ jobId })
    .populate('startedBy confirmedBy cancelledBy', 'user email').lean();
  if (!job) fail(`Import ${jobId} not found.`, 404, 'NOT_FOUND');
  const pending = await ImportRow.countDocuments({ jobId, status: 'pending' });
  return { ...job, pendingRows: pending };
};

export default {
  createImportJob, previewJob, errorReport, confirmJob,
  runJob, resumeJob, cancelJob, getJob,
};
