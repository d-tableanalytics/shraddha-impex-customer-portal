/**
 * Access and refresh tokens.
 *
 * The portal previously issued a single JWT with a 1-day lifetime, stored it in
 * localStorage, and had no way to revoke it: logout was `localStorage.removeItem`
 * on the client, so a stolen token stayed valid for its full life.
 *
 * This adds the standard pair:
 *
 *   access token   sent as a Bearer header. Its lifetime is
 *                  JWT_ACCESS_EXPIRES_IN / JWT_EXPIRES_IN, defaulting to 1 day
 *                  — see the note on `accessTokenTtl` for why the previous 15m
 *                  default was being applied even when .env said otherwise.
 *   refresh token  long-lived (7d), delivered ONLY as an httpOnly cookie, so
 *                  JavaScript - and therefore XSS - cannot read it
 *
 * Rotation and reuse detection: each refresh issues a new token and stores a
 * hash of it. Presenting a token that does not match is a replay.
 *
 * WHAT CHANGED, AND WHY IT HAD TO
 *
 * Reuse detection used to be scoped to the ACCOUNT — one hash on the user, and
 * any mismatch nulled it, revoking every session. In production that fired on
 * 28% of all refresh attempts, because two ordinary things look exactly like a
 * replay under that model: a second browser tab, and a second device. The hash
 * is now per SESSION (`User.refreshSessions`), with a short grace window for a
 * token that was rotated moments ago by a racing tab. Detection still fires; it
 * just no longer takes the account's other devices down with it.
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
 * ⚠ READ BEFORE MAKING THESE `const` AGAIN.
 *
 * These used to be module-level constants:
 *
 *     export const ACCESS_TOKEN_TTL = process.env.JWT_ACCESS_EXPIRES_IN || ... || '15m';
 *
 * and that silently did not work. `server.js` calls `dotenv.config()` at line 25
 * — AFTER the whole ESM import graph has been evaluated, because `import`
 * statements are hoisted and run first. So a module-level read of
 * `process.env.JWT_EXPIRES_IN` in this file ran before `.env` existed, saw
 * `undefined`, and fell through to the hardcoded default.
 *
 * The effect: `JWT_EXPIRES_IN=1d` had been sitting in `backend/.env` doing
 * NOTHING, and every access token was 15 minutes. Verified by executing the real
 * modules in app.js's own import order — a signed token decoded to
 * `exp - iat = 900`. That short token is what made every open tab expire
 * together every quarter hour and pile onto /auth/refresh at once.
 *
 * The compiled-in default is now 1 day, matching what the deployment always
 * intended. It is a DEFAULT rather than a hardcoded value: a server that sets
 * JWT_ACCESS_EXPIRES_IN or JWT_EXPIRES_IN still wins, so the length stays an
 * operational decision. Making the default match the intent means a deployment
 * whose .env lacks the line does not silently fall back to a quarter hour.
 *
 * Functions, not constants, so the value is read when it is USED — by which
 * time dotenv has run no matter where in the graph the caller sits. The secrets
 * below were already lazy for exactly this reason (see `accessSecret`); the TTLs
 * simply were not.
 *
 * Kept as getters rather than moving `dotenv.config()` earlier because that
 * would re-time every module-level env read in the entire program, and this is
 * the only one that was wrong.
 */
export const ACCESS_TOKEN_TTL_DEFAULT = '1d';

export const accessTokenTtl = () =>
  process.env.JWT_ACCESS_EXPIRES_IN || process.env.JWT_EXPIRES_IN || ACCESS_TOKEN_TTL_DEFAULT;
export const refreshTokenTtl = () => process.env.JWT_REFRESH_EXPIRES_IN || '7d';

/** Refresh cookie name, and its lifetime in milliseconds. */
export const REFRESH_COOKIE_NAME = 'refreshToken';
const refreshCookieMaxAgeMs = () => ttlToMs(refreshTokenTtl(), 7 * 24 * 60 * 60 * 1000);

/**
 * How long a just-rotated refresh token stays acceptable.
 *
 * Two tabs of the same session expire at the same instant and both post
 * /auth/refresh. The first rotates; the second arrives milliseconds later still
 * holding the token that was current when it set off. Without a window that is
 * indistinguishable from a replayed token, and the account gets signed out for
 * doing nothing but having two tabs open.
 *
 * 60s is far longer than any legitimate race (they are typically <1s apart) and
 * far shorter than any useful attack window — a stolen token is only usable
 * inside the minute after the victim's own rotation, and using it does not
 * displace the victim's session or grant a refresh token of its own.
 */
export const REFRESH_GRACE_MS = Number(process.env.JWT_REFRESH_GRACE_MS) || 60_000;

/**
 * Most concurrent sessions one account may hold.
 *
 * A ceiling rather than unbounded growth: without one, a user who signs in from
 * a new private window every day accumulates a row per visit forever, and the
 * document grows without limit. When the cap is reached the LEAST RECENTLY USED
 * session is dropped, which is the one the person is least likely to still be
 * sitting in front of.
 */
export const MAX_REFRESH_SESSIONS = Number(process.env.JWT_MAX_SESSIONS) || 10;

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
    expiresIn: accessTokenTtl(),
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
    expiresIn: refreshTokenTtl(),
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
 * Is the SPA served from a different site than this API?
 *
 * ---------------------------------------------------------------------------
 * THE SPLIT-HOST DEPLOYMENT, AND WHY THIS CANNOT BE INFERRED
 * ---------------------------------------------------------------------------
 *
 * AD-14 assumed one origin serves both halves, which is true behind the nginx
 * config in `deploy/` and false the moment the SPA goes to Vercel and the API to
 * Render: `app.vercel.app` and `api.onrender.com` are different registrable
 * domains, so every request between them is CROSS-SITE.
 *
 * A `SameSite=Strict` cookie is simply not sent on a cross-site request. The
 * failure is quiet and looks like nothing at all: login succeeds, the app works
 * for one access-token lifetime, and then every refresh 401s with "No refresh
 * token" because the browser never attached it. Users describe it as "it logs
 * me out every fifteen minutes".
 *
 * EXPLICIT, not inferred. The API cannot reliably know its own public origin —
 * behind a proxy it sees an internal host — so comparing it with FRONTEND_URL
 * would be guesswork that fails open. `SameSite=None` genuinely widens the CSRF
 * surface, so it should be a decision somebody made, recorded in the
 * deployment's environment, rather than something a hostname comparison turned
 * on by accident.
 */
const crossSiteCookies = () => process.env.CROSS_SITE_COOKIES === 'true';

/**
 * Cookie options for the refresh token.
 *
 *   httpOnly  JavaScript cannot read it, so XSS cannot exfiltrate it
 *   secure    HTTPS only in production; disabled in development so local
 *             http://localhost still works. FORCED ON when cross-site, because
 *             browsers reject `SameSite=None` without `Secure` outright — the
 *             pair is not a recommendation, it is a requirement, and getting it
 *             half-right means the cookie is silently never stored
 *   sameSite  'strict' when the SPA and the API share a site — AD-14's case,
 *             and nothing legitimate is lost. Ports do not affect SameSite, so
 *             the dev server on :5173 talking to the API on :5000 still sends
 *             it. 'none' only for a split-host deployment; see above
 *   path      scoped to the auth routes: the cookie is not attached to the
 *             hundreds of ordinary API calls that have no use for it
 *
 * ---------------------------------------------------------------------------
 * WHAT `SameSite=None` COSTS, HONESTLY
 * ---------------------------------------------------------------------------
 *
 * A third-party page can cause the browser to POST /auth/refresh with this
 * cookie attached. It cannot READ the response — CORS allows only the
 * configured origins — so no token is disclosed. What it can do is rotate the
 * refresh token; the browser stores the new one from the same response, and the
 * user's own tabs carry on, with the grace window in `refresh` covering the
 * race. So the exposure is a nuisance, not a session takeover and not a logout.
 *
 * The cost is still real, and the way to avoid paying it is to put both halves
 * on one registrable domain — `app.example.com` and `api.example.com` are
 * same-site, and `strict` keeps working. Prefer that when a custom domain
 * exists; this flag is for when one does not.
 */
export function refreshCookieOptions() {
  const crossSite = crossSiteCookies();
  return {
    httpOnly: true,
    secure: crossSite || process.env.NODE_ENV === 'production',
    sameSite: crossSite ? 'none' : 'strict',
    path: '/api/v1/auth',
    maxAge: refreshCookieMaxAgeMs(),
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
export const accessTokenExpiresInMs = () =>
  ttlToMs(accessTokenTtl(), ttlToMs(ACCESS_TOKEN_TTL_DEFAULT, 24 * 60 * 60_000));

export default {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashRefreshToken,
  refreshHashMatches,
  refreshCookieOptions,
  clearRefreshCookieOptions,
  REFRESH_COOKIE_NAME,
  accessTokenTtl,
  refreshTokenTtl,
  REFRESH_GRACE_MS,
  MAX_REFRESH_SESSIONS,
};
