/**
 * Targeted rate limiting (AD-8).
 *
 * ---------------------------------------------------------------------------
 * Deliberately NOT a global limiter
 * ---------------------------------------------------------------------------
 * `app.js` records why the portal has none: "a single page load costs several
 * requests, and any per-IP ceiling tight enough to matter locked real users out
 * mid-task." That finding still holds, and nothing here changes it — every
 * existing portal route stays unthrottled.
 *
 * What changed is that payroll, PAN and bank details now sit behind the same
 * login (AD-10, AD-14). So the LOGIN needs protecting, and so does the
 * unauthenticated surface. Those, and nothing else.
 *
 * `express-rate-limit` was already a dependency and `app.set('trust proxy', 1)`
 * was already set — without the latter every user behind nginx would share one
 * identity and a per-IP limit would throttle the whole customer base as one
 * client.
 *
 * Store: the default in-memory one is correct here because ecosystem.config.cjs
 * runs `exec_mode: 'fork'` with `instances: 1`. If PM2 ever moves to cluster
 * mode, each worker would enforce its own independent ceiling and this needs a
 * shared store.
 */

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const MINUTE = 60 * 1000;

/** Consistent 429 body, matching the API's `{ success, message }` shape. */
const tooMany = (message) => (req, res) =>
  res.status(429).json({ success: false, message });

const base = {
  standardHeaders: true,
  legacyHeaders: false,
};

/**
 * Login.
 *
 * Keyed on IP **and** email together. IP alone lets one NAT'd office lock out
 * its own staff, and lets credential-stuffing spread across many accounts from
 * a rotating address. Including the email means an attacker gets few attempts
 * per account regardless of where they come from, while a genuine user
 * mistyping their own password never affects a colleague.
 */
export const loginLimiter = rateLimit({
  ...base,
  windowMs: 15 * MINUTE,
  limit: 5,
  // ipKeyGenerator, not req.ip: express-rate-limit v8 requires it so that IPv6
  // clients are bucketed by /64 subnet rather than by a single address, which
  // an attacker can rotate through freely.
  keyGenerator: (req) => {
    const email = String(req.body?.email ?? '').toLowerCase().trim();
    return `${ipKeyGenerator(req.ip)}|${email}`;
  },
  // A successful sign-in should not consume the allowance.
  skipSuccessfulRequests: true,
  handler: tooMany('Too many sign-in attempts. Please try again in a few minutes.'),
});

/**
 * Token refresh. Looser than login: a legitimate client refreshes on every
 * session resume and on every tab, so this is a runaway guard, not a gate.
 */
export const refreshLimiter = rateLimit({
  ...base,
  windowMs: 15 * MINUTE,
  limit: 30,
  handler: tooMany('Too many refresh attempts. Please sign in again.'),
});

/** Password change and admin reset. Keyed per account where one is known. */
export const passwordLimiter = rateLimit({
  ...base,
  windowMs: 15 * MINUTE,
  limit: 5,
  keyGenerator: (req) => String(req.user?._id ?? req.params?.id ?? ipKeyGenerator(req.ip)),
  handler: tooMany('Too many password attempts. Please try again in a few minutes.'),
});

/**
 * Public, unauthenticated endpoints — the careers pages when they ship (AD-15
 * scope note; still-open item 7). The largest unauthenticated write surface in
 * the system, so it gets the tightest ceiling.
 */
export const publicFormLimiter = rateLimit({
  ...base,
  windowMs: 60 * MINUTE,
  limit: 10,
  handler: tooMany('Too many submissions. Please try again later.'),
});

/**
 * Biometric device webhook. HMAC-verified, but an unauthenticated endpoint that
 * writes should still not be an unbounded ingress.
 */
export const webhookLimiter = rateLimit({
  ...base,
  windowMs: 1 * MINUTE,
  limit: 120,
  handler: tooMany('Webhook rate limit exceeded.'),
});

/**
 * Exports and reports. Not an abuse guard so much as a cost guard: these run
 * expensive aggregations and stream large files on a memory-constrained box.
 */
export const exportLimiter = rateLimit({
  ...base,
  windowMs: 1 * MINUTE,
  limit: 10,
  keyGenerator: (req) => String(req.user?._id ?? ipKeyGenerator(req.ip)),
  handler: tooMany('Too many exports in a short period. Please wait a moment.'),
});

export default {
  loginLimiter,
  refreshLimiter,
  passwordLimiter,
  publicFormLimiter,
  webhookLimiter,
  exportLimiter,
};
