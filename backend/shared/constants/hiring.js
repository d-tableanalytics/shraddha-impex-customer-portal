/**
 * Hiring vocabulary.
 *
 * A file of its own, as Attendance, Leave and Payroll each have — the Phase 0
 * `hrms.js` carries the foundation values and says so; module enums arrive with
 * their module.
 *
 * Dependency-free and environment-free: this is bundled into the browser as
 * well as run in Node, so a `process.env` here would be a runtime crash in the
 * SPA (`shared/README.md` rule 1, enforced by the guard in shared-foundation).
 *
 * Every enum is `packages/shared-types/src/hiring.ts` verbatim. Nothing is
 * invented — a status the reference does not have does not appear here.
 */

import { MAX_UPLOAD_BYTES, STORAGE_CATEGORIES } from './hrms.js';

// ---------------------------------------------------------------------------
// Requisition
// ---------------------------------------------------------------------------

export const REQUISITION_STATUSES = Object.freeze([
  'draft',
  'approved',
  'open',
  'filled',
  'cancelled',
]);

/**
 * The legal moves, declared as DATA.
 *
 * 🔴 The reference declares this state machine in a comment and then enforces
 * none of it: `setStatus` writes whatever it is given, so `cancelled → open`
 * and `filled → draft` both succeed. A requisition that has been closed for
 * business reasons can be silently reopened, and a filled one can be dragged
 * back to draft with its hires still attached.
 *
 * Declaring the transitions as a table means an illegal move is one lookup
 * rather than a branch somebody forgot to write, and a test can assert the
 * whole machine directly.
 */
export const REQUISITION_TRANSITIONS = Object.freeze({
  draft: Object.freeze(['approved', 'cancelled']),
  approved: Object.freeze(['open', 'cancelled']),
  open: Object.freeze(['filled', 'cancelled']),
  // Terminal. A new requisition is the way to hire again.
  filled: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export const TERMINAL_REQUISITION_STATUSES = Object.freeze(['filled', 'cancelled']);

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

export const CANDIDATE_SOURCES = Object.freeze([
  'careers',
  'referral',
  'linkedin',
  'naukri',
  'indeed',
  'manual',
]);

/** Résumé types the upload accepts. Checked against the file's own bytes too. */
export const RESUME_MIME_TYPES = Object.freeze([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

/**
 * The résumé upload ceiling, in bytes.
 *
 * Derived from the storage table rather than restated, so multer's limit and
 * the browser's pre-check cannot drift apart — and so the browser can state the
 * limit before somebody waits out an upload that was always going to be
 * refused. Authoritative enforcement is still multer's; this is courtesy.
 */
export const MAX_RESUME_BYTES =
  MAX_UPLOAD_BYTES[STORAGE_CATEGORIES.CANDIDATE_RESUME] ?? MAX_UPLOAD_BYTES.DEFAULT;

/**
 * First bytes each accepted type must carry.
 *
 * A declared `Content-Type` is written by the uploader and proves nothing; a
 * .exe announced as a PDF is the classic way a résumé inbox becomes a delivery
 * mechanism. `%PDF` and the OLE2 / ZIP container signatures are what actually
 * identify these.
 */
export const RESUME_MAGIC_BYTES = Object.freeze({
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // %PDF
  'application/msword': [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]], // OLE2
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    [0x50, 0x4b, 0x03, 0x04], // PK.. — docx is a zip
  ],
});

// ---------------------------------------------------------------------------
// Application pipeline
// ---------------------------------------------------------------------------

export const APPLICATION_STAGES = Object.freeze([
  'applied',
  'screening',
  'interview',
  'offer',
  'hired',
  'rejected',
]);

/**
 * The pipeline advances one step at a time, and `rejected` is reachable from
 * anywhere that is not already closed.
 *
 * 🔴 The reference only blocks moving OUT of `hired`/`rejected`; every other
 * jump is allowed, so `applied → offer` skips screening and interview entirely
 * and the funnel metrics that read stage history become fiction. Forward-by-one
 * is the pipeline the Kanban actually draws.
 */
export const APPLICATION_TRANSITIONS = Object.freeze({
  applied: Object.freeze(['screening', 'rejected']),
  screening: Object.freeze(['interview', 'rejected']),
  interview: Object.freeze(['offer', 'rejected']),
  offer: Object.freeze(['hired', 'rejected']),
  hired: Object.freeze([]),
  rejected: Object.freeze([]),
});

export const CLOSED_APPLICATION_STAGES = Object.freeze(['hired', 'rejected']);

/** The Kanban's column order, left to right. */
export const PIPELINE_COLUMNS = Object.freeze([
  'applied',
  'screening',
  'interview',
  'offer',
  'hired',
  'rejected',
]);

// ---------------------------------------------------------------------------
// Interview
// ---------------------------------------------------------------------------

export const INTERVIEW_STATUSES = Object.freeze([
  'scheduled',
  'completed',
  'cancelled',
  'no_show',
]);

/**
 * Only a scheduled interview can be resolved, and a resolved one is final.
 *
 * The reference lets `setStatus` write anything, so a cancelled interview can
 * be revived to `scheduled` — and feedback then attaches to a session that
 * never happened.
 */
export const INTERVIEW_TRANSITIONS = Object.freeze({
  scheduled: Object.freeze(['completed', 'cancelled', 'no_show']),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
  no_show: Object.freeze([]),
});

export const INTERVIEW_DECISIONS = Object.freeze([
  'strong_hire',
  'hire',
  'no_hire',
  'strong_no_hire',
]);

/** Rating scale for interview feedback. */
export const FEEDBACK_RATING_MIN = 1;
export const FEEDBACK_RATING_MAX = 5;

// ---------------------------------------------------------------------------
// Offer
// ---------------------------------------------------------------------------

/**
 * How long an offer's public access token stays usable.
 *
 * The reference has no token at all — its public routes take the offer's own
 * id — so there is nothing to expire. A bounded window means a link that leaks
 * out of a mailbox months later opens nothing.
 */
export const OFFER_TOKEN_TTL_DAYS = 30;

/** Bytes of entropy in the token. 32 bytes is 256 bits; guessing is not a threat. */
export const OFFER_TOKEN_BYTES = 32;

export const AI_JD_SENIORITIES = Object.freeze(['junior', 'mid', 'senior', 'lead']);

export default {
  REQUISITION_STATUSES,
  REQUISITION_TRANSITIONS,
  TERMINAL_REQUISITION_STATUSES,
  CANDIDATE_SOURCES,
  RESUME_MIME_TYPES,
  MAX_RESUME_BYTES,
  RESUME_MAGIC_BYTES,
  APPLICATION_STAGES,
  APPLICATION_TRANSITIONS,
  CLOSED_APPLICATION_STAGES,
  PIPELINE_COLUMNS,
  INTERVIEW_STATUSES,
  INTERVIEW_TRANSITIONS,
  INTERVIEW_DECISIONS,
  FEEDBACK_RATING_MIN,
  FEEDBACK_RATING_MAX,
  OFFER_TOKEN_TTL_DAYS,
  OFFER_TOKEN_BYTES,
  AI_JD_SENIORITIES,
};
