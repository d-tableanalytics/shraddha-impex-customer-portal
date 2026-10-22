import { queryClient } from "../lib/queryClient";
import { queryKeys } from "../lib/queryKeys";

/**
 * "A booking changed" — mark every screen that shows bookings as out of date.
 *
 * Screens now reuse recently loaded data when revisited instead of downloading
 * it again on every visit. That is only correct if a change made on ONE screen
 * makes the others re-read: confirming a booking on New Booking must not leave
 * Booking History, the Sales Desk or the dashboard tiles showing the position
 * from before it.
 *
 * Stores register a marker here (rather than this file importing them) so there
 * is no import cycle; a marker only flags data stale — the next visit, or a
 * screen already open that asks, does the re-read.
 */

const markers = new Set();

export const registerStaleMarker = (fn) => {
  markers.add(fn);
  return () => markers.delete(fn);
};

/**
 * Call after any successful write that changes bookings, indents, allocations or
 * the selection list. Cheap; safe to call more than needed. Resolves once any
 * query currently on screen has been re-read, for a caller that wants to wait.
 */
export const invalidateBookingData = () => {
  for (const mark of markers) {
    try {
      mark();
    } catch (err) {
      console.error("[invalidation] a store failed to mark itself stale:", err);
    }
  }
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.indentAssignment.all }),
    // Upcoming Stock lists each SKU's open indents.
    queryClient.invalidateQueries({ queryKey: queryKeys.upcomingStock.all }),
  ]);
};
