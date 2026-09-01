/**
 * Authorized access to stored HRMS objects (AD-7).
 *
 * A stored object is only ever reachable through this service, which:
 *   1. resolves who the object belongs to
 *   2. checks the caller's permission against that owner
 *   3. writes an audit entry - issuing the URL is the auditable act
 *   4. returns a SHORT-LIVED presigned URL
 *
 * The reference system serves attendance selfies from a `@Public()` route keyed
 * by filename: an unauthenticated, guessable endpoint returning employee
 * photographs. That is not replicated. Everything here is authenticated,
 * authorised and time-boxed.
 */

import { getReadUrl, ttlFor } from '../../../utils/hrms/storage/index.js';
import { hasHrmsPermission } from '../../../shared/permissions/has-permission.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, STORAGE_CATEGORY_LIST } from '../../../shared/constants/hrms.js';

/**
 * Per-category access rules, registered by the module that owns the category.
 *
 * Phase 0 ships the mechanism with no categories registered - the modules that
 * store files arrive in later phases. An unregistered category is REFUSED, so
 * adding a new kind of stored file cannot accidentally inherit open access.
 *
 * @type {Map<string, {
 *   resolve: (key: string, req: object) => Promise<{ owner?: object, permissions: Array } | null>,
 *   auditAction?: string,
 * }>}
 */
const accessRules = new Map();

/**
 * Declare how objects in a category are authorised.
 *
 * @param {string} category
 * @param {object} rule
 * @param {Function} rule.resolve  given the object key, return
 *   `{ owner, permissions }` where `owner` is a ResourceContext and
 *   `permissions` is the ANY-OF spec list. Return null if the key is unknown.
 * @param {string} [rule.auditAction]  defaults to FILE_URL_ISSUED; the
 *   attendance module passes SELFIE_VIEWED so a photograph read is
 *   distinguishable from an ordinary document read.
 */
export function registerFileAccessRule(category, rule) {
  if (!STORAGE_CATEGORY_LIST.includes(category)) {
    throw new Error(`registerFileAccessRule: unknown category "${category}"`);
  }
  if (typeof rule?.resolve !== 'function') {
    throw new TypeError('registerFileAccessRule: rule.resolve must be a function');
  }
  accessRules.set(category, rule);
}

/** Test seam. */
export function __resetFileAccessRules() {
  accessRules.clear();
}

export const registeredFileCategories = () => [...accessRules.keys()];

export class FileAccessError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'FileAccessError';
    this.statusCode = statusCode;
  }
}

/**
 * Authorise and issue a presigned read URL.
 *
 * @param {object} params
 * @param {string} params.category
 * @param {string} params.key
 * @param {object} params.actor  the HRMS actor
 * @param {object} params.req    for the audit entry
 * @returns {Promise<{ url: string, expiresInSeconds: number }>}
 */
export async function issueReadUrl({ category, key, actor, req }) {
  const rule = accessRules.get(category);
  if (!rule) {
    // Fail closed: a category nobody has declared rules for is not readable.
    throw new FileAccessError(`No access rule is registered for "${category}".`, 403);
  }

  const resolved = await rule.resolve(key, req);
  if (!resolved) {
    throw new FileAccessError('File not found.', 404);
  }

  const allowed = (resolved.permissions ?? []).some((spec) =>
    hasHrmsPermission(actor, spec.module, spec.action, spec.scope, resolved.owner),
  );
  if (!allowed) {
    throw new FileAccessError('Forbidden. You may not read this file.', 403);
  }

  const expiresInSeconds = ttlFor(category);
  const url = await getReadUrl(key, { category, ttlSeconds: expiresInSeconds });

  // The audit entry records the ISSUANCE. Viewing someone's payslip or
  // photograph is the sensitive act, not storing it, and a presigned URL is
  // usable for its whole lifetime - so this is the only point at which the
  // access can be recorded at all.
  await recordAudit(
    { _id: actor.userId },
    rule.auditAction ?? AUDIT_ACTIONS.FILE_URL_ISSUED,
    `Issued a ${expiresInSeconds}s read URL for ${category}`,
    req,
    { meta: { category, key, ownerEmployeeId: resolved.owner?.ownerEmployeeId ?? null } },
  );

  return { url, expiresInSeconds };
}

export default { registerFileAccessRule, issueReadUrl, registeredFileCategories };
