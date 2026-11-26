/**
 * Customer-facing performance benchmark for the booking path.
 *
 * Run:
 *   node --test --experimental-test-module-mocks tests/manual/booking-benchmark.mjs
 *   BENCH_BOOKINGS=20 BENCH_LINES=7 BENCH_LABEL=phase-1 node --test ... (same)
 *
 * WHY IT IS A TEST FILE AND NOT A SCRIPT — the same reason as
 * send-po-test-mail.mjs: the booking controller imports `io` from server.js,
 * and importing server.js for real connects to whatever MONGODB_URI is in .env,
 * which here is PRODUCTION Atlas. `mock.module` is the only thing in this repo
 * that stubs it, and it is available only under the test runner. The controller
 * therefore runs for real against an in-memory replica set and nothing touches
 * the live database.
 *
 * WHY IT COUNTS DATABASE COMMANDS, NOT JUST MILLISECONDS
 * ------------------------------------------------------
 * Wall time measured here is nearly meaningless for production: the database is
 * on localhost, so a round trip costs microseconds. In production the backend
 * is in Sydney and the cluster is in Mumbai, and a round trip costs roughly
 * 150-250ms. What decides how long a customer waits is therefore the NUMBER OF
 * ROUND TRIPS on the request path, which this counts exactly, using the
 * driver's command-monitoring events:
 *
 *     estimated production latency ~= commands on the request path x RTT
 *
 * Both figures are reported. Compare the command count across code versions;
 * treat the milliseconds as a check that nothing has become pathological.
 */

import test, { before, after, mock } from 'node:test';
import mongoose from 'mongoose';

// THE LOOPBACK FENCE, FIRST. This file does not use tests/helpers/mongo.js —
// it builds its own replica set — so the fence that file installs would not be
// loaded, and a single import reaching config/database.js would connect this
// process to PRODUCTION. Imported before anything else for that reason.
import '../helpers/isolation.js';

/**
 * Measure the PRODUCTION setting.
 *
 * isolation.js forces ledger postings to be synchronous so the test suite's
 * assertions do not race them. This file is measuring what a customer actually
 * waits for, so it puts the setting back to the production default. Set
 * BENCH_LEDGER=sync to measure the old behaviour instead.
 */
process.env.IMS_LEDGER_POSTING = process.env.BENCH_LEDGER === 'sync' ? 'sync' : 'async';

// Stubbed for the same reason as every other test file: server.js connects to
// whatever MONGODB_URI is in .env, which is PRODUCTION.
mock.module(new URL('../../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
mock.module(new URL('../../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async () => true },
});

// Imported for its side effect: app.js resolves the import cycle between
// reservation.routes.js and reservation.controller.js. Importing the
// controller on its own hits the cycle mid-initialisation.
await import('../../app.js');

const BOOKINGS = Number(process.env.BENCH_BOOKINGS) || 12;
const LINES = Number(process.env.BENCH_LINES) || 5;
const LABEL = process.env.BENCH_LABEL || 'current';

/** Bookkeeping chatter, excluded so the count reflects real work. */
const IGNORED = new Set(['ismaster', 'hello', 'ping', 'endSessions', 'buildInfo', 'getParameter']);

let server;
let counting = false;
const commands = [];

before(async () => {
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  server = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ launchTimeout: 120_000 }],
  });
  // monitorCommands is what makes the round trips visible. Enabled only here,
  // never in the application.
  await mongoose.connect(server.getUri(), { dbName: 'bench', monitorCommands: true });
  mongoose.connection.on('commandStarted', (e) => {
    if (counting && !IGNORED.has(e.commandName)) commands.push(e.commandName);
  });
  for (const model of Object.values(mongoose.models)) {
    await model.createCollection().catch(() => {});
    await model.init().catch(() => {});
  }
});

after(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

const percentile = (sorted, p) => (sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
  : 0);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

test(`booking path benchmark (${LABEL})`, async () => {
  const { default: User } = await import('../../models/User.js');
  const { default: Location } = await import('../../models/Location.js');
  const { default: InventoryConfig } = await import('../../models/InventoryConfig.js');
  const { createProductModel } = await import('../../models/Product.js');
  const { seedBrands } = await import('../../utils/brandRegistry.js');
  const { createDirectBooking } = await import('../../modules/reservations/reservation.controller.js');

  await seedBrands();
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
  await InventoryConfig.create({ scope: 'global', indentAssignmentMode: 'auto', effectiveFrom: new Date(0) });

  const customer = await User.create({
    email: 'bench@example.com', password: 'x'.repeat(12), user: 'Bench',
    company: 'Bench Co', role: 'Customer', brandAccess: { koken: true }, moq: 'SKIP',
  });

  const Koken = createProductModel('Koken');
  const samples = [];
  const commandCounts = [];

  for (let b = 0; b < BOOKINGS; b += 1) {
    const items = [];
    for (let l = 0; l < LINES; l += 1) {
      const p = await Koken.create({
        skuCode: `BENCH-${b}-${l}`, totalAvailableQuantity: 100,
        bookedQuantity: 0, availableForSale: 100,
      });
      items.push({ productId: String(p._id), quantity: 2 });
    }

    const req = {
      body: { items },
      user: { ...customer.toObject(), id: String(customer._id) },
      method: 'POST',
      originalUrl: '/api/v1/reservations/direct-booking',
      ip: '127.0.0.1',
      headers: {},
    };
    let done;
    const res = {
      status() { return this; },
      json(payload) { done = payload; return this; },
    };

    commands.length = 0;
    counting = true;
    const t0 = process.hrtime.bigint();
    await createDirectBooking(req, res, (e) => { throw e; });
    const t1 = process.hrtime.bigint();
    counting = false;

    if (!done?.success) throw new Error(`booking ${b} failed: ${JSON.stringify(done)}`);
    samples.push(Number(t1 - t0) / 1e6);
    commandCounts.push(commands.length);

    /**
     * Let the background postings finish before timing the next booking.
     *
     * Without this, booking N+1's window would catch booking N's deferred
     * postings and the asynchronous figure would be inflated by work that was
     * never on anyone's request path — measuring the opposite of the point.
     * Counting is already off, so nothing here is attributed to a booking.
     */
    const { default: StockOutbox } = await import('../../models/StockOutbox.js');
    for (let i = 0; i < 100; i += 1) {
      const left = await StockOutbox.countDocuments({ state: { $in: ['pending', 'claimed'] } });
      if (left === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const cmdSorted = [...commandCounts].sort((a, b) => a - b);

  console.log(JSON.stringify({
    label: LABEL,
    bookings: BOOKINGS,
    linesPerBooking: LINES,
    wallMs: {
      mean: +mean(samples).toFixed(2),
      p50: +percentile(sorted, 50).toFixed(2),
      p95: +percentile(sorted, 95).toFixed(2),
      max: +Math.max(...samples).toFixed(2),
    },
    dbCommandsOnRequestPath: {
      mean: +mean(commandCounts).toFixed(1),
      p50: percentile(cmdSorted, 50),
      p95: percentile(cmdSorted, 95),
      perLine: +(mean(commandCounts) / LINES).toFixed(1),
    },
    estimatedProductionMs: {
      note: 'commands on the request path x round-trip time',
      at150msRtt: Math.round(mean(commandCounts) * 150),
      at250msRtt: Math.round(mean(commandCounts) * 250),
    },
  }, null, 1));
});
