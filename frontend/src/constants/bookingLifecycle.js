/**
 * The booking lifecycle, as the customer sees it.
 *
 * Mirrors backend/utils/bookingLifecycle.js — the same four stages, the same
 * labels, and the same one-line descriptions that go into the status emails, so
 * the portal and the customer's inbox never appear to describe different
 * things. Keep the two files in step; the backend copy is the authority for the
 * stored `key` values.
 *
 * `key` is the status stored on the Order document. It differs from `label`
 * only for the first stage: the database has always held 'PO Received', but the
 * customer is told "Booking Received", which is what happened from their side.
 */

export const BOOKING_LIFECYCLE = [
  {
    key: "PO Received",
    label: "Booking Received",
    description: "Your booking has been successfully received and is being processed.",
    nextStep:
      "We will email you as soon as it is prepared and ready for dispatch.",
  },
  {
    key: "Ready for Dispatch",
    label: "Ready for Dispatch",
    description: "Your booking has been processed and is now ready to be dispatched.",
    nextStep: "We will notify you once it has been dispatched.",
  },
  {
    key: "Dispatched",
    label: "Dispatched",
    description: "Your booking has been dispatched and is on its way.",
    nextStep: "You will receive a final confirmation once it has been delivered.",
  },
  {
    key: "Delivered",
    label: "Delivered",
    description: "Your booking has been successfully delivered.",
    nextStep: null,
  },
];

/** Statuses that end the lifecycle rather than advancing it. */
export const TERMINAL_STATUSES = ["Cancelled"];

/** Legacy rows predating the lifecycle count as the first stage. */
export const normalizeStatus = (status) =>
  status === "Booked" ? "PO Received" : status;

export const stageOf = (status) => {
  const key = normalizeStatus(status);
  return BOOKING_LIFECYCLE.find((s) => s.key === key) || null;
};

export const stageIndex = (status) =>
  BOOKING_LIFECYCLE.findIndex((s) => s.key === normalizeStatus(status));

export const stageLabel = (status) => stageOf(status)?.label || status || "—";

/** The stage after `status`, or null at the end of the lifecycle. */
export const nextStageOf = (status) => {
  const idx = stageIndex(status);
  return idx >= 0 && idx < BOOKING_LIFECYCLE.length - 1
    ? BOOKING_LIFECYCLE[idx + 1].key
    : null;
};

/**
 * The stage a booking as a whole is at, from its line-item rows.
 *
 * The LEAST advanced stage any live line sits at — a booking with one line
 * dispatched and one still being prepared has not been dispatched. Mirrors
 * bookingStatusOf() on the server so both agree about what to display and what
 * to announce. Cancelled lines are ignored unless every line is cancelled.
 */
export const bookingStatusOf = (rows = []) => {
  const live = rows.filter((r) => !TERMINAL_STATUSES.includes(r.status));
  if (!live.length) return rows.length ? rows[0].status : null;

  let lowest = null;
  for (const row of live) {
    const idx = stageIndex(row.status);
    if (idx < 0) return normalizeStatus(row.status);
    if (lowest === null || idx < lowest) lowest = idx;
  }
  return BOOKING_LIFECYCLE[lowest].key;
};

/** Date and time of a status update, matching the wording used in the emails. */
export const fmtStatusDateTime = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
};
