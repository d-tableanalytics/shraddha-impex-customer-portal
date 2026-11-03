import { isMultipleOf, moqAppliesTo } from "../../utils/moq";

/**
 * Line checks shared by the two ways a Selection List is confirmed: the review
 * popup (Sales) and the direct Confirm Booking (customers, who are not shown
 * the popup). Both must refuse the same lines, so the rule lives once.
 */

/** The MOQ multiple a line's quantity must respect, or 0 when none applies. */
export const lineMultiple = (user, line) => {
  if (!moqAppliesTo(user)) return 0;
  const moq = Number(line.product.moq) || 0;
  return moq > 1 ? moq : 0;
};

/** Lines whose quantity cannot be booked as it stands. */
export const invalidBookingLines = (user, lines) =>
  lines.filter((l) => {
    const m = lineMultiple(user, l);
    return !Number.isInteger(l.orderQuantity) || l.orderQuantity < 1 || (m && !isMultipleOf(l.orderQuantity, m));
  });
