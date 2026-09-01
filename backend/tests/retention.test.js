/**
 * Retention infrastructure (AD-16) and the audit trail around it.
 *
 * Phase 0 verification requirement 11: retention jobs are configurable.
 *
 * The sweep orchestration, the registry and the pointer-purge ordering are
 * tested directly with in-memory fakes, so no database is required. The audit
 * handler's own query shape is asserted at the source level.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  registerRetentionHandler,
  getRetentionHandler,
  registeredRetentionCategories,
  __resetRetentionHandlers,
} from '../modules/hrms/retention/retention.registry.js';
import { cutoffFor } from '../modules/hrms/retention/retention.sweep.js';
import { purgeStoredObjects } from '../modules/hrms/retention/purgeStoredObjects.js';
import {
  RETENTION_CATEGORIES,
  RETENTION_CATEGORY_LIST,
  RETENTION_ACTIONS,
  RETENTION_EXEMPT_AUDIT_ACTIONS,
  AUDIT_ACTIONS,
  DEFAULT_RETENTION_POLICY,
} from '../shared/constants/hrms.js';

const src = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('a handler can only be registered for a known category', (t) => {
  t.after(() => __resetRetentionHandlers());
  __resetRetentionHandlers();

  assert.throws(
    () => registerRetentionHandler('made-up', { sweep: async () => ({}) }),
    /unknown retention category/,
  );
  assert.throws(
    () => registerRetentionHandler(RETENTION_CATEGORIES.AUDIT_LOG, {}),
    TypeError,
  );

  registerRetentionHandler(RETENTION_CATEGORIES.AUDIT_LOG, { sweep: async () => ({}) });
  assert.ok(getRetentionHandler(RETENTION_CATEGORIES.AUDIT_LOG));
  assert.deepEqual(registeredRetentionCategories(), [RETENTION_CATEGORIES.AUDIT_LOG]);
});

test('an unregistered category has no handler', (t) => {
  t.after(() => __resetRetentionHandlers());
  __resetRetentionHandlers();
  assert.equal(getRetentionHandler(RETENTION_CATEGORIES.ATTENDANCE_SELFIES), null);
});

// ---------------------------------------------------------------------------
// Cutoff
// ---------------------------------------------------------------------------

test('the cutoff is computed from the configured window, not a constant', () => {
  const now = new Date('2026-09-01T00:00:00.000Z');
  assert.equal(cutoffFor(90, now).toISOString(), '2026-06-03T00:00:00.000Z');
  assert.equal(cutoffFor(1095, now).toISOString(), '2023-09-02T00:00:00.000Z');
  // The window is a parameter: changing config changes the cutoff, with no
  // code change anywhere.
  assert.notEqual(cutoffFor(30, now).getTime(), cutoffFor(31, now).getTime());
});

// ---------------------------------------------------------------------------
// Deletion ordering (AD-16) - the pointer goes first
// ---------------------------------------------------------------------------

/** A minimal stand-in for a Mongoose model, recording the call order. */
function fakeModel(docs, { calls }) {
  let remaining = [...docs];
  return {
    find() {
      return {
        select() {
          return {
            limit(n) {
              return {
                async lean() {
                  const batch = remaining.slice(0, n);
                  return batch;
                },
              };
            },
          };
        },
      };
    },
    async updateMany(filter, update) {
      calls.push('updateMany');
      const ids = new Set(filter._id.$in.map(String));
      remaining = remaining.filter((d) => !ids.has(String(d._id)));
      return { modifiedCount: ids.size, update };
    },
  };
}

test('the database pointer is cleared BEFORE the object is deleted', async () => {
  const calls = [];
  const deleteObjects = async (keys) => {
    calls.push('deleteObjects');
    return { deleted: keys, failed: [] };
  };

  const model = fakeModel(
    [
      { _id: '1', selfieKey: 'hrms/attendance/selfies/a/1.jpg' },
      { _id: '2', selfieKey: 'hrms/attendance/selfies/a/2.jpg' },
    ],
    { calls },
  );

  const res = await purgeStoredObjects({
    model,
    filter: {},
    keyFields: ['selfieKey'],
    batchSize: 10,
    deleteObjects,
  });

  assert.equal(res.cleared, 2);
  assert.deepEqual(
    calls,
    ['updateMany', 'deleteObjects'],
    'a failed object delete must leave an orphan, never a dangling pointer',
  );
});

test('an S3 failure produces an orphan rather than aborting the sweep', async () => {
  const calls = [];
  const deleteObjects = async (keys) => ({
    deleted: keys.slice(1),
    failed: [{ key: keys[0], error: 'AccessDenied' }],
  });

  const model = fakeModel(
    [
      { _id: '1', selfieKey: 'a.jpg' },
      { _id: '2', selfieKey: 'b.jpg' },
    ],
    { calls },
  );

  const res = await purgeStoredObjects({
    model,
    filter: {},
    keyFields: ['selfieKey'],
    batchSize: 10,
    deleteObjects,
  });

  assert.equal(res.cleared, 2, 'both pointers are still cleared');
  assert.equal(res.orphaned, 1);
  assert.match(res.notes.join(' '), /orphaned a\.jpg.*lifecycle rule will reap it/);
});

test('a dry run changes nothing', async () => {
  const calls = [];
  const deleteObjects = async () => {
    calls.push('deleteObjects');
    return { deleted: [], failed: [] };
  };

  const model = fakeModel([{ _id: '1', selfieKey: 'a.jpg' }], { calls });
  const res = await purgeStoredObjects({
    model,
    filter: {},
    keyFields: ['selfieKey'],
    dryRun: true,
    batchSize: 10,
    deleteObjects,
  });

  assert.equal(res.cleared, 0);
  assert.deepEqual(calls, [], 'neither the database nor storage may be touched');
  assert.match(res.notes[0], /\[dry run\]/);
});

// ---------------------------------------------------------------------------
// The sweep's own audit trail must survive its own window
// ---------------------------------------------------------------------------

test('the retention sweep and config-change actions are exempt from expiry', () => {
  assert.ok(RETENTION_EXEMPT_AUDIT_ACTIONS.includes(AUDIT_ACTIONS.RETENTION_SWEEP));
  assert.ok(RETENTION_EXEMPT_AUDIT_ACTIONS.includes(AUDIT_ACTIONS.RETENTION_CONFIG_CHANGED));
});

test('the audit handler excludes the exempt actions from its own filter', async () => {
  const code = await src('../modules/hrms/retention/auditRetention.handler.js');
  assert.match(
    code,
    /action: \{ \$nin: RETENTION_EXEMPT_AUDIT_ACTIONS \}/,
    'without this the record of deletion is itself deleted',
  );
  // A scheduled job, not a TTL index - a TTL index cannot archive and its
  // window is not configurable.
  assert.doesNotMatch(code, /expireAfterSeconds/);
  assert.match(code, /RETENTION_ACTIONS\.ARCHIVE/, 'archiving must be supported');
});

test('the sweep writes ONE summary per run and reports what it skipped', async () => {
  const code = await src('../modules/hrms/retention/retention.sweep.js');
  assert.match(code, /recordSystemAudit\(\s*\n?\s*AUDIT_ACTIONS\.RETENTION_SWEEP/);
  assert.match(code, /skipped\.push/, 'a configured category with no handler must be reported');
  assert.match(code, /if \(!dryRun/, 'a dry run must not write an audit row');
});

// ---------------------------------------------------------------------------
// Configurability (verification requirement 11)
// ---------------------------------------------------------------------------

test('no retention period is hardcoded in a service', async () => {
  const files = [
    '../modules/hrms/retention/retention.sweep.js',
    '../modules/hrms/retention/auditRetention.handler.js',
    '../modules/hrms/retention/purgeStoredObjects.js',
    '../modules/hrms/retention/retention.controller.js',
  ];
  for (const rel of files) {
    const stripped = (await src(rel))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.doesNotMatch(stripped, /\b1095\b/, `${rel} hardcodes the audit window`);
    assert.doesNotMatch(stripped, /\b90\s*\*\s*24\b/, `${rel} hardcodes the selfie window`);
  }
});

test('the seeded policy matches the two decided categories and retains the rest', () => {
  assert.deepEqual(DEFAULT_RETENTION_POLICY[RETENTION_CATEGORIES.ATTENDANCE_SELFIES], {
    days: 90,
    action: RETENTION_ACTIONS.DELETE,
  });
  assert.deepEqual(DEFAULT_RETENTION_POLICY[RETENTION_CATEGORIES.AUDIT_LOG], {
    days: 1095,
    action: RETENTION_ACTIONS.ARCHIVE,
  });

  for (const category of RETENTION_CATEGORY_LIST) {
    if (
      category === RETENTION_CATEGORIES.ATTENDANCE_SELFIES ||
      category === RETENTION_CATEGORIES.AUDIT_LOG
    ) {
      continue;
    }
    assert.equal(DEFAULT_RETENTION_POLICY[category].days, null);
    assert.equal(DEFAULT_RETENTION_POLICY[category].action, RETENTION_ACTIONS.RETAIN);
  }
});

test('the config model treats null days as retain, never as expire-now', async () => {
  const code = await src('../models/hrms/HrmsConfig.js');
  assert.match(code, /rule\.days !== null && rule\.action !== RETENTION_ACTIONS\.RETAIN/);
  assert.match(code, /days: \{ type: Number, default: null/);
});

test('the sweep is scheduled on the existing daily cron, not a new scheduler', async () => {
  const server = await src('../server.js');
  assert.match(server, /runHrmsRetentionSweep/);
  assert.match(server, /cron\.schedule\('0 0 \* \* \*'/);
  assert.match(server, /bootstrapHrms\(\)/, 'handlers must be registered at startup');
  // No new queue infrastructure.
  assert.doesNotMatch(server, /bullmq|BullMQ/);
});

test('an on-demand sweep defaults to a dry run', async () => {
  const code = await src('../modules/hrms/retention/retention.controller.js');
  assert.match(
    code,
    /const dryRun = req\.body\?\.dryRun !== false/,
    'an operator must be able to preview without deleting',
  );
});

test('retention routes require settings permissions', async () => {
  const code = await src('../modules/hrms/retention/retention.routes.js');
  assert.match(code, /canView.*M\.SETTINGS, action: A\.VIEW, scope: S\.ORG/s);
  assert.match(code, /canEdit.*M\.SETTINGS, action: A\.EDIT, scope: S\.ORG/s);
  assert.match(code, /router\.put\('\/', canEdit/);
  assert.match(code, /router\.post\('\/sweep', canEdit/);
});

test('the audit log is indexed for the sweep query', async () => {
  const code = await src('../models/AuditLog.js');
  assert.match(
    code,
    /auditLogSchema\.index\(\{ createdAt: 1, action: 1 \}\)/,
    'the sweep would otherwise scan the largest collection in the system',
  );
});
