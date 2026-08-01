/**
 * verify-alerts.js
 * -----------------------------------------------------------------------------
 * Checks for IMS Module M8 — Alerts & Notifications.
 *
 *   1. Consumer only      the engine never calculates inventory
 *   2. Closed type set    no alert category beyond the blueprint's
 *   3. Event decoupling   producers never import the alert engine
 *   4. Lifecycle          Closed is terminal; illegal moves refused
 *   5. Deduplication      one active alert per condition, under concurrency
 *   6. Transition firing  create / touch / auto-resolve
 *   7. Unknown band       raises Planning, never stock-health (BR-54)
 *   8. Cooldown           suppresses the push, never the record (BR-56)
 *   9. Immutability       trigger data cannot be rewritten; alerts cannot be deleted
 *  10. Delivery           in-app only; email/webhook recorded as skipped
 *
 * Sections 1–4 are static. The rest require --db.
 *
 * Usage:
 *   node scripts/verify-alerts.js
 *   node scripts/verify-alerts.js --db
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import InventoryAlert, {
  ALERT_TYPES, ALERT_TYPE_NAMES, ALERT_CATEGORIES, ALERT_TRANSITIONS, SEVERITIES,
} from '../models/InventoryAlert.js';
import AlertRule from '../models/AlertRule.js';
import StockHealth from '../models/StockHealth.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import { raiseAlert, clearAlert, evaluateSkus, transitionAlert } from '../modules/inventory/alert.service.js';
import { subscribeAlerts } from '../modules/inventory/alert.subscriber.js';
import { EVENTS, emitEvent, listenerCounts, resetBus } from '../utils/eventBus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const WITH_DB = process.argv.includes('--db');

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`   ✅ ${name}`); }
  else { failed++; console.log(`   ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const expectFail = async (name, fn) => {
  try { await fn(); check(name, false, 'it succeeded'); }
  catch (err) { check(name, true, `${err.code || err.name}: ${err.message.slice(0, 55)}`); }
};

const readSource = (...parts) =>
  fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
/** Strip comments, so a rule is not "satisfied" by prose describing it. */
const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

const run = async () => {
  // ── 1. Consumer, not calculator ───────────────────────────────────────────
  console.log('\n1. CONSUMER, NOT CALCULATOR');
  const service = codeOnly(readSource('modules', 'inventory', 'alert.service.js'));
  const subscriber = codeOnly(readSource('modules', 'inventory', 'alert.subscriber.js'));
  const controller = codeOnly(readSource('modules', 'inventory', 'alert.controller.js'));
  const engine = `${service}\n${subscriber}`;

  check('never imports the health calculator',
    !/calculateHealth|MAX_LEVEL_FORMULAS|classify/.test(engine));
  check('never imports the balance reducer',
    !/reduceMovements|applyMovements|deriveBalance/.test(engine));
  check('never reads the ledger', !/StockMovement/.test(engine));
  check('never touches legacy inventory fields',
    !/totalAvailableQuantity|bookedQuantity|availableForSale/.test(engine));
  check('never writes a balance', !/StockBalance\.(update|bulkWrite|create|insertMany)/.test(engine));
  check('never writes health', !/StockHealth\.(update|bulkWrite|create|insertMany)/.test(engine));
  check('never writes a snapshot', !/InventorySnapshot|SnapshotRun/.test(engine));
  check('reads the health projection read-only',
    /StockHealth\.find\(/.test(service) && !/StockHealth\.(updateOne|updateMany)/.test(service));
  check('no arithmetic on quantities — values are copied',
    !/onHand\s*[-+*/]\s*|available\s*[-+*/]\s*reserved/.test(service));

  // ── 2. Closed alert type set ──────────────────────────────────────────────
  console.log('\n2. CLOSED TYPE SET');
  check('exactly the four blueprint categories',
    ALERT_CATEGORIES.length === 4 &&
    ['Stock Health', 'Planning', 'Operations', 'Configuration'].every((c) => ALERT_CATEGORIES.includes(c)),
    ALERT_CATEGORIES.join(', '));
  check('every type declares category, severity and label',
    ALERT_TYPE_NAMES.every((t) => ALERT_TYPES[t].category && ALERT_TYPES[t].severity && ALERT_TYPES[t].label));
  check('every declared severity is in the scale',
    ALERT_TYPE_NAMES.every((t) => SEVERITIES.includes(ALERT_TYPES[t].severity)));
  check('no HTTP route can create an alert',
    !/InventoryAlert\.create|raiseAlert\(/.test(controller));
  check('the rules endpoint rejects an unknown type',
    /ALERT_TYPE_NAMES\.includes\(alertType\)/.test(controller));

  // ── 3. Event decoupling ───────────────────────────────────────────────────
  console.log('\n3. EVENT DECOUPLING');
  for (const producer of ['health.service.js', 'count.service.js', 'snapshot.service.js', 'config.controller.js']) {
    const src = readSource('modules', 'inventory', producer);
    check(`${producer} does not import the alert engine`,
      !/alert\.(service|subscriber|controller)/.test(src));
    check(`${producer} emits on the bus`, /emitEvent\(/.test(src));
  }
  const bus = readSource('utils', 'eventBus.js');
  check('the event bus is a leaf (imports only node:events)',
    (bus.match(/^import .*/gm) || []).every((l) => /from 'events'/.test(l)));
  check('the alert engine does not import server.js or io',
    !/from '.*server\.js'|\bio\b\.to\(/.test(engine));
  check('the socket bridge lives in server.js',
    /EVENTS\.NOTIFICATION_CREATED/.test(readSource('server.js')));

  // ── 4. Lifecycle ──────────────────────────────────────────────────────────
  console.log('\n4. LIFECYCLE');
  check('Closed is terminal', ALERT_TRANSITIONS.Closed.length === 0);
  check('Resolved may only close', ALERT_TRANSITIONS.Resolved.join() === 'Closed');
  check('Open may be acknowledged, resolved or closed',
    ['Acknowledged', 'Resolved', 'Closed'].every((s) => ALERT_TRANSITIONS.Open.includes(s)));
  check('nothing reopens a Closed alert',
    !Object.values(ALERT_TRANSITIONS).some((to) => to.includes('Open')));
  check('alerts cannot be deleted',
    /deleteOne.*deleteMany.*findOneAndDelete/s.test(readSource('models', 'InventoryAlert.js')));

  if (!WITH_DB) {
    console.log(`\n${'─'.repeat(52)}`);
    console.log(`   PASSED ${passed}   FAILED ${failed}   (static checks only)`);
    console.log('─'.repeat(52));
    console.log('\n   Re-run with --db to exercise dedup, cooldown and delivery.\n');
    process.exit(failed === 0 ? 0 : 1);
  }

  // ── Database-backed ───────────────────────────────────────────────────────
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/erp_portal');
  console.log(`\n🔌  Connected to MongoDB (${mongoose.connection.name})`);
  await InventoryAlert.syncIndexes();

  const TEST_SKU = '__M8_VERIFY__';
  const TEST_BRAND = 'Koken';
  const cleanup = async () => {
    // The model blocks deletes, so the collection is reached directly. This is
    // the ONLY place that is legitimate — a verification fixture, not a path
    // any part of the application can take.
    await mongoose.connection.collection('inventoryalerts').deleteMany({ skuCode: TEST_SKU });
    await mongoose.connection.collection('inventoryalerts').deleteMany({ relatedEntityId: '__M8_VERIFY_RUN__' });
    await StockHealth.deleteMany({ skuCode: TEST_SKU });
  };
  await cleanup();

  const actor = await User.findOne({ role: 'Admin' }).lean();
  const where = { skuCode: TEST_SKU, brand: TEST_BRAND };
  const silentRule = { enabled: true, severity: 'Medium', delivery: 'silent', cooldownHours: 24, notifyRoles: [] };

  // ── 5. Deduplication ──────────────────────────────────────────────────────
  console.log('\n5. DEDUPLICATION');
  const first = await raiseAlert({
    alertType: 'LOW_STOCK', ...where, title: 'first', message: 'first',
    triggerSource: 'health-projection', rule: silentRule, actor,
  });
  check('the first occurrence creates', first.action === 'created', JSON.stringify(first));

  const second = await raiseAlert({
    alertType: 'LOW_STOCK', ...where, title: 'second', message: 'second',
    triggerSource: 'health-projection', rule: silentRule, actor,
  });
  check('the second occurrence touches, not creates', second.action === 'touched', JSON.stringify(second));
  check('the occurrence counter rose', second.occurrences === 2, `got ${second.occurrences}`);
  check('only one alert exists',
    (await InventoryAlert.countDocuments({ skuCode: TEST_SKU, alertType: 'LOW_STOCK' })) === 1);

  // Concurrency: ten simultaneous raises must still leave exactly one.
  await Promise.all(Array.from({ length: 10 }, () => raiseAlert({
    alertType: 'CRITICAL_STOCK', ...where, title: 'race', message: 'race',
    triggerSource: 'health-projection', rule: silentRule, actor,
  })));
  check('ten concurrent raises leave exactly one active alert',
    (await InventoryAlert.countDocuments({ skuCode: TEST_SKU, alertType: 'CRITICAL_STOCK', active: true })) === 1);

  const dupeIndex = (await InventoryAlert.collection.indexes())
    .find((i) => i.key?.dedupeKey === 1);
  check('the dedup index is unique and partial',
    Boolean(dupeIndex?.unique && dupeIndex?.partialFilterExpression?.active === true));

  // ── 6. Transition firing ──────────────────────────────────────────────────
  console.log('\n6. TRANSITION FIRING');
  const cleared = await clearAlert({ alertType: 'LOW_STOCK', ...where, note: 'condition gone' });
  check('a cleared condition auto-resolves', cleared.action === 'resolved');
  const resolvedDoc = await InventoryAlert.findOne({ alertId: first.alertId }).lean();
  check('auto-resolution is flagged as such', resolvedDoc.autoResolved === true);
  check('the active flag is released', resolvedDoc.active === undefined);
  check('clearing a condition that is already clear is a no-op',
    (await clearAlert({ alertType: 'LOW_STOCK', ...where })).action === 'none');

  const recurrence = await raiseAlert({
    alertType: 'LOW_STOCK', ...where, title: 'again', message: 'again',
    triggerSource: 'health-projection', rule: silentRule, actor,
  });
  check('a recurrence raises a NEW alert, not a reopen', recurrence.action === 'created');
  check('the recurrence has its own id', recurrence.alertId !== first.alertId);

  // ── 7. Unknown band → Planning only (BR-54) ───────────────────────────────
  console.log('\n7. UNKNOWN BAND (BR-54)');
  await StockHealth.create({
    skuCode: TEST_SKU, brand: TEST_BRAND, band: 'Unknown', plannable: false,
    notPlannableReasons: ['NO_LEAD_TIME', 'NO_CONSUMPTION'],
    onHand: 0, available: 0, maxLevel: null, reorderLevel: null,
    replenishmentPercent: null, coverageDays: null, computedAt: new Date(),
  });
  // evaluateSkus loads rules from the database, so the only way to keep this
  // section from pushing real notifications is to silence the rules — which
  // means the prior settings MUST be captured and put back. A verification run
  // that leaves the system muted is worse than no verification at all.
  const priorRules = await AlertRule.find({}, 'alertType delivery').lean();
  await AlertRule.updateMany({}, { $set: { delivery: 'silent' } });

  await evaluateSkus([TEST_SKU], { brand: TEST_BRAND, actor });
  const afterUnknown = await InventoryAlert.find({ skuCode: TEST_SKU, active: true }).lean();
  const activeTypes = afterUnknown.map((a) => a.alertType);
  check('an Unknown SKU raises UNKNOWN_HEALTH', activeTypes.includes('UNKNOWN_HEALTH'));
  check('it raises the specific missing-input alerts',
    activeTypes.includes('MISSING_LEAD_TIME') && activeTypes.includes('MISSING_CONSUMPTION'));
  check('it raises NO stock-health alert',
    !activeTypes.some((t) => ALERT_TYPES[t].category === 'Stock Health'),
    activeTypes.filter((t) => ALERT_TYPES[t].category === 'Stock Health').join());
  check('every planning alert is category Planning',
    activeTypes.filter((t) => t.startsWith('MISSING') || t === 'UNKNOWN_HEALTH')
      .every((t) => ALERT_TYPES[t].category === 'Planning'));

  // Becoming plannable and Critical must flip the whole set over.
  await StockHealth.updateOne({ skuCode: TEST_SKU, brand: TEST_BRAND }, {
    $set: {
      band: 'Critical', plannable: true, notPlannableReasons: [],
      onHand: 5, available: 5, maxLevel: 100, replenishmentPercent: 5, coverageDays: 2,
    },
  });
  await evaluateSkus([TEST_SKU], { brand: TEST_BRAND, actor });
  const afterCritical = (await InventoryAlert.find({ skuCode: TEST_SKU, active: true }).lean())
    .map((a) => a.alertType);
  check('becoming plannable raises CRITICAL_STOCK', afterCritical.includes('CRITICAL_STOCK'));
  check('the planning alerts auto-resolved',
    !afterCritical.includes('UNKNOWN_HEALTH') && !afterCritical.includes('MISSING_LEAD_TIME'),
    afterCritical.join());
  check('the values on the alert are copied from the projection', await (async () => {
    const a = await InventoryAlert.findOne({ skuCode: TEST_SKU, alertType: 'CRITICAL_STOCK', active: true }).lean();
    return a?.snapshot?.onHand === 5 && a?.snapshot?.maxLevel === 100 && a?.snapshot?.band === 'Critical';
  })());

  // ── 8. Cooldown ───────────────────────────────────────────────────────────
  console.log('\n8. COOLDOWN (BR-56)');
  const immediate = { enabled: true, severity: 'Critical', delivery: 'immediate', cooldownHours: 24, notifyRoles: ['Admin'] };
  const notifiedBefore = await Notification.countDocuments({ type: 'inventory' });

  const push1 = await raiseAlert({
    alertType: 'OUT_OF_STOCK', ...where, title: 'push 1', message: 'push 1',
    triggerSource: 'health-projection', rule: immediate, actor,
  });
  const pushed1 = await InventoryAlert.findOne({ alertId: push1.alertId }).lean();
  check('an immediate alert delivers in-app',
    pushed1.deliveries.some((d) => d.channel === 'in-app' && d.status === 'sent'));
  check('a notification row was written',
    (await Notification.countDocuments({ type: 'inventory' })) > notifiedBefore);
  check('lastNotifiedAt is stamped', Boolean(pushed1.lastNotifiedAt));

  // Resolve it, then raise the same condition again inside the window.
  await clearAlert({ alertType: 'OUT_OF_STOCK', ...where, note: 'test' });
  const push2 = await raiseAlert({
    alertType: 'OUT_OF_STOCK', ...where, title: 'push 2', message: 'push 2',
    triggerSource: 'health-projection', rule: immediate, actor,
  });
  const pushed2 = await InventoryAlert.findOne({ alertId: push2.alertId }).lean();
  check('a recurrence inside the cooldown is still RECORDED', push2.action === 'created');
  check('but is not pushed',
    pushed2.deliveries.some((d) => d.channel === 'in-app' && d.status === 'skipped' && d.reason === 'within cooldown'),
    JSON.stringify(pushed2.deliveries));

  // ── 9. Immutability ───────────────────────────────────────────────────────
  console.log('\n9. IMMUTABILITY');
  const doc = await InventoryAlert.findOne({ alertId: push2.alertId });
  await expectFail('the alert type cannot be rewritten', async () => {
    doc.alertType = 'LOW_STOCK';
    await doc.save();
  });
  const doc2 = await InventoryAlert.findOne({ alertId: push2.alertId });
  await expectFail('the trigger snapshot cannot be rewritten', async () => {
    doc2.snapshot = { onHand: 9999 };
    await doc2.save();
  });
  await expectFail('alerts cannot be deleted',
    () => InventoryAlert.deleteOne({ alertId: push2.alertId }));

  const doc3 = await InventoryAlert.findOne({ alertId: push2.alertId });
  doc3.occurrences += 1;
  await doc3.save();
  check('lifecycle fields remain writable',
    (await InventoryAlert.findOne({ alertId: push2.alertId }).lean()).occurrences === 2);

  // Lifecycle guards.
  const acked = await transitionAlert({ alertId: push2.alertId, to: 'Acknowledged', actor, req: null });
  check('Open → Acknowledged is allowed', acked.status === 'Acknowledged');
  await transitionAlert({ alertId: push2.alertId, to: 'Closed', note: 'done', actor, req: null });
  await expectFail('a Closed alert cannot be reopened',
    () => transitionAlert({ alertId: push2.alertId, to: 'Acknowledged', actor, req: null }));

  // Acting on an alert must release the dedup key exactly as an auto-resolve
  // does. If it did not, the next occurrence of a condition someone had already
  // dealt with would silently reopen the closed alert instead of raising a new
  // one — and the two would be indistinguishable afterwards.
  const closed = await InventoryAlert.findOne({ alertId: push2.alertId }).lean();
  check('closing through the API releases the dedup key', closed.active === undefined);

  const reopened = await raiseAlert({
    alertType: 'OUT_OF_STOCK', ...where, title: 'after close', message: 'after close',
    triggerSource: 'health-projection', rule: silentRule, actor,
  });
  check('a condition recurring after a manual close raises a new alert',
    reopened.action === 'created' && reopened.alertId !== push2.alertId);

  const manual = await transitionAlert({ alertId: reopened.alertId, to: 'Resolved', note: 'PO raised', actor, req: null });
  check('a manual resolve is NOT flagged as automatic', manual.autoResolved === false);
  check('resolving through the API releases the dedup key',
    (await InventoryAlert.findOne({ alertId: reopened.alertId }).lean()).active === undefined);

  // ── 10. Delivery channels ─────────────────────────────────────────────────
  console.log('\n10. DELIVERY');
  check('email is recorded as an unenabled channel',
    pushed1.deliveries.some((d) => d.channel === 'email' && d.status === 'skipped'));
  check('webhook is recorded as an unenabled channel',
    pushed1.deliveries.some((d) => d.channel === 'webhook' && d.status === 'skipped'));
  check('no email was actually sent',
    !/nodemailer|sendMail|smtp/i.test(service + subscriber));

  const digest = await raiseAlert({
    alertType: 'OVERSTOCK', ...where, title: 'digest', message: 'digest',
    triggerSource: 'health-projection',
    rule: { enabled: true, severity: 'Low', delivery: 'digest', cooldownHours: 24, notifyRoles: ['Admin'] },
    actor,
  });
  const digested = await InventoryAlert.findOne({ alertId: digest.alertId }).lean();
  check('a digest alert is recorded but not pushed',
    digested.deliveries.some((d) => d.channel === 'in-app' && d.status === 'skipped' && d.reason === 'digest delivery'));

  const disabled = await raiseAlert({
    alertType: 'OVERSTOCK', skuCode: `${TEST_SKU}_OFF`, brand: TEST_BRAND,
    title: 'off', message: 'off', triggerSource: 'health-projection',
    rule: { enabled: false }, actor,
  });
  check('a disabled rule raises nothing', disabled.skipped === 'rule-disabled');

  // ── 11. Subscriptions ─────────────────────────────────────────────────────
  console.log('\n11. SUBSCRIPTIONS');
  // Nothing has subscribed yet — server.js is not loaded by this script — so
  // the first call is what binds the handlers.
  check('nothing is bound before subscribing',
    Object.values(listenerCounts()).every((n) => n === 0));

  const afterFirst = subscribeAlerts();
  check('subscribing binds every producer event',
    [EVENTS.HEALTH_PROJECTED, EVENTS.COUNT_SUBMITTED, EVENTS.COUNT_POSTED, EVENTS.COUNT_REJECTED,
      EVENTS.OVERSOLD_RAISED, EVENTS.SNAPSHOT_COMPLETED, EVENTS.SNAPSHOT_FAILED,
      EVENTS.CONFIG_UPDATED, EVENTS.PROJECTION_FAILED].every((e) => afterFirst[e] === 1),
    JSON.stringify(afterFirst));

  const afterSecond = subscribeAlerts();
  check('subscribing twice does not double-bind — one event, one alert',
    JSON.stringify(afterFirst) === JSON.stringify(afterSecond));

  check('a malformed event cannot throw into the producer', (() => {
    let threw = false;
    try { emitEvent(EVENTS.HEALTH_PROJECTED, { skuCodes: null }); } catch { threw = true; }
    return !threw;
  })());
  check('an event with no listener is harmless', (() => {
    let threw = false;
    try { emitEvent('nothing.listens.to.this', {}); } catch { threw = true; }
    return !threw;
  })());

  resetBus();

  // ── Restore ───────────────────────────────────────────────────────────────
  if (priorRules.length) {
    await AlertRule.bulkWrite(
      priorRules.map((r) => ({
        updateOne: { filter: { alertType: r.alertType }, update: { $set: { delivery: r.delivery } } },
      })),
      { ordered: false },
    );
    const restored = await AlertRule.find({}, 'alertType delivery').lean();
    const byType = new Map(restored.map((r) => [r.alertType, r.delivery]));
    check('alert rules restored to their prior delivery settings',
      priorRules.every((r) => byType.get(r.alertType) === r.delivery));
  }

  await cleanup();
  await mongoose.connection.collection('inventoryalerts').deleteMany({ skuCode: `${TEST_SKU}_OFF` });
  await Notification.deleteMany({ title: { $in: ['push 1', 'push 2'] } });

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`   PASSED ${passed}   FAILED ${failed}`);
  console.log('─'.repeat(52));
  console.log(failed === 0
    ? '\n✅  Alert engine guarantees hold.\n'
    : '\n❌  M8 verification FAILED — see above.\n');

  await mongoose.disconnect();
  process.exit(failed === 0 ? 0 : 1);
};

run().catch(async (err) => {
  console.error('\n❌  Verification crashed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
