/**
 * Inbox vocabulary.
 *
 * Dependency-free and environment-free: bundled into the browser as well as run
 * in Node, so a `process.env` here would be a runtime crash in the SPA
 * (`shared/README.md` rule 1, enforced by the guard in shared-foundation).
 *
 * ---------------------------------------------------------------------------
 * 🔴 Why the type list here is longer than the reference's
 * ---------------------------------------------------------------------------
 * `packages/shared-types/src/inbox.ts` declares eleven types. Its producers
 * then emit a twelfth that is not in the list (`ticket`), never emit one that
 * is (`exit.task`), and overload `announcement` for EIGHT unrelated events:
 * recognition, a pending review, an interview, a requisition approval, an asset
 * assignment, an asset request, an asset decision and a policy publication.
 * Nothing validates the response, so the mismatch ships silently — and the page
 * renders the raw type string as its label, so a person reads
 * "attendance.correction.pending" in a coloured pill.
 *
 * One value per event is what makes the type useful for anything: filtering,
 * colouring, and knowing where the item points. The events are the reference's
 * — not one has been invented — but each now has its own name.
 */

// ---------------------------------------------------------------------------
// Categories — what a type is FOR, which is what the UI colours by
// ---------------------------------------------------------------------------

export const INBOX_CATEGORIES = Object.freeze({
  /** Something is waiting on this person. The reference's `actionable`. */
  ACTION: 'action',
  /** The outcome of something this person asked for. */
  DECISION: 'decision',
  /** Company-wide or team-wide news. */
  ANNOUNCEMENT: 'announcement',
  /** Something happened that concerns this person. No action, no decision. */
  UPDATE: 'update',
});

export const INBOX_CATEGORY_LIST = Object.freeze(Object.values(INBOX_CATEGORIES));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const C = INBOX_CATEGORIES;

/**
 * Every inbox event, with the module that raises it, its category, and the
 * screen it points at.
 *
 * `href` is a FUNCTION of the type, declared once, here. 🔴 The reference
 * stores a raw href string on every row — a per-item, unvalidated navigation
 * target whose only contract is "somewhere the browser will be sent". Deriving
 * it means a notification cannot carry a link the server did not compute, and
 * that changing where Leave lives is one edit rather than a data migration.
 */
export const INBOX_TYPES = Object.freeze({
  // Leave
  LEAVE_PENDING: 'leave.pending',
  LEAVE_DECIDED: 'leave.decided',
  // Attendance
  ATTENDANCE_CORRECTION_PENDING: 'attendance.correction.pending',
  ATTENDANCE_CORRECTION_DECIDED: 'attendance.correction.decided',
  // Expenses
  EXPENSE_PENDING: 'expense.pending',
  EXPENSE_DECIDED: 'expense.decided',
  // Exits
  EXIT_INITIATED: 'exit.initiated',
  EXIT_CLEARANCE: 'exit.clearance',
  // Documents
  POLICY_PUBLISHED: 'policy.published',
  // Engage
  ANNOUNCEMENT_PUBLISHED: 'announcement.published',
  RECOGNITION_RECEIVED: 'recognition.received',
  // Helpdesk
  TICKET_ASSIGNED: 'ticket.assigned',
  // Hiring
  INTERVIEW_SCHEDULED: 'interview.scheduled',
  REQUISITION_APPROVED: 'requisition.approved',
  // Onboarding
  OFFER_LETTER_READY: 'offer_letter.ready',
  ONBOARDING_TASK_ASSIGNED: 'onboarding.task',
  // Assets
  ASSET_ASSIGNED: 'asset.assigned',
  ASSET_REQUEST_RAISED: 'asset.request.raised',
  ASSET_REQUEST_DECIDED: 'asset.request.decided',
  // Performance
  REVIEW_ASSIGNED: 'review.assigned',
});

export const INBOX_TYPE_LIST = Object.freeze(Object.values(INBOX_TYPES));

const T = INBOX_TYPES;

/**
 * Per type: the human label, the category, and the path — RELATIVE to the HRMS
 * prefix, which the caller prepends.
 *
 * Every path below is the reference's own, with two corrections: its
 * `/documents/policies` and `/assets/mine` are its route shapes, and the
 * equivalents here are this app's.
 */
export const INBOX_TYPE_META = Object.freeze({
  [T.LEAVE_PENDING]: { label: 'Leave request', category: C.ACTION, path: '/leave/approvals' },
  [T.LEAVE_DECIDED]: { label: 'Leave decision', category: C.DECISION, path: '/leave/me' },

  [T.ATTENDANCE_CORRECTION_PENDING]: {
    label: 'Attendance correction',
    category: C.ACTION,
    path: '/attendance/corrections',
  },
  [T.ATTENDANCE_CORRECTION_DECIDED]: {
    label: 'Correction decision',
    category: C.DECISION,
    path: '/attendance/corrections',
  },

  [T.EXPENSE_PENDING]: { label: 'Expense claim', category: C.ACTION, path: '/expenses/queue' },
  [T.EXPENSE_DECIDED]: { label: 'Expense decision', category: C.DECISION, path: '/expenses/claims' },

  [T.EXIT_INITIATED]: { label: 'Exit request', category: C.ACTION, path: '/exits/requests' },
  [T.EXIT_CLEARANCE]: { label: 'Exit clearance', category: C.ACTION, path: '/exits/clearances' },

  [T.POLICY_PUBLISHED]: { label: 'Policy', category: C.ANNOUNCEMENT, path: '/documents/policies' },

  [T.ANNOUNCEMENT_PUBLISHED]: {
    label: 'Announcement',
    category: C.ANNOUNCEMENT,
    path: '/engage/announcements',
  },
  [T.RECOGNITION_RECEIVED]: {
    label: 'Recognition',
    category: C.UPDATE,
    path: '/engage/recognition',
  },

  [T.TICKET_ASSIGNED]: { label: 'Helpdesk ticket', category: C.ACTION, path: '/helpdesk/queue' },

  [T.INTERVIEW_SCHEDULED]: { label: 'Interview', category: C.ACTION, path: '/hiring/interviews' },
  [T.REQUISITION_APPROVED]: {
    label: 'Requisition',
    category: C.DECISION,
    path: '/hiring/requisitions',
  },

  [T.OFFER_LETTER_READY]: {
    label: 'Offer letter',
    category: C.ACTION,
    path: '/onboarding/offers',
  },
  [T.ONBOARDING_TASK_ASSIGNED]: {
    label: 'Onboarding task',
    category: C.ACTION,
    path: '/onboarding/checklists',
  },

  [T.ASSET_ASSIGNED]: { label: 'Asset', category: C.UPDATE, path: '/assets/mine' },
  [T.ASSET_REQUEST_RAISED]: { label: 'Asset request', category: C.ACTION, path: '/assets/requests' },
  [T.ASSET_REQUEST_DECIDED]: {
    label: 'Asset request',
    category: C.DECISION,
    path: '/assets/mine',
  },

  [T.REVIEW_ASSIGNED]: { label: 'Review', category: C.ACTION, path: '/performance/reviews' },
});

/** A type whose category is ACTION is one somebody has to do something about. */
export const isActionable = (type) => INBOX_TYPE_META[type]?.category === C.ACTION;

export const categoryOf = (type) => INBOX_TYPE_META[type]?.category ?? C.UPDATE;

export const labelOf = (type) => INBOX_TYPE_META[type]?.label ?? 'Notification';

/**
 * Where an item points, DERIVED (see the note on `INBOX_TYPES`).
 *
 * `prefix` is passed in rather than imported so this file stays free of any
 * dependency, including on `constants/hrms.js`. Callers pass
 * `HRMS_ROUTE_PREFIX`.
 */
export function hrefFor(type, prefix = '') {
  const path = INBOX_TYPE_META[type]?.path;
  // An unknown type still has to go somewhere sensible rather than nowhere.
  return `${prefix}${path ?? '/dashboard'}`;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * The most items one event may fan out to in a single write.
 *
 * An org-wide announcement is one `insertMany`, but a company of a hundred
 * thousand is still not one statement. 🔴 The reference loops single INSERTs
 * inside the producer's own transaction, so a 5,000-person announcement holds a
 * write transaction open for 5,000 round trips.
 */
export const INBOX_FANOUT_CHUNK = 500;

/** The unread badge stops counting here and renders "99+", as every app does. */
export const INBOX_BADGE_MAX = 99;

/** Poll intervals, in milliseconds — the reference's own 15s / 30s. */
export const INBOX_BADGE_POLL_MS = 15_000;
export const INBOX_LIST_POLL_MS = 30_000;

export const INBOX_TITLE_MAX = 200;
export const INBOX_BODY_MAX = 1000;

export default {
  INBOX_CATEGORIES,
  INBOX_CATEGORY_LIST,
  INBOX_TYPES,
  INBOX_TYPE_LIST,
  INBOX_TYPE_META,
  isActionable,
  categoryOf,
  labelOf,
  hrefFor,
  INBOX_FANOUT_CHUNK,
  INBOX_BADGE_MAX,
  INBOX_BADGE_POLL_MS,
  INBOX_LIST_POLL_MS,
  INBOX_TITLE_MAX,
  INBOX_BODY_MAX,
};
