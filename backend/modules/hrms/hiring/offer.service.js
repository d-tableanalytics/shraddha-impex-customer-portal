/**
 * Hiring offers, and the candidate-facing accept/reject flow.
 *
 * Ported from the reference's `hiring-offer.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * 🔴 THE DEFECT THIS MODULE EXISTS TO CLOSE
 * ---------------------------------------------------------------------------
 * The reference's careers endpoints are keyed by the offer's own UUID:
 *
 *     GET  /careers/offer/:id          -> name, email, designation, CTC
 *     GET  /careers/offer/:id/pdf      -> the signed letter
 *     POST /careers/offer/:id/accept   -> accepts, on the candidate's behalf
 *     POST /careers/offer/:id/reject
 *
 * All `@Public()`. No token, no rate limit, no proof the caller is the
 * candidate. Anyone who holds an id — from a forwarded email, a browser
 * history, a proxy log, a screenshot — can read someone's salary or accept an
 * employment offer for them. It is the same defect AD-15 found in the
 * attendance selfie endpoint, on a document that decides what somebody earns.
 *
 * The replacement:
 *
 *   - a 256-bit random ACCESS TOKEN is minted when the offer is sent, and the
 *     token is the only thing that opens the public routes; the id opens
 *     nothing
 *   - it is stored HASHED, so a database dump yields no working links
 *   - it is compared in CONSTANT TIME against the stored digest
 *   - it EXPIRES, so a link that leaks months later is inert
 *   - every refusal is audited, because an unauthenticated endpoint that
 *     leaves no trace gives an attacker unlimited quiet attempts
 *
 * ---------------------------------------------------------------------------
 * What is not built
 * ---------------------------------------------------------------------------
 * The reference renders a PDF letter with `pdf-lib` and emails a link. Neither
 * is built here: there is no mail service in this codebase, and Payroll
 * deferred payslip PDFs for the same reason. The offer, its token and the whole
 * accept/reject workflow are complete; the token is returned to the recruiter
 * once, at send time, for them to deliver.
 */

import crypto from 'node:crypto';
import mongoose from 'mongoose';

import {
  HiringOffer,
  Application,
  Candidate,
  JobRequisition,
} from '../../../models/hrms/HiringModels.js';
import { recordAudit, recordSystemAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import {
  OFFER_TOKEN_BYTES,
  OFFER_TOKEN_TTL_DAYS,
  CLOSED_APPLICATION_STAGES,
} from '../../../shared/constants/hiring.js';
import { toDecimalString, fromDecimal } from '../../../shared/payroll/money.js';
import { advanceTo } from './application.service.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsValidationError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

/** SHA-256 of the token. The plaintext is shown once and never stored. */
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * The offer's current state, derived rather than stored.
 *
 * The reference has three nullable timestamps and no status, so every screen
 * re-derives "is this offer live" from them — and each one can get it wrong.
 */
export function offerState(row) {
  if (row.acceptedAt) return 'accepted';
  if (row.rejectedAt) return 'rejected';
  if (row.sentAt) {
    const expired =
      row.accessTokenExpiresAt && new Date(row.accessTokenExpiresAt).getTime() < Date.now();
    return expired ? 'expired' : 'sent';
  }
  return 'draft';
}

const toDto = (row, extras = {}) => ({
  id: idStr(row._id),
  applicationId: idStr(row.applicationId),
  candidateName: extras.candidateName ?? null,
  candidateEmail: extras.candidateEmail ?? null,
  requisitionTitle: extras.requisitionTitle ?? null,
  ctc: fromDecimal(row.ctc),
  joiningDate: row.joiningDate,
  designation: row.designation,
  negotiationNotes: row.negotiationNotes ?? null,
  state: offerState(row),
  sentAt: row.sentAt ? new Date(row.sentAt).toISOString() : null,
  acceptedAt: row.acceptedAt ? new Date(row.acceptedAt).toISOString() : null,
  rejectedAt: row.rejectedAt ? new Date(row.rejectedAt).toISOString() : null,
  rejectionReason: row.rejectionReason ?? null,
  expiresAt: row.accessTokenExpiresAt
    ? new Date(row.accessTokenExpiresAt).toISOString()
    : null,
  signature: row.signature
    ? {
        name: row.signature.name,
        signedAt: row.signature.signedAt
          ? new Date(row.signature.signedAt).toISOString()
          : null,
      }
    : null,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

/** Candidate and requisition context for a page of offers, in two queries. */
async function enrich(rows) {
  if (rows.length === 0) return [];

  const applications = await Application.find({
    _id: { $in: [...new Set(rows.map((r) => idStr(r.applicationId)))] },
  })
    .select('candidateId requisitionId')
    .lean();

  const [candidates, requisitions] = await Promise.all([
    Candidate.find({ _id: { $in: applications.map((a) => a.candidateId) } })
      .select('name email')
      .lean(),
    JobRequisition.find({ _id: { $in: applications.map((a) => a.requisitionId) } })
      .select('title')
      .lean(),
  ]);

  const applicationById = new Map(applications.map((a) => [idStr(a._id), a]));
  const candidateById = new Map(candidates.map((c) => [idStr(c._id), c]));
  const titleById = new Map(requisitions.map((r) => [idStr(r._id), r.title]));

  return rows.map((row) => {
    const application = applicationById.get(idStr(row.applicationId));
    const candidate = application ? candidateById.get(idStr(application.candidateId)) : null;
    return toDto(row, {
      candidateName: candidate?.name ?? null,
      candidateEmail: candidate?.email ?? null,
      requisitionTitle: application ? titleById.get(idStr(application.requisitionId)) ?? null : null,
    });
  });
}

// ---------------------------------------------------------------------------
// Recruiter-facing
// ---------------------------------------------------------------------------

export async function listOffers(query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, applicationId } = query;
  const filter = applicationId ? { applicationId: oid(applicationId) } : {};

  const [rows, total] = await Promise.all([
    HiringOffer.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    HiringOffer.countDocuments(filter),
  ]);

  return { data: await enrich(rows), total, page, pageSize };
}

export async function createOffer(input, context = {}) {
  const application = await Application.findById(input.applicationId).lean();
  if (!application) {
    throw new HrmsValidationError('Unknown application.', [
      { path: 'applicationId', message: 'That application does not exist.' },
    ]);
  }
  if (CLOSED_APPLICATION_STAGES.includes(application.stage)) {
    throw new HrmsConflictError(
      `This application is ${application.stage}; no offer can be raised.`,
      { code: 'APPLICATION_CLOSED' },
    );
  }

  // A joining date in the past is almost certainly a typo, and it would be
  // printed on the letter. The reference accepts one.
  if (input.joiningDate < new Date().toISOString().slice(0, 10)) {
    throw new HrmsValidationError('The joining date cannot be in the past.', [
      { path: 'joiningDate', message: 'Choose today or a future date.' },
    ]);
  }

  // One live offer at a time. Two outstanding offers to the same person for the
  // same role is a negotiation the system cannot represent, and either could be
  // accepted.
  const live = await HiringOffer.findOne({
    applicationId: oid(input.applicationId),
    acceptedAt: null,
    rejectedAt: null,
  })
    .select('_id')
    .lean();
  if (live) {
    throw new HrmsConflictError(
      'This candidate already has an offer awaiting a decision. Withdraw it before raising another.',
      { code: 'OFFER_ALREADY_OPEN' },
    );
  }

  const row = await HiringOffer.create({
    applicationId: oid(input.applicationId),
    ctc: mongoose.Types.Decimal128.fromString(toDecimalString(input.ctc)),
    joiningDate: input.joiningDate,
    designation: input.designation,
    negotiationNotes: input.negotiationNotes ?? null,
    createdByUserId: context.user?._id ?? null,
  });

  // Raising an offer advances the pipeline, as in the reference — forwards only.
  await advanceTo(input.applicationId, 'offer', context);

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.OFFER_CREATED,
    `Raised an offer for ${input.designation} joining ${input.joiningDate}`,
    context.req,
    {
      meta: {
        offerId: idStr(row._id),
        applicationId: idStr(input.applicationId),
        designation: input.designation,
        joiningDate: input.joiningDate,
        ctc: Number(input.ctc),
      },
    },
  );

  return (await enrich([row.toObject()]))[0];
}

/**
 * Send the offer: mint its access token and open the candidate's link.
 *
 * The PLAINTEXT TOKEN IS RETURNED ONCE, here, and never again — only its hash
 * is stored. The recruiter delivers the link; there is no mail service in this
 * codebase to do it for them, and inventing one would be building a module
 * under another name.
 */
export async function sendOffer(id, context = {}) {
  const offer = await loadOffer(id);
  const state = offerState(offer);

  if (state !== 'draft') {
    throw new HrmsConflictError(
      state === 'sent'
        ? 'This offer has already been sent.'
        : `This offer is ${state} and cannot be sent again.`,
      { code: 'OFFER_NOT_SENDABLE' },
    );
  }

  const token = crypto.randomBytes(OFFER_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + OFFER_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const updated = await HiringOffer.findOneAndUpdate(
    { _id: id, sentAt: null },
    {
      $set: {
        sentAt: new Date(),
        sentByUserId: context.user?._id ?? null,
        accessTokenHash: hashToken(token),
        accessTokenExpiresAt: expiresAt,
      },
    },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('This offer was sent before your request completed.', {
      code: 'OFFER_NOT_SENDABLE',
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.OFFER_SENT,
    `Sent the offer for ${offer.designation}; the candidate link expires ${expiresAt.toISOString().slice(0, 10)}`,
    context.req,
    // The TOKEN IS NOT AUDITED. An audit trail is read by more people than an
    // offer is, and a credential in it is a credential leak.
    { meta: { offerId: idStr(id), applicationId: idStr(offer.applicationId), expiresAt } },
  );

  const dto = (await enrich([updated.toObject()]))[0];
  return {
    ...dto,
    /** Shown ONCE. Not stored in plaintext and not recoverable. */
    accessToken: token,
    candidatePath: `/careers/offer/${token}`,
  };
}

// ---------------------------------------------------------------------------
// Candidate-facing — token is the only credential
// ---------------------------------------------------------------------------

/**
 * Resolve an offer from its access token.
 *
 * Constant-time comparison against the stored digest. The lookup is BY HASH, so
 * a wrong token finds nothing and a right one finds exactly one row — there is
 * no id path into any of this.
 *
 * Every refusal is audited as a system event: an unauthenticated endpoint that
 * leaves no trace when refused gives an attacker unlimited quiet attempts, and
 * a run of refusals is the only visible sign anyone is trying.
 */
export async function resolveOfferByToken(token, { ip, userAgent } = {}) {
  const digest = hashToken(token);

  const row = await HiringOffer.findOne({ accessTokenHash: digest })
    .select('+accessTokenHash')
    .lean();

  if (!row) {
    await recordSystemAudit(
      AUDIT_ACTIONS.OFFER_LINK_REFUSED,
      'An offer link was presented that matches no offer',
      { ip: ip ?? null, userAgent: userAgent ?? null },
    );
    throw new HrmsNotFoundError('Offer');
  }

  // Belt and braces over the indexed lookup: the comparison itself is constant
  // time, so nothing about the stored digest leaks through response timing.
  const matches =
    typeof row.accessTokenHash === 'string' &&
    row.accessTokenHash.length === digest.length &&
    crypto.timingSafeEqual(Buffer.from(row.accessTokenHash), Buffer.from(digest));
  if (!matches) {
    await recordSystemAudit(
      AUDIT_ACTIONS.OFFER_LINK_REFUSED,
      'An offer link failed verification',
      { ip: ip ?? null, offerId: idStr(row._id) },
    );
    throw new HrmsNotFoundError('Offer');
  }

  if (row.accessTokenExpiresAt && new Date(row.accessTokenExpiresAt).getTime() < Date.now()) {
    await recordSystemAudit(
      AUDIT_ACTIONS.OFFER_LINK_REFUSED,
      'An expired offer link was presented',
      { ip: ip ?? null, offerId: idStr(row._id) },
    );
    throw new HrmsConflictError(
      'This offer link has expired. Please contact your recruiter for a new one.',
      { code: 'OFFER_LINK_EXPIRED' },
    );
  }

  return row;
}

/**
 * What the candidate sees.
 *
 * Deliberately NARROWER than the recruiter's view: the negotiation notes are
 * the recruiter's internal record of the haggling and are not the candidate's
 * to read. The reference returns the same DTO to both.
 */
export async function publicViewOffer(token, meta = {}) {
  const row = await resolveOfferByToken(token, meta);
  const [dto] = await enrich([row]);
  return {
    candidateName: dto.candidateName,
    designation: dto.designation,
    ctc: dto.ctc,
    joiningDate: dto.joiningDate,
    requisitionTitle: dto.requisitionTitle,
    state: dto.state,
    sentAt: dto.sentAt,
    expiresAt: dto.expiresAt,
    acceptedAt: dto.acceptedAt,
    rejectedAt: dto.rejectedAt,
  };
}

export async function acceptOffer(token, input, meta = {}) {
  const row = await resolveOfferByToken(token, meta);
  assertDecidable(row);

  const now = new Date();
  const updated = await HiringOffer.findOneAndUpdate(
    // Conditional on both being unset, so a double-click cannot accept twice
    // and an accept cannot race a reject.
    { _id: row._id, acceptedAt: null, rejectedAt: null },
    {
      $set: {
        acceptedAt: now,
        signature: {
          name: input.signatureName,
          ipAddress: meta.ip ? String(meta.ip).slice(0, 64) : null,
          userAgent: meta.userAgent ? String(meta.userAgent).slice(0, 300) : null,
          signedAt: now,
        },
        // The link is spent. Keeping it live after a decision would let anyone
        // holding it keep reading the salary indefinitely.
        accessTokenHash: null,
        accessTokenExpiresAt: null,
      },
    },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('This offer has already been decided.', {
      code: 'OFFER_ALREADY_DECIDED',
    });
  }

  await recordSystemAudit(
    AUDIT_ACTIONS.OFFER_ACCEPTED,
    `Offer ${idStr(row._id)} accepted by the candidate, signed as "${input.signatureName}"`,
    {
      offerId: idStr(row._id),
      applicationId: idStr(row.applicationId),
      signatureName: input.signatureName,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    },
  );

  return publicDecisionResult(updated);
}

export async function rejectOffer(token, input = {}, meta = {}) {
  const row = await resolveOfferByToken(token, meta);
  assertDecidable(row);

  const updated = await HiringOffer.findOneAndUpdate(
    { _id: row._id, acceptedAt: null, rejectedAt: null },
    {
      $set: {
        rejectedAt: new Date(),
        rejectionReason: input.reason ?? null,
        accessTokenHash: null,
        accessTokenExpiresAt: null,
      },
    },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('This offer has already been decided.', {
      code: 'OFFER_ALREADY_DECIDED',
    });
  }

  await recordSystemAudit(
    AUDIT_ACTIONS.OFFER_REJECTED,
    `Offer ${idStr(row._id)} declined by the candidate`,
    {
      offerId: idStr(row._id),
      applicationId: idStr(row.applicationId),
      reason: input.reason ?? null,
      ip: meta.ip ?? null,
    },
  );

  return publicDecisionResult(updated);
}

function assertDecidable(row) {
  if (!row.sentAt) {
    throw new HrmsConflictError('This offer has not been sent yet.', {
      code: 'OFFER_NOT_SENT',
    });
  }
  if (row.acceptedAt || row.rejectedAt) {
    throw new HrmsConflictError('This offer has already been decided.', {
      code: 'OFFER_ALREADY_DECIDED',
    });
  }
}

/** The candidate's confirmation. Nothing internal crosses back. */
const publicDecisionResult = (row) => ({
  state: offerState(row),
  acceptedAt: row.acceptedAt ? new Date(row.acceptedAt).toISOString() : null,
  rejectedAt: row.rejectedAt ? new Date(row.rejectedAt).toISOString() : null,
});

async function loadOffer(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Offer');
  const row = await HiringOffer.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('Offer');
  return row;
}

export { hashToken, loadOffer };

export default {
  listOffers,
  createOffer,
  sendOffer,
  publicViewOffer,
  acceptOffer,
  rejectOffer,
  offerState,
};
