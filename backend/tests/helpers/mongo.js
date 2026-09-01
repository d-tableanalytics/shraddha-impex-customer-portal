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
