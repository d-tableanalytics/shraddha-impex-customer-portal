/**
 * Access and refresh tokens.
 *
 * The portal previously issued a single JWT with a 1-day lifetime, stored it in
 * localStorage, and had no way to revoke it: logout was `localStorage.removeItem`
 * on the client, so a stolen token stayed valid for its full life.
 *
 * This adds the standard pair:
 *
 *   access token   short-lived (15m), sent as a Bearer header, never stored
 *                  anywhere durable
 *   refresh token  long-lived (7d), delivered ONLY as an httpOnly cookie, so
 *                  JavaScript - and therefore XSS - cannot read it
 *
 * Rotation and reuse detection: each refresh issues a new token and stores a
 * hash of it. Presenting a refresh token that does not match the stored hash
 * means the previous one was replayed, so every session for that user is
 * revoked rather than merely refusing the request.
 *
 * AD-14 makes the httpOnly cookie practical: HRMS is served from the same
 * origin as the portal, so there is no cross-site cookie problem to work
 * around. (`cookie-parser` was already mounted, and `middlewares/auth.js`
 * already read `req.cookies.accessToken` - the plumbing existed before the
 * flow did.)
 */

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

/**
 * Access-token lifetime.
 *
 * `JWT_EXPIRES_IN` is the portal's existing variable and is still honoured, so
 * an environment that sets it keeps its current behaviour. New deployments get
 * the short default.
 */
export const ACCESS_TOKEN_TTL = process.env.JWT_ACCESS_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '15m';
export const REFRESH_TOKEN_TTL = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

/** Refresh cookie name and lifetime, in milliseconds. */
export const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_COOKIE_MAX_AGE_MS = ttlToMs(REFRESH_TOKEN_TTL, 7 * 24 * 60 * 60 * 1000);

const accessSecret = () => process.env.JWT_SECRET;
/**
 * The refresh secret is separate where configured, so an access token can never
 * be replayed as a refresh token. It falls back to JWT_SECRET (with a distinct
 * `type` claim still separating them) so an environment that has not set it
 * keeps working.
 */
const refreshSecret = () => process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;

/**
 * Sign an access token.
 *
 * The payload keeps `id` as its subject claim - `middlewares/auth.js` reads
 * `decoded.id`, and every previously issued token has it - so nothing about
 * verification changes.
 */
export function signAccessToken(userId) {
  return jwt.sign({ id: String(userId), type: 'access' }, accessSecret(), {
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

/**
 * Sign a refresh token.
 *
 * `jti` is random per issue, so two refreshes seconds apart still produce
 * different tokens and therefore different stored hashes - rotation cannot
 * collide.
 */
export function signRefreshToken(userId) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ id: String(userId), type: 'refresh', jti }, refreshSecret(), {
    expiresIn: REFRESH_TOKEN_TTL,
  });
  return { token, jti };
}

/** Verify a refresh token. Returns the payload, or null if it is not valid. */
export function verifyRefreshToken(token) {
  try {
    const payload = jwt.verify(token, refreshSecret());
    if (payload?.type !== 'refresh') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Hash a refresh token for storage.
 *
 * SHA-256 rather than bcrypt: the token is already 200+ bits of unguessable
 * entropy, so a slow KDF buys nothing, and refresh runs on every session
 * resume. The hash exists so a database leak does not yield usable sessions.
 */
export const hashRefreshToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

/** Constant-time comparison of two refresh-token hashes. */
export function refreshHashMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Cookie options for the refresh token.
 *
 *   httpOnly  JavaScript cannot read it, so XSS cannot exfiltrate it
 *   secure    HTTPS only in production; disabled in development so local
 *             http://localhost still works
 *   sameSite  'strict' - AD-14 keeps everything same-site, so nothing legitimate
 *             is lost. Ports do not affect SameSite, so the dev server on :5173
 *             talking to the API on :5000 still sends it
 *   path      scoped to the auth routes: the cookie is not attached to the
 *             hundreds of ordinary API calls that have no use for it
 */
export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
  };
}

/** Options for clearing the cookie. Must match everything except maxAge. */
export function clearRefreshCookieOptions() {
  const { maxAge, ...rest } = refreshCookieOptions();
  void maxAge;
  return rest;
}

/** Parse a JWT-style TTL ("15m", "7d", "45s") to milliseconds. */
export function ttlToMs(ttl, fallback) {
  const m = /^(\d+)\s*([smhd])$/.exec(String(ttl).trim());
  if (!m) return fallback;
  const value = Number(m[1]);
  const unit = m[2];
  const factor = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * factor;
}

/** Seconds until the access token expires - handy for a client-side timer. */
export const accessTokenExpiresInMs = () => ttlToMs(ACCESS_TOKEN_TTL, 15 * 60_000);

export default {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashRefreshToken,
  refreshHashMatches,
  refreshCookieOptions,
  clearRefreshCookieOptions,
  REFRESH_COOKIE_NAME,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
};
