/**
 * Authentication hardening and targeted rate limiting.
 *
 * Phase 0 verification requirement 10: login cannot bypass rate limiting or
 * password hashing.
 *
 * The password and token services are tested directly. Wiring that needs a
 * database is asserted at the source level instead of mocked - a mocked login
 * would prove only that the mock works.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile } from 'node:fs/promises';

import {
  hashPassword,
  verifyPassword,
  isHashed,
  validatePasswordStrength,
  MIN_PASSWORD_LENGTH,
} from '../utils/password.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashRefreshToken,
  refreshHashMatches,
  refreshCookieOptions,
  clearRefreshCookieOptions,
  REFRESH_COOKIE_NAME,
  ttlToMs,
} from '../utils/tokens.js';
import { loginLimiter, passwordLimiter } from '../middlewares/rateLimiters.js';
import { buildTestApp, withServer, post, put } from './helpers/http.js';

const src = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

/**
 * Read a source file with its comments removed.
 *
 * Needed because these assertions look for code that must NOT exist, and the
 * commit that removed that code explains what it removed - so a naive match
 * finds the explanation and fails. Stripping comments makes the assertion test
 * the program rather than the prose.
 */
const code = async (rel) =>
  (await src(rel))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Same thing under a name that reads at the call site. */
const stripped = code;

// ---------------------------------------------------------------------------
// Password hashing (AD-10)
// ---------------------------------------------------------------------------

test('a hashed password verifies and is recognised as hashed', async () => {
  const hash = await hashPassword('correct horse');
  assert.equal(isHashed(hash), true);
  assert.notEqual(hash, 'correct horse');

  const good = await verifyPassword('correct horse', hash);
  assert.deepEqual(good, { ok: true, needsRehash: false });

  const bad = await verifyPassword('wrong horse', hash);
  assert.equal(bad.ok, false);
});

test('a legacy plaintext password still authenticates, and is flagged for rehash', async () => {
  // This is what keeps every existing account working while plaintext is
  // migrated away. Without it, switching to bcrypt would lock out the userbase.
  const stored = 'legacy-plaintext';
  const match = await verifyPassword('legacy-plaintext', stored);
  assert.deepEqual(match, { ok: true, needsRehash: true });

  const miss = await verifyPassword('nope', stored);
  assert.deepEqual(miss, { ok: false, needsRehash: false });
});

test('verifyPassword is defensive about missing or non-string input', async () => {
  for (const [c, s] of [
    [undefined, 'x'],
    ['x', undefined],
    [null, null],
    ['x', ''],
    [123, 'x'],
  ]) {
    const r = await verifyPassword(c, s);
    assert.deepEqual(r, { ok: false, needsRehash: false });
  }
});

test('isHashed recognises every bcrypt variant and rejects plaintext', () => {
  assert.equal(isHashed('$2a$10$abcdefghijklmnopqrstuv'), true);
  assert.equal(isHashed('$2b$10$abcdefghijklmnopqrstuv'), true);
  assert.equal(isHashed('$2y$12$abcdefghijklmnopqrstuv'), true);
  assert.equal(isHashed('hunter2'), false);
  assert.equal(isHashed(''), false);
  assert.equal(isHashed(null), false);
});

test('hashPassword refuses an empty password rather than hashing nothing', async () => {
  await assert.rejects(() => hashPassword(''), TypeError);
  await assert.rejects(() => hashPassword(undefined), TypeError);
});

test('the existing minimum password length is unchanged', () => {
  assert.equal(MIN_PASSWORD_LENGTH, 5, 'shortening or lengthening this invalidates live accounts');
  assert.equal(validatePasswordStrength('abcde').ok, true);
  assert.equal(validatePasswordStrength('abcd').ok, false);
});

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const withSecret = (fn) => {
  const prev = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret-value-for-unit-tests';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prev;
  }
};

test('an access token keeps the `id` claim the existing middleware reads', () => {
  withSecret(() => {
    const token = signAccessToken('507f1f77bcf86cd799439011');
    const [, payloadB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    // middlewares/auth.js does `User.findById(decoded.id)` - this must not move.
    assert.equal(payload.id, '507f1f77bcf86cd799439011');
    assert.equal(payload.type, 'access');
    assert.ok(payload.exp > payload.iat);
  });
});

test('refresh tokens are distinct on every issue, so rotation cannot collide', () => {
  withSecret(() => {
    const a = signRefreshToken('u1');
    const b = signRefreshToken('u1');
    assert.notEqual(a.token, b.token, 'two refreshes must differ even for the same user');
    assert.notEqual(a.jti, b.jti);
    assert.notEqual(hashRefreshToken(a.token), hashRefreshToken(b.token));
  });
});

test('an access token cannot be replayed as a refresh token', () => {
  withSecret(() => {
    const access = signAccessToken('u1');
    assert.equal(verifyRefreshToken(access), null, 'type claim must separate the two');
  });
});

test('verifyRefreshToken rejects tampered and malformed tokens', () => {
  withSecret(() => {
    const { token } = signRefreshToken('u1');
    assert.ok(verifyRefreshToken(token));
    assert.equal(verifyRefreshToken(`${token}x`), null);
    assert.equal(verifyRefreshToken('not.a.token'), null);
    assert.equal(verifyRefreshToken(''), null);
  });
});

test('refresh hashes compare in constant time and only match themselves', () => {
  const a = hashRefreshToken('token-a');
  const b = hashRefreshToken('token-b');
  assert.equal(refreshHashMatches(a, a), true);
  assert.equal(refreshHashMatches(a, b), false);
  // Different lengths must not throw - timingSafeEqual would.
  assert.equal(refreshHashMatches(a, 'short'), false);
  assert.equal(refreshHashMatches(null, a), false);
});

test('the refresh cookie is httpOnly, SameSite=Strict and scoped to /api/v1/auth', () => {
  const opts = refreshCookieOptions();
  assert.equal(opts.httpOnly, true, 'XSS must not be able to read the refresh token');
  assert.equal(opts.sameSite, 'strict');
  assert.equal(opts.path, '/api/v1/auth', 'not attached to every ordinary API call');
  assert.ok(opts.maxAge > 0);
  // Clearing must match every attribute except maxAge or the browser keeps it.
  const clear = clearRefreshCookieOptions();
  assert.equal(clear.httpOnly, opts.httpOnly);
  assert.equal(clear.sameSite, opts.sameSite);
  assert.equal(clear.path, opts.path);
  assert.equal('maxAge' in clear, false);
});

test('the refresh cookie is Secure in production and not in development', () => {
  const prev = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.equal(refreshCookieOptions().secure, true);
    process.env.NODE_ENV = 'development';
    assert.equal(refreshCookieOptions().secure, false, 'local http must still work');
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test('ttlToMs parses JWT-style durations and falls back safely', () => {
  assert.equal(ttlToMs('15m', 0), 15 * 60_000);
  assert.equal(ttlToMs('7d', 0), 7 * 86_400_000);
  assert.equal(ttlToMs('30s', 0), 30_000);
  assert.equal(ttlToMs('2h', 0), 2 * 3_600_000);
  assert.equal(ttlToMs('nonsense', 1234), 1234);
});

// ---------------------------------------------------------------------------
// Rate limiting (AD-8) - real behaviour over HTTP
// ---------------------------------------------------------------------------

test('the login limiter blocks after repeated failures for the same email', async () => {
  const app = buildTestApp({
    mount: (a) => {
      // Fails like a wrong password would, so the limiter counts the attempt.
      a.post('/login', loginLimiter, (req, res) =>
        res.status(401).json({ success: false, message: 'Invalid credentials' }),
      );
    },
  });

  await withServer(app, async (url) => {
    const attempt = () => post(url, '/login', { email: 'victim@example.com', password: 'guess' });
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await attempt()).status, 401, `attempt ${i + 1} should still be allowed`);
    }
    const blocked = await attempt();
    assert.equal(blocked.status, 429, 'the sixth attempt must be rate limited');
    assert.match(blocked.body.message, /too many sign-in attempts/i);
  });
});

test('the login limiter buckets per email, so one account cannot lock out another', async () => {
  const app = buildTestApp({
    mount: (a) => {
      a.post('/login', loginLimiter, (req, res) =>
        res.status(401).json({ success: false, message: 'Invalid credentials' }),
      );
    },
  });

  await withServer(app, async (url) => {
    for (let i = 0; i < 6; i += 1) {
      await post(url, '/login', { email: 'attacked@example.com', password: 'guess' });
    }
    // A different colleague behind the same IP is unaffected.
    const other = await post(url, '/login', { email: 'colleague@example.com', password: 'x' });
    assert.equal(other.status, 401, 'a different email must not inherit the block');
  });
});

test('a successful sign-in does not consume the allowance', async () => {
  const app = buildTestApp({
    mount: (a) => {
      a.post('/login', loginLimiter, (req, res) => res.status(200).json({ success: true }));
    },
  });

  await withServer(app, async (url) => {
    for (let i = 0; i < 8; i += 1) {
      const r = await post(url, '/login', { email: 'busy@example.com', password: 'right' });
      assert.equal(r.status, 200, `successful sign-in ${i + 1} must not be throttled`);
    }
  });
});

test('the password limiter is keyed per account, not per IP', async () => {
  const app = buildTestApp({
    mount: (a) => {
      a.put('/users/:id/password', passwordLimiter, (req, res) =>
        res.status(200).json({ success: true }),
      );
    },
  });

  await withServer(app, async (url) => {
    const hit = (id) => put(url, `/users/${id}/password`, {});
    for (let i = 0; i < 5; i += 1) await hit('aaa');
    assert.equal((await hit('aaa')).status, 429);
    assert.equal((await hit('bbb')).status, 200, 'a different account has its own allowance');
  });
});

// ---------------------------------------------------------------------------
// Wiring: no bypass exists
// ---------------------------------------------------------------------------

test('there is no second raw-password login endpoint', async () => {
  const apiRoutes = await code('../routes/api.routes.js');

  // The old inline implementation is gone.
  assert.doesNotMatch(
    apiRoutes,
    /user\.password\s*!==\s*String\(password\)/,
    'the raw plaintext comparison must not survive anywhere',
  );

  // ...and the route now delegates to the one secure controller, with the limiter.
  assert.match(
    apiRoutes,
    /router\.post\('\/auth\/login',\s*loginLimiter,\s*login\)/,
    'the legacy path must reuse the secure login and its limiter',
  );
  assert.match(apiRoutes, /import \{ login \} from '\.\.\/modules\/auth\/auth\.controller\.js'/);
});

test('both login routes are rate limited', async () => {
  const authRoutes = await src('../modules/auth/auth.routes.js');
  assert.match(authRoutes, /router\.post\('\/login',\s*loginLimiter,\s*login\)/);
  assert.match(authRoutes, /router\.post\('\/refresh',\s*refreshLimiter/);
  assert.match(authRoutes, /passwordLimiter/, 'password change must be limited');
});

test('no password is written without hashing', async () => {
  for (const rel of ['../modules/auth/auth.controller.js', '../modules/users/user.controller.js']) {
    const stripped = await code(rel);
    // The three previous plaintext writes.
    assert.doesNotMatch(stripped, /user\.password\s*=\s*newPassword/, `${rel} writes plaintext`);
    assert.doesNotMatch(stripped, /password:\s*newPassword\b/, `${rel} writes plaintext`);
    assert.doesNotMatch(
      stripped,
      /password,\n\s+user: user \|\| null/,
      `${rel} passes the raw password into User.create`,
    );
    assert.match(stripped, /hashPassword/, `${rel} must use the shared hashing service`);
  }
});

test('login rehashes a legacy plaintext password on success', async () => {
  const code = await src('../modules/auth/auth.controller.js');
  assert.match(code, /needsRehash/, 'login must act on the rehash signal');
  assert.match(code, /upgradePasswordHash/);
});

test('changing or resetting a password revokes existing sessions', async () => {
  const auth = await src('../modules/auth/auth.controller.js');
  assert.match(
    auth,
    /password: await hashPassword\(newPassword\), refreshTokenHash: null/,
    'a password change must drop live refresh tokens',
  );

  const users = await src('../modules/users/user.controller.js');
  assert.match(
    users,
    /password: hashed, refreshTokenHash: null/,
    'an admin reset must drop live refresh tokens',
  );
});

/**
 * THIS TEST WAS INVERTED ON PURPOSE, AND HERE IS WHY.
 *
 * It used to assert that reuse detection nulls the account-wide
 * `refreshTokenHash` — i.e. that ONE bad token signs the account out of every
 * device. That was the intended design, and in production it was the bug:
 *
 *   auth.refresh                  69
 *   auth.refresh.reuse_detected   27   ← 28% of all refresh attempts
 *
 * with one admin force-signed-out 13 times in five hours. Two ordinary things
 * are indistinguishable from a replayed token under an account-wide hash — a
 * second browser TAB (same cookie, both expire together, both refresh at once)
 * and a second DEVICE (signing in overwrote the one hash).
 *
 * Detection is now scoped to the SESSION that presented the token, so a replay
 * still fails and is still audited — it just cannot take the account's other
 * devices with it. The assertions below pin the properties that make that safe.
 */
test('refresh reuse refuses one session without revoking the account', async () => {
  const code = await src('../modules/auth/auth.controller.js');

  // Still a constant-time comparison, still in this controller.
  assert.match(code, /refreshHashMatches/);
  // Still audited, so a real attack remains visible.
  assert.match(code, /AUTH_REFRESH_REUSE_DETECTED/);

  // The blast radius is gone: the refuse branch must clear the cookie and
  // return, and must NOT null the account-wide hash on its way out.
  assert.doesNotMatch(
    code,
    /AUTH_REFRESH_REUSE_DETECTED[\s\S]{0,400}?\$set: \{ refreshTokenHash: null \}/,
    'reuse detection must no longer revoke every session for the account',
  );

  // Sessions are per device.
  assert.match(code, /refreshSessions/, 'sessions must be stored per device');
  // Rotation is a compare-and-swap on ONE element, not a blind overwrite.
  assert.match(
    code,
    /\$elemMatch: \{ hash: currentHash \}/,
    'rotation must be a compare-and-swap against the presented session',
  );
  // The grace window is what makes two racing tabs survive.
  assert.match(code, /REFRESH_GRACE_MS/, 'a rotation grace window must exist');
  assert.match(
    code,
    /prevHash/,
    'the just-superseded token must remain acceptable inside the window',
  );
});

/**
 * The grace branch must not touch the cookie.
 *
 * The losing tab's response used to `res.clearCookie(...)`, which deleted the
 * refresh cookie the WINNING tab had just been issued — so even the tab that
 * won the race was signed out at its next refresh. Serving a bare access token
 * with no Set-Cookie and no clearCookie is what keeps the winner alive.
 */
test('a racing tab is served without rotating or touching the cookie', async () => {
  // Comments stripped: the branch EXPLAINS that it must not set or clear the
  // cookie, so matching the prose would fail on its own rationale.
  const code = await stripped('../modules/auth/auth.controller.js');
  const graceBranch = /if \(onGrace\) \{[\s\S]*?token = signAccessToken\(user\._id\);/;
  assert.match(code, graceBranch, 'the grace branch must mint a bare access token');

  const branch = code.match(graceBranch)?.[0] ?? '';
  assert.doesNotMatch(branch, /res\.cookie\(/, 'the grace branch must not re-issue a cookie');
  assert.doesNotMatch(branch, /clearCookie/, 'the grace branch must not clear the winner\'s cookie');
});

/**
 * A deploy must not sign out everyone holding a valid cookie.
 *
 * Every existing account has a `refreshTokenHash` string and an empty
 * `refreshSessions`, so without an adoption path their first refresh after this
 * ships would find no session and 401.
 */
test('a session issued under the old single-hash model is adopted, not rejected', async () => {
  const code = await src('../modules/auth/auth.controller.js');
  assert.match(code, /adoptLegacySession/, 'legacy cookies must be adopted');
  assert.match(
    code,
    /refreshHashMatches\(presentedHash, user\.refreshTokenHash\)/,
    'adoption must verify the legacy hash before trusting it',
  );
});

test('the frontend refreshes once, not once per concurrent request', async () => {
  const code = await readFile(
    new URL('../../frontend/src/services/api.js', import.meta.url),
    'utf8',
  );
  assert.match(code, /withCredentials: true/, 'the refresh cookie must be sent');
  assert.match(code, /let refreshPromise = null/, 'refresh must be single-flight');
  assert.match(code, /_retry/, 'a retried request must not loop');
  assert.doesNotMatch(
    code,
    /if \(error\.response\?\.status === 401\) \{\s*\n\s*\/\/ Clear token and force logout/,
    'the old logout-on-401 behaviour must be gone',
  );
});
