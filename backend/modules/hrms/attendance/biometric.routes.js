/**
 * The biometric ingestion webhook, mounted at
 * /api/v1/hrms/attendance/biometric.
 *
 * ---------------------------------------------------------------------------
 * 🔴 THIS ROUTER IS MOUNTED OUTSIDE THE HRMS AUTHENTICATION CHAIN
 * ---------------------------------------------------------------------------
 * It is the ONLY HRMS surface that is. A punch clock has no session and cannot
 * hold a JWT, so authentication is an HMAC-SHA256 signature over the raw
 * request body, verified with a shared secret. That is the reference's design
 * and it is sound; what follows is what makes it safe here.
 *
 *   - The endpoint DOES NOT EXIST unless a secret of at least 16 characters is
 *     configured. The reference reads its secret from a config schema, and an
 *     empty one would still produce a valid HMAC — every payload signed with
 *     the empty key would be accepted. Here it 503s instead.
 *   - The RAW body is what is signed and what is verified. The global
 *     `express.json` in app.js consumes the stream before any router runs, so
 *     the bytes are captured by its `verify` hook — see ./rawBody.js. A body
 *     parser mounted here would only ever see an already-parsed object.
 *   - Rate limited, because it is unauthenticated by construction (AD-8).
 *   - Rejections are audited. An endpoint that writes attendance and leaves no
 *     trace when refused gives an attacker unlimited quiet attempts.
 *
 * AD-1 removed the reference's `:orgSlug` path parameter: single tenant, so
 * there is no organisation to resolve and no slug to leak.
 */

import express from 'express';
import rateLimit from 'express-rate-limit';

import { biometricIngestSchema } from '../../../shared/schemas/attendance.js';
import { formatZodIssues } from '../../../shared/validation/common.js';
import {
  verifySignature,
  ingest,
  isBiometricIngestEnabled,
  auditRejection,
  BiometricAuthError,
} from './biometric.service.js';
import { MAX_BIOMETRIC_PUNCHES } from '../../../shared/constants/attendance.js';

const router = express.Router();

/**
 * A generous ceiling for a legitimate fleet of devices replaying a backlog,
 * and a hard one for anything else. AD-8's targeted-limiter pattern.
 */
const biometricLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.HRMS_BIOMETRIC_RATE_LIMIT ?? 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many biometric ingestion requests.' },
});

/**
 * Body size ceiling for an UNAUTHENTICATED caller.
 *
 * 500 punches of roughly 300 bytes each is under 200 KB. The global JSON limit
 * is 10 MB, which is far too generous for a route anyone on the internet can
 * post to, so this is checked before the signature — refusing early costs less
 * than hashing megabytes of someone's junk.
 */
const MAX_BODY_BYTES = 1024 * 1024;

router.post('/', biometricLimiter, async (req, res, next) => {
  try {
    if (!isBiometricIngestEnabled()) {
      // Not 404: the route exists and is simply not configured. 503 says that
      // truthfully, and matches how the codebase reports an uninstalled
      // capability everywhere else.
      return res.status(503).json({
        success: false,
        message: 'Biometric ingestion is not configured on this server.',
        code: 'HRMS_NOT_IMPLEMENTED',
      });
    }

    const rawBody = req.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      // The `verify` hook in app.js did not run for this request, which means
      // the wiring is broken rather than the caller being at fault. Failing
      // closed and loudly is the only safe answer: the alternative is
      // verifying a signature against bytes we do not have.
      await auditRejection('raw body was not captured — biometric HMAC cannot be verified', {
        ip: req.ip,
      });
      return res.status(500).json({
        success: false,
        message: 'Biometric ingestion is misconfigured on this server.',
      });
    }

    if (rawBody.length > MAX_BODY_BYTES) {
      await auditRejection('payload exceeds the biometric body limit', {
        ip: req.ip,
        bytes: rawBody.length,
      });
      return res.status(413).json({ success: false, message: 'Payload too large.' });
    }

    // Signature FIRST, before the parsed body is looked at in any way. An
    // unauthenticated caller must not reach the business logic on the strength
    // of a payload nobody has authenticated.
    try {
      verifySignature(rawBody, req.get('x-signature'));
    } catch (error) {
      if (error instanceof BiometricAuthError) {
        await auditRejection(error.message, {
          ip: req.ip,
          userAgent: req.get('user-agent') ?? null,
          bytes: rawBody.length,
        });
        return res.status(error.statusCode).json({ success: false, message: error.message });
      }
      throw error;
    }

    const parsed = biometricIngestSchema.safeParse(req.body);
    if (!parsed.success) {
      await auditRejection('payload failed validation', {
        ip: req.ip,
        issues: formatZodIssues(parsed.error),
      });
      return res.status(400).json({
        success: false,
        message: `Invalid biometric payload. Send between 1 and ${MAX_BIOMETRIC_PUNCHES} canonical punches.`,
        errors: formatZodIssues(parsed.error),
      });
    }

    const data = await ingest(parsed.data);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

export default router;
