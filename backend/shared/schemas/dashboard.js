/**
 * Dashboard wire contracts (AD-6).
 *
 * One input, and it is an enum: the chart's window. Everything else the
 * dashboard shows is derived from the session's own actor, so there is nothing
 * else for a caller to supply — and nothing to validate away.
 */

import { z } from 'zod';

import { LOGIN_TREND_RANGE_LIST } from '../constants/dashboard.js';

/**
 * The reference's 7d / 14d / 30d, as a closed enum rather than a number.
 *
 * A free `days` integer would let a caller ask for a five-year aggregation over
 * the audit log from a page that is polled on every visit.
 */
export const dashboardRangeQuery = z.object({
  range: z.enum(LOGIN_TREND_RANGE_LIST).default('7d'),
});

export default { dashboardRangeQuery };
