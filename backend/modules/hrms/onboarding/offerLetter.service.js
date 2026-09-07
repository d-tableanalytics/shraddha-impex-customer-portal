/**
 * Onboarding offer letters — the employee-facing offer, signed in-app.
 *
 * Ported from the reference's `offer-letter.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * This is NOT Hiring's offer, and both exist on purpose
 * ---------------------------------------------------------------------------
 * The reference ships two offer flows and so does this codebase:
 *
 *   Hiring `HiringOffer`   hangs off an Application, addressed to a CANDIDATE
 *                          who has no account, authorised by a hashed public
 *                          token mailed to them
 *   Onboarding `OfferLetter` (here) hangs off an EMPLOYEE record, read and
 *                          signed by that person once they are signed in
 *
 * They share no collection, no route and no token. Collapsing them would break
 * the case each is for: a candidate cannot sign in, and an employee should not
 * need an emailed link to read their own letter.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. THE LETTER IS GENERATED AT CREATE, NOT AT SEND. The reference generates it
 *    inside `send`, and its OffersTab then renders the Send button only when
 *    `!sentAt && pdfKey` — a condition no row can ever satisfy, because a draft
 *    has no key and a sent one has `sentAt`. The primary action of the tab is
 *    literally unreachable. Generating at create makes a draft reviewable
 *    before it goes out, and makes Send mean only "release it".
 *
 * 2. THE DOCUMENT IS READ THROUGH THE STORAGE LAYER. The reference writes a PDF
 *    to the instance's local disk and reads it back with
 *    `path.resolve(uploadsRoot, pdfKey)` — a resolve an absolute key escapes
 *    entirely. Here it goes to the `offer-letter` category and is only ever
 *    read through `issueReadUrl`, which authorises, audits and expires.
 *
 * 3. THE SIGNATURE IMAGE IS GONE — see the model's note.
 *
 * 4. THE LIST IS PAGINATED (AD-13).
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import { OfferLetter } from '../../../models/hrms/OnboardingModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { notify } from '../inbox/notifier.service.js';
import { INBOX_TYPES } from '../../../shared/constants/inbox.js';
import {
  AUDIT_ACTIONS,
  STORAGE_CATEGORIES,
  PAGE_SIZE_DEFAULT,
} from '../../../shared/constants/hrms.js';
import { toDecimalString, fromDecimal } from '../../../shared/payroll/money.js';
import { putObject } from '../../../utils/hrms/storage/index.js';
import { issueReadUrl } from '../storage/storage.service.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import { hasHrmsPermission } from '../../../shared/permissions/has-permission.js';
import { renderOfferLetter } from './offerLetterDocument.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsForbiddenError,
  HrmsValidationError,
} from '../hrms.errors.js';

const CATEGORY = STORAGE_CATEGORIES.OFFER_LETTER;

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const nameOf = (e) => `${e?.firstName ?? ''} ${e?.lastName ?? ''}`.trim() || 'Unknown';

/**
 * The offer's state, DERIVED from its timestamps.
 *
 * The reference computes this on the client, in `statusOf()`. Deriving it here
 * means one definition rather than one per screen, and no stored column that
 * can drift out of step with the timestamps beside it.
 */
export function offerLetterState(row) {
  if (row.rejectedAt) return 'rejected';
  if (row.acceptedAt) return 'accepted';
  if (row.sentAt) return 'sent';
  return 'draft';
}

const toDto = (row) => ({
  id: idStr(row._id),
  employeeId: idStr(row.employeeId),
  employeeName: row.employeeName ?? null,
  ctc: fromDecimal(row.ctc),
  joiningDate: row.joiningDate,
  designation: row.designation,
  /** `hasDocument`, never the key — a listing must not mint access to anything. */
  hasDocument: Boolean(row.documentKey),
  state: offerLetterState(row),
  sentAt: row.sentAt ? new Date(row.sentAt).toISOString() : null,
  acceptedAt: row.acceptedAt ? new Date(row.acceptedAt).toISOString() : null,
  rejectedAt: row.rejectedAt ? new Date(row.rejectedAt).toISOString() : null,
  rejectionReason: row.rejectionReason ?? null,
  signature: row.signature
    ? {
        name: row.signature.name,
        signedAt: row.signature.signedAt ? new Date(row.signature.signedAt).toISOString() : null,
      }
    : null,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listOfferLetters(query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, employeeId } = query;
  const filter = { ...(employeeId ? { employeeId: oid(employeeId) } : {}) };

  const [rows, total] = await Promise.all([
    OfferLetter.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    OfferLetter.countDocuments(filter),
  ]);

  return { data: rows.map(toDto), total, page, pageSize };
}

/**
 * One employee's offers.
 *
 * Anyone may ask for their own; `onboarding:view:org` is needed for anybody
 * else's. Same rule as the reference, with the id taken from the path validated
 * against the session rather than trusted.
 */
export async function listOfferLettersForEmployee(employeeId, actor) {
  const isSelf = Boolean(actor?.employeeId) && idStr(actor.employeeId) === idStr(employeeId);
  if (!isSelf && !hasHrmsPermission(actor, M.ONBOARDING, A.VIEW, S.ORG)) {
    throw new HrmsForbiddenError('You may not view these offer letters.');
  }
  const rows = await OfferLetter.find({ employeeId: oid(employeeId) })
    .sort({ createdAt: -1 })
    .lean();
  return rows.map(toDto);
}

/** The signed-in employee's own offers, for the new-hire portal. No id on the wire. */
export async function myOfferLetters(actor) {
  if (!actor?.employeeId) return [];
  const rows = await OfferLetter.find({ employeeId: oid(actor.employeeId) })
    .sort({ createdAt: -1 })
    .lean();
  return rows.map(toDto);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createOfferLetter(input, context = {}) {
  const employee = await Employee.findOne({ _id: input.employeeId, deletedAt: null })
    .select('_id firstName lastName status')
    .lean()
    .catch(() => null);
  if (!employee) {
    throw new HrmsValidationError('Unknown employee.', [
      { path: 'employeeId', message: 'That employee does not exist.' },
    ]);
  }
  if (employee.status === 'exited' || employee.status === 'inactive') {
    throw new HrmsConflictError('That employee has left, so an offer cannot be raised for them.', {
      code: 'EMPLOYEE_NOT_OFFERABLE',
    });
  }

  // An outstanding offer must be settled before another is raised, or the
  // candidate sees two live letters and can sign either.
  const pending = await OfferLetter.findOne({
    employeeId: oid(input.employeeId),
    acceptedAt: null,
    rejectedAt: null,
  })
    .select('_id')
    .lean();
  if (pending) {
    throw new HrmsConflictError(
      `${nameOf(employee)} already has an offer letter awaiting a decision.`,
      { code: 'OFFER_LETTER_PENDING' },
    );
  }

  const row = await OfferLetter.create({
    employeeId: oid(input.employeeId),
    employeeName: nameOf(employee),
    ctc: mongoose.Types.Decimal128.fromString(toDecimalString(input.ctc)),
    joiningDate: input.joiningDate,
    designation: input.designation,
    createdByUserId: context.user?._id ?? null,
  });

  // Generated at CREATE — see note 1. A draft is reviewable before it is sent.
  const documentKey = await generateDocument(row, nameOf(employee), context);
  await OfferLetter.updateOne({ _id: row._id }, { $set: { documentKey } });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.OFFER_LETTER_CREATED,
    `Drafted an offer letter for ${nameOf(employee)} as ${input.designation}`,
    context.req,
    {
      meta: {
        offerLetterId: idStr(row._id),
        employeeId: idStr(employee._id),
        designation: input.designation,
      },
    },
  );

  return toDto({ ...row.toObject(), documentKey });
}

/**
 * Release the offer to the candidate.
 *
 * The reference emails the candidate and files an inbox item. Inbox now
 * exists, so the item is filed — to the offer's OWN employee, never to anybody
 * named in the request. No salary and no designation terms travel in it: the
 * new-hire portal is where the offer is read, behind its own authorisation.
 */
export async function sendOfferLetter(id, context = {}) {
  const offer = await loadOfferLetter(id);
  const state = offerLetterState(offer);

  if (state !== 'draft') {
    throw new HrmsConflictError(
      state === 'sent'
        ? 'This offer letter has already been sent.'
        : `This offer letter is ${state} and cannot be sent again.`,
      { code: 'OFFER_LETTER_NOT_SENDABLE' },
    );
  }

  const updated = await OfferLetter.findOneAndUpdate(
    { _id: offer._id, sentAt: null },
    { $set: { sentAt: new Date(), sentByUserId: context.user?._id ?? null } },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('This offer letter was sent before your request completed.', {
      code: 'OFFER_LETTER_NOT_SENDABLE',
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.OFFER_LETTER_SENT,
    `Sent the offer letter for ${offer.designation} to ${offer.employeeName}`,
    context.req,
    { meta: { offerLetterId: idStr(offer._id), employeeId: idStr(offer.employeeId) } },
  );

  await notify({
    to: idStr(offer.employeeId),
    type: INBOX_TYPES.OFFER_LETTER_READY,
    title: 'Your offer letter is ready',
    body: 'Review, sign, and accept it in the portal.',
    entity: 'offer_letter',
    entityId: idStr(offer._id),
  });

  return toDto(updated.toObject());
}

/**
 * The candidate accepts.
 *
 * Only the offer's own employee may sign, matched on the session's employee id
 * — the reference matches on `userId`, which cannot express a new hire who has
 * no login yet. The update is conditional on both timestamps still being unset,
 * so a double submit cannot accept twice and an accept cannot race a reject.
 */
export async function signOfferLetter(id, input, context = {}) {
  const offer = await loadOfferLetter(id);
  assertIsSubject(offer, context.actor);
  assertDecidable(offer);

  const now = new Date();
  const updated = await OfferLetter.findOneAndUpdate(
    { _id: offer._id, acceptedAt: null, rejectedAt: null },
    {
      $set: {
        acceptedAt: now,
        signature: {
          name: input.signatureName,
          ipAddress: context.req?.ip ? String(context.req.ip).slice(0, 64) : null,
          userAgent: context.req?.get?.('user-agent')
            ? String(context.req.get('user-agent')).slice(0, 300)
            : null,
          signedAt: now,
        },
      },
    },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('This offer letter was already decided.', {
      code: 'OFFER_LETTER_DECIDED',
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.OFFER_LETTER_ACCEPTED,
    `${offer.employeeName} accepted the offer for ${offer.designation}, signed as "${input.signatureName}"`,
    context.req,
    {
      meta: {
        offerLetterId: idStr(offer._id),
        employeeId: idStr(offer.employeeId),
        signatureName: input.signatureName,
      },
    },
  );

  return toDto(updated.toObject());
}

export async function rejectOfferLetter(id, input, context = {}) {
  const offer = await loadOfferLetter(id);
  assertIsSubject(offer, context.actor);
  assertDecidable(offer);

  const updated = await OfferLetter.findOneAndUpdate(
    { _id: offer._id, acceptedAt: null, rejectedAt: null },
    { $set: { rejectedAt: new Date(), rejectionReason: input?.reason ?? null } },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('This offer letter was already decided.', {
      code: 'OFFER_LETTER_DECIDED',
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.OFFER_LETTER_REJECTED,
    `${offer.employeeName} declined the offer for ${offer.designation}`,
    context.req,
    { meta: { offerLetterId: idStr(offer._id), employeeId: idStr(offer.employeeId) } },
  );

  return toDto(updated.toObject());
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

async function generateDocument(row, employeeName, context = {}) {
  const companyName = await resolveCompanyName();
  const { body, contentType, filename } = renderOfferLetter({
    candidateName: employeeName,
    designation: row.designation,
    ctc: toDecimalString(fromDecimal(row.ctc)),
    joiningDate: row.joiningDate,
    companyName,
  });

  const buffer = Buffer.from(body, 'utf8');
  const stored = await putObject({
    category: CATEGORY,
    body: buffer,
    contentType,
    // Scoped by the offer, so one letter's key can never collide with another's.
    scope: idStr(row._id),
    filename,
    size: buffer.length,
  });
  return stored.key;
}

/**
 * The company's own name, from CompanyProfile.
 *
 * Resolved lazily and defensively: a letter is still a valid letter if the
 * profile has not been filled in, and the fallback says nothing untrue.
 */
async function resolveCompanyName() {
  try {
    const { default: CompanyProfile } = await import('../../../models/hrms/CompanyProfile.js');
    const profile = await CompanyProfile.findOne({}).select('legalName displayName').lean();
    return profile?.legalName || profile?.displayName || null;
  } catch {
    return null;
  }
}

/** A short-lived URL for the letter. Authorised and audited by `issueReadUrl`. */
export async function issueOfferLetterUrl(id, actor, req) {
  const offer = await loadOfferLetter(id);
  if (!offer.documentKey) throw new HrmsNotFoundError('Offer letter document');
  return issueReadUrl({ category: CATEGORY, key: offer.documentKey, actor, req });
}

/**
 * Who may read a stored offer letter — the rule the storage layer applies.
 *
 * The subject may read their own; `onboarding:view:org` reads anybody's. The
 * owner context is the employee the offer is FOR, so `self` scope evaluates
 * against the right person rather than against whoever is asking.
 */
export async function resolveOfferLetterAccess(key) {
  const row = await OfferLetter.findOne({ documentKey: key }).select('employeeId').lean();
  if (!row) return null;

  const employee = await Employee.findById(row.employeeId)
    .select('_id userId departmentId managerChain deletedAt')
    .lean();
  if (!employee) return null;

  return {
    owner: {
      ownerUserId: idStr(employee.userId) ?? undefined,
      ownerEmployeeId: idStr(employee._id),
      ownerDepartmentId: idStr(employee.departmentId) ?? undefined,
      ownerManagerChain: (employee.managerChain ?? []).map(idStr),
    },
    permissions: [
      { module: M.ONBOARDING, action: A.VIEW, scope: S.ORG },
      { module: M.ONBOARDING, action: A.VIEW, scope: S.SELF },
    ],
  };
}

// ---------------------------------------------------------------------------

function assertIsSubject(offer, actor) {
  if (!actor?.employeeId || idStr(actor.employeeId) !== idStr(offer.employeeId)) {
    throw new HrmsForbiddenError('Only the person this offer is addressed to can decide it.');
  }
}

function assertDecidable(offer) {
  if (!offer.sentAt) {
    throw new HrmsConflictError('This offer letter has not been sent yet.', {
      code: 'OFFER_LETTER_NOT_SENT',
    });
  }
  if (offer.acceptedAt) {
    throw new HrmsConflictError('This offer letter has already been accepted.', {
      code: 'OFFER_LETTER_DECIDED',
    });
  }
  if (offer.rejectedAt) {
    throw new HrmsConflictError('This offer letter has already been declined.', {
      code: 'OFFER_LETTER_DECIDED',
    });
  }
}

export async function loadOfferLetter(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Offer letter');
  const row = await OfferLetter.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('Offer letter');
  return row;
}

export { toDto as offerLetterDto };

export default {
  listOfferLetters,
  listOfferLettersForEmployee,
  myOfferLetters,
  createOfferLetter,
  sendOfferLetter,
  signOfferLetter,
  rejectOfferLetter,
  issueOfferLetterUrl,
  resolveOfferLetterAccess,
  offerLetterState,
};
