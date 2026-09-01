/**
 * Retention handler registry (AD-16).
 *
 * Each module that owns a retention category registers how to sweep it. The
 * sweep itself knows nothing about employees, selfies or payslips - it reads
 * the configured rule and calls the handler.
 *
 * That inversion matters for a reason beyond tidiness: a category with NO
 * registered handler is skipped and REPORTED, rather than silently doing
 * nothing. Adding a retention category in config without implementing its sweep
 * would otherwise look like it was working.
 */

import { RETENTION_CATEGORY_LIST } from '../../../shared/constants/hrms.js';

/**
 * @type {Map<string, {
 *   sweep: (params: { cutoff: Date, action: string, dryRun: boolean, batchSize: number })
 *            => Promise<{ scanned: number, affected: number, failed?: number, notes?: string[] }>,
 *   description?: string,
 * }>}
 */
const handlers = new Map();

export function registerRetentionHandler(category, handler) {
  if (!RETENTION_CATEGORY_LIST.includes(category)) {
    throw new Error(`registerRetentionHandler: unknown retention category "${category}"`);
  }
  if (typeof handler?.sweep !== 'function') {
    throw new TypeError('registerRetentionHandler: handler.sweep must be a function');
  }
  handlers.set(category, handler);
}

export const getRetentionHandler = (category) => handlers.get(category) ?? null;
export const registeredRetentionCategories = () => [...handlers.keys()];

/** Test seam. */
export function __resetRetentionHandlers() {
  handlers.clear();
}
