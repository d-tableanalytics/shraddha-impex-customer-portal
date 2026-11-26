import mongoose from 'mongoose';

/**
 * A hard fence between the test suite and any real database.
 *
 * The tests mutate stock, confirm bookings, raise POs and cancel them. The
 * repository's `.env` points `MONGODB_URI` at the PRODUCTION Atlas cluster, and
 * a single stray `mongoose.connect()` — in a test, in a helper, in a module
 * imported for an unrelated reason — would run all of that against live
 * customer data. Nothing in the test harness is supposed to do that, which is
 * exactly why it must be enforced rather than assumed.
 *
 * `mongoose.connect` is wrapped once, at import, and refuses any host that is
 * not a loopback address. `mongodb-memory-server` binds to 127.0.0.1, so every
 * legitimate test connection passes and no test has to opt in.
 *
 * Deliberately not a config flag: a flag can be set wrongly. A host check
 * cannot be satisfied by a production URI under any setting.
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

/** Every host a connection string names — `mongodb://a:1,b:2/db` names two. */
export const hostsOf = (uri) => {
  const body = String(uri).replace(/^mongodb(\+srv)?:\/\//, '');
  const authless = body.includes('@') ? body.slice(body.indexOf('@') + 1) : body;
  const hostPart = authless.split('/')[0].split('?')[0];
  return hostPart.split(',').map((h) => h.replace(/\[|\]/g, '').split(':')[0]).filter(Boolean);
};

/** True when every host in `uri` is a loopback address. */
export const isIsolated = (uri) => {
  const hosts = hostsOf(uri);
  return hosts.length > 0 && hosts.every((h) => LOOPBACK.has(h));
};

const originalConnect = mongoose.connect.bind(mongoose);
const originalCreate = mongoose.createConnection.bind(mongoose);
let installed = false;

const refuse = (uri) => new Error(
  'Refusing to connect: tests may only use a loopback database. ' +
  `Got host(s) ${hostsOf(uri).join(', ')}. ` +
  'Use startTestMongo()/startTestReplSet() from tests/helpers/mongo.js.',
);

/**
 * Wrap every way mongoose opens a connection so a non-loopback URI throws.
 *
 * BOTH entry points are covered. `connect` is the one config/database.js uses,
 * but `createConnection` opens a connection just as real, and a fence with a
 * hole in it is worse than none — it invites the assumption that the check
 * happened.
 */
export const enforceIsolatedDatabase = () => {
  if (installed) return;
  installed = true;
  mongoose.connect = (uri, ...rest) => {
    if (!isIsolated(uri)) throw refuse(uri);
    return originalConnect(uri, ...rest);
  };
  mongoose.createConnection = (uri, ...rest) => {
    // Called with no URI it creates an unconnected handle, which is harmless.
    if (uri !== undefined && !isIsolated(uri)) throw refuse(uri);
    return originalCreate(uri, ...rest);
  };
};

/**
 * Ledger postings complete before the call returns, for the test suite only.
 *
 * In production a posting is deferred: the customer's stock, booking and
 * reservation are committed, and the historical record is written just after,
 * off the request path. Dozens of tests assert on movements immediately after
 * the action that caused them, and under the production setting those
 * assertions would race the posting rather than test anything.
 *
 * Set here rather than in each test file so no test can forget it, and so a
 * test that DOES want the asynchronous behaviour has to ask for it explicitly
 * (see tests/stock-outbox.test.js).
 */
export const forceSynchronousLedger = () => {
  process.env.IMS_LEDGER_POSTING = 'sync';
};

enforceIsolatedDatabase();
forceSynchronousLedger();

export default {
  enforceIsolatedDatabase, forceSynchronousLedger, isIsolated, hostsOf,
};
