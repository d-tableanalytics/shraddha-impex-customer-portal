import path from 'path';
import fs from 'fs';
import ExcelJS from 'exceljs';

import ImportJob from '../../models/ImportJob.js';
import { IMPORT_TEMPLATES, IMPORT_TYPE_NAMES, headersFor } from './import.templates.js';
import {
  createImportJob, previewJob, errorReport, confirmJob, resumeJob, cancelJob, getJob,
} from './import.service.js';
import { hasPermission } from '../../middlewares/rbac.js';
import { allowedBrands } from '../../utils/brandAccess.js';

/**
 * Import endpoints (IMS Module M9).
 *
 * The route-level permission is the broad "may import something" gate; the
 * per-TYPE permission is checked here, because the type arrives in the request
 * body and a route cannot see it. Same shape as Module M7, where the route
 * checks the permission and the service checks the record.
 */

// Express parses the query string with `qs` in extended mode, so
// `?status[$ne]=Cancelled` arrives as an object. Non-strings are dropped rather
// than coerced, so an operator can never reach a filter.
const asString = (value) => {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
};
const asInt = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
};

const handle = (error, res, next) => {
  if (error?.status) {
    return res.status(error.status).json({ success: false, message: error.message, code: error.code });
  }
  return next(error);
};

/** May this user run this import type? */
const mayImport = (user, importType) => {
  const template = IMPORT_TEMPLATES[importType];
  if (!template) return false;
  return template.permissions.some((p) => hasPermission(user, p));
};

/** Remove an uploaded file when the request is rejected before staging. */
const discard = (file) => {
  if (file?.path) fs.promises.unlink(file.path).catch(() => {});
};

// ─── Catalogue and templates ─────────────────────────────────────────────────

/** What this user may import, so the UI offers only what will be accepted. */
export const listImportTypes = async (req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      data: IMPORT_TYPE_NAMES.map((key) => {
        const t = IMPORT_TEMPLATES[key];
        return {
          importType: key,
          label: t.label,
          description: t.description,
          allowed: mayImport(req.user, key),
          columns: t.columns.map((c) => ({
            header: c.header, required: Boolean(c.required),
            type: c.type, note: c.note ?? null,
            allowed: c.enumOf ?? null,
          })),
        };
      }),
    });
  } catch (error) { next(error); }
};

/**
 * Download a blank template.
 *
 * Generated from the same registry the validator reads, so a template can never
 * carry a header the importer does not recognise. Required columns are marked
 * and the notes ride along as cell comments, which removes most of the reason
 * people get an import wrong on the first attempt.
 */
export const downloadTemplate = async (req, res, next) => {
  try {
    const importType = asString(req.params.importType);
    const template = IMPORT_TEMPLATES[importType];
    if (!template) {
      return res.status(400).json({ success: false, message: `Unknown import type "${importType}".` });
    }
    if (!mayImport(req.user, importType)) {
      return res.status(403).json({ success: false, message: `You do not have permission to import ${template.label}.` });
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(template.label.slice(0, 31));

    sheet.columns = template.columns.map((c) => ({
      header: c.required ? `${c.header} *` : c.header,
      key: c.field,
      width: Math.min(Math.max(c.header.length + 6, 14), 34),
    }));

    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.eachCell((cell, i) => {
      const col = template.columns[i - 1];
      const bits = [col.note, col.enumOf ? `One of: ${col.enumOf.join(', ')}` : null].filter(Boolean);
      if (bits.length) cell.note = bits.join('\n');
    });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    // One filled example row. A blank template leaves people guessing at date
    // and list formats, which is where most first-attempt failures come from.
    if (template.sample) {
      sheet.addRow(template.columns.map((c) => template.sample[c.header] ?? ''));
    }

    // The header row the validator will actually look for, unadorned by the
    // asterisks — so a user who deletes the sample row still has a usable file.
    const guide = workbook.addWorksheet('Notes');
    guide.columns = [{ header: 'Column', width: 26 }, { header: 'Required', width: 10 }, { header: 'Notes', width: 70 }];
    guide.getRow(1).font = { bold: true };
    for (const c of template.columns) {
      guide.addRow([
        c.header,
        c.required ? 'Yes' : 'No',
        [c.note, c.enumOf ? `One of: ${c.enumOf.join(', ')}` : null].filter(Boolean).join(' ') || '',
      ]);
    }
    guide.addRow([]);
    guide.addRow(['The header row must match these column names. Extra columns are ignored.']);
    guide.addRow([`Expected headers: ${headersFor(importType).join(' | ')}`]);

    res.setHeader('Content-Disposition', `attachment; filename="${importType}-template.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) { next(error); }
};

// ─── Pipeline ────────────────────────────────────────────────────────────────

export const upload = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file was uploaded.' });
    }

    const importType = asString(req.body.importType);
    if (!importType || !IMPORT_TEMPLATES[importType]) {
      discard(req.file);
      return res.status(400).json({
        success: false,
        message: `importType must be one of: ${IMPORT_TYPE_NAMES.join(', ')}.`,
      });
    }
    if (!mayImport(req.user, importType)) {
      discard(req.file);
      return res.status(403).json({
        success: false,
        message: `You do not have permission to import ${IMPORT_TEMPLATES[importType].label}.`,
      });
    }

    // Names the file and what was actually read off it. "The file must be .xlsx"
    // in front of a file the user believes IS .xlsx is unactionable — the cause
    // is usually .xlsm, .ods, or a name with no extension at all.
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
    if (!['xlsx', 'xls', 'csv'].includes(ext)) {
      discard(req.file);
      return res.status(400).json({
        success: false,
        code: 'UNSUPPORTED_FILE_TYPE',
        message:
          `"${req.file.originalname}" is ${ext ? `a .${ext} file` : 'a file with no extension'}. ` +
          'Imports must be .xlsx, .xls or .csv — open it in Excel and use Save As to convert it.',
      });
    }

    const brand = asString(req.body.brand) ?? null;
    if (brand && !allowedBrands(req.user).includes(brand)) {
      discard(req.file);
      return res.status(403).json({ success: false, message: 'Access to this brand is restricted for your account.' });
    }

    const job = await createImportJob({
      filePath: req.file.path,
      fileName: req.file.originalname,
      fileType: ext,
      fileSize: req.file.size,
      importType,
      brand,
      locationCode: asString(req.body.locationCode)?.toUpperCase() ?? null,
      force: asString(req.body.force) === 'true',
      actor: req.user,
      req,
    });

    res.status(201).json({ success: true, data: job });
  } catch (error) {
    discard(req.file);
    handle(error, res, next);
  }
};

export const preview = async (req, res, next) => {
  try {
    const result = await previewJob(asString(req.params.jobId), {
      page: asInt(req.query.page, 1, 1, 10_000),
      limit: asInt(req.query.limit, 50, 1, 200),
      invalidOnly: asString(req.query.invalidOnly) === 'true',
    });
    res.status(200).json({ success: true, ...result });
  } catch (error) { handle(error, res, next); }
};

export const errors = async (req, res, next) => {
  try {
    const result = await errorReport(asString(req.params.jobId), {
      page: asInt(req.query.page, 1, 1, 10_000),
      limit: asInt(req.query.limit, 100, 1, 500),
      category: asString(req.query.category) ?? null,
    });
    res.status(200).json({ success: true, ...result });
  } catch (error) { handle(error, res, next); }
};

export const confirm = async (req, res, next) => {
  try {
    const jobId = asString(req.params.jobId);
    const existing = await ImportJob.findOne({ jobId }, 'importType').lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Import not found' });
    // Re-checked at confirm, not only at upload — this is the request that
    // actually changes stock, and permissions may have changed in between.
    if (!mayImport(req.user, existing.importType)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to confirm this import.' });
    }

    const job = await confirmJob({ jobId, actor: req.user, req });
    res.status(200).json({ success: true, data: job });
  } catch (error) { handle(error, res, next); }
};

export const status = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await getJob(asString(req.params.jobId)) });
  } catch (error) { handle(error, res, next); }
};

export const resume = async (req, res, next) => {
  try {
    const jobId = asString(req.params.jobId);
    const existing = await ImportJob.findOne({ jobId }, 'importType').lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Import not found' });
    if (!mayImport(req.user, existing.importType)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to resume this import.' });
    }
    res.status(200).json({ success: true, data: await resumeJob({ jobId, actor: req.user, req }) });
  } catch (error) { handle(error, res, next); }
};

export const cancel = async (req, res, next) => {
  try {
    const jobId = asString(req.params.jobId);
    const existing = await ImportJob.findOne({ jobId }, 'importType').lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Import not found' });
    if (!mayImport(req.user, existing.importType)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to cancel this import.' });
    }
    const job = await cancelJob({ jobId, reason: asString(req.body?.reason) ?? null, actor: req.user, req });
    res.status(200).json({ success: true, data: job });
  } catch (error) { handle(error, res, next); }
};

// ─── History ─────────────────────────────────────────────────────────────────

export const history = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    // A brand-less import (locations, cross-brand master) is visible to anyone
    // who may see the history; a brand-scoped one only within that brand.
    const filter = { $or: [{ brand: null }, { brand: { $in: brands } }] };

    const importType = asString(req.query.importType);
    if (importType) {
      if (!IMPORT_TYPE_NAMES.includes(importType)) {
        return res.status(400).json({ success: false, message: `Unknown import type "${importType}".` });
      }
      filter.importType = importType;
    }

    const jobStatus = asString(req.query.status);
    if (jobStatus) {
      const allowed = ImportJob.schema.path('status').enumValues;
      if (!allowed.includes(jobStatus)) {
        return res.status(400).json({ success: false, message: `Status must be one of: ${allowed.join(', ')}.` });
      }
      filter.status = jobStatus;
    }

    const limit = asInt(req.query.limit, 25, 1, 200);
    const page = asInt(req.query.page, 1, 1, 10_000);

    const [rows, total, byStatus] = await Promise.all([
      ImportJob.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('startedBy confirmedBy', 'user email').lean(),
      ImportJob.countDocuments(filter),
      ImportJob.aggregate([
        { $match: { $or: [{ brand: null }, { brand: { $in: brands } }] } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
    ]);

    res.status(200).json({
      success: true,
      data: rows.map((j) => ({ ...j, label: IMPORT_TEMPLATES[j.importType]?.label ?? j.importType })),
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
      statusCounts: Object.fromEntries(byStatus.map((s) => [s._id, s.n])),
    });
  } catch (error) { next(error); }
};

export default {
  listImportTypes, downloadTemplate, upload, preview, errors,
  confirm, status, resume, cancel, history,
};
