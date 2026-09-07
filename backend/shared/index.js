/**
 * Barrel for the shared HRMS foundation.
 *
 * Prefer importing the specific sub-module - `shared/permissions/index.js`,
 * `shared/constants/hrms.js` - so a consumer that needs only the
 * dependency-free parts never pulls Zod into its graph. This barrel exists for
 * convenience where that does not matter.
 */

export * from './permissions/index.js';
export * from './constants/hrms.js';
export * from './security/sensitive-fields.js';
