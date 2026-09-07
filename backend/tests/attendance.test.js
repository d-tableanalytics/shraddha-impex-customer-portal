/**
 * Attendance — services and the HTTP layer.
 *
 * A real Express app over a real MongoDB, following the pattern the Employee
 * Master and Org Structure route tests established. Only `protect` is stubbed;
 * the permission chain, the validator, the services, the storage service and
 * the error handler are all the genuine article, because those are the parts a
 * route test exists to exercise.
 *
 * The security assertions are the point of this file. AD-15 names three
 * defects in the reference and this suite proves each is closed:
 *   1. the selfie endpoint is authenticated and scope-checked, not public
 *   2. coordinates are stored per punch, so a clock-out cannot overwrite them
 *   3. a punch never waits on the geocoder
 * plus the consent rule the reference has no equivalent for: declining capture
 * must still leave the punch possible.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.STORAGE_LOCAL_PATH =
  process.env.STORAGE_LOCAL_PATH ||
  (await fs.mkdtemp(path.join(os.tmpdir(), 'hrms-attendance-')));

// Fixed before the module graph loads: the biometric service reads it at call
// time, but setting it here keeps the enabled/disabled cases explicit.
process.env.HRMS_BIOMETRIC_WEBHOOK_SECRET = 'test-biometric-secret-value';

const Employee = (await import('../models/hrms/Employee.js')).default;
const User = (await import('../models/User.js')).default;
const AttendanceRecord = (await import('../models/hrms/AttendanceRecord.js')).default;
const AttendanceCorrection = (await import('../models/hrms/AttendanceCorrection.js')).default;
const AttendanceConsent = (await import('../models/hrms/AttendanceConsent.js')).default;
const AuditLog = (await import('../models/AuditLog.js')).default;
const HrmsConfig = (await import('../models/hrms/HrmsConfig.js')).default;

const attendanceRoutes = (await import('../modules/hrms/attendance/attendance.routes.js')).default;
const biometricRoutes = (await import('../modules/hrms/attendance/biometric.routes.js')).default;
const { captureBiometricRawBody } = await import('../modules/hrms/attendance/rawBody.js');
const attendanceService = await import('../modules/hrms/attendance/attendance.service.js');
const consentService = await import('../modules/hrms/attendance/consent.service.js');
const selfieService = await import('../modules/hrms/attendance/selfie.service.js');
const biometricService = await import('../modules/hrms/attendance/biometric.service.js');
const geocode = await import('../modules/hrms/attendance/geocode.service.js');
const { attendanceSelfieRetentionHandler } = await import(
  '../modules/hrms/attendance/selfieRetention.handler.js'
);

const { hrmsAuthorizationChain, setEmployeeResolver } = await import('../middlewares/hrmsAuth.js');
const { hrmsErrorHandler } = await import('../modules/hrms/hrms.errors.js');
const {
  registerReferenceProvider,
  __resetReferenceProviders,
} = await import('../modules/hrms/references/reference.service.js');
const { employeeReferenceProvider } = await import(
  '../modules/hrms/employees/employee.provider.js'
);
const {
  __resetFileAccessRules,
  issueReadUrl,
  FileAccessError,
} = await import('../modules/hrms/storage/storage.service.js');
const { registerRetentionHandler, __resetRetentionHandlers } = await import(
  '../modules/hrms/retention/retention.registry.js'
);
const { runHrmsRetentionSweep } = await import('../modules/hrms/retention/retention.sweep.js');
const { putObject, objectExists } = await import('../utils/hrms/storage/index.js');

const { HRMS_ROLES: R } = await import('../shared/permissions/constants.js');
const { STORAGE_CATEGORIES, RETENTION_CATEGORIES, CONSENT_PURPOSES, AUDIT_ACTIONS } = await import(
  '../shared/constants/hrms.js'
);
const { attendanceDayString, dayToDate, shiftDay } = await import(
  '../shared/attendance/status.js'
);
const {
  buildTestApp,
  stubProtect,
  withServer,
  get,
  post,
} = await import('./helpers/http.js');
const { startTestMongo, stopTestMongo, syncIndexes, clearCollections } = await import(
  './helpers/mongo.js'
);

const P = '/api/v1/hrms/attendance';
const oid = () => new mongoose.Types.ObjectId();
const TODAY = () => attendanceDayString();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

before(async () => {
  await startTestMongo();
  await syncIndexes(
    Employee,
    User,
    AttendanceRecord,
    AttendanceCorrection,
    AttendanceConsent,
  );
});

after(async () => {
  await stopTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  __resetReferenceProviders();
  __resetFileAccessRules();
  __resetRetentionHandlers();
  geocode.__resetGeocodeCache();
  // No outbound HTTP from a test. The default driver would try Nominatim.
  geocode.setGeocoder(null);

  registerReferenceProvider('employee', employeeReferenceProvider);
  setEmployeeResolver((userId) => employeeReferenceProvider.byUserId(userId));
  selfieService.registerSelfieAccessRule();
});

/** An app mounting the authenticated attendance router as production does. */
function appFor(user) {
  return buildTestApp({
    mount: (app) => {
      const router = express.Router();
      router.use(stubProtect(user));
      router.use(hrmsAuthorizationChain);
      router.use('/attendance', attendanceRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

/**
 * The biometric webhook, wired EXACTLY as production wires it.
 *
 * `buildTestApp` is not used here, deliberately. It applies a plain
 * `express.json()`, and the whole point of this route is that the global JSON
 * parser consumes the stream — so the raw bytes must come from that parser's
 * `verify` hook, as they do in app.js. A test app without the hook would pass
 * or fail for reasons that have nothing to do with the code under test, and
 * would have hidden the bug this arrangement caught.
 */
function biometricApp() {
  const app = express();
  app.use(express.json({ limit: '10mb', verify: captureBiometricRawBody }));
  app.use('/api/v1/hrms/attendance/biometric', biometricRoutes);
  app.use((req, res) => res.status(404).json({ success: false, message: 'Not found' }));
  return app;
}

let seq = 0;

/** A User plus its Employee, wired the way the actor resolver expects. */
async function makeEmployee({
  roles = [R.EMPLOYEE],
  status = 'active',
  managerChain = [],
  reportingManagerId = null,
  deletedAt = null,
} = {}) {
  seq += 1;
  const user = await User.create({
    email: `att${seq}@example.com`,
    password: 'x'.repeat(60),
    user: `Person ${seq}`,
    role: 'Management',
    roles,
    status: 'Active',
  });

  const employee = await Employee.create({
    userId: user._id,
    employeeCode: `EMP${String(seq).padStart(3, '0')}`,
    firstName: 'Person',
    lastName: String(seq),
    dateOfJoining: new Date('2024-01-01'),
    status,
    managerChain,
    reportingManagerId,
    deletedAt,
  });

  return {
    user: { _id: user._id, role: 'Management', roles, status: 'Active' },
    employee,
    id: String(employee._id),
  };
}

/** Grant consent directly, bypassing the endpoint, for punch-flow setup. */
const grantConsent = (employeeId, purpose) =>
  AttendanceConsent.create({
    employeeId,
    purpose,
    granted: true,
    consentTextVersion: consentService.CONSENT_NOTICES[purpose].version,
    grantedAt: new Date(),
  });

/** A real 1x1 JPEG, so magic-byte validation sees genuine bytes. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

/** Upload a selfie through the service, returning its storage key. */
const uploadFor = (employeeId) =>
  selfieService.storeSelfie({ employeeId, buffer: JPEG, mimeType: 'image/jpeg' });

// ===========================================================================
// Authentication and the AD-4 gate
// ===========================================================================

test('every attendance endpoint refuses an unauthenticated caller', async () => {
  const app = appFor(null);
  await withServer(app, async (url) => {
    for (const [method, route] of [
      ['GET', '/today'],
      ['GET', '/'],
      ['GET', '/team-grid'],
      ['GET', '/corrections'],
      ['GET', '/consent'],
    ]) {
      const res = await get(url, `${P}${route}`);
      assert.equal(res.status, 401, `${method} ${route} must be 401`);
    }
    for (const route of ['/clock-in', '/clock-out', '/corrections', '/consent']) {
      const res = await post(url, `${P}${route}`, {});
      assert.equal(res.status, 401, `POST ${route} must be 401`);
    }
  });
});

test('a portal Customer holds no HRMS grant and is refused (AD-4)', async () => {
  const customer = { _id: oid(), role: 'Customer', roles: ['Customer'], status: 'Active' };
  await withServer(appFor(customer), async (url) => {
    const res = await get(url, `${P}/today`);
    assert.equal(res.status, 403);
    assert.match(res.body.message, /no HRMS access/i);
  });
});

test('a suspended account cannot reach attendance even holding an HRMS role', async () => {
  const user = { _id: oid(), role: 'Management', roles: [R.EMPLOYEE], status: 'Suspended' };
  await withServer(appFor(user), async (url) => {
    assert.equal((await get(url, `${P}/today`)).status, 401);
  });
});

// ===========================================================================
// Clock in / clock out
// ===========================================================================

test('an employee clocks in, and the record carries the SERVER time', async () => {
  const { user, id } = await makeEmployee();

  await withServer(appFor(user), async (url) => {
    const before = Date.now();
    const res = await post(url, `${P}/clock-in`, { source: 'web' });
    const after = Date.now();

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);

    // The envelope, asserted explicitly: a payload spread beside `data`
    // instead of under it is the bug that once killed the employee directory.
    const record = res.body.data;
    assert.ok(record.id, 'the payload must be under data');
    assert.equal(record.employeeId, id);
    assert.equal(record.date, TODAY());
    assert.equal(record.status, 'present');
    assert.equal(record.source, 'web');

    const at = new Date(record.clockIn).getTime();
    assert.ok(at >= before && at <= after, 'the punch time is the server clock');
  });
});

test('a punch body cannot name an employee - the actor decides', async () => {
  const { user, id } = await makeEmployee();
  const victim = await makeEmployee();

  await withServer(appFor(user), async (url) => {
    // `.strict()` refuses the unknown key outright rather than ignoring it,
    // so a caller learns their attempt was rejected, not silently rewritten.
    const res = await post(url, `${P}/clock-in`, { employeeId: victim.id });
    assert.equal(res.status, 400);

    const clean = await post(url, `${P}/clock-in`, {});
    assert.equal(clean.body.data.employeeId, id);
    assert.equal(await AttendanceRecord.countDocuments({ employeeId: victim.id }), 0);
  });
});

test('a second clock-in on the same day is a 409, not an overwrite', async () => {
  const { user } = await makeEmployee();

  await withServer(appFor(user), async (url) => {
    const first = await post(url, `${P}/clock-in`, {});
    assert.equal(first.status, 201);

    const second = await post(url, `${P}/clock-in`, {});
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'ATTENDANCE_ALREADY_CLOCKED_IN');

    const record = await AttendanceRecord.findOne({});
    assert.equal(
      new Date(record.clockIn).toISOString(),
      first.body.data.clockIn,
      'the original punch time is untouched',
    );
  });
});

test('clocking out without clocking in is refused', async () => {
  const { user } = await makeEmployee();
  await withServer(appFor(user), async (url) => {
    const res = await post(url, `${P}/clock-out`, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'ATTENDANCE_NOT_CLOCKED_IN');
  });
});

test('a second clock-out is refused', async () => {
  const { user } = await makeEmployee();
  await withServer(appFor(user), async (url) => {
    await post(url, `${P}/clock-in`, {});
    assert.equal((await post(url, `${P}/clock-out`, {})).status, 200);

    const again = await post(url, `${P}/clock-out`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'ATTENDANCE_ALREADY_CLOCKED_OUT');
  });
});

test('concurrent clock-ins produce ONE record - the unique index decides', async () => {
  const { user, employee } = await makeEmployee();

  await withServer(appFor(user), async (url) => {
    const results = await Promise.all([
      post(url, `${P}/clock-in`, {}),
      post(url, `${P}/clock-in`, {}),
      post(url, `${P}/clock-in`, {}),
    ]);

    const created = results.filter((r) => r.status === 201);
    assert.equal(created.length, 1, 'exactly one request may win');
    for (const loser of results.filter((r) => r.status !== 201)) {
      assert.equal(loser.status, 409);
    }
    assert.equal(await AttendanceRecord.countDocuments({ employeeId: employee._id }), 1);
  });
});

// ===========================================================================
// Employment status and soft deletion
// ===========================================================================

test('a soft-deleted employee cannot clock in', async () => {
  const { user, employee } = await makeEmployee();
  await Employee.updateOne({ _id: employee._id }, { $set: { deletedAt: new Date() } });

  await withServer(appFor(user), async (url) => {
    const res = await post(url, `${P}/clock-in`, {});
    assert.equal(res.status, 403);
    // Refused one layer earlier than the service's own status check: the
    // actor's employee lookup filters `deletedAt: null`, so a soft-deleted
    // person resolves to no employee context at all. Two independent refusals
    // for the same condition, which is the right number for this one.
    assert.match(res.body.message, /no employee record|no longer active/i);
    assert.equal(await AttendanceRecord.countDocuments({}), 0);
  });
});

test('the service refuses a soft-deleted employee even with a live actor', async () => {
  // The guard the test above cannot reach, asserted directly: an employee
  // soft-deleted between the actor being built and the punch arriving.
  const { employee } = await makeEmployee();
  const actor = {
    userId: String(oid()),
    employeeId: String(employee._id),
    departmentId: null,
    managerChain: [],
    roleKeys: [R.EMPLOYEE],
    permissions: [],
  };
  await Employee.updateOne({ _id: employee._id }, { $set: { deletedAt: new Date() } });

  await assert.rejects(
    () => attendanceService.clockIn(actor, { source: 'web' }, {}),
    /no longer active/i,
  );
  assert.equal(await AttendanceRecord.countDocuments({}), 0);
});

test('an exited, invited or suspended employee cannot clock in', async () => {
  for (const status of ['exited', 'invited', 'suspended', 'inactive']) {
    await clearCollections();
    registerReferenceProvider('employee', employeeReferenceProvider);
    const { user } = await makeEmployee({ status });

    await withServer(appFor(user), async (url) => {
      const res = await post(url, `${P}/clock-in`, {});
      assert.equal(res.status, 403, `status "${status}" must not be able to punch`);
      assert.match(res.body.message, /employment status/i);
    });
  }
});

test('probation and notice are working states and may punch', async () => {
  for (const status of ['probation', 'notice']) {
    await clearCollections();
    registerReferenceProvider('employee', employeeReferenceProvider);
    const { user } = await makeEmployee({ status });

    await withServer(appFor(user), async (url) => {
      assert.equal((await post(url, `${P}/clock-in`, {})).status, 201, status);
    });
  }
});

test('an HRMS user with no employee record is refused, and told why', async () => {
  const user = { _id: oid(), role: 'Management', roles: [R.EMPLOYEE], status: 'Active' };
  await withServer(appFor(user), async (url) => {
    const res = await post(url, `${P}/clock-in`, {});
    assert.equal(res.status, 403);
    assert.match(res.body.message, /no employee record/i);
  });
});

// ===========================================================================
// Consent (AD-15) - the rule the reference has no equivalent for
// ===========================================================================

test('a punch WITHOUT consent still succeeds - consent is free', async () => {
  const { user } = await makeEmployee();

  await withServer(appFor(user), async (url) => {
    const res = await post(url, `${P}/clock-in`, {});
    assert.equal(res.status, 201, 'declining capture must never block a punch');
    assert.equal(res.body.data.clockInCapture.hasSelfie, false);
    assert.equal(res.body.data.clockInCapture.geo, null);
  });
});

test('supplying a location without consent is refused', async () => {
  const { user } = await makeEmployee();

  await withServer(appFor(user), async (url) => {
    const res = await post(url, `${P}/clock-in`, { geo: { lat: 22.7, lng: 75.85 } });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /consent for location/i);
    assert.equal(await AttendanceRecord.countDocuments({}), 0, 'nothing is stored');
  });
});

test('supplying a selfie without consent is refused', async () => {
  const { user, employee } = await makeEmployee();
  const { key } = await uploadFor(employee._id);

  await withServer(appFor(user), async (url) => {
    const res = await post(url, `${P}/clock-in`, { selfieKey: key });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /consent for selfie/i);
  });
});

test('consent is recorded as an append-only ledger, and withdrawal erases captures', async () => {
  const { user, employee } = await makeEmployee();

  await withServer(appFor(user), async (url) => {
    const initial = await get(url, `${P}/consent`);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.data[CONSENT_PURPOSES.ATTENDANCE_LOCATION].granted, false);
    assert.equal(initial.body.data[CONSENT_PURPOSES.ATTENDANCE_LOCATION].decided, false);
    assert.ok(
      initial.body.data[CONSENT_PURPOSES.ATTENDANCE_LOCATION].notice.body.length > 50,
      'the notice text ships with the state so the UI cannot show different wording',
    );

    const granted = await post(url, `${P}/consent`, {
      purpose: CONSENT_PURPOSES.ATTENDANCE_LOCATION,
      granted: true,
    });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.data.state[CONSENT_PURPOSES.ATTENDANCE_LOCATION].granted, true);

    const punch = await post(url, `${P}/clock-in`, {
      geo: { lat: 22.7196, lng: 75.8577, accuracy: 12 },
    });
    assert.equal(punch.status, 201);
    assert.equal(punch.body.data.clockInCapture.geo.lat, 22.7196);
    assert.equal(punch.body.data.clockInCapture.geo.accuracy, 12);

    // Withdrawal ERASES what was captured, per AD-15's recommendation.
    const withdrawn = await post(url, `${P}/consent`, {
      purpose: CONSENT_PURPOSES.ATTENDANCE_LOCATION,
      granted: false,
    });
    assert.equal(withdrawn.status, 200);

    const record = await AttendanceRecord.findOne({ employeeId: employee._id }).lean();
    assert.equal(record.clockInCapture.geo, null, 'coordinates are erased on withdrawal');
    assert.ok(record.clockIn, 'but the punch itself survives - it is a business record');

    // Both decisions are kept; nothing is updated in place.
    const ledger = await AttendanceConsent.find({
      employeeId: employee._id,
      purpose: CONSENT_PURPOSES.ATTENDANCE_LOCATION,
    })
      .sort({ createdAt: 1 })
      .lean();
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0].granted, true);
    assert.equal(ledger[1].granted, false);
  });
});

test('consent decisions are audited', async () => {
  const { user } = await makeEmployee();

  await withServer(appFor(user), async (url) => {
    await post(url, `${P}/consent`, {
      purpose: CONSENT_PURPOSES.ATTENDANCE_SELFIE,
      granted: true,
    });
    await post(url, `${P}/consent`, {
      purpose: CONSENT_PURPOSES.ATTENDANCE_SELFIE,
      granted: false,
    });

    const actions = (await AuditLog.find({}).lean()).map((a) => a.action);
    assert.ok(actions.includes(AUDIT_ACTIONS.CONSENT_GRANTED));
    assert.ok(actions.includes(AUDIT_ACTIONS.CONSENT_WITHDRAWN));
  });
});

test('consent for one purpose is not consent for the other', async () => {
  const { user, employee } = await makeEmployee();
  await grantConsent(employee._id, CONSENT_PURPOSES.ATTENDANCE_LOCATION);

  await withServer(appFor(user), async (url) => {
    const ok = await post(url, `${P}/clock-in`, { geo: { lat: 1, lng: 1 } });
    assert.equal(ok.status, 201, 'location was consented');

    const { key } = await uploadFor(employee._id);
    const refused = await post(url, `${P}/clock-out`, { selfieKey: key });
    assert.equal(refused.status, 400, 'selfie was not');
    assert.match(refused.body.message, /consent for selfie/i);
  });
});

// ===========================================================================
// GPS validation
// ===========================================================================

test('out-of-range coordinates are refused at the boundary', async () => {
  const { user, employee } = await makeEmployee();
  await grantConsent(employee._id, CONSENT_PURPOSES.ATTENDANCE_LOCATION);

  await withServer(appFor(user), async (url) => {
    for (const geo of [
      { lat: 91, lng: 0 },
      { lat: -91, lng: 0 },
      { lat: 0, lng: 181 },
      { lat: 0, lng: -181 },
      { lat: 'north', lng: 0 },
      { lat: 0, lng: 0, accuracy: -5 },
      { lat: 0, lng: 0, accuracy: 999999 },
    ]) {
      const res = await post(url, `${P}/clock-in`, { geo });
      assert.equal(res.status, 400, `${JSON.stringify(geo)} must be refused`);
    }
    assert.equal(await AttendanceRecord.countDocuments({}), 0);
  });
});

test('coordinates are stored PER PUNCH - a clock-out cannot overwrite the clock-in (AD-15 defect 2)', async () => {
  const { user, employee } = await makeEmployee();
  await grantConsent(employee._id, CONSENT_PURPOSES.ATTENDANCE_LOCATION);

  await withServer(appFor(user), async (url) => {
    await post(url, `${P}/clock-in`, { geo: { lat: 22.7196, lng: 75.8577 } });
    const out = await post(url, `${P}/clock-out`, { geo: { lat: 19.076, lng: 72.8777 } });

    assert.equal(out.status, 200);
    // The reference keeps one geo pair for both punches, so this assertion is
    // exactly what it would fail.
    assert.equal(out.body.data.clockInCapture.geo.lat, 22.7196, 'the arrival location survives');
    assert.equal(out.body.data.clockOutCapture.geo.lat, 19.076, 'the departure is its own');
  });
});

// ===========================================================================
// Selfies - AD-15 defect 1
// ===========================================================================

test('the selfie upload rejects a non-image whatever its declared type', async () => {
  const { employee } = await makeEmployee();

  await assert.rejects(
    () =>
      selfieService.storeSelfie({
        employeeId: employee._id,
        // Declares itself a JPEG; the bytes are HTML.
        buffer: Buffer.from('<html><script>alert(1)</script></html>'),
        mimeType: 'image/jpeg',
      }),
    /not a valid JPEG, PNG or WebP/,
  );
});

test('the selfie upload rejects an unsupported type and an oversized file', async () => {
  const { employee } = await makeEmployee();

  await assert.rejects(
    () =>
      selfieService.storeSelfie({
        employeeId: employee._id,
        buffer: JPEG,
        mimeType: 'application/pdf',
      }),
    /Selfies must be one of/,
  );

  await assert.rejects(
    () =>
      selfieService.storeSelfie({
        employeeId: employee._id,
        // Past the 2 MB category ceiling AD-15 asks for.
        buffer: Buffer.concat([JPEG, Buffer.alloc(3 * 1024 * 1024)]),
        mimeType: 'image/jpeg',
      }),
    /larger than/,
  );
});

test("a selfie key belonging to someone else is refused at punch time", async () => {
  const attacker = await makeEmployee();
  const victim = await makeEmployee();
  await grantConsent(attacker.employee._id, CONSENT_PURPOSES.ATTENDANCE_SELFIE);

  const { key: victimKey } = await uploadFor(victim.employee._id);

  await withServer(appFor(attacker.user), async (url) => {
    const res = await post(url, `${P}/clock-in`, { selfieKey: victimKey });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /does not belong to you/i);
  });
});

test('a forged or traversing selfie key never reaches storage', async () => {
  const { user, employee } = await makeEmployee();
  await grantConsent(employee._id, CONSENT_PURPOSES.ATTENDANCE_SELFIE);

  await withServer(appFor(user), async (url) => {
    for (const selfieKey of [
      '../../etc/passwd',
      'hrms/attendance/selfies/../../../secret.jpg',
      'hrms/payroll/payslips/abc/1234.pdf',
      `hrms/attendance/selfies/${employee._id}/notauuid.jpg`,
      `hrms/attendance/selfies/${employee._id}/${crypto.randomUUID()}.exe`,
    ]) {
      const res = await post(url, `${P}/clock-in`, { selfieKey });
      assert.equal(res.status, 400, `${selfieKey} must be refused by the schema`);
    }
  });
});

test('the selfie URL endpoint is authenticated and scope-checked (AD-15 defect 1)', async () => {
  const owner = await makeEmployee();
  const stranger = await makeEmployee();
  await grantConsent(owner.employee._id, CONSENT_PURPOSES.ATTENDANCE_SELFIE);

  const { key } = await uploadFor(owner.employee._id);

  let recordId;
  await withServer(appFor(owner.user), async (url) => {
    const punch = await post(url, `${P}/clock-in`, { selfieKey: key });
    recordId = punch.body.data.id;

    // The owner may see their own.
    const mine = await get(url, `${P}/records/${recordId}/selfie/in`);
    assert.equal(mine.status, 200);
    assert.ok(mine.body.data.url, 'a presigned URL is issued');
    assert.equal(mine.body.data.expiresInSeconds, 60, 'AD-15 asks for a 60-second window');
  });

  // An unrelated colleague may NOT. In the reference this is a public route
  // that would have served the photograph to anyone at all.
  await withServer(appFor(stranger.user), async (url) => {
    const res = await get(url, `${P}/records/${recordId}/selfie/in`);
    assert.equal(res.status, 403);
  });

  // Neither may an unauthenticated caller.
  await withServer(appFor(null), async (url) => {
    assert.equal((await get(url, `${P}/records/${recordId}/selfie/in`)).status, 401);
  });
});

test("a manager may read a report's selfie; a peer may not", async () => {
  const manager = await makeEmployee({ roles: [R.MANAGER] });
  const report = await makeEmployee({ managerChain: [manager.employee._id] });
  const peer = await makeEmployee({ roles: [R.MANAGER] });
  await grantConsent(report.employee._id, CONSENT_PURPOSES.ATTENDANCE_SELFIE);

  const { key } = await uploadFor(report.employee._id);
  let recordId;
  await withServer(appFor(report.user), async (url) => {
    recordId = (await post(url, `${P}/clock-in`, { selfieKey: key })).body.data.id;
  });

  await withServer(appFor(manager.user), async (url) => {
    assert.equal((await get(url, `${P}/records/${recordId}/selfie/in`)).status, 200);
  });
  await withServer(appFor(peer.user), async (url) => {
    assert.equal(
      (await get(url, `${P}/records/${recordId}/selfie/in`)).status,
      403,
      'another manager outside the chain is a stranger',
    );
  });
});

test('issuing a selfie URL writes a SELFIE_VIEWED audit entry, not a generic file read', async () => {
  const { user, employee } = await makeEmployee();
  await grantConsent(employee._id, CONSENT_PURPOSES.ATTENDANCE_SELFIE);
  const { key } = await uploadFor(employee._id);

  await withServer(appFor(user), async (url) => {
    const recordId = (await post(url, `${P}/clock-in`, { selfieKey: key })).body.data.id;
    await AuditLog.deleteMany({});
    await get(url, `${P}/records/${recordId}/selfie/in`);

    const entries = await AuditLog.find({}).lean();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, AUDIT_ACTIONS.SELFIE_VIEWED);
    assert.equal(entries[0].meta.category, STORAGE_CATEGORIES.ATTENDANCE_SELFIE);
  });
});

test('a list response exposes hasSelfie, never a storage key or a URL', async () => {
  const { user, employee } = await makeEmployee();
  await grantConsent(employee._id, CONSENT_PURPOSES.ATTENDANCE_SELFIE);
  const { key } = await uploadFor(employee._id);

  await withServer(appFor(user), async (url) => {
    await post(url, `${P}/clock-in`, { selfieKey: key });
    const res = await get(url, `${P}/`);

    const body = JSON.stringify(res.body);
    assert.equal(res.body.data.data[0].clockInCapture.hasSelfie, true);
    assert.ok(!body.includes(key), 'the object key must never leave the server');
    assert.ok(!body.includes('selfieKey'));
  });
});

test('an orphan selfie - uploaded but never punched - is readable by nobody', async () => {
  const { user, employee } = await makeEmployee();
  const { key } = await uploadFor(employee._id);

  const actor = { ...(await employeeReferenceProvider.byUserId(String(user._id))) };
  await assert.rejects(
    () =>
      issueReadUrl({
        category: STORAGE_CATEGORIES.ATTENDANCE_SELFIE,
        key,
        actor: { userId: String(user._id), employeeId: actor.id, permissions: [] },
        req: {},
      }),
    (err) => err instanceof FileAccessError && err.statusCode === 404,
  );
});

// ===========================================================================
// Scope on reads
// ===========================================================================

test('an employee sees only their own attendance', async () => {
  const me = await makeEmployee();
  const other = await makeEmployee();

  await withServer(appFor(me.user), async (url) => {
    await post(url, `${P}/clock-in`, {});
  });
  await withServer(appFor(other.user), async (url) => {
    await post(url, `${P}/clock-in`, {});
  });

  await withServer(appFor(me.user), async (url) => {
    const res = await get(url, `${P}/`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.total, 1);
    assert.equal(res.body.data.data[0].employeeId, me.id);
  });
});

test("an employee asking for a colleague's records is refused, not given an empty page", async () => {
  const me = await makeEmployee();
  const other = await makeEmployee();

  await withServer(appFor(me.user), async (url) => {
    const res = await get(url, `${P}/?employeeId=${other.id}`);
    assert.equal(res.status, 403, '"not yours" and "none found" are different answers');
  });
});

test('a manager sees their team, including indirect reports, and not outsiders', async () => {
  const manager = await makeEmployee({ roles: [R.MANAGER] });
  const direct = await makeEmployee({ managerChain: [manager.employee._id] });
  const skip = await makeEmployee({ managerChain: [direct.employee._id, manager.employee._id] });
  const outsider = await makeEmployee();

  for (const person of [manager, direct, skip, outsider]) {
    await withServer(appFor(person.user), async (url) => {
      await post(url, `${P}/clock-in`, {});
    });
  }

  await withServer(appFor(manager.user), async (url) => {
    const res = await get(url, `${P}/`);
    const ids = res.body.data.data.map((r) => r.employeeId);
    assert.equal(res.body.data.total, 3);
    assert.ok(ids.includes(manager.id) && ids.includes(direct.id) && ids.includes(skip.id));
    assert.ok(!ids.includes(outsider.id), 'a manager is not entitled to the whole company');
  });
});

test('HR sees the whole company', async () => {
  const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
  const a = await makeEmployee();
  const b = await makeEmployee();

  for (const person of [a, b]) {
    await withServer(appFor(person.user), async (url) => {
      await post(url, `${P}/clock-in`, {});
    });
  }

  await withServer(appFor(hr.user), async (url) => {
    const res = await get(url, `${P}/`);
    assert.equal(res.body.data.total, 2);
  });
});

test('the history list is PAGINATED, and the total counts only what is in scope', async () => {
  const me = await makeEmployee();
  const other = await makeEmployee();

  const today = TODAY();
  for (let i = 0; i < 5; i += 1) {
    await AttendanceRecord.create({
      employeeId: me.employee._id,
      date: dayToDate(shiftDay(today, -i)),
      clockIn: new Date(),
      source: 'web',
      status: 'present',
    });
  }
  await AttendanceRecord.create({
    employeeId: other.employee._id,
    date: dayToDate(today),
    clockIn: new Date(),
    source: 'web',
    status: 'present',
  });

  await withServer(appFor(me.user), async (url) => {
    const res = await get(url, `${P}/?page=1&pageSize=2`);
    assert.equal(res.body.data.data.length, 2);
    assert.equal(res.body.data.total, 5, 'the total excludes the other employee');
    assert.equal(res.body.data.page, 1);

    const page3 = await get(url, `${P}/?page=3&pageSize=2`);
    assert.equal(page3.body.data.data.length, 1);
  });
});

test('the list query is strict and its range is checked', async () => {
  const { user } = await makeEmployee();
  await withServer(appFor(user), async (url) => {
    assert.equal((await get(url, `${P}/?from=2026-03-01&to=2026-01-01`)).status, 400);
    assert.equal((await get(url, `${P}/?from=nonsense`)).status, 400);
    assert.equal((await get(url, `${P}/?wat=1`)).status, 400);
    assert.equal((await get(url, `${P}/?employeeId=notanid`)).status, 400);
  });
});

test('an ordinary employee cannot reach the team grid', async () => {
  const { user } = await makeEmployee();
  await withServer(appFor(user), async (url) => {
    assert.equal((await get(url, `${P}/team-grid`)).status, 403);
  });
});

test('the team grid lists every report, including those who have not punched', async () => {
  const manager = await makeEmployee({ roles: [R.MANAGER] });
  const punched = await makeEmployee({ managerChain: [manager.employee._id] });
  const absent = await makeEmployee({ managerChain: [manager.employee._id] });

  await withServer(appFor(punched.user), async (url) => {
    await post(url, `${P}/clock-in`, {});
  });

  await withServer(appFor(manager.user), async (url) => {
    const res = await get(url, `${P}/team-grid`);
    assert.equal(res.status, 200);

    const byId = new Map(res.body.data.map((r) => [r.employeeId, r]));
    assert.equal(byId.size, 2);
    assert.equal(byId.get(punched.id).derived.kind, 'in_progress');
    assert.equal(
      byId.get(absent.id).status,
      'absent',
      'the people who have NOT arrived are the point of this screen',
    );
    assert.equal(byId.get(absent.id).recordId, null);
  });
});

// ===========================================================================
// Derived status
// ===========================================================================

test('the derived status is computed server-side from the shared thresholds', async () => {
  const { user, employee } = await makeEmployee();
  const today = TODAY();

  const cases = [
    [8, 'full_day'],
    [4, 'half_day'],
    [2, 'present_partial'],
  ];

  for (const [hours, expected] of cases) {
    await AttendanceRecord.deleteMany({});
    const start = new Date(`${today}T03:30:00.000Z`);
    await AttendanceRecord.create({
      employeeId: employee._id,
      date: dayToDate(today),
      clockIn: start,
      clockOut: new Date(start.getTime() + hours * 3_600_000),
      source: 'web',
      status: 'present',
    });

    await withServer(appFor(user), async (url) => {
      const res = await get(url, `${P}/`);
      assert.equal(res.body.data.data[0].derived.kind, expected, `${hours}h`);
      assert.equal(res.body.data.data[0].hoursWorked, hours);
    });
  }
});

// ===========================================================================
// Corrections
// ===========================================================================

test('an employee submits a correction for their own day', async () => {
  const { user, id } = await makeEmployee();
  const yesterday = shiftDay(TODAY(), -1);

  await withServer(appFor(user), async (url) => {
    const res = await post(url, `${P}/corrections`, {
      date: yesterday,
      requestedClockIn: `${yesterday}T03:30:00.000Z`,
      requestedClockOut: `${yesterday}T12:30:00.000Z`,
      reason: 'I forgot to clock in when I arrived on site.',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.employeeId, id, 'the subject comes from the actor');
    assert.equal(res.body.data.status, 'pending');
  });
});

test('a correction is validated: reason length, at least one time, order, and the future', async () => {
  const { user } = await makeEmployee();
  const yesterday = shiftDay(TODAY(), -1);
  // +2, not +1: the future bound carries one day of timezone tolerance on
  // purpose, because the correction picker produces a date in the VIEWER's
  // calendar, which is already tomorrow in UTC for part of every day. +1 is
  // inside that envelope and must be accepted; +2 is future everywhere. See
  // `isNotFutureDay` — the bound that made corrections unfileable overnight.
  const tomorrow = shiftDay(TODAY(), 2);

  await withServer(appFor(user), async (url) => {
    const bad = [
      { date: yesterday, requestedClockIn: `${yesterday}T04:00:00.000Z`, reason: 'too short' },
      { date: yesterday, reason: 'No times were supplied at all here.' },
      {
        date: yesterday,
        requestedClockIn: `${yesterday}T12:00:00.000Z`,
        requestedClockOut: `${yesterday}T04:00:00.000Z`,
        reason: 'Out before in, which cannot happen.',
      },
      {
        date: tomorrow,
        requestedClockIn: `${tomorrow}T04:00:00.000Z`,
        reason: 'A correction for a day that has not happened.',
      },
    ];
    for (const body of bad) {
      assert.equal((await post(url, `${P}/corrections`, body)).status, 400, JSON.stringify(body));
    }
  });
});

test('a requested time must fall on the requested day', async () => {
  const { user } = await makeEmployee();
  const yesterday = shiftDay(TODAY(), -1);
  const lastMonth = shiftDay(TODAY(), -30);

  await withServer(appFor(user), async (url) => {
    // The reference accepts this: its browser builds the timestamp from a date
    // picker and its server never re-checks the pairing.
    const res = await post(url, `${P}/corrections`, {
      date: yesterday,
      requestedClockIn: `${lastMonth}T04:00:00.000Z`,
      reason: 'A time from a completely different month.',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, new RegExp(yesterday));
  });
});

test('a second PENDING correction for the same day is refused by the index', async () => {
  const { user } = await makeEmployee();
  const yesterday = shiftDay(TODAY(), -1);
  const body = {
    date: yesterday,
    requestedClockIn: `${yesterday}T04:00:00.000Z`,
    reason: 'The first request for this particular day.',
  };

  await withServer(appFor(user), async (url) => {
    assert.equal((await post(url, `${P}/corrections`, body)).status, 201);

    const second = await post(url, `${P}/corrections`, body);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'CORRECTION_ALREADY_PENDING');
  });
});

test('a REJECTED request does not block a resubmission', async () => {
  const manager = await makeEmployee({ roles: [R.MANAGER] });
  const employee = await makeEmployee({ managerChain: [manager.employee._id] });
  const yesterday = shiftDay(TODAY(), -1);
  const body = {
    date: yesterday,
    requestedClockIn: `${yesterday}T04:00:00.000Z`,
    reason: 'The first attempt at explaining this.',
  };

  let correctionId;
  await withServer(appFor(employee.user), async (url) => {
    correctionId = (await post(url, `${P}/corrections`, body)).body.data.id;
  });
  await withServer(appFor(manager.user), async (url) => {
    await post(url, `${P}/corrections/${correctionId}/decide`, { decision: 'reject' });
  });
  await withServer(appFor(employee.user), async (url) => {
    const again = await post(url, `${P}/corrections`, {
      ...body,
      reason: 'A better explanation this second time around.',
    });
    assert.equal(again.status, 201, 'the partial index constrains pending rows only');
  });
});

test('an approval rewrites the attendance record and records what it changed', async () => {
  const manager = await makeEmployee({ roles: [R.MANAGER] });
  const employee = await makeEmployee({ managerChain: [manager.employee._id] });
  const yesterday = shiftDay(TODAY(), -1);

  await AttendanceRecord.create({
    employeeId: employee.employee._id,
    date: dayToDate(yesterday),
    clockIn: new Date(`${yesterday}T05:00:00.000Z`),
    source: 'web',
    status: 'present',
  });

  let correctionId;
  await withServer(appFor(employee.user), async (url) => {
    correctionId = (
      await post(url, `${P}/corrections`, {
        date: yesterday,
        requestedClockIn: `${yesterday}T03:30:00.000Z`,
        requestedClockOut: `${yesterday}T12:30:00.000Z`,
        reason: 'I actually arrived at 9am, not 10:30.',
      })
    ).body.data.id;
  });

  await withServer(appFor(manager.user), async (url) => {
    const res = await post(url, `${P}/corrections/${correctionId}/decide`, {
      decision: 'approve',
      comment: 'Confirmed with the site log.',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'approved');
  });

  const record = await AttendanceRecord.findOne({ employeeId: employee.employee._id }).lean();
  assert.equal(new Date(record.clockIn).toISOString(), `${yesterday}T03:30:00.000Z`);
  assert.equal(new Date(record.clockOut).toISOString(), `${yesterday}T12:30:00.000Z`);
  assert.equal(record.source, 'manual');
  assert.ok(record.correctedAt, 'the day is marked as corrected, not silently rewritten');
  assert.equal(String(record.correctionId), correctionId);

  const audit = await AuditLog.findOne({
    action: AUDIT_ACTIONS.ATTENDANCE_CORRECTION_DECIDED,
  }).lean();
  assert.equal(audit.meta.applied.before.clockIn, `${yesterday}T05:00:00.000Z`);
  assert.equal(audit.meta.applied.after.clockIn, `${yesterday}T03:30:00.000Z`);
});

test('approving a day with no record CREATES one - the commonest reason to file', async () => {
  const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
  const employee = await makeEmployee();
  const yesterday = shiftDay(TODAY(), -1);

  let correctionId;
  await withServer(appFor(employee.user), async (url) => {
    correctionId = (
      await post(url, `${P}/corrections`, {
        date: yesterday,
        requestedClockIn: `${yesterday}T03:30:00.000Z`,
        requestedClockOut: `${yesterday}T12:30:00.000Z`,
        reason: 'I never clocked in at all that day.',
      })
    ).body.data.id;
  });

  await withServer(appFor(hr.user), async (url) => {
    assert.equal(
      (await post(url, `${P}/corrections/${correctionId}/decide`, { decision: 'approve' })).status,
      200,
    );
  });

  const record = await AttendanceRecord.findOne({ employeeId: employee.employee._id }).lean();
  assert.ok(record, 'a record is created for the day');
  assert.equal(record.source, 'manual');
});

test('a rejection changes nothing about the attendance record', async () => {
  const manager = await makeEmployee({ roles: [R.MANAGER] });
  const employee = await makeEmployee({ managerChain: [manager.employee._id] });
  const yesterday = shiftDay(TODAY(), -1);

  await AttendanceRecord.create({
    employeeId: employee.employee._id,
    date: dayToDate(yesterday),
    clockIn: new Date(`${yesterday}T05:00:00.000Z`),
    source: 'web',
    status: 'present',
  });

  let correctionId;
  await withServer(appFor(employee.user), async (url) => {
    correctionId = (
      await post(url, `${P}/corrections`, {
        date: yesterday,
        requestedClockIn: `${yesterday}T02:00:00.000Z`,
        reason: 'An optimistic claim about my arrival time.',
      })
    ).body.data.id;
  });

  await withServer(appFor(manager.user), async (url) => {
    await post(url, `${P}/corrections/${correctionId}/decide`, { decision: 'reject' });
  });

  const record = await AttendanceRecord.findOne({ employeeId: employee.employee._id }).lean();
  assert.equal(new Date(record.clockIn).toISOString(), `${yesterday}T05:00:00.000Z`);
  assert.equal(record.source, 'web');
});

test('an employee cannot decide anything', async () => {
  const a = await makeEmployee();
  const b = await makeEmployee();
  const yesterday = shiftDay(TODAY(), -1);

  let correctionId;
  await withServer(appFor(b.user), async (url) => {
    correctionId = (
      await post(url, `${P}/corrections`, {
        date: yesterday,
        requestedClockIn: `${yesterday}T04:00:00.000Z`,
        reason: 'A perfectly ordinary correction request.',
      })
    ).body.data.id;
  });

  await withServer(appFor(a.user), async (url) => {
    const res = await post(url, `${P}/corrections/${correctionId}/decide`, {
      decision: 'approve',
    });
    assert.equal(res.status, 403);
  });
});

test('a manager cannot decide a request from OUTSIDE their team', async () => {
  const manager = await makeEmployee({ roles: [R.MANAGER] });
  const outsider = await makeEmployee();
  const yesterday = shiftDay(TODAY(), -1);

  let correctionId;
  await withServer(appFor(outsider.user), async (url) => {
    correctionId = (
      await post(url, `${P}/corrections`, {
        date: yesterday,
        requestedClockIn: `${yesterday}T04:00:00.000Z`,
        reason: 'Filed by somebody this manager does not manage.',
      })
    ).body.data.id;
  });

  // The route gate passes - they hold approve:team - and the SERVICE refuses,
  // which is where the check belongs because the subject must be read first.
  await withServer(appFor(manager.user), async (url) => {
    const res = await post(url, `${P}/corrections/${correctionId}/decide`, {
      decision: 'approve',
    });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /may not decide/i);
  });

  const correction = await AttendanceCorrection.findById(correctionId).lean();
  assert.equal(correction.status, 'pending');
});

test('nobody may decide their OWN correction, not even HR', async () => {
  const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
  const yesterday = shiftDay(TODAY(), -1);

  await withServer(appFor(hr.user), async (url) => {
    const correctionId = (
      await post(url, `${P}/corrections`, {
        date: yesterday,
        requestedClockIn: `${yesterday}T02:00:00.000Z`,
        reason: 'Granting myself some extra hours this morning.',
      })
    ).body.data.id;

    // The reference allows exactly this: hr_admin holds approve:org, which
    // covers their own request.
    const res = await post(url, `${P}/corrections/${correctionId}/decide`, {
      decision: 'approve',
    });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /your own/i);
  });
});

test('a correction cannot be decided twice', async () => {
  const manager = await makeEmployee({ roles: [R.MANAGER] });
  const employee = await makeEmployee({ managerChain: [manager.employee._id] });
  const yesterday = shiftDay(TODAY(), -1);

  let correctionId;
  await withServer(appFor(employee.user), async (url) => {
    correctionId = (
      await post(url, `${P}/corrections`, {
        date: yesterday,
        requestedClockIn: `${yesterday}T04:00:00.000Z`,
        reason: 'A request that will be decided more than once.',
      })
    ).body.data.id;
  });

  await withServer(appFor(manager.user), async (url) => {
    assert.equal(
      (await post(url, `${P}/corrections/${correctionId}/decide`, { decision: 'approve' })).status,
      200,
    );
    const again = await post(url, `${P}/corrections/${correctionId}/decide`, {
      decision: 'reject',
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'CORRECTION_ALREADY_DECIDED');
  });
});

test('the corrections list is scoped the same way attendance is', async () => {
  const manager = await makeEmployee({ roles: [R.MANAGER] });
  const report = await makeEmployee({ managerChain: [manager.employee._id] });
  const outsider = await makeEmployee();
  const yesterday = shiftDay(TODAY(), -1);

  for (const person of [report, outsider]) {
    await withServer(appFor(person.user), async (url) => {
      await post(url, `${P}/corrections`, {
        date: yesterday,
        requestedClockIn: `${yesterday}T04:00:00.000Z`,
        reason: 'A request from one particular person here.',
      });
    });
  }

  await withServer(appFor(manager.user), async (url) => {
    const res = await get(url, `${P}/corrections`);
    assert.equal(res.body.data.total, 1);
    assert.equal(res.body.data.data[0].employeeId, report.id);
  });

  await withServer(appFor(outsider.user), async (url) => {
    const res = await get(url, `${P}/corrections`);
    assert.equal(res.body.data.total, 1);
    assert.equal(res.body.data.data[0].employeeId, outsider.id);
  });
});

test('a punch and a correction are both audited', async () => {
  const { user } = await makeEmployee();
  const yesterday = shiftDay(TODAY(), -1);

  await withServer(appFor(user), async (url) => {
    await post(url, `${P}/clock-in`, {});
    await post(url, `${P}/clock-out`, {});
    await post(url, `${P}/corrections`, {
      date: yesterday,
      requestedClockIn: `${yesterday}T04:00:00.000Z`,
      reason: 'Something that definitely needs auditing.',
    });
  });

  const actions = (await AuditLog.find({}).lean()).map((a) => a.action);
  assert.ok(actions.includes(AUDIT_ACTIONS.ATTENDANCE_CLOCK_IN));
  assert.ok(actions.includes(AUDIT_ACTIONS.ATTENDANCE_CLOCK_OUT));
  assert.ok(actions.includes(AUDIT_ACTIONS.ATTENDANCE_CORRECTION_SUBMITTED));
});

// ===========================================================================
// Geocoding - AD-15 defect 3
// ===========================================================================

test('a punch does not wait on the geocoder', async () => {
  const { user, employee } = await makeEmployee();
  await grantConsent(employee._id, CONSENT_PURPOSES.ATTENDANCE_LOCATION);

  let released;
  const gate = new Promise((resolve) => {
    released = resolve;
  });
  // A geocoder that never returns until this test lets it. The reference
  // AWAITS its equivalent inside clockIn, so this would hang there.
  geocode.setGeocoder(async () => {
    await gate;
    return 'MG Road, Vijay Nagar, Indore';
  });

  try {
    await withServer(appFor(user), async (url) => {
      const started = Date.now();
      const res = await post(url, `${P}/clock-in`, { geo: { lat: 22.7196, lng: 75.8577 } });
      assert.equal(res.status, 201);
      assert.ok(Date.now() - started < 2000, 'the punch returned without the label');
      assert.equal(res.body.data.clockInCapture.locationLabel, null);
    });
  } finally {
    released();
    geocode.setGeocoder(null);
  }
});

test('the resolved label is written back afterwards, and a failure is survivable', async () => {
  const { employee } = await makeEmployee();
  const record = await AttendanceRecord.create({
    employeeId: employee._id,
    date: dayToDate(TODAY()),
    clockIn: new Date(),
    source: 'web',
    status: 'present',
    clockInCapture: { at: new Date(), geo: { lat: 22.7196, lng: 75.8577 } },
  });

  geocode.setGeocoder(async () => 'MG Road, Vijay Nagar, Indore');
  await geocode.resolveLater(record._id, 'in', { lat: 22.7196, lng: 75.8577 });

  const updated = await AttendanceRecord.findById(record._id).lean();
  assert.equal(updated.clockInCapture.locationLabel, 'MG Road, Vijay Nagar, Indore');

  // A throwing geocoder must not reject - this runs detached in production.
  geocode.__resetGeocodeCache();
  geocode.setGeocoder(async () => {
    throw new Error('Nominatim is down');
  });
  await assert.doesNotReject(() =>
    geocode.resolveLater(record._id, 'out', { lat: 1, lng: 1 }),
  );
  geocode.setGeocoder(null);
});

// ===========================================================================
// Retention (AD-16)
// ===========================================================================

test('the retention sweep deletes expired selfies and KEEPS the punch record', async () => {
  registerRetentionHandler(
    RETENTION_CATEGORIES.ATTENDANCE_SELFIES,
    attendanceSelfieRetentionHandler,
  );

  const { employee } = await makeEmployee();
  const { key } = await uploadFor(employee._id);
  assert.equal(await objectExists(key), true);

  const old = await AttendanceRecord.create({
    employeeId: employee._id,
    // Comfortably past the seeded 90-day window.
    date: dayToDate(shiftDay(TODAY(), -400)),
    clockIn: new Date(),
    source: 'web',
    status: 'present',
    clockInCapture: { at: new Date(), selfieKey: key },
  });

  const recent = await AttendanceRecord.create({
    employeeId: employee._id,
    date: dayToDate(TODAY()),
    clockIn: new Date(),
    source: 'web',
    status: 'present',
    clockInCapture: { at: new Date(), selfieKey: (await uploadFor(employee._id)).key },
  });

  const summary = await runHrmsRetentionSweep();
  const result = summary.results.find((r) => r.category === RETENTION_CATEGORIES.ATTENDANCE_SELFIES);
  assert.ok(result, 'the category has a registered handler and actually ran');
  assert.equal(result.affected, 1);

  const sweptRow = await AttendanceRecord.findById(old._id).lean();
  assert.equal(sweptRow.clockInCapture.selfieKey, null, 'the pointer is nulled');
  assert.ok(sweptRow.clockIn, 'the punch survives - it is payroll evidence');
  assert.equal(await objectExists(key), false, 'the object is gone from storage');

  const keptRow = await AttendanceRecord.findById(recent._id).lean();
  assert.ok(keptRow.clockInCapture.selfieKey, 'an in-window selfie is untouched');
});

test('an unregistered retention handler is REPORTED, not silently skipped', async () => {
  // Nothing registered in this test, so the configured category has no handler.
  await HrmsConfig.load();
  const summary = await runHrmsRetentionSweep({ dryRun: true });
  const skipped = summary.skipped.map((s) => s.category);
  assert.ok(
    skipped.includes(RETENTION_CATEGORIES.ATTENDANCE_SELFIES),
    'a configured-but-unimplemented category must not look like it is working',
  );
});

test('purgeNow refuses an unbounded purge', async () => {
  await assert.rejects(
    () => attendanceSelfieRetentionHandler.purgeNow({ filter: {} }),
    /refusing an unbounded selfie purge/,
  );
});

test('withdrawing selfie consent erases the photographs immediately', async () => {
  registerRetentionHandler(
    RETENTION_CATEGORIES.ATTENDANCE_SELFIES,
    attendanceSelfieRetentionHandler,
  );

  const { user, employee } = await makeEmployee();
  await grantConsent(employee._id, CONSENT_PURPOSES.ATTENDANCE_SELFIE);
  const { key } = await uploadFor(employee._id);

  await withServer(appFor(user), async (url) => {
    await post(url, `${P}/clock-in`, { selfieKey: key });
    assert.equal(await objectExists(key), true);

    const res = await post(url, `${P}/consent`, {
      purpose: CONSENT_PURPOSES.ATTENDANCE_SELFIE,
      granted: false,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.erased.affected, 1);
  });

  const record = await AttendanceRecord.findOne({ employeeId: employee._id }).lean();
  assert.equal(record.clockInCapture.selfieKey, null);
  assert.ok(record.clockIn, 'the punch remains');
  assert.equal(await objectExists(key), false, 'erase now means now, not at the nightly sweep');
});

// ===========================================================================
// Biometric ingestion
// ===========================================================================

const sign = (body, secret = process.env.HRMS_BIOMETRIC_WEBHOOK_SECRET) =>
  crypto.createHmac('sha256', secret).update(body).digest('hex');

const postSigned = async (url, payload, { signature, secret } = {}) => {
  const body = JSON.stringify(payload);
  const res = await fetch(`${url}/api/v1/hrms/attendance/biometric`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature': signature ?? sign(body, secret),
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

test('the biometric webhook refuses an unsigned or wrongly-signed payload', async () => {
  const { employee } = await makeEmployee();
  const payload = {
    punches: [
      {
        employeeCode: employee.employeeCode,
        timestamp: new Date().toISOString(),
        punchType: 'in',
        deviceId: 'DEV-1',
      },
    ],
  };

  await withServer(biometricApp(), async (url) => {
    const unsigned = await fetch(`${url}/api/v1/hrms/attendance/biometric`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(unsigned.status, 401);

    const wrong = await postSigned(url, payload, { secret: 'a-completely-different-secret' });
    assert.equal(wrong.status, 401);

    // A short signature must not slip past by truncating the comparison.
    const truncated = await postSigned(url, payload, { signature: 'abc123' });
    assert.equal(truncated.status, 401);

    assert.equal(await AttendanceRecord.countDocuments({}), 0);
  });
});

test('a rejected biometric call is audited', async () => {
  await withServer(biometricApp(), async (url) => {
    await postSigned(url, { punches: [] }, { secret: 'wrong-secret-entirely-here' });
  });
  const entry = await AuditLog.findOne({
    action: AUDIT_ACTIONS.ATTENDANCE_BIOMETRIC_REJECTED,
  }).lean();
  assert.ok(entry, 'probing an unauthenticated endpoint must leave a trace');
});

/**
 * A completed shift on the PREVIOUS day.
 *
 * Anchored to yesterday rather than to fixed hours today, because a punch
 * timestamp later than the moment the suite runs is legitimately refused as
 * being in the future — an early-morning run would otherwise fail on the
 * clock-out. Both instants land inside the same business day (09:00 and 18:00
 * IST), so they belong to one record.
 */
const shiftDayIso = () => {
  const day = shiftDay(TODAY(), -1);
  return { day, in: `${day}T03:30:00.000Z`, out: `${day}T12:30:00.000Z` };
};

test('a correctly signed batch is applied, and unknown codes are reported', async () => {
  const { employee } = await makeEmployee();
  const shift = shiftDayIso();

  await withServer(biometricApp(), async (url) => {
    const res = await postSigned(url, {
      punches: [
        {
          employeeCode: employee.employeeCode,
          timestamp: shift.in,
          punchType: 'in',
          deviceId: 'DEV-1',
        },
        {
          employeeCode: employee.employeeCode,
          timestamp: shift.out,
          punchType: 'out',
          deviceId: 'DEV-1',
        },
        {
          employeeCode: 'NOSUCHCODE',
          timestamp: shift.in,
          punchType: 'in',
          deviceId: 'DEV-1',
        },
      ],
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.received, 3);
    assert.equal(res.body.data.applied, 2);
    assert.equal(res.body.data.skipped.length, 1, 'one bad row does not abort the batch');
    assert.match(res.body.data.skipped[0].reason, /unknown or deleted/);
  });

  const record = await AttendanceRecord.findOne({ employeeId: employee._id }).lean();
  assert.equal(record.source, 'biometric');
  assert.equal(record.deviceId, 'DEV-1');
  assert.equal(new Date(record.clockIn).toISOString(), shift.in);
  assert.equal(new Date(record.clockOut).toISOString(), shift.out);
  assert.equal(
    attendanceDayString(new Date(record.date)),
    // The day is derived from the punch in the BUSINESS zone, so both
    // instants file against one record rather than splitting across two.
    attendanceDayString(new Date(shift.in)),
  );
});

test('the earliest in-punch and the latest out-punch win', async () => {
  const { employee } = await makeEmployee();
  const shift = shiftDayIso();
  const later = `${shift.day}T04:00:00.000Z`;
  const earlier = `${shift.day}T11:00:00.000Z`;

  await withServer(biometricApp(), async (url) => {
    const res = await postSigned(url, {
      punches: [
        { employeeCode: employee.employeeCode, timestamp: later, punchType: 'in', deviceId: 'D' },
        { employeeCode: employee.employeeCode, timestamp: shift.in, punchType: 'in', deviceId: 'D' },
        { employeeCode: employee.employeeCode, timestamp: earlier, punchType: 'out', deviceId: 'D' },
        { employeeCode: employee.employeeCode, timestamp: shift.out, punchType: 'out', deviceId: 'D' },
      ],
    });
    assert.equal(res.body.data.applied, 4);
  });

  const record = await AttendanceRecord.findOne({ employeeId: employee._id }).lean();
  assert.equal(
    new Date(record.clockIn).toISOString(),
    shift.in,
    "a later swipe must not push someone's arrival time forwards",
  );
  assert.equal(
    new Date(record.clockOut).toISOString(),
    shift.out,
    'a shift that swipes out twice ends at the last one',
  );
});

test('implausible biometric timestamps are skipped, not stored', async () => {
  const { employee } = await makeEmployee();

  await withServer(biometricApp(), async (url) => {
    const res = await postSigned(url, {
      punches: [
        {
          employeeCode: employee.employeeCode,
          timestamp: new Date(Date.now() + 86_400_000).toISOString(),
          punchType: 'in',
          deviceId: 'D',
        },
        {
          employeeCode: employee.employeeCode,
          timestamp: new Date(Date.now() - 400 * 86_400_000).toISOString(),
          punchType: 'in',
          deviceId: 'D',
        },
      ],
    });

    assert.equal(res.body.data.applied, 0);
    assert.equal(res.body.data.skipped.length, 2);
    assert.match(res.body.data.skipped[0].reason, /future/);
    assert.match(res.body.data.skipped[1].reason, /days old/);
  });

  assert.equal(await AttendanceRecord.countDocuments({}), 0);
});

test('a soft-deleted or non-working employee is skipped by biometric ingest', async () => {
  const deleted = await makeEmployee({ deletedAt: new Date() });
  const exited = await makeEmployee({ status: 'exited' });

  await withServer(biometricApp(), async (url) => {
    const res = await postSigned(url, {
      punches: [
        { employeeCode: deleted.employee.employeeCode, timestamp: new Date().toISOString(), punchType: 'in', deviceId: 'D' },
        { employeeCode: exited.employee.employeeCode, timestamp: new Date().toISOString(), punchType: 'in', deviceId: 'D' },
      ],
    });
    assert.equal(res.body.data.applied, 0);
    assert.equal(res.body.data.skipped.length, 2);
  });
});

test('the webhook is disabled when no secret is configured', async () => {
  const saved = process.env.HRMS_BIOMETRIC_WEBHOOK_SECRET;
  // An empty or too-short secret must DISABLE the endpoint. The reference
  // would still compute a valid HMAC with an empty key and accept anything.
  process.env.HRMS_BIOMETRIC_WEBHOOK_SECRET = '';
  try {
    assert.equal(biometricService.isBiometricIngestEnabled(), false);
    await withServer(biometricApp(), async (url) => {
      const res = await postSigned(url, { punches: [] }, { secret: 'anything' });
      assert.equal(res.status, 503);
    });
  } finally {
    process.env.HRMS_BIOMETRIC_WEBHOOK_SECRET = saved;
  }
});

test('the biometric route is the ONLY unauthenticated HRMS surface', async () => {
  // A guard against the mount in hrms.routes.js drifting: anything added above
  // `router.use(protect)` would silently become public.
  const hrmsRoutes = (await import('../modules/hrms/hrms.routes.js')).default;
  const app = buildTestApp({
    mount: (a) => {
      a.use('/api/v1/hrms', hrmsRoutes);
    },
  });

  await withServer(app, async (url) => {
    for (const route of [
      '/api/v1/hrms/me',
      '/api/v1/hrms/attendance/today',
      '/api/v1/hrms/attendance',
      '/api/v1/hrms/attendance/corrections',
      '/api/v1/hrms/attendance/consent',
      '/api/v1/hrms/employees',
      '/api/v1/hrms/files/url?category=attendance-selfie&key=x',
    ]) {
      const res = await get(url, route);
      assert.ok(
        res.status === 401 || res.status === 500,
        `${route} must not answer without authentication (got ${res.status})`,
      );
      if (res.status === 500) {
        // `protect` needs a real JWT setup; what matters is that it RAN.
        assert.ok(!res.body?.success, route);
      }
    }
  });
});
