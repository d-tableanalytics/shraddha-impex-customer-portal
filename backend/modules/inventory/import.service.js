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
import { nextSequence } from '../../models/Counter.js';

import { IMPORT_TEMPLATES, matchHeaders, coerce } from './import.templates.js';
import { readerFor, MAX_ROWS } from './import.parser.js';
import { postBatch } from './ledger.service.js';
import { applyMovements } from './balance.service.js';
import { recomputeHealthForSkus } from './health.service.js';
import { resolveConfig } from './config.service.js';
import { createCount, startCount, recordCounts, submitCount } from './count.service.js';
import { DEFAULT_REASON_CODE } from './adjustment.service.js';
import { recordAudit } from '../../utils/auditLog.js';
import { allowedBrands, ALL_BRANDS } from '../../utils/brandAccess.js';
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
const buildContext = async (importType, { user }) => {
  const template = IMPORT_TEMPLATES[importType];
  const context = {
    brands: new Set(ALL_BRANDS),
    // Brand isolation: a file may only touch brands this user can see. Enforced
    // per row rather than per file, because one bad row must not fail the rest.
    allowedBrands: new Set(allowedBrands(user)),
    skus: null,
    locations: new Map(),
    reasonCodes: new Set(),
  };

  if (template.requireExistingSku) {
    // skuCode::brand, so the same code under two brands stays two SKUs.
    const needsMsil = Boolean(template.verifyMsil);
    const rows = await Product.find({}, `skuCode brand${needsMsil ? ' msilCode' : ''}`).lean();
    context.skus = new Set(rows.map((p) => `${p.skuCode}::${p.brand}`));

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

  // ── Brand resolved from the SKU ──────────────────────────────────────────
  // Runs BEFORE the brand checks below, so a resolved brand goes through the
  // same access and existence rules as one typed into a sheet.
  if (template.resolveBrandFromSku && data.skuCode && !data.brand) {
    const resolved = context.skuToBrand?.get(data.skuCode);
    if (!resolved) {
      errors.push({
        category: 'reference', column: 'SKU Code',
        message: `${data.skuCode} is not in the catalogue.`,
        value: data.skuCode,
      });
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
  if (errors.length === 0 && typeof template.validate === 'function') {
    errors.push(...template.validate(data));
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
    const context = await buildContext(importType, { user: actor });
    const read = readerFor(fileType);

    let mapping = null;
    const seenKeys = new Map();
    let staged = [];
    const errorDocs = [];

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
    `${totalRows} row(s), ${validRows} valid, ${invalidRows} rejected.`,
    req, { meta: { jobId, importType, fileName, fileHash, totalRows, validRows, invalidRows, fileErrors } });

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

/** Products are the master itself — written directly, with M1's own normalisers. */
const processMaster = async ({ rows, actor }) => {
  const successes = [];
  const failures = [];
  const ops = new Map(); // brand → bulk ops, so each discriminator writes once

  for (const row of rows) {
    const d = row.data;
    const season = normaliseSeason(d.currentSeason);
    if (!season.ok) {
      failures.push({ rowNumber: row.rowNumber, reason: `Invalid season "${season.raw}".` });
      continue;
    }

    const set = {
      ...(d.msilCode !== undefined && d.msilCode !== null ? { msilCode: d.msilCode } : {}),
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

    if (!ops.has(d.brand)) ops.set(d.brand, []);
    ops.get(d.brand).push({
      rowNumber: row.rowNumber,
      op: {
        updateOne: {
          filter: { skuCode: d.skuCode },
          // Upsert: the same import creates new SKUs and updates existing ones,
          // which is what "master import" means to the people running it.
          update: { $set: set, $setOnInsert: { skuCode: d.skuCode } },
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

  return { successes, failures, refs: [] };
};

/** Planning is the master import narrowed to four fields. */
const processPlanning = (args) => processMaster(args);

/** Opening balances and movements both post through the ledger, unchanged. */
const processMovements = (movementType) => async ({ rows, job, chunkIndex, actor, req }) => {
  const successes = [];
  const failures = [];

  const lines = rows.map((row) => ({
    movementType: movementType || row.data.movementType,
    skuCode: row.data.skuCode,
    brand: row.data.brand,
    locationCode: row.data.locationCode,
    quantity: movementType === 'OPENING' ? row.data.quantity : row.data.quantity,
    unitCost: row.data.unitCost ?? null,
    reasonCode: row.data.reasonCode ?? null,
    note: row.data.note ?? null,
  }));

  let result;
  try {
    result = await postBatch({
      // DETERMINISTIC, and derived from the chunk index fixed at staging time.
      // A resumed or retried chunk replays the original batch instead of
      // posting a second one — the ledger's own idempotency, reused rather
      // than reimplemented.
      idempotencyKey: `import-${job.jobId}-${chunkIndex}`,
      workflowType: 'import',
      referenceType: 'import',
      referenceId: job.jobId,
      actor,
      effectiveDate: rows.find((r) => r.data.effectiveDate)?.data.effectiveDate ?? null,
      note: `${IMPORT_TEMPLATES[job.importType].label} import ${job.jobId} (chunk ${chunkIndex + 1})`,
      lines,
    }, req);
  } catch (error) {
    // A transient conflict is rethrown so the chunk-level retry can take it.
    // Recording it as a row failure would reject a perfectly good file because
    // a booking happened to touch the same SKU a millisecond earlier.
    if (isRetryable(error)) throw error;
    // A genuine rejection: the ledger refused the batch, so every row in it
    // failed together and the reason is the same for all of them.
    for (const row of rows) failures.push({ rowNumber: row.rowNumber, reason: error.message });
    return { successes, failures, refs: [] };
  }

  const posted = await StockMovement.find({ batchId: result.batch.batchId }).lean();

  // Projections update from the movements, exactly as the count and booking
  // flows do. Never written directly, and never rebuilt wholesale.
  if (!result.replayed && posted.length) await applyMovements(posted);
  const affected = [...new Set(rows.map((r) => r.data.skuCode))];
  await recomputeHealthForSkus(affected);

  const txnBySku = new Map(posted.map((m) => [`${m.skuCode}::${m.brand}`, m.transactionId]));
  for (const row of rows) {
    successes.push({
      rowNumber: row.rowNumber,
      result: {
        batchId: result.batch.batchId,
        transactionId: txnBySku.get(`${row.data.skuCode}::${row.data.brand}`) ?? null,
        replayed: result.replayed,
      },
    });
  }

  return {
    successes, failures,
    refs: [{ kind: 'ledgerBatch', id: result.batch.batchId, chunkIndex }],
  };
};

/**
 * Bulk stock update — the sheet says what stock SHOULD be; this works out what
 * changed.
 *
 * The uploader gives an absolute figure per SKU. Writing that figure into the
 * balance would break the one rule the whole design rests on, so each row is
 * turned into the DIFFERENCE against the current position and posted as an
 * ADJUSTMENT. The result the user sees is "stock is now 250"; what the ledger
 * records is "+37 on the 1st, by this person, from this file".
 *
 * The current figure is read HERE, at processing time, not when the file was
 * staged. A file validated an hour ago against a SKU that has since been sold
 * from must adjust against the figure that is true now, or the sale would be
 * silently reversed.
 */
const processStockUpdate = async ({ rows, job, chunkIndex, actor, req }) => {
  const successes = [];
  const failures = [];

  // One query for the whole chunk rather than one per row.
  const balances = await StockBalance.find({
    $or: rows.map((r) => ({
      skuCode: r.data.skuCode, brand: r.data.brand, locationCode: r.data.locationCode,
    })),
  }).lean();
  const byKey = new Map(balances.map((b) => [`${b.skuCode}::${b.brand}::${b.locationCode}`, b]));

  const lines = [];
  const lineRows = [];
  const unchanged = [];

  for (const row of rows) {
    const d = row.data;
    const current = byKey.get(`${d.skuCode}::${d.brand}::${d.locationCode}`);
    const before = current?.onHand ?? 0;
    const reserved = current?.reserved ?? 0;
    const delta = d.quantity - before;

    // A row that states the figure stock is already at is not an error — on a
    // full stock-take sheet most rows will say exactly that. It is reported as
    // processed-but-unchanged so the summary can distinguish "nothing to do"
    // from "did not run".
    if (delta === 0) {
      unchanged.push(row);
      continue;
    }

    // Reserved stock is committed to live bookings; cutting below it creates an
    // oversell that only surfaces at dispatch. One bad row fails alone.
    if (d.quantity < reserved) {
      failures.push({
        rowNumber: row.rowNumber,
        reason: `${reserved} unit${reserved === 1 ? ' is' : 's are'} reserved against live bookings, so stock cannot be set to ${d.quantity}.`,
      });
      continue;
    }

    lines.push({
      movementType: 'ADJUSTMENT',
      skuCode: d.skuCode,
      brand: d.brand,
      locationCode: d.locationCode,
      quantity: delta,
      beforeQuantity: before,
      afterQuantity: d.quantity,
      reasonCode: d.reasonCode || DEFAULT_REASON_CODE,
      note: d.note ?? null,
    });
    lineRows.push(row);
  }

  // Every row in the chunk already matched, so there is nothing to post. Going
  // ahead would hand postBatch an empty batch, which it correctly refuses.
  if (lines.length === 0) {
    for (const row of unchanged) {
      successes.push({ rowNumber: row.rowNumber, result: { unchanged: true, quantity: row.data.quantity } });
    }
    return { successes, failures, refs: [] };
  }

  let result;
  try {
    result = await postBatch({
      idempotencyKey: `import-${job.jobId}-${chunkIndex}`,
      workflowType: 'stock-update',
      referenceType: 'import',
      referenceId: job.jobId,
      actor,
      note: `Stock Update import ${job.jobId} (chunk ${chunkIndex + 1})`,
      lines,
    }, req);
  } catch (error) {
    if (isRetryable(error)) throw error;
    for (const row of lineRows) failures.push({ rowNumber: row.rowNumber, reason: error.message });
    for (const row of unchanged) {
      successes.push({ rowNumber: row.rowNumber, result: { unchanged: true, quantity: row.data.quantity } });
    }
    return { successes, failures, refs: [] };
  }

  const posted = await StockMovement.find({ batchId: result.batch.batchId }).lean();
  if (!result.replayed && posted.length) await applyMovements(posted);
  await recomputeHealthForSkus([...new Set(lineRows.map((r) => r.data.skuCode))]);

  const txnBySku = new Map(posted.map((mv) => [`${mv.skuCode}::${mv.brand}`, mv.transactionId]));
  for (const [i, row] of lineRows.entries()) {
    successes.push({
      rowNumber: row.rowNumber,
      result: {
        batchId: result.batch.batchId,
        transactionId: txnBySku.get(`${row.data.skuCode}::${row.data.brand}`) ?? null,
        before: lines[i].beforeQuantity,
        after: lines[i].afterQuantity,
        delta: lines[i].quantity,
        replayed: result.replayed,
      },
    });
  }
  for (const row of unchanged) {
    successes.push({ rowNumber: row.rowNumber, result: { unchanged: true, quantity: row.data.quantity } });
  }

  return {
    successes, failures,
    refs: [{ kind: 'ledgerBatch', id: result.batch.batchId, chunkIndex }],
  };
};

/**
 * Counted quantities go INTO a count session; they do not become adjustments.
 *
 * The session is created once for the whole job, filled chunk by chunk, and
 * submitted at the end — leaving it exactly where a hand-counted session would
 * be: awaiting an approver. Nothing posts to the ledger here. Module M7 decides
 * whether these variances are real, and M7's separation-of-duties rule still
 * applies, so whoever uploaded the sheet cannot also approve it.
 */
const processCount = async ({ rows, job, actor, req }) => {
  const successes = [];
  const failures = [];

  const lines = rows.map((row) => ({
    skuCode: row.data.skuCode,
    countedQuantity: row.data.countedQuantity,
    reasonCode: row.data.reasonCode ?? null,
    note: row.data.note ?? null,
  }));

  try {
    await recordCounts({ countId: job.options.countId, lines, actor, req });
    for (const row of rows) successes.push({ rowNumber: row.rowNumber, result: { countId: job.options.countId } });
  } catch (error) {
    for (const row of rows) failures.push({ rowNumber: row.rowNumber, reason: error.message });
  }

  return { successes, failures, refs: [] };
};

const processLocations = async ({ rows }) => {
  const successes = [];
  const failures = [];

  for (const row of rows) {
    const d = row.data;
    try {
      await Location.updateOne(
        { code: d.code },
        {
          $set: {
            name: d.name,
            ...(d.type ? { type: d.type } : {}),
            ...(d.address !== null && d.address !== undefined ? { address: d.address } : {}),
            ...(d.active !== null && d.active !== undefined ? { active: d.active } : {}),
          },
          $setOnInsert: { code: d.code },
        },
        { upsert: true, runValidators: true },
      );
      successes.push({ rowNumber: row.rowNumber, result: { code: d.code } });
    } catch (error) {
      failures.push({ rowNumber: row.rowNumber, reason: error.message });
    }
  }

  return { successes, failures, refs: [] };
};

const PROCESSORS = {
  'inventory-master': processMaster,
  planning: processPlanning,
  'opening-stock': processMovements('OPENING'),
  'stock-update': processStockUpdate,
  'stock-movements': processMovements(null),
  'physical-count': processCount,
  locations: processLocations,
};

// ─── Confirm and process ─────────────────────────────────────────────────────

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

  // A physical-count import needs its session to exist before any row lands,
  // and it is created ONCE for the job rather than per chunk.
  if (job.importType === 'physical-count') {
    const skuCodes = await ImportRow.distinct('data.skuCode', { jobId, valid: true });
    try {
      const created = await createCount({
        scope: 'spot',
        brand: job.brand || null,
        locationCode: job.locationCode || null,
        skuCodes,
        // A SKU counted at zero must be countable, so the session cannot be
        // limited to SKUs that already show stock.
        includeZeroStock: true,
        notes: `Imported from ${job.fileName} (${job.jobId}).`,
        actor, req,
      });
      await startCount({ countId: created.countId, actor, req });
      job.options = { ...(job.options || {}), countId: created.countId };
      job.producedRefs.push({ kind: 'count', id: created.countId, chunkIndex: -1 });
    } catch (error) {
      // The count service refused the scope — most often because a SKU has no
      // balance row at that location and so has never held stock there. Recorded
      // on the job rather than thrown, so the user gets the reason on the screen
      // they are looking at instead of a 500.
      job.status = 'Failed';
      job.fileErrors.push(`A count session could not be opened: ${error.message}`);
      job.completedAt = new Date();
      await job.save();
      fail(`A count session could not be opened: ${error.message}`, error.status || 400, error.code || 'COUNT_SCOPE_REJECTED');
    }
  }

  job.status = 'Processing';
  job.confirmedBy = actor._id;
  job.confirmedAt = new Date();
  await job.save();

  await recordAudit(actor, 'Inventory Import Confirmed',
    `Import ${jobId} confirmed: ${job.validRows} row(s) queued for processing.`,
    req, { meta: { jobId, importType: job.importType, validRows: job.validRows, countId: job.options?.countId } });

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

    // A submitted count is where an imported count sheet belongs: filled in and
    // waiting for an approver, exactly like one entered by hand.
    if (fresh.importType === 'physical-count' && fresh.options?.countId && fresh.successfulRows > 0) {
      try {
        await submitCount({ countId: fresh.options.countId, allowUncounted: true, actor, req });
      } catch (error) {
        fresh.fileErrors.push(`Rows loaded, but the count could not be submitted: ${error.message}`);
      }
    }

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
