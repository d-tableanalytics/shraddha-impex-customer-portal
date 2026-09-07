/**
 * A tiny HTTP harness for route-level tests.
 *
 * Starts a real Express app on an ephemeral port and talks to it with Node's
 * built-in fetch, so the middleware under test runs exactly as it does in
 * production - no supertest dependency, and no mocking of the guards.
 *
 * Only ONE thing is stubbed: authentication. `middlewares/auth.js` verifies a
 * JWT and loads the user from MongoDB, neither of which a unit test should
 * need. `stubProtect(user)` sets `req.user` the way `protect` would, and
 * everything downstream is the genuine article.
 */

import express from 'express';
import { once } from 'node:events';

import { errorHandler } from '../../middlewares/errorHandler.js';

/**
 * Stand-in for `middlewares/auth.js#protect`.
 *
 * Mirrors its two rejections so tests see the same behaviour: no user -> 401,
 * and a non-Active account -> 401.
 */
export function stubProtect(user) {
  return (req, res, next) => {
    if (!user) {
      return res
        .status(401)
        .json({ success: false, message: 'Not authorized to access this route.' });
    }
    if (user.status && user.status !== 'Active') {
      return res
        .status(401)
        .json({ success: false, message: 'User account is inactive or suspended.' });
    }
    req.user = user;
    return next();
  };
}

/**
 * Build an Express app for a test.
 *
 * @param {object}   options
 * @param {Function} options.mount  receives the app; mount routers/middleware here
 */
export function buildTestApp({ mount }) {
  const app = express();
  app.use(express.json());
  mount(app);
  app.use((req, res) => res.status(404).json({ success: false, message: 'API Route Not Found' }));
  app.use(errorHandler);
  return app;
}

/** Start on an ephemeral port; returns `{ url, close }`. */
export async function startServer(app) {
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function request(baseUrl, path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

export const get = (baseUrl, path, init = {}) => request(baseUrl, path, init);

export const post = (baseUrl, path, payload, init = {}) =>
  request(baseUrl, path, {
    ...init,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

export const put = (baseUrl, path, payload, init = {}) =>
  request(baseUrl, path, {
    ...init,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

export const patch = (baseUrl, path, payload, init = {}) =>
  request(baseUrl, path, {
    ...init,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...init.headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

export const del = (baseUrl, path, init = {}) => request(baseUrl, path, { ...init, method: 'DELETE' });

/** Run `fn(url)` against a freshly started app, always shutting it down after. */
export async function withServer(app, fn) {
  const { url, close } = await startServer(app);
  try {
    return await fn(url);
  } finally {
    await close();
  }
}
