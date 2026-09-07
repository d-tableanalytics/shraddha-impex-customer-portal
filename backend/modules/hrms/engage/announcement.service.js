/**
 * Announcements — the company news feed.
 *
 * Ported from the reference's `announcement.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. TARGETING IS APPLIED IN THE QUERY. 🔴 The reference fetches the newest 100
 *    announcements and THEN filters them in memory with `canSee`. A burst of
 *    announcements aimed at other departments therefore pushes the ones
 *    actually addressed to a reader off their feed entirely — they are inside
 *    the 100 that were fetched, or they are gone. Here the visibility rule is
 *    part of the `find`, so a reader's page is drawn from announcements
 *    addressed to them.
 *
 * 2. THE LIST IS PAGINATED (AD-13).
 *
 * 3. DELETE CHECKS EXISTENCE. The reference calls `delete` on an unchecked id,
 *    so removing an already-removed announcement throws a Prisma error instead
 *    of a 404.
 *
 * 4. `mediaKeys` IS GONE — see the model's note. The reference declares it,
 *    returns it, and never writes it.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import User from '../../../models/User.js';
import { Announcement } from '../../../models/hrms/EngageModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { notify } from '../inbox/notifier.service.js';
import { INBOX_TYPES } from '../../../shared/constants/inbox.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import { hasHrmsPermission } from '../../../shared/permissions/has-permission.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import { resolveDepartment } from '../references/reference.service.js';
import { HrmsNotFoundError, HrmsValidationError } from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const nameOf = (e) => `${e?.firstName ?? ''} ${e?.lastName ?? ''}`.trim() || 'Unknown';

/**
 * The announcement's state, DERIVED from its timestamps.
 *
 * The reference derives the same thing on the client, in the draft/published
 * split its list renders. Deriving it here means one definition rather than one
 * per screen, and no stored column that can disagree with the dates beside it.
 */
export function announcementState(row, now = new Date()) {
  if (!row.publishedAt) return 'draft';
  if (row.expiresAt && new Date(row.expiresAt).getTime() < now.getTime()) return 'expired';
  return 'published';
}

const toDto = (row, extras = {}) => ({
  id: idStr(row._id),
  title: row.title,
  body: row.body,
  state: announcementState(row),
  publishedAt: row.publishedAt ? new Date(row.publishedAt).toISOString() : null,
  expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
  targetRoleKeys: row.targetRoleKeys ?? [],
  targetDepartmentIds: (row.targetDepartmentIds ?? []).map(idStr),
  targetDepartmentNames: extras.targetDepartmentNames ?? [],
  /** Empty on both means everybody, which is the reference's rule. */
  orgWide:
    (row.targetRoleKeys ?? []).length === 0 && (row.targetDepartmentIds ?? []).length === 0,
  createdByEmployeeId: idStr(row.createdByEmployeeId),
  createdByName: row.createdByName ?? null,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

/** Department labels for a page of announcements — one query, not one per row. */
async function enrich(rows) {
  if (rows.length === 0) return [];

  const ids = [
    ...new Set(rows.flatMap((r) => (r.targetDepartmentIds ?? []).map(idStr)).filter(Boolean)),
  ];
  const names = new Map(
    await Promise.all(
      ids.map(async (id) => [id, (await resolveDepartment(id).catch(() => null))?.name ?? null]),
    ),
  );

  return rows.map((r) =>
    toDto(r, {
      targetDepartmentNames: (r.targetDepartmentIds ?? [])
        .map((d) => names.get(idStr(d)))
        .filter(Boolean),
    }),
  );
}

/**
 * What this reader may see.
 *
 * HR sees everything, drafts included — that is what the reference's list does
 * and what its Drafts section renders. Everybody else sees announcements that
 * are published, not expired, and either untargeted or aimed at one of their
 * roles or their department.
 *
 * 🔴 Built as a QUERY rather than an in-memory filter — see note 1.
 */
function visibilityFilter(actor) {
  if (hasHrmsPermission(actor, M.ENGAGE, A.EDIT, S.ORG)) return {};

  const roleKeys = actor?.roleKeys ?? [];
  const departmentId = actor?.departmentId ? oid(actor.departmentId) : null;

  return {
    publishedAt: { $ne: null },
    $and: [
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
      {
        $or: [
          // Untargeted — everybody.
          { targetRoleKeys: { $size: 0 }, targetDepartmentIds: { $size: 0 } },
          ...(roleKeys.length ? [{ targetRoleKeys: { $in: roleKeys } }] : []),
          ...(departmentId ? [{ targetDepartmentIds: departmentId }] : []),
        ],
      },
    ],
  };
}

export async function listAnnouncements(query = {}, actor) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, state } = query;
  const isHr = hasHrmsPermission(actor, M.ENGAGE, A.EDIT, S.ORG);

  const now = new Date();
  const stateFilter =
    !state || !isHr
      ? {}
      : state === 'draft'
        ? { publishedAt: null }
        : state === 'expired'
          ? { publishedAt: { $ne: null }, expiresAt: { $ne: null, $lt: now } }
          : {
              publishedAt: { $ne: null },
              $or: [{ expiresAt: null }, { expiresAt: { $gte: now } }],
            };

  const filter = { ...visibilityFilter(actor), ...stateFilter };

  const [rows, total] = await Promise.all([
    Announcement.find(filter)
      // Newest published first, then newest drafted — the reference's ordering.
      .sort({ publishedAt: -1, createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Announcement.countDocuments(filter),
  ]);

  return { data: await enrich(rows), total, page, pageSize };
}

/** One announcement, read through the SAME filter the list uses. */
export async function getAnnouncement(id, actor) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Announcement');
  const row = await Announcement.findOne({ _id: id, ...visibilityFilter(actor) }).lean();
  // A 404 rather than a 403: whether an announcement addressed to somebody else
  // exists is not this reader's business.
  if (!row) throw new HrmsNotFoundError('Announcement');
  return (await enrich([row]))[0];
}

export async function createAnnouncement(input, context = {}) {
  const actor = context.actor;

  if (input.targetDepartmentIds?.length) {
    await assertDepartments(input.targetDepartmentIds);
  }

  const author = actor?.employeeId
    ? await Employee.findById(actor.employeeId).select('_id firstName lastName').lean()
    : null;

  const row = await Announcement.create({
    title: input.title,
    body: input.body,
    publishedAt: input.publishNow ? new Date() : null,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    targetRoleKeys: input.targetRoleKeys ?? [],
    targetDepartmentIds: (input.targetDepartmentIds ?? []).map(oid),
    createdByEmployeeId: actor?.employeeId ? oid(actor.employeeId) : null,
    createdByName: author ? nameOf(author) : null,
    createdByUserId: context.user?._id ?? null,
  });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ANNOUNCEMENT_CREATED,
    `Created the announcement "${row.title}"${input.publishNow ? ' and published it' : ' as a draft'}`,
    context.req,
    {
      meta: {
        announcementId: idStr(row._id),
        published: Boolean(input.publishNow),
        targetRoleKeys: input.targetRoleKeys ?? [],
        targetDepartmentIds: input.targetDepartmentIds ?? [],
      },
    },
  );

  if (input.publishNow) await auditPublish(row, context);

  return (await enrich([row.toObject()]))[0];
}

/**
 * Publish a draft.
 *
 * The reference returns the row unchanged if it is already published; that is
 * kept — publishing twice is a no-op rather than an error, because the button
 * disappearing is a race a second click will lose harmlessly.
 */
export async function publishAnnouncement(id, context = {}) {
  const existing = await loadAnnouncement(id);
  if (existing.publishedAt) return (await enrich([existing]))[0];

  const updated = await Announcement.findOneAndUpdate(
    { _id: existing._id, publishedAt: null },
    { $set: { publishedAt: new Date() } },
    { new: true },
  );
  // Somebody published it between the read and the write. Still a no-op.
  if (!updated) return (await enrich([await loadAnnouncement(id)]))[0];

  await auditPublish(updated, context);
  return (await enrich([updated.toObject()]))[0];
}

/**
 * Publish: fan an inbox item out to the audience, and audit the act.
 *
 * Inbox now exists, so the reference's fan-out is real — but as ONE
 * `insertMany` per chunk rather than a loop of single INSERTs inside the
 * publishing transaction, which is what the reference does. An org-wide
 * announcement to 5,000 people is 5,000 round trips there.
 *
 * The audience is computed from the announcement's OWN targeting, by the same
 * rule the feed's visibility filter uses — so a notification cannot reach
 * somebody the feed would have hidden the announcement from.
 */
async function auditPublish(row, context) {
  const orgWide =
    (row.targetRoleKeys ?? []).length === 0 && (row.targetDepartmentIds ?? []).length === 0;

  await notify({
    to: await audienceFor(row),
    type: INBOX_TYPES.ANNOUNCEMENT_PUBLISHED,
    title: row.title,
    // The first line of the announcement, not the whole thing — the feed is
    // where it is read. The reference sends no body at all here.
    body: (row.body ?? '').slice(0, 140) || null,
    entity: 'announcement',
    entityId: idStr(row._id),
  });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ANNOUNCEMENT_PUBLISHED,
    `Published "${row.title}" to ${orgWide ? 'the whole company' : 'a targeted audience'}`,
    context.req,
    {
      meta: {
        announcementId: idStr(row._id),
        orgWide,
        targetRoleKeys: row.targetRoleKeys ?? [],
        targetDepartmentIds: (row.targetDepartmentIds ?? []).map(idStr),
      },
    },
  );
}

/**
 * Everyone this announcement is addressed to, as employee ids.
 *
 * Untargeted means everybody live. Targeted means the union of the named
 * departments and the named roles — the same `$or` the feed's visibility filter
 * applies, so the two cannot disagree about who the audience is.
 */
async function audienceFor(row) {
  const departmentIds = row.targetDepartmentIds ?? [];
  const roleKeys = row.targetRoleKeys ?? [];

  if (departmentIds.length === 0 && roleKeys.length === 0) {
    const everyone = await Employee.find({ deletedAt: null, status: { $nin: ['exited', 'inactive'] } })
      .select('_id')
      .lean();
    return everyone.map((e) => idStr(e._id));
  }

  const byDepartment = departmentIds.length
    ? await Employee.find({
        deletedAt: null,
        status: { $nin: ['exited', 'inactive'] },
        departmentId: { $in: departmentIds },
      })
        .select('_id')
        .lean()
    : [];

  // Roles live on the User account, so a role-targeted announcement resolves
  // through it — the one place this module has to cross that line.
  const byRole = roleKeys.length
    ? await Employee.find({
        deletedAt: null,
        status: { $nin: ['exited', 'inactive'] },
        userId: {
          $in: (await User.find({ roles: { $in: roleKeys } }).select('_id').lean()).map((u) => u._id),
        },
      })
        .select('_id')
        .lean()
    : [];

  // `notify` de-duplicates, so somebody matching both targets is told once.
  return [...byDepartment, ...byRole].map((e) => idStr(e._id));
}

export async function deleteAnnouncement(id, context = {}) {
  // 🔴 The reference deletes an unchecked id — see note 3.
  const existing = await loadAnnouncement(id);

  await Announcement.deleteOne({ _id: existing._id });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ANNOUNCEMENT_DELETED,
    `Deleted the announcement "${existing.title}"`,
    context.req,
    { meta: { announcementId: idStr(existing._id), title: existing.title } },
  );
}

// ---------------------------------------------------------------------------

async function assertDepartments(ids) {
  for (const id of ids) {
    const department = await resolveDepartment(id).catch(() => null);
    if (!department) {
      throw new HrmsValidationError('Unknown department.', [
        { path: 'targetDepartmentIds', message: 'One of those departments does not exist.' },
      ]);
    }
  }
}

export async function loadAnnouncement(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Announcement');
  const row = await Announcement.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('Announcement');
  return row;
}

export { toDto as announcementDto, visibilityFilter, idStr, oid, nameOf };

export default {
  listAnnouncements,
  getAnnouncement,
  createAnnouncement,
  publishAnnouncement,
  deleteAnnouncement,
  announcementState,
};
