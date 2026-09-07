/**
 * The public careers page.
 *
 * Ported from the reference's `public-careers.controller.ts` and the public
 * half of its `job-posting.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * Everything here is reachable WITHOUT authentication
 * ---------------------------------------------------------------------------
 * So everything here is written on the assumption that the caller is hostile:
 *
 *   - only PUBLISHED, UNCLOSED postings are visible, and only the fields an
 *     advert needs. The reference's public list returns the requisition's
 *     department and location, which is fine; it does NOT leak headcount,
 *     budget or the business justification, and neither does this
 *   - an applicant cannot set `source` (which would let them claim to be a
 *     referral) or any recruiter-owned field
 *   - a duplicate application is reported as success. Telling an anonymous
 *     caller "you have already applied" turns the endpoint into an oracle for
 *     who has applied where
 *   - the slug is the only identifier exposed, and it carries a random suffix
 *     so the set of open roles cannot be enumerated by guessing titles
 */

import { JobPosting, JobRequisition, Application } from '../../../models/hrms/HiringModels.js';
import { recordSystemAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';
import { TERMINAL_REQUISITION_STATUSES } from '../../../shared/constants/hiring.js';
import { upsertCandidateByEmail } from './candidate.service.js';
import { resolveDepartment, resolveLocation } from '../references/reference.service.js';
import { HrmsNotFoundError } from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));

/** Only a live posting on a requisition that is still hiring. */
const LIVE_POSTING = { deletedAt: null, publishedAt: { $ne: null }, closedAt: null };

/**
 * The advert, and nothing else.
 *
 * Explicitly constructed rather than spread from the row: a spread is how an
 * internal field ends up on a public page the first time somebody adds one.
 */
const publicPostingDto = (posting, requisition, names) => ({
  slug: posting.publicSlug,
  title: requisition?.title ?? null,
  departmentName: names?.get(idStr(requisition?.departmentId)) ?? null,
  locationName: names?.get(idStr(requisition?.locationId)) ?? null,
  description: posting.description,
  requirements: posting.requirements,
  publishedAt: posting.publishedAt ? new Date(posting.publishedAt).toISOString() : null,
});

/** Resolve department and location names for a set of requisitions. */
async function nameLookup(requisitions) {
  const names = new Map();
  const ids = [
    ...new Set(
      requisitions.flatMap((r) => [idStr(r.departmentId), idStr(r.locationId)]).filter(Boolean),
    ),
  ];
  await Promise.all(
    ids.map(async (id) => {
      const dept = await resolveDepartment(id).catch(() => null);
      if (dept) return names.set(id, dept.name);
      const loc = await resolveLocation(id).catch(() => null);
      if (loc) names.set(id, loc.name);
    }),
  );
  return names;
}

export async function listOpenRoles() {
  const postings = await JobPosting.find(LIVE_POSTING).sort({ publishedAt: -1 }).limit(200).lean();
  if (postings.length === 0) return [];

  const requisitions = await JobRequisition.find({
    _id: { $in: [...new Set(postings.map((p) => idStr(p.requisitionId)))] },
    deletedAt: null,
    // A filled or cancelled requisition must not advertise, even if somebody
    // forgot to close its posting.
    status: { $nin: TERMINAL_REQUISITION_STATUSES },
  }).lean();

  const byId = new Map(requisitions.map((r) => [idStr(r._id), r]));
  const names = await nameLookup(requisitions);

  return postings
    .filter((p) => byId.has(idStr(p.requisitionId)))
    .map((p) => publicPostingDto(p, byId.get(idStr(p.requisitionId)), names));
}

export async function getOpenRole(slug) {
  const posting = await JobPosting.findOne({ ...LIVE_POSTING, publicSlug: slug }).lean();
  // A 404 either way — an unpublished posting must be indistinguishable from
  // one that does not exist, or the endpoint reports what is in the pipeline.
  if (!posting) throw new HrmsNotFoundError('Role');

  const requisition = await JobRequisition.findOne({
    _id: posting.requisitionId,
    deletedAt: null,
    status: { $nin: TERMINAL_REQUISITION_STATUSES },
  }).lean();
  if (!requisition) throw new HrmsNotFoundError('Role');

  const names = await nameLookup([requisition]);
  return publicPostingDto(posting, requisition, names);
}

/**
 * Apply from the careers page.
 *
 * Creates or reuses the candidate by email, then opens an application. A
 * repeat application is reported as success — see the header.
 */
export async function applyToRole(slug, input, meta = {}) {
  const posting = await JobPosting.findOne({ ...LIVE_POSTING, publicSlug: slug }).lean();
  if (!posting) throw new HrmsNotFoundError('Role');

  const requisition = await JobRequisition.findOne({
    _id: posting.requisitionId,
    deletedAt: null,
    status: { $nin: TERMINAL_REQUISITION_STATUSES },
  })
    .select('_id title')
    .lean();
  if (!requisition) throw new HrmsNotFoundError('Role');

  const candidate = await upsertCandidateByEmail(input);

  let created = false;
  try {
    await Application.create({
      candidateId: candidate._id,
      requisitionId: requisition._id,
      stage: 'applied',
      appliedAt: new Date(),
      currentStageAt: new Date(),
      stageHistory: [{ stage: 'applied', at: new Date(), byUserId: null, note: 'Applied via careers page' }],
    });
    created = true;
  } catch (error) {
    // The unique (candidateId, requisitionId) index refused a repeat. Not an
    // error the applicant should see — see the header.
    if (error?.code !== 11000) throw error;
  }

  await recordSystemAudit(
    AUDIT_ACTIONS.PUBLIC_APPLICATION_RECEIVED,
    created
      ? `A careers-page application was received for "${requisition.title}"`
      : `A repeat careers-page application for "${requisition.title}" was ignored`,
    {
      requisitionId: idStr(requisition._id),
      candidateId: idStr(candidate._id),
      slug,
      duplicate: !created,
      ip: meta.ip ?? null,
    },
  );

  // The same body either way. Nothing here confirms whether the person was
  // already in the pipeline.
  return { received: true, role: requisition.title };
}

export default { listOpenRoles, getOpenRole, applyToRole };
