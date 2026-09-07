/**
 * Interviews and panel feedback.
 *
 * Ported from the reference's `interview.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * What changes, and why
 * ---------------------------------------------------------------------------
 * 1. "MY INTERVIEWS" IS AN INDEXED QUERY. The reference loads EVERY interview
 *    in the organisation and filters the panel in JavaScript
 *    (`interview.service.ts:59-77`). That is a full scan on every panelist's
 *    dashboard, and it pulls every candidate's name into memory to show one
 *    person their own three interviews.
 *
 * 2. THE STATUS MACHINE IS ENFORCED. `setStatus` writes anything, so a
 *    cancelled interview can be revived to `scheduled` and feedback then
 *    attaches to a session that never happened.
 *
 * 3. FEEDBACK IS PANELIST-ONLY, FULL STOP. The reference lets anyone holding
 *    `hiring:edit:org` submit feedback *as themselves* on an interview they
 *    were not on — a recruiter can file a hire recommendation for a panel they
 *    never sat. Reading the aggregate is the recruiter's job; writing a review
 *    is the interviewer's.
 *
 * 4. THE PANEL IS EMPLOYEES. The reference stores user ids and reads
 *    `User.displayName`. Here the canonical person is the Employee (AD-4), and
 *    a soft-deleted one cannot be put on a panel.
 */

import mongoose from 'mongoose';

import {
  Interview,
  InterviewFeedback,
  Application,
  Candidate,
  JobRequisition,
} from '../../../models/hrms/HiringModels.js';
import Employee from '../../../models/hrms/Employee.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { notify } from '../inbox/notifier.service.js';
import { INBOX_TYPES } from '../../../shared/constants/inbox.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import {
  INTERVIEW_TRANSITIONS,
  CLOSED_APPLICATION_STAGES,
} from '../../../shared/constants/hiring.js';
import { advanceTo } from './application.service.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsValidationError,
  HrmsForbiddenError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const toDto = (row, extras = {}) => ({
  id: idStr(row._id),
  applicationId: idStr(row.applicationId),
  candidateName: extras.candidateName ?? null,
  requisitionTitle: extras.requisitionTitle ?? null,
  round: row.round,
  panel: (row.panel ?? []).map((p) => ({
    employeeId: idStr(p.employeeId),
    name: p.name,
  })),
  scheduledAt: row.scheduledAt ? new Date(row.scheduledAt).toISOString() : null,
  durationMinutes: row.durationMinutes,
  meetingLink: row.meetingLink ?? null,
  status: row.status,
  feedbackCount: extras.feedbackCount ?? 0,
  /** Whether the CALLER still owes a review. Drives the panelist's own list. */
  awaitingMyFeedback: extras.awaitingMyFeedback ?? false,
});

/** Candidate, requisition title and feedback counts for a page of interviews. */
async function enrich(rows, actorEmployeeId = null) {
  if (rows.length === 0) return [];

  const applications = await Application.find({
    _id: { $in: [...new Set(rows.map((r) => idStr(r.applicationId)))] },
  })
    .select('candidateId requisitionId')
    .lean();

  const [candidates, requisitions, feedbackCounts, mine] = await Promise.all([
    Candidate.find({ _id: { $in: applications.map((a) => a.candidateId) } })
      .select('name')
      .lean(),
    JobRequisition.find({ _id: { $in: applications.map((a) => a.requisitionId) } })
      .select('title')
      .lean(),
    InterviewFeedback.aggregate([
      { $match: { interviewId: { $in: rows.map((r) => r._id) } } },
      { $group: { _id: '$interviewId', n: { $sum: 1 } } },
    ]),
    actorEmployeeId
      ? InterviewFeedback.find({
          interviewId: { $in: rows.map((r) => r._id) },
          interviewerEmployeeId: oid(actorEmployeeId),
        })
          .select('interviewId')
          .lean()
      : Promise.resolve([]),
  ]);

  const applicationById = new Map(applications.map((a) => [idStr(a._id), a]));
  const candidateName = new Map(candidates.map((c) => [idStr(c._id), c.name]));
  const requisitionTitle = new Map(requisitions.map((r) => [idStr(r._id), r.title]));
  const counts = new Map(feedbackCounts.map((f) => [idStr(f._id), f.n]));
  const alreadyReviewed = new Set(mine.map((f) => idStr(f.interviewId)));

  return rows.map((row) => {
    const application = applicationById.get(idStr(row.applicationId));
    const onPanel =
      actorEmployeeId &&
      (row.panel ?? []).some((p) => idStr(p.employeeId) === idStr(actorEmployeeId));
    return toDto(row, {
      candidateName: application ? candidateName.get(idStr(application.candidateId)) ?? null : null,
      requisitionTitle: application
        ? requisitionTitle.get(idStr(application.requisitionId)) ?? null
        : null,
      feedbackCount: counts.get(idStr(row._id)) ?? 0,
      awaitingMyFeedback:
        Boolean(onPanel) && row.status === 'scheduled' && !alreadyReviewed.has(idStr(row._id)),
    });
  });
}

export async function listInterviews(query = {}, actorEmployeeId = null) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, applicationId, status } = query;

  const filter = {
    ...(applicationId ? { applicationId: oid(applicationId) } : {}),
    ...(status ? { status } : {}),
  };

  const [rows, total] = await Promise.all([
    Interview.find(filter)
      .sort({ scheduledAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Interview.countDocuments(filter),
  ]);

  return { data: await enrich(rows, actorEmployeeId), total, page, pageSize };
}

/**
 * The caller's own interviews.
 *
 * An indexed query on `panel.employeeId` — see note 1 in the header. Every
 * authenticated employee may call this; it is scoped to them by construction,
 * so there is no id to tamper with and no permission beyond having an employee
 * record.
 */
export async function listMyInterviews(actorEmployeeId, query = {}) {
  if (!actorEmployeeId) return { data: [], total: 0, page: 1, pageSize: PAGE_SIZE_DEFAULT };

  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, status } = query;
  const filter = {
    'panel.employeeId': oid(actorEmployeeId),
    ...(status ? { status } : {}),
  };

  const [rows, total] = await Promise.all([
    Interview.find(filter)
      .sort({ scheduledAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Interview.countDocuments(filter),
  ]);

  return { data: await enrich(rows, actorEmployeeId), total, page, pageSize };
}

export async function scheduleInterview(input, context = {}) {
  const application = await Application.findById(input.applicationId).lean();
  if (!application) {
    throw new HrmsValidationError('Unknown application.', [
      { path: 'applicationId', message: 'That application does not exist.' },
    ]);
  }
  if (CLOSED_APPLICATION_STAGES.includes(application.stage)) {
    throw new HrmsConflictError(
      `This application is ${application.stage}; no further interviews can be scheduled.`,
      { code: 'APPLICATION_CLOSED' },
    );
  }

  // An interview in the past cannot be attended. The reference accepts one.
  if (new Date(input.scheduledAt).getTime() < Date.now()) {
    throw new HrmsValidationError('An interview cannot be scheduled in the past.', [
      { path: 'scheduledAt', message: 'Choose a future date and time.' },
    ]);
  }

  const panellists = await Employee.find({
    _id: { $in: input.panelEmployeeIds },
    deletedAt: null,
  })
    .select('_id userId firstName lastName status')
    .lean();

  if (panellists.length !== new Set(input.panelEmployeeIds.map(String)).size) {
    throw new HrmsValidationError('One or more panellists do not exist.', [
      { path: 'panelEmployeeIds', message: 'Every panellist must be a current employee.' },
    ]);
  }

  // A duplicate round for the same application is almost always a double
  // submit; the reference allows unlimited identical rounds.
  const clash = await Interview.findOne({
    applicationId: oid(input.applicationId),
    round: input.round,
    status: { $in: ['scheduled', 'completed'] },
  })
    .select('_id')
    .lean();
  if (clash) {
    throw new HrmsConflictError(
      `Round ${input.round} is already scheduled for this application.`,
      { code: 'INTERVIEW_ROUND_EXISTS' },
    );
  }

  const row = await Interview.create({
    applicationId: oid(input.applicationId),
    round: input.round,
    panel: panellists.map((e) => ({
      employeeId: e._id,
      userId: e.userId ?? null,
      name: `${e.firstName ?? ''} ${e.lastName ?? ''}`.trim(),
    })),
    scheduledAt: new Date(input.scheduledAt),
    durationMinutes: input.durationMinutes,
    meetingLink: input.meetingLink ?? null,
    status: 'scheduled',
    createdByUserId: context.user?._id ?? null,
  });

  // Scheduling advances the pipeline, as in the reference — but only forwards.
  await advanceTo(input.applicationId, 'interview', context);

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.INTERVIEW_SCHEDULED,
    `Scheduled round ${input.round} with ${panellists.length} panellist(s)`,
    context.req,
    {
      meta: {
        interviewId: idStr(row._id),
        applicationId: idStr(input.applicationId),
        round: input.round,
        panel: panellists.map((e) => idStr(e._id)),
        scheduledAt: input.scheduledAt,
      },
    },
  );

  /**
   * The reference's panel notification — one item per panellist, addressed to
   * the panel resolved and validated above.
   *
   * The candidate's NAME is deliberately not in the body: a panellist opens the
   * interview and sees it there, and an interview notification that names the
   * candidate turns every recipient's inbox into a partial hiring pipeline.
   */
  await notify({
    to: panellists.map((e) => idStr(e._id)),
    type: INBOX_TYPES.INTERVIEW_SCHEDULED,
    title: `Interview scheduled — round ${input.round}`,
    body: `You are on the panel. ${input.durationMinutes} minutes.`,
    entity: 'interview',
    entityId: idStr(row._id),
  });

  return (await enrich([row.toObject()], context.actorEmployeeId))[0];
}

export async function setInterviewStatus(id, input, context = {}) {
  const interview = await loadInterview(id);

  const allowed = INTERVIEW_TRANSITIONS[interview.status] ?? [];
  if (!allowed.includes(input.status)) {
    throw new HrmsConflictError(
      allowed.length === 0
        ? `This interview is ${interview.status} and is final.`
        : `A ${interview.status} interview can only become: ${allowed.join(', ')}.`,
      { code: 'INTERVIEW_INVALID_TRANSITION' },
    );
  }

  const updated = await Interview.findOneAndUpdate(
    { _id: id, status: interview.status },
    { $set: { status: input.status } },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('This interview changed before your update was saved.', {
      code: 'INTERVIEW_INVALID_TRANSITION',
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.INTERVIEW_STATUS_CHANGED,
    `Interview moved from ${interview.status} to ${input.status}`,
    context.req,
    { meta: { interviewId: idStr(id), from: interview.status, to: input.status } },
  );

  return (await enrich([updated.toObject()], context.actorEmployeeId))[0];
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

const feedbackDto = (row, name = null) => ({
  id: idStr(row._id),
  interviewId: idStr(row.interviewId),
  interviewerEmployeeId: idStr(row.interviewerEmployeeId),
  interviewerName: name,
  ratings: row.ratings ?? {},
  comments: row.comments ?? null,
  decision: row.decision,
  submittedAt: row.submittedAt ? new Date(row.submittedAt).toISOString() : null,
});

export async function listFeedback(interviewId) {
  const interview = await loadInterview(interviewId);
  const rows = await InterviewFeedback.find({ interviewId: oid(interviewId) })
    .sort({ submittedAt: -1 })
    .lean();

  // The panel already carries every name, so the display name needs no join.
  const names = new Map((interview.panel ?? []).map((p) => [idStr(p.employeeId), p.name]));
  return rows.map((r) => feedbackDto(r, names.get(idStr(r.interviewerEmployeeId)) ?? null));
}

/**
 * Submit a review.
 *
 * 🔴 PANELISTS ONLY. The reference lets anyone with `hiring:edit:org` file
 * feedback under their own name on an interview they never attended. Reading
 * the aggregate is a recruiter's job; writing a hire recommendation belongs to
 * the person who sat in the room.
 *
 * The interviewer is the AUTHENTICATED actor, never a body field, and the
 * unique index is what actually stops a double vote under a double submit.
 */
export async function submitFeedback(interviewId, input, actorEmployeeId, context = {}) {
  const interview = await loadInterview(interviewId);

  if (!actorEmployeeId) {
    throw new HrmsForbiddenError('Your account has no employee record.');
  }

  const onPanel = (interview.panel ?? []).some(
    (p) => idStr(p.employeeId) === idStr(actorEmployeeId),
  );
  if (!onPanel) {
    throw new HrmsForbiddenError('Only a panellist on this interview may submit feedback.');
  }

  // Feedback on a cancelled interview would attach a review to a session that
  // did not happen.
  if (interview.status === 'cancelled') {
    throw new HrmsConflictError('This interview was cancelled; feedback cannot be submitted.', {
      code: 'INTERVIEW_CANCELLED',
    });
  }

  try {
    const row = await InterviewFeedback.create({
      interviewId: oid(interviewId),
      interviewerEmployeeId: oid(actorEmployeeId),
      interviewerUserId: context.user?._id ?? null,
      ratings: input.ratings,
      comments: input.comments ?? null,
      decision: input.decision,
      submittedAt: new Date(),
    });

    await recordAudit(
      context.user,
      AUDIT_ACTIONS.INTERVIEW_FEEDBACK_SUBMITTED,
      `Submitted interview feedback: ${input.decision}`,
      context.req,
      {
        meta: {
          feedbackId: idStr(row._id),
          interviewId: idStr(interviewId),
          decision: input.decision,
          // The decision and who made it, not the free-text comments — those
          // are on the row and do not need duplicating into the audit trail.
          criteria: Object.keys(input.ratings ?? {}),
        },
      },
    );

    const name = (interview.panel ?? []).find(
      (p) => idStr(p.employeeId) === idStr(actorEmployeeId),
    )?.name;
    return feedbackDto(row.toObject(), name ?? null);
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError('You have already submitted feedback for this interview.', {
        code: 'FEEDBACK_ALREADY_SUBMITTED',
      });
    }
    throw error;
  }
}

async function loadInterview(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Interview');
  const row = await Interview.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('Interview');
  return row;
}

export { loadInterview };

export default {
  listInterviews,
  listMyInterviews,
  scheduleInterview,
  setInterviewStatus,
  listFeedback,
  submitFeedback,
};
