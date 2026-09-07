/**
 * Raw-body capture for the biometric webhook's HMAC verification.
 *
 * ---------------------------------------------------------------------------
 * Why this has to exist at all
 * ---------------------------------------------------------------------------
 * The signature is computed over the EXACT bytes the device sent. Verifying it
 * against a re-serialised object cannot work: `JSON.stringify` of a parsed body
 * differs from the original in key order, whitespace and number formatting, so
 * honest senders would fail and a crafted body that parses identically would
 * pass.
 *
 * `express.json()` is applied globally in app.js, ahead of every router, and it
 * CONSUMES the request stream. By the time the HRMS router is reached there is
 * nothing left to read — a second body parser on the route sees an
 * already-parsed object and never gets bytes. This is the reason a webhook
 * cannot simply add `express.raw()` further down the stack, and it is why the
 * reference enables `rawBody` at bootstrap rather than in its controller.
 *
 * `verify` is the hook body-parser provides for exactly this: it runs with the
 * raw buffer in hand, before parsing, and is the standard Express solution for
 * signed webhooks.
 *
 * ---------------------------------------------------------------------------
 * Scoped to ONE path on purpose
 * ---------------------------------------------------------------------------
 * Capturing every request body would keep a second copy of every upload,
 * order and import payload in memory — up to the 10 MB JSON limit, on every
 * request, for the benefit of one route. The URL test below keeps the cost to
 * the webhook that needs it.
 */

import { HRMS_API_PREFIX } from '../../../shared/constants/hrms.js';

/** The one path whose raw bytes are kept. */
export const BIOMETRIC_PATH = `${HRMS_API_PREFIX}/attendance/biometric`;

/**
 * `express.json({ verify })` hook.
 *
 * Stashes the raw buffer on `req.rawBody` for the biometric webhook and does
 * nothing at all for every other request. Never throws: a body-parser `verify`
 * that throws turns into a 400 for the caller, and this is not the layer that
 * decides whether a request is valid.
 *
 * @param {object} req
 * @param {object} _res
 * @param {Buffer} buf
 */
export function captureBiometricRawBody(req, _res, buf) {
  // `req.originalUrl` rather than `req.url`: this runs before any router has
  // stripped its mount prefix, but a query string can still be attached.
  const url = req.originalUrl ?? req.url ?? '';
  if (buf?.length && url.split('?')[0].startsWith(BIOMETRIC_PATH)) {
    req.rawBody = buf;
  }
}

export default captureBiometricRawBody;
