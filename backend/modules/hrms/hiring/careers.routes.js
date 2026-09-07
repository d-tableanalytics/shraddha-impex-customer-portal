/**
 * The public careers surface, mounted at /api/v1/hrms/careers.
 *
 * ---------------------------------------------------------------------------
 * 🔴 THIS ROUTER IS MOUNTED OUTSIDE THE HRMS AUTHENTICATION CHAIN
 * ---------------------------------------------------------------------------
 * It is the second such surface, after the biometric webhook, and the reasoning
 * is the same: a job applicant has no account, and a candidate deciding on an
 * offer is not an employee yet. Express matches middleware in declaration
 * order, so mounting this ABOVE `router.use(protect)` is what leaves it
 * reachable — and putting it below would break it silently.
 *
 * What makes it safe:
 *
 *   - the LISTING exposes only published, unclosed adverts, and only the fields
 *     an advert needs. Headcount, budget and the business justification never
 *     cross
 *   - the OFFER routes are authorised by a 256-bit token in the path, stored
 *     hashed and compared in constant time. The reference keys these on the
 *     offer's own UUID, so anyone holding one can read a candidate's salary or
 *     accept on their behalf — the single worst defect in its hiring module
 *   - everything is RATE LIMITED, because it is unauthenticated by construction
 *     (AD-8)
 *   - refusals are audited: an endpoint that leaves no trace when refused gives
 *     an attacker unlimited quiet attempts
 *
 * Nothing else goes here.
 */

import express from 'express';
import rateLimit from 'express-rate-limit';

import { validate } from '../../../middlewares/validate.js';
import {
  publicApplySchema,
  acceptOfferSchema,
  rejectOfferSchema,
  offerTokenSchema,
} from '../../../shared/schemas/hiring.js';
import { hrmsErrorHandler } from '../hrms.errors.js';
import * as controller from './hiring.controller.js';

const router = express.Router();

/**
 * Browsing is cheap; applying and deciding are not.
 *
 * Two limiters rather than one, so a busy careers page does not exhaust the
 * budget that protects the write paths.
 */
const browseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.HRMS_CAREERS_BROWSE_RATE_LIMIT ?? 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again shortly.' },
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.HRMS_CAREERS_WRITE_RATE_LIMIT ?? 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again later.' },
});

/**
 * Reject a malformed token before it reaches a database query.
 *
 * The token is the only credential these routes have, so it is validated as
 * strictly as one: 64 hex characters, nothing else. A caller probing with
 * `../` or an ObjectId never gets past this.
 */
const validateToken = (req, res, next) => {
  const parsed = offerTokenSchema.safeParse(req.params.token);
  if (!parsed.success) {
    // Deliberately the same 404 an unknown token gets. A different response for
    // "malformed" and "not found" tells an attacker when they have the shape
    // right.
    return res.status(404).json({ success: false, message: 'Offer not found.' });
  }
  req.params.token = parsed.data;
  return next();
};

// ---------------------------------------------------------------------------
// Open roles
// ---------------------------------------------------------------------------

router.get('/postings', browseLimiter, controller.publicListRoles);
router.get('/postings/:slug', browseLimiter, controller.publicGetRole);

router.post(
  '/postings/:slug/apply',
  writeLimiter,
  validate({ body: publicApplySchema }),
  controller.publicApply,
);

// ---------------------------------------------------------------------------
// Offers — authorised by the token, never by an id
// ---------------------------------------------------------------------------

router.get('/offer/:token', browseLimiter, validateToken, controller.publicViewOffer);

router.post(
  '/offer/:token/accept',
  writeLimiter,
  validateToken,
  validate({ body: acceptOfferSchema }),
  controller.publicAcceptOffer,
);

router.post(
  '/offer/:token/reject',
  writeLimiter,
  validateToken,
  validate({ body: rejectOfferSchema }),
  controller.publicRejectOffer,
);

/**
 * The HRMS error handler, mounted here too.
 *
 * This router sits ABOVE the one in `hrms.routes.js`, so it never reaches it —
 * without this, a `HrmsNotFoundError` from an unknown token would fall through
 * to the portal's handler and surface as a 500.
 */
router.use(hrmsErrorHandler);

export default router;
