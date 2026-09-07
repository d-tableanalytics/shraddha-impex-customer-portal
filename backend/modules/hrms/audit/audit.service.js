/**
 * Audit Logs.
 *
 * The reference's `GET /audit-logs`, over the AuditLog collection this codebase
 * already has. No second collection and no second writer: every HRMS module
 * already records through `utils/auditLog.js#recordAudit`, and this is the read
 * side that was missing.
 *
 * ---------------------------------------------------------------------------
 * Redaction, and why it is not optional
 * ---------------------------------------------------------------------------
 * `audit-logs:view:org` is held by super_admin, hr_admin AND auditor.
 * `settings:view:org` is held by super_admin alone. So the audit trail is read
 * by two roles that may not open Settings at all.
 *
 * The reference stores `payload: req.body` unredacted and renders it in a modal
 * on that page — so its hr_admin and auditor can read SSO client secrets and
 * integration API keys straight out of the audit trail, which is a privilege
 * escalation through a screen designed for oversight.
 *
 * Two things stop that here. This module's own writers never put a secret in
 * `meta` (see settings.service.js), and this reader redacts on the way out
 * anyway — because `meta` is a `Mixed` field that every module in the system
 * can write, and an audit reader must not depend on all of them being careful
 * forever.
 */

import mongoose from 'mongoose';

import AuditLog from '../../../models/AuditLog.js';
import User from '../../../models/User.js';
import Employee from '../../../models/hrms/Employee.js';
import { ALL_SECRET_KEYS } from '../../../shared/schemas/settings.js';

/**
 * Key names whose VALUE is never shown, whatever module wrote it.
 *
 * Matched case-insensitively on the key, not the value — a redactor that
 * pattern-matched values would both miss short secrets and mangle ordinary
 * text that happens to look like one.
 */
const REDACT_KEYS = Object.freeze(
  [
    ...ALL_SECRET_KEYS,
    'password',
    'newPassword',
    'currentPassword',
    'token',
    'accessToken',
    'refreshToken',
    'secret',
    'apiSecret',
    'privateKey',
    'awsSecretAccessKey',
    'sessionToken',
    'otp',
  ].map((k) => k.toLowerCase()),
);

const REDACTED = '[redacted]';

/** Does this key name a secret? Substring, so `slackWebhookUrl` is caught too. */
const isSecretKey = (key) => {
  const k = String(key).toLowerCase();
  return REDACT_KEYS.some((needle) => k === needle || k.includes(needle));
};

/**
 * Walk `meta` and blank every secret-looking key, at any depth.
 *
 * Depth-bounded: `meta` is `Mixed`, so a cyclic or pathologically nested value
 * would otherwise hang the request that is meant to be reading the audit trail.
 */
export function redactMeta(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map((v) => redactMeta(v, depth + 1));
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : redactMeta(v, depth + 1);
  }
  return out;
}

/** Escape a user string before it reaches a regex. */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const dayStart = (day) => new Date(`${day}T00:00:00.000Z`);
const dayEnd = (day) => new Date(`${day}T23:59:59.999Z`);

/**
 * One page of the audit trail.
 *
 * Paged and sorted on the server. `createdAt` descending with an `_id`
 * tiebreak: entries written in the same millisecond would otherwise shuffle
 * between pages, and a trail that reorders under paging is not evidence.
 */
export async function listAuditLogs(query = {}) {
  const { page, pageSize, action, userId, from, to } = query;

  const filter = {};
  if (action) filter.action = new RegExp(escapeRegex(action), 'i');
  if (userId) filter.user = new mongoose.Types.ObjectId(String(userId));
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = dayStart(from);
    if (to) filter.createdAt.$lte = dayEnd(to);
  }

  const [rows, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  // Actor names for this page only, in two batched queries.
  //
  // The employee record is the source of a person's NAME here — `User` has no
  // name field at all (its display column is `user`), which is why every other
  // module resolves people through Employee. The user row is the fallback for
  // an account with no employee record, such as a portal-only administrator.
  const userIds = [...new Set(rows.map((r) => r.user).filter(Boolean).map(String))];
  const [employees, users] = await Promise.all([
    userIds.length
      ? Employee.find({ userId: { $in: userIds } })
          // Soft-deleted employees are DELIBERATELY included: an audit trail
          // must still name whoever performed an action after they have left,
          // or the evidence loses its actor the moment somebody is offboarded.
          .select('userId firstName lastName employeeCode')
          .lean()
      : [],
    userIds.length ? User.find({ _id: { $in: userIds } }).select('user email').lean() : [],
  ]);

  const byUser = new Map();
  for (const u of users) {
    byUser.set(String(u._id), { name: u.user || u.email || null, employeeCode: null });
  }
  for (const e of employees) {
    const name = `${e.firstName ?? ''} ${e.lastName ?? ''}`.trim();
    if (name) byUser.set(String(e.userId), { name, employeeCode: e.employeeCode ?? null });
  }

  return {
    data: rows.map((row) => {
      const actor = row.user ? (byUser.get(String(row.user)) ?? null) : null;
      return {
        id: String(row._id),
        action: row.action,
        actorUserId: row.user ? String(row.user) : null,
        actorName: actor?.name ?? null,
        /**
         * Two people can share a name; nobody shares an employee code. In an
         * evidence trail that difference decides who is answerable, so the
         * code travels with the name whenever the actor has one.
         */
        actorEmployeeCode: actor?.employeeCode ?? null,
        method: row.method ?? null,
        endpoint: row.endpoint ?? null,
        ipAddress: row.ipAddress ?? null,
        remarks: row.remarks ?? null,
        meta: redactMeta(row.meta),
        createdAt: row.createdAt,
      };
    }),
    total,
    page,
    pageSize,
  };
}

/**
 * The distinct actions present, for the filter dropdown.
 *
 * Capped: `action` is a free string and the collection is expected to be the
 * largest in the system, so an uncapped `distinct` would be a table scan on the
 * one screen most likely to be opened during an incident.
 */
export async function listAuditActions(limit = 200) {
  const rows = await AuditLog.aggregate([
    { $group: { _id: '$action', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: limit },
  ]);
  return rows.map((r) => r._id).filter(Boolean).sort();
}

export default { listAuditLogs, listAuditActions, redactMeta };
