/**
 * eNPS — the 0–10 pulse survey.
 *
 * Ported from the reference's `enps.service.ts`, whose header documents the
 * scoring this reproduces exactly:
 *
 *   score = promoters% − detractors%
 *   promoters   9-10
 *   passives    7-8
 *   detractors  0-6
 *
 * ---------------------------------------------------------------------------
 * An eNPS answer is ANONYMOUS, and the audit trail has to agree
 * ---------------------------------------------------------------------------
 * The respondent is recorded so a second answer can be refused, and for nothing
 * else: no read path joins a response to a person, and the results endpoint
 * returns band counts only.
 *
 * 🔴 The reference then audits `enps.respond` with the acting user attached,
 * against the survey id — so every "anonymous" answer is attributable by
 * anybody who can read the audit log, and the anonymity the survey promises is
 * not real. Here the response is a SYSTEM audit event with no actor: the trail
 * proves an answer arrived without saying whose it was.
 *
 * ---------------------------------------------------------------------------
 * Other deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. `closesAt` MUST BE IN THE FUTURE — enforced in the shared schema. The
 *    reference accepts a past date, so a survey can be launched already closed
 *    and can never be answered.
 *
 * 2. THE LIST IS PAGINATED (AD-13).
 *
 * 3. RESULTS CARRY THE BAND BOUNDARIES AND THE COMMENTS. The reference returns
 *    four numbers and drops the comments entirely — they are collected, stored,
 *    and never readable by anyone.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import { ENpsSurvey, ENpsResponse } from '../../../models/hrms/EngageModels.js';
import { recordAudit, recordSystemAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import {
  enpsBandFor,
  ENPS_PROMOTER_MIN,
  ENPS_PASSIVE_MIN,
  ENPS_QUESTION,
} from '../../../shared/constants/engage.js';
import { HrmsNotFoundError, HrmsConflictError, HrmsValidationError } from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const nameOf = (e) => `${e?.firstName ?? ''} ${e?.lastName ?? ''}`.trim() || 'Unknown';

/** Open means the closing time has not passed. A survey launches on creation. */
export function surveyIsOpen(row, now = new Date()) {
  return new Date(row.closesAt).getTime() > now.getTime();
}

const toDto = (row, extras = {}) => ({
  id: idStr(row._id),
  name: row.name,
  question: ENPS_QUESTION,
  launchedAt: row.launchedAt ? new Date(row.launchedAt).toISOString() : null,
  closesAt: row.closesAt ? new Date(row.closesAt).toISOString() : null,
  open: surveyIsOpen(row),
  createdByEmployeeId: idStr(row.createdByEmployeeId),
  createdByName: row.createdByName ?? null,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  responseCount: extras.responseCount ?? 0,
  hasResponded: extras.hasResponded ?? false,
});

/** Counts and the caller's own answered-state for a page — two queries. */
async function enrich(rows, actor) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r._id);
  const self = actor?.employeeId ? oid(actor.employeeId) : null;

  const [counts, mine] = await Promise.all([
    ENpsResponse.aggregate([
      { $match: { surveyId: { $in: ids } } },
      { $group: { _id: '$surveyId', n: { $sum: 1 } } },
    ]),
    self
      ? ENpsResponse.find({ surveyId: { $in: ids }, respondentEmployeeId: self })
          .select('surveyId')
          .lean()
      : [],
  ]);

  const bySurvey = new Map(counts.map((c) => [idStr(c._id), c.n]));
  const answered = new Set(mine.map((r) => idStr(r.surveyId)));

  return rows.map((r) =>
    toDto(r, {
      responseCount: bySurvey.get(idStr(r._id)) ?? 0,
      hasResponded: answered.has(idStr(r._id)),
    }),
  );
}

export async function listEnpsSurveys(query = {}, actor) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT } = query;

  const [rows, total] = await Promise.all([
    ENpsSurvey.find({})
      .sort({ launchedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    ENpsSurvey.countDocuments({}),
  ]);

  return { data: await enrich(rows, actor), total, page, pageSize };
}

export async function getEnpsSurvey(id, actor) {
  const row = await loadSurvey(id);
  return (await enrich([row], actor))[0];
}

export async function createEnpsSurvey(input, context = {}) {
  const actor = context.actor;

  const author = actor?.employeeId
    ? await Employee.findById(actor.employeeId).select('_id firstName lastName').lean()
    : null;

  const row = await ENpsSurvey.create({
    name: input.name,
    // Launched on creation, as the reference launches it.
    launchedAt: new Date(),
    closesAt: new Date(input.closesAt),
    createdByEmployeeId: actor?.employeeId ? oid(actor.employeeId) : null,
    createdByName: author ? nameOf(author) : null,
    createdByUserId: context.user?._id ?? null,
  });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ENPS_SURVEY_CREATED,
    `Launched the eNPS survey "${row.name}", closing ${new Date(input.closesAt).toISOString().slice(0, 10)}`,
    context.req,
    { meta: { surveyId: idStr(row._id), name: row.name, closesAt: input.closesAt } },
  );

  return (await enrich([row.toObject()], actor))[0];
}

export async function submitEnpsResponse(id, input, context = {}) {
  const actor = context.actor;
  if (!actor?.employeeId) {
    throw new HrmsValidationError('No employee context.', [
      { path: 'respondent', message: 'You need an employee record to answer a survey.' },
    ]);
  }

  const survey = await loadSurvey(id);
  if (!surveyIsOpen(survey)) {
    throw new HrmsConflictError('This survey has closed.', { code: 'ENPS_CLOSED' });
  }

  const existing = await ENpsResponse.findOne({
    surveyId: survey._id,
    respondentEmployeeId: oid(actor.employeeId),
  })
    .select('_id')
    .lean();
  if (existing) {
    throw new HrmsConflictError('You have already answered this survey.', {
      code: 'ENPS_ALREADY_ANSWERED',
    });
  }

  try {
    await ENpsResponse.create({
      surveyId: survey._id,
      respondentEmployeeId: oid(actor.employeeId),
      score: input.score,
      comment: input.comment ?? null,
      submittedAt: new Date(),
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError('You have already answered this survey.', {
        code: 'ENPS_ALREADY_ANSWERED',
      });
    }
    throw error;
  }

  /**
   * 🔴 NO ACTOR, and no score — see the header.
   *
   * The trail records that a response arrived for this survey. It does not
   * record who sent it, and it does not record what they said: an eNPS score
   * beside a name in an audit log is the whole thing the survey promises not
   * to do.
   */
  await recordSystemAudit(
    AUDIT_ACTIONS.ENPS_RESPONDED,
    `An anonymous response was recorded for the eNPS survey "${survey.name}"`,
    { surveyId: idStr(survey._id) },
  );

  return getEnpsSurvey(survey._id, actor);
}

/**
 * The score.
 *
 * `promoters% − detractors%`, rounded, and 0 with no responses — the
 * reference's formula exactly. The band boundaries travel with the result so a
 * legend cannot drift from the maths, and the comments are returned because
 * they are the part a pulse survey is actually read for (defect 3).
 */
export async function enpsResults(id) {
  const survey = await loadSurvey(id);

  const responses = await ENpsResponse.find({ surveyId: survey._id })
    .select('score comment submittedAt')
    .sort({ submittedAt: -1 })
    .lean();

  const total = responses.length;
  const bands = { promoters: 0, passives: 0, detractors: 0 };
  for (const r of responses) bands[enpsBandFor(r.score)] += 1;

  const score =
    total === 0 ? 0 : Math.round(((bands.promoters - bands.detractors) / total) * 100);

  return {
    surveyId: idStr(survey._id),
    surveyName: survey.name,
    open: surveyIsOpen(survey),
    score,
    ...bands,
    totalResponses: total,
    /** So a legend and the arithmetic cannot disagree. */
    bandBoundaries: { promoterMin: ENPS_PROMOTER_MIN, passiveMin: ENPS_PASSIVE_MIN },
    /**
     * Comments, with no respondent attached — the survey is anonymous and the
     * results endpoint is the only place they can be read. The reference
     * collects them and shows them to nobody.
     */
    comments: responses
      .filter((r) => r.comment)
      .map((r) => ({ comment: r.comment, score: r.score })),
  };
}

// ---------------------------------------------------------------------------

export async function loadSurvey(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('eNPS survey');
  const row = await ENpsSurvey.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('eNPS survey');
  return row;
}

export { toDto as enpsSurveyDto };

export default {
  listEnpsSurveys,
  getEnpsSurvey,
  createEnpsSurvey,
  submitEnpsResponse,
  enpsResults,
  surveyIsOpen,
};
