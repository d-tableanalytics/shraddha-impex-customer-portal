/**
 * A real MongoDB, in memory, for tests that are about database behaviour.
 *
 * Most HRMS tests are pure and need none of this. These do: a partial unique
 * index, an aggregation, and a delete guard that counts rows are all things
 * whose behaviour lives in the database. Asserting them against a mock would
 * only prove the mock agrees with itself — and the index in particular is the
 * single thing standing between two live departments and the same code.
 *
 * `mongodb-memory-server` downloads a real mongod on first use and runs it on a
 * random port; nothing touches the configured MONGODB_URI.
 */

import mongoose from 'mongoose';

/** First start includes a binary download on a cold machine. */
const LAUNCH_TIMEOUT_MS = 120_000;

let server = null;

/** Start mongod and connect mongoose. Call from a `before` hook. */
export async function startTestMongo() {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ instance: { launchTimeout: LAUNCH_TIMEOUT_MS } });
  await mongoose.connect(server.getUri(), { dbName: 'hrms_test' });
  return server.getUri();
}

export async function stopTestMongo() {
  await mongoose.disconnect();
  if (server) await server.stop();
  server = null;
}

/**
 * A single-node REPLICA SET, for tests about transactions.
 *
 * The plain server above has no transactions, so every transactional workflow
 * quietly takes its "run without one" fallback there — which is how the
 * booking confirmation's real path (commit, abort, retry) went untested. Use
 * this when the transaction itself is what is under test.
 *
 * Builds every model's indexes before returning: an index build holds a
 * collection lock, and a transaction that meets it fails with a LockTimeout
 * that has nothing to do with the code under test.
 */
export async function startTestReplSet() {
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  server = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ launchTimeout: LAUNCH_TIMEOUT_MS }],
  });
  await mongoose.connect(server.getUri(), { dbName: 'txn_test' });
  for (const model of Object.values(mongoose.models)) {
    await model.createCollection().catch(() => {});
    await model.init().catch(() => {});
  }
  return server.getUri();
}

/**
 * Build the declared indexes for these models.
 *
 * Mongoose creates indexes in the background, so without this a test could
 * insert a duplicate before the unique index exists and pass for the wrong
 * reason. `syncIndexes` also drops indexes the schema no longer declares, so
 * the collection matches the model exactly.
 */
export async function syncIndexes(...models) {
  for (const model of models) await model.syncIndexes();
}

/** Empty every collection, so each test starts from a known state. */
export async function clearCollections() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

export default { startTestMongo, stopTestMongo, syncIndexes, clearCollections };
