/**
 * The booking lifecycle — one definition, used by every part of the flow.
 *
 * The admin panel advances a booking through four stages. The stage a booking
 * sits at drives three separate things: the badge and timeline the customer
 * sees, the wording of the email they are sent, and the history row written for
 * the audit trail. Those were previously three sets of hard-coded strings in
 * three files, which is how a lifecycle ends up with a stage renamed in the UI
 * but not in the mail.
 *
 * `key` is the value STORED on the Order document; `label` is display-only.
 * They differ for the first stage — the database has always held 'PO Received'
 * and existing rows cannot be rewritten safely, but customers are told
 * "Booking Received", which is what actually happened from their side. Renaming
 * a label is therefore free; changing a key is a data migration.
 *
 * The frontend mirrors this file at src/constants/bookingLifecycle.js — keep the
 * two in step.
 */

export const BOOKING_LIFECYCLE = [
  {
    key: 'PO Received',
    label: 'Booking Received',
    // Subject lines follow the brief: "Your Booking #<id> is Ready for Dispatch",
    // with the noun and the reference swapping to Purchase Order once one is
    // raised — see utils/transactionTerms.js.
    subject: (ref, noun = 'Booking') => `Your ${noun} #${ref} has been Received`,
    // One sentence describing the stage the booking has just reached.
    description: (noun = 'booking') => `Your ${noun} has been successfully received and is being processed.`,
    // What happens next. Null on the terminal stage, where there is no next step.
    nextStep: (noun = 'booking') => 'No action is needed from your side — we will email you again '
      + `as soon as your ${noun} is prepared and ready for dispatch.`,
    // In-app bell notification wording.
    notification: 'has been received and is being processed',
  },
  {
    key: 'Ready for Dispatch',
    label: 'Ready for Dispatch',
    subject: (ref, noun = 'Booking') => `Your ${noun} #${ref} is Ready for Dispatch`,
    description: (noun = 'booking') => `Your ${noun} has been processed and is now ready for dispatch.`,
    nextStep: 'We will notify you once it has been dispatched.',
    notification: 'is ready for dispatch',
  },
  {
    key: 'Dispatched',
    label: 'Dispatched',
    subject: (ref, noun = 'Booking') => `Your ${noun} #${ref} has been Dispatched`,
    description: (noun = 'booking') => `Your ${noun} has been dispatched and is on its way.`,
    nextStep: 'You will receive a final confirmation once it has been delivered. '
      + 'Please keep your PO reference handy for the delivery.',
    notification: 'has been dispatched',
  },
  {
    key: 'Delivered',
    label: 'Delivered',
    subject: (ref, noun = 'Booking') => `Your ${noun} #${ref} has been Delivered`,
    description: (noun = 'booking') => `Your ${noun} has been successfully delivered.`,
    nextStep: null,
    notification: 'has been delivered',
  },
];

/**
 * Stages a booking can hold that are NOT part of the forward lifecycle.
 *
 * 'Booked' is the pre-lifecycle status of rows created before the four stages
 * existed; it is treated as the first stage everywhere rather than migrated,
 * because a legacy row genuinely is a received booking. 'Cancelled' ends the
 * lifecycle and is recorded in the timeline, but is not one of the four stages
 * and carries no lifecycle email — cancellation has its own notification path.
 */
export const LEGACY_FIRST_STAGE = 'Booked';
export const TERMINAL_STATUSES = ['Cancelled'];

/** Map a stored status onto its lifecycle key. Legacy 'Booked' is stage one. */
export const normalizeStatus = (status) =>
  status === LEGACY_FIRST_STAGE ? 'PO Received' : status;

/**
 * Resolve a stage's customer-facing copy for the noun in force.
 *
 * `description` and `nextStep` are declared as either a plain string or a
 * function of the noun, depending on whether the sentence mentions the
 * transaction at all ("We will notify you once it has been dispatched" reads
 * the same either way). Callers must not care which: they ask here and get
 * strings, so no template has to remember to invoke one and not the other.
 */
export const stageCopy = (stage, noun = 'booking') => {
  const text = (v) => (typeof v === 'function' ? v(noun) : (v || ''));
  return {
    label: stage?.label ?? '',
    description: text(stage?.description),
    nextStep: text(stage?.nextStep),
  };
};

/** The lifecycle entry for a stored status, or null for Cancelled/unknown. */
export const stageOf = (status) => {
  const key = normalizeStatus(status);
  return BOOKING_LIFECYCLE.find((s) => s.key === key) || null;
};

/** Position in the lifecycle, or -1 for a status that is not one of the stages. */
export const stageIndex = (status) => {
  const key = normalizeStatus(status);
  return BOOKING_LIFECYCLE.findIndex((s) => s.key === key);
};

/** Display name for any status, lifecycle stage or not. */
export const stageLabel = (status) => stageOf(status)?.label || status || '—';

/** True when a status change into `status` should send the customer an email. */
export const isNotifiableStage = (status) => stageIndex(status) >= 0;

/**
 * The stage a whole booking is at, given its line-item rows.
 *
 * A booking is stored as one Order document per SKU sharing an orderId, so
 * "the booking's status" is a derived value. It is the LEAST advanced stage any
 * live line sits at: a booking with one line dispatched and one still being
 * prepared has not been dispatched, and telling the customer otherwise is worse
 * than telling them nothing. Cancelled lines are ignored unless every line is
 * cancelled, in which case the booking itself is cancelled.
 *
 * The frontend derives the same value the same way — see services/orders.js.
 */
export const bookingStatusOf = (rows = []) => {
  const live = rows.filter((r) => !TERMINAL_STATUSES.includes(r.status));
  if (!live.length) return rows.length ? rows[0].status : null;

  let lowest = null;
  for (const row of live) {
    const idx = stageIndex(row.status);
    // A status that is not a lifecycle stage at all cannot be ranked, so it is
    // reported as-is rather than being silently sorted into the sequence.
    if (idx < 0) return normalizeStatus(row.status);
    if (lowest === null || idx < lowest) lowest = idx;
  }
  return BOOKING_LIFECYCLE[lowest].key;
};

export default {
  BOOKING_LIFECYCLE,
  TERMINAL_STATUSES,
  normalizeStatus,
  stageOf,
  stageIndex,
  stageLabel,
  isNotifiableStage,
  bookingStatusOf,
};
