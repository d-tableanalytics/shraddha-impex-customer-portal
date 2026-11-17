import { istYmd } from './businessDay.js';

/**
 * The default DISPATCH DATE of a booking line: 3 days after the booking date.
 *
 * Stored on the line's `scheduledDate` - the same per-line field the Sales Desk
 * edits from the booking's Delivery schedule panel and from the PO dialog, and
 * that the delivery schedule email prints - so there is one dispatch date per
 * line, not a default in one place and an edit in another. The desk can still
 * change or clear it; this only fills it in at confirmation.
 *
 * Counted in CALENDAR days from the booking's day in India (Asia/Kolkata), so a
 * booking made at 23:30 IST counts from that day, whatever zone the server runs
 * in. Stored as UTC midnight of the target day - exactly what a 'YYYY-MM-DD'
 * picked on the desk becomes (`new Date('2026-11-20')`) - so a default date and
 * a hand-picked one read back, display and compare identically everywhere.
 */
export const DEFAULT_DISPATCH_DAYS = 3;

export const defaultDispatchDate = (bookingDate, days = DEFAULT_DISPATCH_DAYS) => {
  const [y, m, d] = istYmd(bookingDate).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days));
};

export default { DEFAULT_DISPATCH_DAYS, defaultDispatchDate };
