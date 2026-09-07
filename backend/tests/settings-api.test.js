/**
 * Settings / Administration and Audit Logs — the HTTP layer, over a real MongoDB.
 *
 * Only `protect` is stubbed. The permission chain, the validators, the crypto,
 * the services and the error handler are all the genuine article.
 *
 * Settings is privileged infrastructure, so most of what follows is about what
 * must NOT happen: a secret must never leave the server, not through a read
 * endpoint and not through the audit trail; a role that cannot open Settings
 * must not reach it by another door; and a configuration write must not be able
 * to set a field nobody declared.
 *
 * The sharpest test in the file is `an hr_admin cannot read a secret through
 * the audit trail` — that is a live privilege-escalation path in the reference,
 * because `audit-logs:view:org` reaches two roles that `settings:view:org`
 * does not.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import Employee from '../models/hrms/Employee.js';
import CompanyProfile from '../models/hrms/CompanyProfile.js';
import { SsoConfig, IntegrationConfig } from '../models/hrms/SettingsModels.js';
import AuditLog from '../models/AuditLog.js';
import User from '../models/User.js';
import settingsRoutes from '../modules/hrms/settings/settings.routes.js';
import auditRoutes from '../modules/hrms/audit/audit.routes.js';
import { redactMeta } from '../modules/hrms/audit/audit.service.js';
import { hrmsAuthorizationChain, setEmployeeResolver } from '../middlewares/hrmsAuth.js';
import { hrmsErrorHandler } from '../modules/hrms/hrms.errors.js';
import {
  registerReferenceProvider,
  __resetReferenceProviders,
} from '../modules/hrms/references/reference.service.js';
import { employeeReferenceProvider } from '../modules/hrms/employees/employee.provider.js';
import { AUDIT_ACTIONS } from '../shared/constants/hrms.js';
import { HRMS_ROLES as R, HRMS_ROLE_LIST } from '../shared/permissions/constants.js';
import { decryptField, __resetCrypto } from '../utils/hrms/crypto/index.js';
import { BRAND_TOKENS } from '../shared/schemas/settings.js';
import { buildTestApp, stubProtect, withServer, get, post, patch, put } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const S = '/api/v1/hrms/settings';
const AL = '/api/v1/hrms/audit-logs';
const oid = () => new mongoose.Types.ObjectId();

/** A 1x1 PNG — real magic bytes, so the content check passes. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000a49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
);

before(async () => {
  await startTestMongo();
  await syncIndexes(Employee, CompanyProfile, SsoConfig, IntegrationConfig);
});

after(async () => {
  await stopTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  __resetCrypto();
  __resetReferenceProviders();
  registerReferenceProvider('employee', employeeReferenceProvider);
  setEmployeeResolver((userId) => employeeReferenceProvider.byUserId(userId));
});

function appFor(user) {
  return buildTestApp({
    mount: (app) => {
      const router = express.Router();
      router.use(stubProtect(user));
      router.use(hrmsAuthorizationChain);
      router.use('/settings', settingsRoutes);
      router.use('/audit-logs', auditRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

let seq = 0;
async function makePerson(roles, over = {}) {
  seq += 1;
  const userId = oid();
  await User.create({
    _id: userId,
    name: over.name ?? `${over.firstName ?? 'Test'} Person`,
    email: `st${seq}@example.com`,
    password: 'hashed-not-used',
    role: over.portalRole ?? 'Management',
    roles,
    status: 'Active',
  });
  const employee = await Employee.create({
    employeeCode: `ST-${String(seq).padStart(4, '0')}`,
    userId,
    firstName: over.firstName ?? 'Test',
    lastName: `Person${seq}`,
    dateOfJoining: new Date('2020-01-01'),
    status: 'active',
  });
  return {
    user: { _id: userId, role: over.portalRole ?? 'Management', roles, status: 'Active' },
    employee,
  };
}

const envelope = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  return res.body.data;
};

const refused = (res, status) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  return res.body;
};

async function seedRoles() {
  return {
    superAdmin: await makePerson([R.SUPER_ADMIN], { firstName: 'Sue' }),
    hr: await makePerson([R.HR_ADMIN], { firstName: 'Hana' }),
    auditor: await makePerson([R.AUDITOR], { firstName: 'Ada' }),
    payroll: await makePerson([R.PAYROLL_ADMIN], { firstName: 'Fiona' }),
    it: await makePerson([R.IT_ADMIN], { firstName: 'Ivan' }),
    manager: await makePerson([R.MANAGER], { firstName: 'Mo' }),
    staff: await makePerson([R.EMPLOYEE], { firstName: 'Sam' }),
  };
}

/** Upload a file through the real multipart path. */
async function uploadLogo(url, bytes, { filename = 'logo.png', type = 'image/png' } = {}) {
  const form = new FormData();
  form.append('logo', new Blob([bytes], { type }), filename);
  const res = await fetch(`${url}${S}/company/logo`, { method: 'POST', body: form });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// ===========================================================================
// Who may reach Settings at all
// ===========================================================================

test('Settings is super-admin only, on every route', async () => {
  const roles = await seedRoles();
  const reads = [`${S}/company`, `${S}/roles`, `${S}/sso`, `${S}/integrations`];

  await withServer(appFor(roles.superAdmin.user), async (url) => {
    for (const path of reads) assert.equal((await get(url, path)).status, 200, path);
  });

  // Every other HRMS role, including the two that CAN read audit logs.
  for (const key of ['hr', 'auditor', 'payroll', 'it', 'manager', 'staff']) {
    await withServer(appFor(roles[key].user), async (url) => {
      for (const path of reads) refused(await get(url, path), 403);
      refused(await patch(url, `${S}/company`, { displayName: 'x' }), 403);
      refused(await put(url, `${S}/sso`, { provider: 'google' }), 403);
      refused(await put(url, `${S}/integrations`, { kind: 'slack' }), 403);
    });
  }
});

test('AD-4: a Customer reaches no settings or audit endpoint', async () => {
  const userId = oid();
  await User.create({
    _id: userId,
    name: 'Buyer Co',
    email: 'buyer@example.com',
    password: 'hashed-not-used',
    role: 'Customer',
    roles: [],
    status: 'Active',
  });
  const customer = { _id: userId, role: 'Customer', roles: [], status: 'Active' };

  await withServer(appFor(customer), async (url) => {
    for (const path of [`${S}/company`, `${S}/roles`, `${S}/sso`, `${S}/integrations`, `${AL}/`]) {
      refused(await get(url, path), 403);
    }
  });
});

test('an unauthenticated caller gets 401, not an empty settings page', async () => {
  await withServer(appFor(null), async (url) => {
    assert.equal((await get(url, `${S}/company`)).status, 401);
    assert.equal((await get(url, `${AL}/`)).status, 401);
  });
});

// ===========================================================================
// Company profile — the EXISTING CompanyProfile, not a second one
// ===========================================================================

test('the company tab reads and writes the SAME document /hrms/company serves', async () => {
  const { superAdmin } = await seedRoles();
  await CompanyProfile.create({ key: 'company-profile', legalName: 'Shraddha Impex' });

  await withServer(appFor(superAdmin.user), async (url) => {
    const before = envelope(await get(url, `${S}/company`));
    assert.equal(before.legalName, 'Shraddha Impex');

    await patch(url, `${S}/company`, { displayName: 'Shraddha' });
  });

  // One document, updated in place — not a second settings collection.
  assert.equal(await CompanyProfile.countDocuments(), 1);
  const doc = await CompanyProfile.findOne({ key: 'company-profile' });
  assert.equal(doc.displayName, 'Shraddha');
  assert.equal(doc.legalName, 'Shraddha Impex');
});

test('brand defaults are filled in on the SERVER', async () => {
  // The reference defaults them in the browser only, so its GET keeps
  // returning `{}` and every client re-invents the palette.
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${S}/company`));
    assert.deepEqual(data.brand, BRAND_TOKENS);
  });
});

test('a partial brand update keeps the other tokens', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    const data = envelope(await patch(url, `${S}/company`, { brand: { accent: '#123456' } }));
    assert.equal(data.brand.accent, '#123456');
    assert.equal(data.brand.primary, BRAND_TOKENS.primary);
    assert.equal(data.brand.primaryDark, BRAND_TOKENS.primaryDark);
  });
});

test('the brand is an ALLOW-LIST — an unknown token is refused', async () => {
  // The reference writes `brand` as `Record<string, any>` straight to the
  // column, so its branding blob is an unbounded key/value store on a
  // privileged endpoint.
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    refused(await patch(url, `${S}/company`, { brand: { evil: '#000000' } }), 400);
    refused(await patch(url, `${S}/company`, { brand: { primary: 'red' } }), 400);
    refused(await patch(url, `${S}/company`, { brand: { primary: '#12345' } }), 400);
  });
});

test('mass assignment is refused — Settings cannot reach past its own remit', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    // Real CompanyProfile fields, but not this screen's to edit — they belong
    // to the company module's own wider surface.
    refused(await patch(url, `${S}/company`, { defaultStateCode: 'MH' }), 400);
    refused(await patch(url, `${S}/company`, { statutory: { pan: 'AAAAA0000A' } }), 400);
    refused(await patch(url, `${S}/company`, { key: 'other' }), 400);
    refused(await patch(url, `${S}/company`, { logoKey: 'hrms/anything/else.png' }), 400);

    // Mixed with a legitimate field: without `.strict()` the unknown key is
    // silently stripped and the request SUCCEEDS, which is the reference's
    // behaviour and the thing that makes mass assignment invisible.
    refused(
      await patch(url, `${S}/company`, { displayName: 'Shraddha', defaultStateCode: 'MH' }),
      400,
    );
    refused(
      await patch(url, `${S}/company`, { displayName: 'Shraddha', logoKey: 'x/y.png' }),
      400,
    );
  });
});

test('an empty update is refused rather than silently doing nothing', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    refused(await patch(url, `${S}/company`, {}), 400);
  });
});

// ===========================================================================
// Logo
// ===========================================================================

test('a PNG logo is stored and served as a presigned URL', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    const res = await uploadLogo(url, PNG);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const data = res.body.data;
    assert.ok(data.logoKey, 'a storage key is recorded');
    assert.ok(data.logoUrl, 'and a URL is issued for it');
    // The raw key is the storage path; the URL is what the browser gets.
    assert.notEqual(data.logoKey, data.logoUrl);
    assert.match(data.logoKey, /company/);
  });

  const doc = await CompanyProfile.findOne({ key: 'company-profile' });
  assert.ok(doc.logoKey, 'written to the existing CompanyProfile document');
});

test('a renamed JPEG is refused on its CONTENT, not its name', async () => {
  // A Content-Type header is written by the uploader and proves nothing, and
  // the payslip renderer embeds this file with `pdf-lib.embedPng`.
  const { superAdmin } = await seedRoles();
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');

  await withServer(appFor(superAdmin.user), async (url) => {
    const res = await uploadLogo(url, jpeg, { filename: 'logo.png', type: 'image/png' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /not a PNG/i);
  });
});

test('a non-PNG content type is refused before a byte is buffered', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    const res = await uploadLogo(url, PNG, { type: 'image/jpeg' });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /PNG/i);
  });
});

test('an oversized logo is a 400, not a 500', async () => {
  const { superAdmin } = await seedRoles();
  const huge = Buffer.concat([PNG, Buffer.alloc(600 * 1024)]);
  await withServer(appFor(superAdmin.user), async (url) => {
    const res = await uploadLogo(url, huge);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /KB/);
  });
});

test('only a super admin may replace the logo', async () => {
  const { hr } = await seedRoles();
  await withServer(appFor(hr.user), async (url) => {
    const res = await uploadLogo(url, PNG);
    assert.equal(res.status, 403);
  });
});

// ===========================================================================
// SSO — secrets in, never out
// ===========================================================================

const GOOGLE = {
  provider: 'google',
  clientId: 'client-abc',
  clientSecret: 'SUPER-SECRET-VALUE',
  redirectUri: 'https://hr.example.com/sso/callback',
  active: true,
};

test('every provider is listed, configured or not', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${S}/sso`));
    assert.deepEqual(data.map((p) => p.provider), ['google', 'microsoft', 'okta']);
    assert.equal(data.every((p) => p.hasClientSecret === false), true);
  });
});

test('the SSO client secret NEVER comes back', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    const created = envelope(await put(url, `${S}/sso`, GOOGLE));
    assert.equal(created.hasClientSecret, true);
    assert.equal(created.clientSecret, undefined);

    const listed = await get(url, `${S}/sso`);
    const raw = JSON.stringify(listed.body);
    assert.ok(!raw.includes('SUPER-SECRET-VALUE'), 'the secret must not be in the list response');
    assert.ok(!raw.includes('clientSecretEnc'), 'nor the envelope');

    const google = listed.body.data.find((p) => p.provider === 'google');
    assert.equal(google.hasClientSecret, true);
    assert.equal(google.clientId, 'client-abc');
    assert.deepEqual(Object.keys(google).sort(), [
      'active', 'clientId', 'hasClientSecret', 'id', 'provider', 'redirectUri', 'updatedAt',
    ]);
  });
});

test('the SSO secret is ENCRYPTED at rest, not stored as a column', async () => {
  // The reference stores `clientSecret` as a plain column.
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    await put(url, `${S}/sso`, GOOGLE);
  });

  const raw = await SsoConfig.findOne({ provider: 'google' }).select('+clientSecretEnc').lean();
  assert.ok(!JSON.stringify(raw).includes('SUPER-SECRET-VALUE'));
  assert.ok(raw.clientSecretEnc?.ct, 'an envelope, not a value');
  assert.equal(await decryptField(raw.clientSecretEnc), 'SUPER-SECRET-VALUE');
});

test('the secret is not required to toggle a provider, and is not cleared', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    await put(url, `${S}/sso`, GOOGLE);
    // The form cannot resubmit a value it was never given.
    const updated = envelope(
      await put(url, `${S}/sso`, { ...GOOGLE, clientSecret: undefined, active: false }),
    );
    assert.equal(updated.active, false);
    assert.equal(updated.hasClientSecret, true);
  });

  const raw = await SsoConfig.findOne({ provider: 'google' }).select('+clientSecretEnc').lean();
  assert.equal(await decryptField(raw.clientSecretEnc), 'SUPER-SECRET-VALUE');
});

test('configuring a provider for the first time REQUIRES a secret', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    refused(await put(url, `${S}/sso`, { ...GOOGLE, clientSecret: undefined }), 400);
  });
});

test('an unknown provider, a bad URL and an unknown field are all refused', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    refused(await put(url, `${S}/sso`, { ...GOOGLE, provider: 'facebook' }), 400);
    refused(await put(url, `${S}/sso`, { ...GOOGLE, redirectUri: 'not-a-url' }), 400);
    refused(await put(url, `${S}/sso`, { ...GOOGLE, isSystem: true }), 400);
  });
});

// ===========================================================================
// Integrations
// ===========================================================================

const SLACK = {
  kind: 'slack',
  config: { webhookUrl: 'https://hooks.slack.example/T/B/XYZ-SECRET', defaultChannel: '#hr' },
  active: true,
};

test('the integration catalogue carries the field contract from the SERVER', async () => {
  // The reference keeps this table in the browser only, then returns every
  // field it marked secret anyway.
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${S}/integrations`));
    assert.equal(data.length, 7);

    const slack = data.find((i) => i.kind === 'slack');
    assert.deepEqual(slack.fields.map((f) => f.key), ['webhookUrl', 'defaultChannel']);
    assert.equal(slack.fields.find((f) => f.key === 'webhookUrl').secret, true);
  });
});

test('an integration SECRET never comes back; the non-secret fields do', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    const saved = envelope(await put(url, `${S}/integrations`, SLACK));
    assert.deepEqual(saved.configuredSecrets, ['webhookUrl']);
    assert.equal(saved.config.defaultChannel, '#hr');
    assert.equal(saved.config.webhookUrl, undefined);

    const listed = await get(url, `${S}/integrations`);
    const raw = JSON.stringify(listed.body);
    assert.ok(!raw.includes('XYZ-SECRET'), 'the webhook must not be in the response');
    assert.ok(!raw.includes('secretsEnc'));

    // The exact shape, not just "the plaintext is absent" — an ENVELOPE is
    // ciphertext, so a leak of the encrypted blob would pass that check while
    // still handing the browser the wrapped data key.
    const slack = listed.body.data.find((i) => i.kind === 'slack');
    assert.deepEqual(Object.keys(slack).sort(), [
      'active', 'config', 'configuredSecrets', 'fields', 'id', 'kind', 'updatedAt',
    ]);
  });
});

test('every secret field of every kind is excluded', async () => {
  // One assertion per credential the reference hands back.
  const { superAdmin } = await seedRoles();
  const cases = [
    ['quickbooks', { clientId: 'qb', clientSecret: 'QB-SECRET', realmId: '1' }, 'QB-SECRET'],
    ['teams', { webhookUrl: 'https://teams.example/TEAMS-SECRET' }, 'TEAMS-SECRET'],
    ['biometric_zkteco', { deviceIp: '10.0.0.5', devicePort: 4370, commKey: 'ZK-SECRET' }, 'ZK-SECRET'],
    ['biometric_essl', { apiUrl: 'https://essl.example', apiKey: 'ESSL-SECRET' }, 'ESSL-SECRET'],
    ['biometric_realtime', { deviceIp: '10.0.0.6', authToken: 'RT-SECRET' }, 'RT-SECRET'],
  ];

  await withServer(appFor(superAdmin.user), async (url) => {
    for (const [kind, config, secret] of cases) {
      await put(url, `${S}/integrations`, { kind, config, active: true });
    }
    const raw = JSON.stringify((await get(url, `${S}/integrations`)).body);
    for (const [, , secret] of cases) {
      assert.ok(!raw.includes(secret), `${secret} leaked`);
    }
  });
});

test('integration secrets are encrypted at rest', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    await put(url, `${S}/integrations`, SLACK);
  });

  const raw = await IntegrationConfig.findOne({ kind: 'slack' }).select('+secretsEnc').lean();
  assert.ok(!JSON.stringify(raw.config).includes('XYZ-SECRET'));
  assert.ok(raw.secretsEnc.webhookUrl?.ct);
  assert.equal(
    await decryptField(raw.secretsEnc.webhookUrl),
    'https://hooks.slack.example/T/B/XYZ-SECRET',
  );
});

test('an undeclared config field is refused', async () => {
  // The reference's `config` is `z.record(z.string(), z.any())` — anything at
  // all, written straight into the column.
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    refused(
      await put(url, `${S}/integrations`, { kind: 'slack', config: { rogueField: 'x' } }),
      400,
    );
    // A field that belongs to a DIFFERENT kind is still undeclared here.
    refused(await put(url, `${S}/integrations`, { kind: 'slack', config: { apiKey: 'x' } }), 400);
    refused(await put(url, `${S}/integrations`, { kind: 'not_a_kind', config: {} }), 400);
  });
});

test('an empty secret means "leave it alone", not "clear it"', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    await put(url, `${S}/integrations`, SLACK);
    const updated = envelope(
      await put(url, `${S}/integrations`, {
        kind: 'slack',
        config: { webhookUrl: '', defaultChannel: '#people' },
        active: true,
      }),
    );
    assert.deepEqual(updated.configuredSecrets, ['webhookUrl']);
    assert.equal(updated.config.defaultChannel, '#people');
  });
});

// ===========================================================================
// Roles — read only
// ===========================================================================

test('the role matrix is the eight CODE-defined roles, with their permissions', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${S}/roles`));

    assert.equal(data.editable, false, 'the screen must say it cannot be edited here');
    assert.deepEqual(data.roles.map((r) => r.key).sort(), [...HRMS_ROLE_LIST].sort());
    assert.equal(data.roles.every((r) => r.isSystem), true);

    const admin = data.roles.find((r) => r.key === R.SUPER_ADMIN);
    assert.ok(admin.permissions.length > 0);
    assert.ok(
      admin.permissions.some(
        (p) => p.module === 'settings' && p.action === 'edit' && p.scope === 'org',
      ),
    );
  });
});

test('the matrix reports how many accounts hold each role', async () => {
  const roles = await seedRoles();
  await makePerson([R.HR_ADMIN], { firstName: 'Second' });

  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${S}/roles`));
    assert.equal(data.roles.find((r) => r.key === R.HR_ADMIN).userCount, 2);
    assert.equal(data.roles.find((r) => r.key === R.SUPER_ADMIN).userCount, 1);
  });
});

test('there is NO role create, update or delete route', async () => {
  // The reference's builder writes Role/RolePermission rows that its ActorLoader
  // really does read. Shraddha resolves permissions from the code matrix
  // (AD-3), so the same screen here would grant nothing — offering it would be
  // a lie told by the UI. Role MEMBERSHIP is changed at
  // PATCH /hrms/employees/:id/roles instead.
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    assert.equal((await post(url, `${S}/roles`, { key: 'x', label: 'X' })).status, 404);
    assert.equal((await patch(url, `${S}/roles/anything`, { label: 'X' })).status, 404);
    assert.equal((await put(url, `${S}/roles`, { key: 'x' })).status, 404);
  });
});

test('there is no danger-zone data reset', async () => {
  // The reference's `POST /admin/reset-dtable-seed` wipes every employee,
  // payroll run and leave balance and reseeds a demo tenant whose admin
  // password is published in its own confirm dialog.
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    for (const path of ['/api/v1/hrms/admin/reset-dtable-seed', `${S}/reset`, `${S}/seed`]) {
      assert.equal((await post(url, path, {})).status, 404, path);
    }
  });
});

// ===========================================================================
// Audit logs
// ===========================================================================

async function seedAudit() {
  const roles = await seedRoles();
  await AuditLog.create([
    {
      user: roles.superAdmin.user._id,
      action: AUDIT_ACTIONS.SETTINGS_SSO_UPDATED,
      method: 'PUT',
      endpoint: '/api/v1/hrms/settings/sso',
      remarks: 'Updated the google SSO configuration.',
      meta: { provider: 'google', secretRotated: true },
      createdAt: new Date('2026-03-02T10:00:00Z'),
    },
    {
      user: roles.hr.user._id,
      action: AUDIT_ACTIONS.SETTINGS_COMPANY_UPDATED,
      method: 'PATCH',
      endpoint: '/api/v1/hrms/settings/company',
      meta: { fields: ['displayName'] },
      createdAt: new Date('2026-03-05T10:00:00Z'),
    },
    {
      user: null,
      action: 'hrms.retention.sweep',
      method: 'SYSTEM_JOB',
      meta: { purged: 3 },
      createdAt: new Date('2026-03-09T10:00:00Z'),
    },
  ]);
  return roles;
}

test('audit logs are readable by super_admin, hr_admin and auditor — and nobody else', async () => {
  const roles = await seedAudit();
  for (const key of ['superAdmin', 'hr', 'auditor']) {
    await withServer(appFor(roles[key].user), async (url) => {
      assert.equal((await get(url, `${AL}/`)).status, 200, key);
    });
  }
  for (const key of ['payroll', 'it', 'manager', 'staff']) {
    await withServer(appFor(roles[key].user), async (url) => {
      refused(await get(url, `${AL}/`), 403);
    });
  }
});

test('the trail lists newest first, with the actor resolved', async () => {
  const roles = await seedAudit();
  await withServer(appFor(roles.auditor.user), async (url) => {
    const data = envelope(await get(url, `${AL}/`));
    assert.equal(data.total, 3);
    assert.equal(data.data[0].action, 'hrms.retention.sweep');
    assert.equal(data.data[0].actorName, null, 'a system job has no actor');
    assert.equal(data.data[2].action, AUDIT_ACTIONS.SETTINGS_SSO_UPDATED);
    // The NAME comes from the employee record, not the user row — `User` has
    // no name field at all, which is why every module resolves people through
    // Employee.
    const { firstName, lastName } = roles.superAdmin.employee;
    assert.equal(data.data[2].actorName, `${firstName} ${lastName}`);
    assert.equal(data.data[2].actorUserId, String(roles.superAdmin.user._id));
    // Two people can share a name; nobody shares an employee code. In an
    // evidence trail that is what decides who is answerable.
    assert.equal(data.data[2].actorEmployeeCode, roles.superAdmin.employee.employeeCode);
    assert.equal(data.data[0].actorEmployeeCode, null, 'a system job has no code either');
  });
});

test('an actor who has since been offboarded is still named', async () => {
  const roles = await seedAudit();
  // Soft-delete the actor AFTER the entry was written. An audit trail that
  // loses its actor the moment somebody leaves is not evidence.
  await Employee.updateOne(
    { _id: roles.superAdmin.employee._id },
    { $set: { deletedAt: new Date(), status: 'exited' } },
  );

  await withServer(appFor(roles.auditor.user), async (url) => {
    const data = envelope(await get(url, `${AL}/`));
    const { firstName, lastName } = roles.superAdmin.employee;
    assert.equal(data.data[2].actorName, `${firstName} ${lastName}`);
    assert.equal(data.data[2].actorEmployeeCode, roles.superAdmin.employee.employeeCode);
  });
});

test('the trail filters by action, actor and date range', async () => {
  const roles = await seedAudit();
  await withServer(appFor(roles.auditor.user), async (url) => {
    const byAction = envelope(await get(url, `${AL}/?action=settings.sso`));
    assert.equal(byAction.total, 1);

    const byUser = envelope(await get(url, `${AL}/?userId=${roles.hr.user._id}`));
    assert.equal(byUser.total, 1);
    assert.equal(byUser.data[0].action, AUDIT_ACTIONS.SETTINGS_COMPANY_UPDATED);

    const byDate = envelope(await get(url, `${AL}/?from=2026-03-04&to=2026-03-06`));
    assert.equal(byDate.total, 1);

    // The `to` bound is inclusive of the whole day, not midnight.
    const sameDay = envelope(await get(url, `${AL}/?from=2026-03-05&to=2026-03-05`));
    assert.equal(sameDay.total, 1);
  });
});

test('the action filter is escaped, so a metacharacter cannot stall it', async () => {
  const roles = await seedAudit();
  await withServer(appFor(roles.auditor.user), async (url) => {
    // An unbalanced paren: `new RegExp('(')` THROWS, so an unescaped filter is
    // a 500 on the one screen most likely to be open during an incident.
    // `(a+)+$` is a valid regex and would pass either way.
    for (const hostile of ['(', '[', '\\', '(a+)+$', '.*']) {
      const res = await get(url, `${AL}/?action=${encodeURIComponent(hostile)}`);
      assert.equal(res.status, 200, `action=${hostile} should not be a 500`);
      assert.equal(envelope(res).total, 0, `action=${hostile} must match literally`);
    }
  });
});

test('the trail is paged, and a nonsense page is refused', async () => {
  const roles = await seedAudit();
  await withServer(appFor(roles.auditor.user), async (url) => {
    const page = envelope(await get(url, `${AL}/?page=1&pageSize=2`));
    assert.equal(page.data.length, 2);
    assert.equal(page.total, 3);

    // The reference `parseInt`s these with no NaN guard and no lower bound, so
    // `?page=-5` reaches `skip` as a negative offset.
    refused(await get(url, `${AL}/?page=-5`), 400);
    refused(await get(url, `${AL}/?page=abc`), 400);
    refused(await get(url, `${AL}/?pageSize=100000`), 400);
    refused(await get(url, `${AL}/?from=2026-03-09&to=2026-03-01`), 400);
    refused(await get(url, `${AL}/?bogus=1`), 400);
  });
});

// ===========================================================================
// The escalation path the reference leaves open
// ===========================================================================

test('an hr_admin cannot read a secret through the AUDIT TRAIL', async () => {
  // The sharpest test in this file. `settings:view:org` is super_admin only,
  // but `audit-logs:view:org` reaches hr_admin and auditor. The reference
  // stores `req.body` in its audit payload and renders it verbatim on the audit
  // page, so its hr_admin can read the SSO client secret that Settings never
  // shows them. Two roles, one screen, full escalation.
  const roles = await seedRoles();

  await withServer(appFor(roles.superAdmin.user), async (url) => {
    await put(url, `${S}/sso`, GOOGLE);
    await put(url, `${S}/integrations`, SLACK);
  });

  // Nothing written to the trail carries a secret in the first place.
  const rows = await AuditLog.find().lean();
  const stored = JSON.stringify(rows);
  assert.ok(!stored.includes('SUPER-SECRET-VALUE'), 'the SSO secret reached the audit log');
  assert.ok(!stored.includes('XYZ-SECRET'), 'the webhook reached the audit log');
  assert.ok(stored.includes('secretRotated'), 'but the fact of rotation is recorded');

  // And the reader redacts anyway, for the modules it does not own.
  for (const key of ['hr', 'auditor']) {
    await withServer(appFor(roles[key].user), async (url) => {
      const raw = JSON.stringify((await get(url, `${AL}/`)).body);
      assert.ok(!raw.includes('SUPER-SECRET-VALUE'), `${key} saw the SSO secret`);
      assert.ok(!raw.includes('XYZ-SECRET'), `${key} saw the webhook`);
    });
  }
});

test('the reader redacts a secret ANOTHER module wrote', async () => {
  // `meta` is a Mixed field every module can write. An audit reader must not
  // depend on all of them being careful forever.
  const roles = await seedRoles();
  await AuditLog.create({
    user: roles.superAdmin.user._id,
    action: 'some.other.module',
    method: 'POST',
    meta: {
      clientSecret: 'LEAKED-A',
      nested: { apiKey: 'LEAKED-B', harmless: 'fine' },
      list: [{ authToken: 'LEAKED-C' }],
      password: 'LEAKED-D',
      slackWebhookUrl: 'LEAKED-E',
    },
  });

  await withServer(appFor(roles.auditor.user), async (url) => {
    const raw = JSON.stringify((await get(url, `${AL}/`)).body);
    for (const leak of ['LEAKED-A', 'LEAKED-B', 'LEAKED-C', 'LEAKED-D', 'LEAKED-E']) {
      assert.ok(!raw.includes(leak), `${leak} was not redacted`);
    }
    assert.ok(raw.includes('harmless'), 'ordinary values survive');
  });
});

test('redactMeta is depth-bounded and total', () => {
  assert.deepEqual(redactMeta({ a: 1 }), { a: 1 });
  assert.equal(redactMeta(null), null);
  assert.equal(redactMeta('plain'), 'plain');
  assert.deepEqual(redactMeta({ token: 'x' }), { token: '[redacted]' });
  // Case-insensitive, and a substring match so compound names are caught.
  assert.deepEqual(redactMeta({ AwsSecretAccessKey: 'x' }), { AwsSecretAccessKey: '[redacted]' });

  // A pathologically nested value must not hang the request.
  let deep = { apiKey: 'x' };
  for (let i = 0; i < 40; i += 1) deep = { nested: deep };
  assert.doesNotThrow(() => redactMeta(deep));
});

// ===========================================================================
// Auditing of settings changes
// ===========================================================================

test('every settings mutation is audited, and a refusal is not', async () => {
  const roles = await seedRoles();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    await patch(url, `${S}/company`, { displayName: 'Shraddha' });
    await put(url, `${S}/sso`, GOOGLE);
    await put(url, `${S}/integrations`, SLACK);
    await uploadLogo(url, PNG);
  });
  await withServer(appFor(roles.hr.user), async (url) => {
    await patch(url, `${S}/company`, { displayName: 'Nope' }); // 403
  });

  const actions = (await AuditLog.find().lean()).map((r) => r.action);
  assert.equal(actions.filter((a) => a === AUDIT_ACTIONS.SETTINGS_COMPANY_UPDATED).length, 1);
  assert.equal(actions.filter((a) => a === AUDIT_ACTIONS.SETTINGS_SSO_UPDATED).length, 1);
  assert.equal(actions.filter((a) => a === AUDIT_ACTIONS.SETTINGS_INTEGRATION_UPDATED).length, 1);
  assert.equal(actions.filter((a) => a === AUDIT_ACTIONS.SETTINGS_LOGO_UPDATED).length, 1);
});

test('a no-op company update writes no audit row', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    const current = envelope(await get(url, `${S}/company`));
    await patch(url, `${S}/company`, { displayName: current.displayName });
  });
  assert.equal(await AuditLog.countDocuments({ action: AUDIT_ACTIONS.SETTINGS_COMPANY_UPDATED }), 0);
});

// ===========================================================================
// Envelope
// ===========================================================================

test('every settings and audit response uses the standard envelope', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    for (const path of [
      `${S}/company`,
      `${S}/roles`,
      `${S}/sso`,
      `${S}/integrations`,
      `${AL}/`,
      `${AL}/actions`,
    ]) {
      const res = await get(url, path);
      assert.equal(res.status, 200, path);
      assert.deepEqual(Object.keys(res.body).sort(), ['data', 'success'], path);
      assert.equal(res.body.success, true, path);
    }
  });
});
