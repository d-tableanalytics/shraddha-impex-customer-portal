/** Time-remaining formatting for the PO deadline countdown. */

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Human-readable time left, coarsening as the window widens:
 *   > 1 day  → "5d 3h left"
 *   > 1 hour → "7h 12m left"
 *   else     → "43m left"
 * Non-positive input reads as "Overdue".
 */
export const formatRemaining = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return "Overdue";
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
};

export default { formatRemaining, MINUTE, HOUR, DAY };
