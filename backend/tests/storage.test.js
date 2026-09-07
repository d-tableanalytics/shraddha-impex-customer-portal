/**
 * HRMS object storage (AD-7).
 *
 * Phase 0 verification requirements 8 and 9:
 *   8. Protected S3 objects require authorization.
 *   9. The selfie endpoint is not public.
 *
 * Exercised against the `local` driver, which implements the same interface as
 * S3 - including issuing a short-lived signed URL rather than a raw path, so
 * the access pattern under test is the production one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.STORAGE_LOCAL_PATH =
  process.env.STORAGE_LOCAL_PATH || (await fs.mkdtemp(path.join(os.tmpdir(), 'hrms-storage-')));

const {
  putObject,
  getReadUrl,
  deleteObject,
  deleteObjects,
  objectExists,
  buildStorageKey,
  maxUploadBytesFor,
  ttlFor,
  getStorageDriver,
} = await import('../utils/hrms/storage/index.js');
const { createLocalDriver } = await import('../utils/hrms/storage/local.js');
const {
  registerFileAccessRule,
  issueReadUrl,
  FileAccessError,
  __resetFileAccessRules,
  registeredFileCategories,
} = await import('../modules/hrms/storage/storage.service.js');
const storageRoutes = (await import('../modules/hrms/storage/storage.routes.js')).default;
const { STORAGE_CATEGORIES, PRESIGNED_URL_TTL, MAX_UPLOAD_BYTES } = await import(
  '../shared/constants/hrms.js'
);
const { HRMS_ROLES: R, HRMS_MODULES: M, HRMS_ACTIONS: A, SCOPES: S } = await import(
  '../shared/permissions/constants.js'
);
const { buildHrmsActor } = await import('../shared/permissions/has-permission.js');
const { buildTestApp, stubProtect, withServer, get } = await import('./helpers/http.js');
const { hrmsAuthorizationChain } = await import('../middlewares/hrmsAuth.js');

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

test('object keys are random and never derived from user input', () => {
  const a = buildStorageKey(STORAGE_CATEGORIES.EMPLOYEE_DOCUMENT, {
    scope: 'emp1',
    filename: 'Priya Sharma - PAN.pdf',
  });
  const b = buildStorageKey(STORAGE_CATEGORIES.EMPLOYEE_DOCUMENT, {
    scope: 'emp1',
    filename: 'Priya Sharma - PAN.pdf',
  });

  assert.notEqual(a, b, 'two uploads of the same file must not collide or be guessable');
  assert.ok(a.startsWith('hrms/employees/documents/emp1/'));
  assert.ok(a.endsWith('.pdf'), 'the extension is kept');
  assert.ok(!a.includes('Priya'), 'the filename must not leak into the key');
  assert.ok(!a.includes(' '));
});

test('a key cannot be steered out of its prefix', () => {
  const key = buildStorageKey(STORAGE_CATEGORIES.PAYSLIP, {
    scope: '../../etc',
    filename: '../../../evil.sh',
  });
  assert.ok(key.startsWith('hrms/payroll/payslips/'));
  assert.ok(!key.includes('..'));
});

test('an unknown category is refused', () => {
  assert.throws(() => buildStorageKey('nonsense'), /unknown storage category/);
});

// ---------------------------------------------------------------------------
// Limits and TTLs
// ---------------------------------------------------------------------------

test('a selfie has a tighter size ceiling than a general upload', () => {
  const selfie = maxUploadBytesFor(STORAGE_CATEGORIES.ATTENDANCE_SELFIE);
  assert.equal(selfie, 2 * 1024 * 1024);
  assert.ok(selfie < MAX_UPLOAD_BYTES.DEFAULT, 'the global 10 MB cap is too generous for a selfie');
});

test('a selfie URL is shorter-lived than a document URL', () => {
  assert.equal(ttlFor(STORAGE_CATEGORIES.ATTENDANCE_SELFIE), PRESIGNED_URL_TTL.SELFIE);
  assert.equal(ttlFor(STORAGE_CATEGORIES.BANK_FILE), PRESIGNED_URL_TTL.BANK_FILE);
  assert.equal(ttlFor(STORAGE_CATEGORIES.EMPLOYEE_DOCUMENT), PRESIGNED_URL_TTL.DEFAULT);
  assert.ok(ttlFor(STORAGE_CATEGORIES.ATTENDANCE_SELFIE) < PRESIGNED_URL_TTL.DEFAULT);
});

test('an oversized upload is refused before it is stored', async () => {
  await assert.rejects(
    () =>
      putObject({
        category: STORAGE_CATEGORIES.ATTENDANCE_SELFIE,
        body: Buffer.alloc(16),
        contentType: 'image/jpeg',
        size: 5 * 1024 * 1024,
      }),
    (err) => err.statusCode === 413,
  );
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test('an object can be stored, found, read back and deleted', async () => {
  const { key } = await putObject({
    category: STORAGE_CATEGORIES.EMPLOYEE_DOCUMENT,
    body: Buffer.from('hello'),
    contentType: 'text/plain',
    scope: 'emp1',
    filename: 'note.txt',
    size: 5,
  });

  assert.equal(await objectExists(key), true);

  const url = await getReadUrl(key, { category: STORAGE_CATEGORIES.EMPLOYEE_DOCUMENT });
  assert.match(url, /^\/api\/v1\/hrms\/files\/local\?/, 'the local driver signs a URL like S3 does');

  await deleteObject(key);
  assert.equal(await objectExists(key), false);
});

test('deleting an object that is already gone is not an error', async () => {
  await deleteObject('hrms/employees/documents/nope/missing.txt');
});

test('bulk delete reports per-key outcome so one failure cannot abort a sweep', async () => {
  const { key } = await putObject({
    category: STORAGE_CATEGORIES.PAYSLIP,
    body: Buffer.from('x'),
    contentType: 'text/plain',
    size: 1,
  });
  const res = await deleteObjects([key, 'hrms/payroll/payslips/none/absent.pdf']);
  assert.equal(res.deleted.length, 2, 'a missing object counts as deleted');
  assert.equal(res.failed.length, 0);
});

test('the local driver refuses to run in production', () => {
  const prevEnv = process.env.NODE_ENV;
  const prevDriver = process.env.STORAGE_DRIVER;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.STORAGE_DRIVER;
    assert.throws(() => createLocalDriver(), /Refusing to use local disk storage in production/);
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = prevDriver;
  }
});

test('the local signed URL expires and cannot be forged', async () => {
  const driver = getStorageDriver();
  const url = await driver.getSignedUrl('hrms/payroll/payslips/a/b.pdf', 60);
  const q = Object.fromEntries(new URLSearchParams(url.split('?')[1]));

  assert.equal(driver.verifySignedUrl(q), true);
  assert.equal(driver.verifySignedUrl({ ...q, key: 'hrms/payroll/payslips/a/other.pdf' }), false);
  assert.equal(driver.verifySignedUrl({ ...q, sig: 'f'.repeat(64) }), false);
  assert.equal(driver.verifySignedUrl({ ...q, expires: String(Date.now() - 1000) }), false);
  assert.equal(driver.verifySignedUrl({}), false);
});

// ---------------------------------------------------------------------------
// Authorization (verification requirement 8)
// ---------------------------------------------------------------------------

const PAYSLIP_KEY = 'hrms/payroll/payslips/emp-1/abc.pdf';

function registerPayslipRule() {
  registerFileAccessRule(STORAGE_CATEGORIES.PAYSLIP, {
    resolve: async (key) =>
      key === PAYSLIP_KEY
        ? {
            owner: { ownerEmployeeId: 'emp-1', ownerManagerChain: ['mgr-1'] },
            permissions: [
              { module: M.PAYROLL, action: A.VIEW, scope: S.SELF },
              { module: M.PAYROLL, action: A.VIEW, scope: S.ORG },
            ],
          }
        : null,
  });
}

test('an unregistered category is refused - access is not inherited by default', async (t) => {
  t.after(() => __resetFileAccessRules());
  __resetFileAccessRules();

  const actor = buildHrmsActor({ userId: 'u1', roles: [R.SUPER_ADMIN] });
  await assert.rejects(
    () => issueReadUrl({ category: STORAGE_CATEGORIES.PAYSLIP, key: 'x', actor, req: {} }),
    (err) => err instanceof FileAccessError && err.statusCode === 403,
  );
  assert.deepEqual(registeredFileCategories(), []);
});

test('the owner may read their own file; a stranger may not', async (t) => {
  t.after(() => __resetFileAccessRules());
  __resetFileAccessRules();
  registerPayslipRule();

  const owner = buildHrmsActor({
    userId: 'u1',
    roles: [R.EMPLOYEE],
    employee: { id: 'emp-1', departmentId: 'd1', managerChain: ['mgr-1'] },
  });
  const stranger = buildHrmsActor({
    userId: 'u2',
    roles: [R.EMPLOYEE],
    employee: { id: 'emp-2', departmentId: 'd1', managerChain: [] },
  });

  const ok = await issueReadUrl({
    category: STORAGE_CATEGORIES.PAYSLIP,
    key: PAYSLIP_KEY,
    actor: owner,
    req: {},
  });
  assert.ok(ok.url);
  // A payslip is a document, so it gets the default window - not the 60s one
  // reserved for selfies and bank files.
  assert.equal(ok.expiresInSeconds, PRESIGNED_URL_TTL.DEFAULT);

  await assert.rejects(
    () =>
      issueReadUrl({
        category: STORAGE_CATEGORIES.PAYSLIP,
        key: PAYSLIP_KEY,
        actor: stranger,
        req: {},
      }),
    (err) => err.statusCode === 403,
  );
});

test('a payroll admin may read anyone\'s file through org scope', async (t) => {
  t.after(() => __resetFileAccessRules());
  __resetFileAccessRules();
  registerPayslipRule();

  const payrollAdmin = buildHrmsActor({ userId: 'u3', roles: [R.PAYROLL_ADMIN] });
  const res = await issueReadUrl({
    category: STORAGE_CATEGORIES.PAYSLIP,
    key: PAYSLIP_KEY,
    actor: payrollAdmin,
    req: {},
  });
  assert.ok(res.url);
});

test('an unknown key is 404, not 403 - the rule ran and found nothing', async (t) => {
  t.after(() => __resetFileAccessRules());
  __resetFileAccessRules();
  registerPayslipRule();

  const admin = buildHrmsActor({ userId: 'u1', roles: [R.SUPER_ADMIN] });
  await assert.rejects(
    () =>
      issueReadUrl({
        category: STORAGE_CATEGORIES.PAYSLIP,
        key: 'hrms/payroll/payslips/emp-9/none.pdf',
        actor: admin,
        req: {},
      }),
    (err) => err.statusCode === 404,
  );
});

// ---------------------------------------------------------------------------
// Over HTTP (verification requirement 9)
// ---------------------------------------------------------------------------

function filesAppFor(user) {
  return buildTestApp({
    mount: (app) => {
      const router = express.Router();
      router.use(stubProtect(user));
      router.use(hrmsAuthorizationChain);
      router.use('/files', storageRoutes);
      app.use('/api/v1/hrms', router);
    },
  });
}

test('the file endpoint is not public - a Customer cannot reach it', async () => {
  const customer = { _id: 'c1', role: 'Customer', roles: [], status: 'Active' };
  await withServer(filesAppFor(customer), async (url) => {
    const res = await get(
      url,
      `/api/v1/hrms/files/url?category=${STORAGE_CATEGORIES.ATTENDANCE_SELFIE}&key=x`,
    );
    assert.equal(res.status, 403);
  });

  await withServer(filesAppFor(null), async (url) => {
    const res = await get(url, '/api/v1/hrms/files/url?category=payslip&key=x');
    assert.equal(res.status, 401);
  });
});

test('the file endpoint validates its inputs', async (t) => {
  t.after(() => __resetFileAccessRules());
  __resetFileAccessRules();

  const hr = { _id: 'u1', role: 'Admin', roles: [R.HR_ADMIN], status: 'Active' };
  await withServer(filesAppFor(hr), async (url) => {
    assert.equal((await get(url, '/api/v1/hrms/files/url')).status, 400);
    assert.equal((await get(url, '/api/v1/hrms/files/url?category=payslip')).status, 400);
    assert.equal(
      (await get(url, '/api/v1/hrms/files/url?category=made-up&key=x')).status,
      400,
      'an unknown category is rejected',
    );
    // A real category with no registered rule fails closed.
    assert.equal((await get(url, '/api/v1/hrms/files/url?category=payslip&key=x')).status, 403);
  });
});

// ---------------------------------------------------------------------------
// The reference system's public selfie route is NOT replicated
// ---------------------------------------------------------------------------

test('no HRMS route serves a file without authentication', async () => {
  const routerSrc = await readFile(
    new URL('../modules/hrms/hrms.routes.js', import.meta.url),
    'utf8',
  );
  // Everything under /hrms sits behind the chain declared once at the top.
  assert.match(routerSrc, /router\.use\(protect\)/);
  assert.match(routerSrc, /router\.use\(hrmsAuthorizationChain\)/);
  assert.match(routerSrc, /router\.use\('\/files', storageRoutes\)/);

  const storageSrc = await readFile(
    new URL('../modules/hrms/storage/storage.routes.js', import.meta.url),
    'utf8',
  );
  // The dev-only local route must refuse unless the local driver is active.
  assert.match(storageSrc, /driver\.name !== 'local'/);
  assert.match(storageSrc, /verifySignedUrl/);
});

test('the S3 driver requires SSE-KMS configuration rather than defaulting to SSE-S3', async () => {
  const src = await readFile(new URL('../utils/hrms/storage/s3.js', import.meta.url), 'utf8');
  assert.match(src, /ServerSideEncryption: 'aws:kms'/);
  assert.match(src, /SSEKMSKeyId/);
  assert.match(src, /HRMS_S3_KMS_KEY_ID .*is required/s);
  // AD-7: credentials come from the instance role, never from .env.
  assert.doesNotMatch(src, /AWS_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(src, /credentials:\s*\{/);
});
