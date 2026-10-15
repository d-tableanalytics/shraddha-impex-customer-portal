/**
 * Query keys and cache policy, in one place.
 *
 * Every key starts with its resource, so a mutation can invalidate a whole
 * resource (`queryKeys.dashboard.all`) without knowing which variants exist.
 * The cache is cleared on every change of account (lib/queryClient.js), so keys
 * do not need to carry the user.
 *
 * POLICY. Only data shown for READING is cached, and only for as long as the
 * table below says. Stock checks, booking confirmation, PO generation and every
 * other write go to the server every time and are never answered from here.
 */

export const STALE = {
  // Aggregate tiles and charts: a few seconds behind is fine, and every booking
  // change invalidates them anyway (see store/invalidation.js).
  dashboard: 30 * 1000,
  // The assignment queue drives stock decisions: always re-validated with the
  // server, but the last queue is shown at once while that happens.
  indentAssignment: 0,
};

export const queryKeys = {
  dashboard: {
    all: ["dashboard"],
    // `range` undefined = the server's default range (6 months).
    stats: (range) => ["dashboard", "stats", range ?? "default"],
  },
  indentAssignment: {
    all: ["indent-assignment"],
    queue: () => ["indent-assignment", "queue"],
  },
};
