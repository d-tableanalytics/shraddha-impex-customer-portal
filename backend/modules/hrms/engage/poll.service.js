/**
 * Polls — HR launches, everybody answers once.
 *
 * Ported from the reference's `poll.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * Anonymity is a PRESENTATION and AUDIT rule, not a storage one
 * ---------------------------------------------------------------------------
 * The respondent is always recorded, because a second response has to be
 * refusable. What changes for an anonymous poll is the AUDIT TRAIL.
 *
 * 🔴 The reference audits `poll.respond` with the acting user attached, on
 * every poll including anonymous ones. Its own service header claims responses
 * are "scrubbed from result endpoints" — true, and beside the point: the audit
 * log names the respondent and the poll, so an "anonymous" answer is
 * attributable by anybody who can read the trail. Here an anonymous poll's
 * response is recorded as a SYSTEM event with no actor: the trail still proves
 * a response happened and when, without saying whose it was.
 *
 * ---------------------------------------------------------------------------
 * Other deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. A DRAFT POLL CAN BE LAUNCHED. The reference offers `launchNow: false` and
 *    then has no launch endpoint at all, so a draft poll is permanently
 *    unreachable — it can never be answered and can never be opened.
 *
 * 2. A SCALE ANSWER IS A NUMBER. The reference validates
 *    `Number(answer.text)` in 1..10 while its own UI submits `scale_0`..
 *    `scale_10` as option KEYS — so a scale poll answered through its form
 *    stores keys, `scaleAverage` is always null, and the poll is unreadable.
 *
 * 3. THE LISTS ARE PAGINATED (AD-13), and `hasResponded` is one query for the
 *    page rather than a relation loaded per poll.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import { Poll, PollResponse } from '../../../models/hrms/EngageModels.js';
import { recordAudit, recordSystemAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import { CHOICE_POLL_KINDS, POLL_SCALE_MIN, POLL_SCALE_MAX } from '../../../shared/constants/engage.js';
import { HrmsNotFoundError, HrmsConflictError, HrmsValidationError } from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const nameOf = (e) => `${e?.firstName ?? ''} ${e?.lastName ?? ''}`.trim() || 'Unknown';

/** Open means launched and not past its closing time. */
export function pollIsOpen(row, now = new Date()) {
  if (!row.launchedAt) return false;
  if (row.closesAt && new Date(row.closesAt).getTime() <= now.getTime()) return false;
  return true;
}

const toDto = (row, extras = {}) => ({
  id: idStr(row._id),
  question: row.question,
  kind: row.kind,
  options: (row.options ?? []).map((o) => ({ key: o.key, label: o.label })),
  targetRoleKeys: row.targetRoleKeys ?? [],
  launchedAt: row.launchedAt ? new Date(row.launchedAt).toISOString() : null,
  closesAt: row.closesAt ? new Date(row.closesAt).toISOString() : null,
  anonymous: row.anonymous,
  open: pollIsOpen(row),
  createdByEmployeeId: idStr(row.createdByEmployeeId),
  createdByName: row.createdByName ?? null,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  responseCount: extras.responseCount ?? 0,
  hasResponded: extras.hasResponded ?? false,
});

/**
 * Response counts and the caller's own answered-state for a page of polls.
 *
 * Two aggregate queries for the page. The reference includes a `_count` and a
 * filtered `responses` relation on every poll in the list, which is a join per
 * row on every render.
 */
async function enrich(rows, actor) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r._id);
  const self = actor?.employeeId ? oid(actor.employeeId) : null;

  const [counts, mine] = await Promise.all([
    PollResponse.aggregate([
      { $match: { pollId: { $in: ids } } },
      { $group: { _id: '$pollId', n: { $sum: 1 } } },
    ]),
    self
      ? PollResponse.find({ pollId: { $in: ids }, respondentEmployeeId: self })
          .select('pollId')
          .lean()
      : [],
  ]);

  const byPoll = new Map(counts.map((c) => [idStr(c._id), c.n]));
  const answered = new Set(mine.map((r) => idStr(r.pollId)));

  return rows.map((r) =>
    toDto(r, {
      responseCount: byPoll.get(idStr(r._id)) ?? 0,
      hasResponded: answered.has(idStr(r._id)),
    }),
  );
}

export async function listPolls(query = {}, actor) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, kind, open } = query;

  const now = new Date();
  const filter = {
    ...(kind ? { kind } : {}),
    ...(open === undefined
      ? {}
      : open
        ? {
            launchedAt: { $ne: null },
            $or: [{ closesAt: null }, { closesAt: { $gt: now } }],
          }
        : {
            $or: [{ launchedAt: null }, { closesAt: { $ne: null, $lte: now } }],
          }),
  };

  const [rows, total] = await Promise.all([
    Poll.find(filter)
      .sort({ launchedAt: -1, createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Poll.countDocuments(filter),
  ]);

  return { data: await enrich(rows, actor), total, page, pageSize };
}

export async function getPoll(id, actor) {
  const row = await loadPoll(id);
  return (await enrich([row], actor))[0];
}

export async function createPoll(input, context = {}) {
  const actor = context.actor;

  const author = actor?.employeeId
    ? await Employee.findById(actor.employeeId).select('_id firstName lastName').lean()
    : null;

  const row = await Poll.create({
    question: input.question,
    kind: input.kind,
    // Scale and open-ended carry no options, whatever the caller sent.
    options: CHOICE_POLL_KINDS.includes(input.kind) ? input.options : [],
    targetRoleKeys: input.targetRoleKeys ?? [],
    launchedAt: input.launchNow ? new Date() : null,
    closesAt: input.closesAt ? new Date(input.closesAt) : null,
    anonymous: input.anonymous,
    createdByEmployeeId: actor?.employeeId ? oid(actor.employeeId) : null,
    createdByName: author ? nameOf(author) : null,
    createdByUserId: context.user?._id ?? null,
  });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.POLL_CREATED,
    `Created the ${input.kind.replace('_', ' ')} poll "${input.question}"${
      input.launchNow ? ' and launched it' : ' as a draft'
    }${input.anonymous ? ' (anonymous)' : ''}`,
    context.req,
    {
      meta: {
        pollId: idStr(row._id),
        kind: input.kind,
        anonymous: input.anonymous,
        launched: Boolean(input.launchNow),
      },
    },
  );

  return (await enrich([row.toObject()], actor))[0];
}

/**
 * Launch a draft.
 *
 * 🔴 The reference has no such endpoint — see note 1. Its own create form
 * offers "Save as draft", and a poll saved that way can never be launched,
 * answered or read.
 */
export async function launchPoll(id, context = {}) {
  const existing = await loadPoll(id);
  if (existing.launchedAt) {
    throw new HrmsConflictError('This poll has already been launched.', {
      code: 'POLL_ALREADY_LAUNCHED',
    });
  }
  if (existing.closesAt && new Date(existing.closesAt).getTime() <= Date.now()) {
    throw new HrmsConflictError('This poll’s closing time has already passed.', {
      code: 'POLL_CLOSED',
    });
  }

  const updated = await Poll.findOneAndUpdate(
    { _id: existing._id, launchedAt: null },
    { $set: { launchedAt: new Date() } },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('This poll was launched before your request completed.', {
      code: 'POLL_ALREADY_LAUNCHED',
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.POLL_LAUNCHED,
    `Launched the poll "${existing.question}"`,
    context.req,
    { meta: { pollId: idStr(existing._id) } },
  );

  return (await enrich([updated.toObject()], context.actor))[0];
}

/**
 * Answer a poll, once.
 *
 * The answer is validated against the poll's OWN kind and options — the shape
 * accepted depends on what was asked, which is the part the reference's single
 * loose `{keys, text}` never quite enforces.
 */
export async function respondToPoll(id, input, context = {}) {
  const actor = context.actor;
  if (!actor?.employeeId) {
    throw new HrmsValidationError('No employee context.', [
      { path: 'respondent', message: 'You need an employee record to answer a poll.' },
    ]);
  }

  const poll = await loadPoll(id);
  if (!poll.launchedAt) {
    throw new HrmsConflictError('This poll has not been launched yet.', {
      code: 'POLL_NOT_LAUNCHED',
    });
  }
  if (poll.closesAt && new Date(poll.closesAt).getTime() <= Date.now()) {
    throw new HrmsConflictError('This poll has closed.', { code: 'POLL_CLOSED' });
  }

  const answer = normaliseAnswer(poll, input);

  // Pre-checked only for a better message than a duplicate-key error; the
  // unique index is the guarantee.
  const existing = await PollResponse.findOne({
    pollId: poll._id,
    respondentEmployeeId: oid(actor.employeeId),
  })
    .select('_id')
    .lean();
  if (existing) {
    throw new HrmsConflictError('You have already answered this poll.', {
      code: 'POLL_ALREADY_ANSWERED',
    });
  }

  try {
    await PollResponse.create({
      pollId: poll._id,
      respondentEmployeeId: oid(actor.employeeId),
      keys: answer.keys,
      text: answer.text,
      scale: answer.scale,
      submittedAt: new Date(),
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError('You have already answered this poll.', {
        code: 'POLL_ALREADY_ANSWERED',
      });
    }
    throw error;
  }

  /**
   * 🔴 THE AUDIT ENTRY IS THE ANONYMITY BOUNDARY — see the header.
   *
   * A named poll records who answered. An anonymous one records that an answer
   * arrived, and nothing more: no actor, no employee id, not even in `meta`.
   */
  if (poll.anonymous) {
    await recordSystemAudit(
      AUDIT_ACTIONS.POLL_RESPONDED,
      `An anonymous response was recorded for the poll "${poll.question}"`,
      { pollId: idStr(poll._id), anonymous: true },
    );
  } else {
    await recordAudit(
      context.user,
      AUDIT_ACTIONS.POLL_RESPONDED,
      `Answered the poll "${poll.question}"`,
      context.req,
      { meta: { pollId: idStr(poll._id), anonymous: false } },
    );
  }

  return getPoll(poll._id, actor);
}

/**
 * Validate the answer against what was actually asked.
 *
 * Single: exactly one known key. Multi: at least one, all known. Scale: a
 * number in range, in its own field. Open-ended: text.
 */
function normaliseAnswer(poll, input) {
  const keys = input.keys ?? [];

  if (CHOICE_POLL_KINDS.includes(poll.kind)) {
    const known = new Set((poll.options ?? []).map((o) => o.key));
    const unknown = keys.filter((k) => !known.has(k));
    if (unknown.length > 0) {
      throw new HrmsValidationError('Unknown option.', [
        { path: 'keys', message: `This poll has no option called: ${unknown.join(', ')}.` },
      ]);
    }
    if (poll.kind === 'single' && keys.length !== 1) {
      throw new HrmsValidationError('Choose exactly one option.', [
        { path: 'keys', message: 'A single-choice poll takes one answer.' },
      ]);
    }
    if (poll.kind === 'multi' && keys.length === 0) {
      throw new HrmsValidationError('Choose at least one option.', [
        { path: 'keys', message: 'Pick one or more.' },
      ]);
    }
    return { keys, text: null, scale: null };
  }

  if (poll.kind === 'scale') {
    const scale = input.scale;
    if (!Number.isInteger(scale) || scale < POLL_SCALE_MIN || scale > POLL_SCALE_MAX) {
      throw new HrmsValidationError('Choose a rating.', [
        { path: 'scale', message: `Pick a number from ${POLL_SCALE_MIN} to ${POLL_SCALE_MAX}.` },
      ]);
    }
    return { keys: [], text: null, scale };
  }

  // open_ended
  if (!input.text) {
    throw new HrmsValidationError('Write an answer.', [
      { path: 'text', message: 'This poll asks for a written response.' },
    ]);
  }
  return { keys: [], text: input.text, scale: null };
}

/**
 * Aggregated results. HR only — the route enforces it and this is the only
 * read path that touches responses in bulk.
 *
 * No respondent is named for ANY poll here, anonymous or not: the reference
 * returns the same aggregate shape, and a named poll's value is that HR knows
 * participation, not who said what.
 */
export async function pollResults(id) {
  const poll = await loadPoll(id);
  const responses = await PollResponse.find({ pollId: poll._id })
    .select('keys text scale')
    .lean();

  const optionCounts = {};
  // Every declared option starts at zero, so a zero-vote option is visible
  // rather than missing — the reference omits it entirely.
  for (const option of poll.options ?? []) optionCounts[option.key] = 0;

  const openTexts = [];
  const scaleValues = [];

  for (const r of responses) {
    for (const k of r.keys ?? []) {
      optionCounts[k] = (optionCounts[k] ?? 0) + 1;
    }
    if (poll.kind === 'scale' && Number.isFinite(r.scale)) scaleValues.push(r.scale);
    if (poll.kind === 'open_ended' && r.text) openTexts.push(r.text);
  }

  const scaleAverage = scaleValues.length
    ? Number((scaleValues.reduce((s, v) => s + v, 0) / scaleValues.length).toFixed(2))
    : null;

  return {
    pollId: idStr(poll._id),
    question: poll.question,
    kind: poll.kind,
    anonymous: poll.anonymous,
    options: (poll.options ?? []).map((o) => ({ key: o.key, label: o.label })),
    totalResponses: responses.length,
    optionCounts,
    scaleAverage,
    openTexts,
  };
}

// ---------------------------------------------------------------------------

export async function loadPoll(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Poll');
  const row = await Poll.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('Poll');
  return row;
}

export { toDto as pollDto, normaliseAnswer };

export default {
  listPolls,
  getPoll,
  createPoll,
  launchPoll,
  respondToPoll,
  pollResults,
  pollIsOpen,
};
