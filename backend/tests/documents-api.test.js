/**
 * Documents — the HTTP layer, over a real MongoDB.
 *
 * Only `protect` is stubbed, exactly as every other HRMS route test does it.
 * The permission chain, the validator, the service, the storage layer and the
 * error handler are all the genuine article.
 *
 * The tests that matter most are the storage and visibility ones. Documents is
 * the module that holds contracts, ID proofs and signed policies, so "who can
 * read these bytes" is the whole game — and it is where the reference is
 * weakest.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';

// Documents go through the real storage layer, onto a scratch directory.
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_PATH =
  process.env.STORAGE_LOCAL_PATH || (await fs.mkdtemp(path.join(os.tmpdir(), 'hrms-docs-')));

import Employee from '../models/hrms/Employee.js';
import {
  DocumentFolder,
  HrmsDocument,
  DocumentAcknowledgment,
} from '../models/hrms/DocumentModels.js';
import AuditLog from '../models/AuditLog.js';
import User from '../models/User.js';
import documentRoutes from '../modules/hrms/documents/document.routes.js';
import {
  resolveEmployeeDocumentAccess,
  resolveCompanyDocumentAccess,
} from '../modules/hrms/documents/document.service.js';
import { hrmsAuthorizationChain, setEmployeeResolver } from '../middlewares/hrmsAuth.js';
import { hrmsErrorHandler } from '../modules/hrms/hrms.errors.js';
import {
  registerReferenceProvider,
  __resetReferenceProviders,
} from '../modules/hrms/references/reference.service.js';
import { employeeReferenceProvider } from '../modules/hrms/employees/employee.provider.js';
import {
  registerFileAccessRule,
  __resetFileAccessRules,
} from '../modules/hrms/storage/storage.service.js';
import { __resetStorage, getObjectStream } from '../utils/hrms/storage/index.js';
import { AUDIT_ACTIONS, STORAGE_CATEGORIES } from '../shared/constants/hrms.js';
import { HRMS_ROLES as R } from '../shared/permissions/constants.js';
import { buildTestApp, stubProtect, withServer, get, post, patch, del } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const P = '/api/v1/hrms/documents';
const oid = () => new mongoose.Types.ObjectId();

/** A one-page PDF, by magic bytes. */
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('body'), Buffer.from('\n%%EOF')]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 2)]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

before(async () => {
  await startTestMongo();
  await syncIndexes(Employee, DocumentFolder, HrmsDocument, DocumentAcknowledgment);
});

after(async () => {
  await stopTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  __resetReferenceProviders();
  __resetFileAccessRules();
  __resetStorage();
  registerReferenceProvider('employee', employeeReferenceProvider);
  setEmployeeResolver((userId) => employeeReferenceProvider.byUserId(userId));
  registerFileAccessRule(STORAGE_CATEGORIES.EMPLOYEE_DOCUMENT, {
    resolve: resolveEmployeeDocumentAccess,
    auditAction: AUDIT_ACTIONS.DOCUMENT_VIEWED,
  });
  registerFileAccessRule(STORAGE_CATEGORIES.COMPANY_ASSET, {
    resolve: resolveCompanyDocumentAccess,
    auditAction: AUDIT_ACTIONS.DOCUMENT_VIEWED,
  });
});

function appFor(user) {
  return buildTestApp({
    mount: (app) => {
      const router = express.Router();
      router.use(stubProtect(user));
      router.use(hrmsAuthorizationChain);
      router.use('/documents', documentRoutes);
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
    name: `${over.firstName ?? 'Test'} Person`,
    email: `docs${seq}@example.com`,
    password: 'hashed-not-used',
    role: 'Management',
    roles,
    status: 'Active',
  });
  const employee = await Employee.create({
    employeeCode: `DC-${String(seq).padStart(4, '0')}`,
    userId,
    firstName: over.firstName ?? 'Test',
    lastName: over.lastName ?? `Person${seq}`,
    dateOfJoining: new Date('2020-01-01'),
    status: over.status ?? 'active',
    ...over,
  });
  return { user: { _id: userId, role: 'Management', roles, status: 'Active' }, employee };
}

const envelope = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  return res.body.data;
};

const errorBody = (res, status, code) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  if (code) assert.equal(res.body.code, code);
  return res.body;
};

const day = (offset) =>
  new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

/** Upload a file as multipart. */
async function upload(url, { buffer = PDF, filename = 'contract.pdf', type = 'application/pdf', fields = {} }) {
  const boundary = '----hrmsdoctest';
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${type}\r\n\r\n`,
    ),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );

  const res = await fetch(`${url}${P}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function seedOrg() {
  const hr = await makePerson([R.HR_ADMIN], { firstName: 'Hana' });
  const staff = await makePerson([R.EMPLOYEE], { firstName: 'Sam' });
  const other = await makePerson([R.EMPLOYEE], { firstName: 'Otto' });
  const manager = await makePerson([R.MANAGER], { firstName: 'Mira' });
  return { hr, staff, other, manager };
}

// ===========================================================================
// Upload and file validation
// ===========================================================================

test('HR uploads to the company library; an employee uploads only to their own repo', async () => {
  const { hr, staff } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const doc = envelope(
      await upload(url, { fields: { name: 'Leave policy', tags: 'hr,policy' } }),
      201,
    );
    assert.equal(doc.scope, 'company');
    assert.deepEqual(doc.tags, ['hr', 'policy']);
    assert.equal(doc.mimeType, 'application/pdf');
  });

  await withServer(appFor(staff.user), async (url) => {
    // No employeeId means the library — refused for an ordinary employee.
    errorBody(await upload(url, { fields: { name: 'Sneaky' } }), 403);

    const mine = envelope(
      await upload(url, {
        fields: { name: 'My PAN card', employeeId: String(staff.employee._id) },
      }),
      201,
    );
    assert.equal(mine.scope, 'employee');
    assert.equal(mine.employeeId, String(staff.employee._id));
  });
});

test('an employee cannot upload into somebody else’s repository', async () => {
  const { staff, other } = await seedOrg();

  await withServer(appFor(staff.user), async (url) => {
    errorBody(
      await upload(url, {
        fields: { name: 'Planted', employeeId: String(other.employee._id) },
      }),
      403,
    );
  });
});

test('THE BYTES decide the type, not the client', async () => {
  // The reference stores the declared MIME type and serves it back inline,
  // which turns an uploaded .html into script execution on the API origin.
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    // HTML wearing a PDF's name and content type.
    errorBody(
      await upload(url, {
        buffer: HTML,
        filename: 'policy.pdf',
        type: 'application/pdf',
        fields: { name: 'Hostile' },
      }),
      400,
    );

    // HTML declared honestly is refused too — the whitelist has no entry for
    // it, because a document a browser will execute is not a document.
    errorBody(
      await upload(url, {
        buffer: HTML,
        filename: 'page.html',
        type: 'text/html',
        fields: { name: 'Honest HTML' },
      }),
      400,
    );

    // A real PDF lying about being a PNG is still stored as a PDF.
    const doc = envelope(
      await upload(url, {
        buffer: PDF,
        filename: 'x.png',
        type: 'image/png',
        fields: { name: 'Honest bytes' },
      }),
      201,
    );
    assert.equal(doc.mimeType, 'application/pdf');

    // Plain text is fine, and is recorded as text.
    const note = envelope(
      await upload(url, {
        buffer: Buffer.from('a plain note'),
        filename: 'note.txt',
        type: 'text/plain',
        fields: { name: 'Note' },
      }),
      201,
    );
    assert.equal(note.mimeType, 'text/plain');
  });
});

test('a ZIP is accepted only when it claims to be an Office document', async () => {
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    envelope(
      await upload(url, {
        buffer: DOCX,
        filename: 'handbook.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fields: { name: 'Handbook' },
      }),
      201,
    );

    // The same bytes as a plain archive are refused.
    errorBody(
      await upload(url, {
        buffer: DOCX,
        filename: 'stuff.zip',
        type: 'application/zip',
        fields: { name: 'Archive' },
      }),
      400,
    );
  });
});

test('the storage key never reaches a browser, and the original filename never becomes a path', async () => {
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const doc = envelope(
      await upload(url, {
        filename: '../../../etc/passwd.pdf',
        fields: { name: 'Traversal attempt' },
      }),
      201,
    );

    assert.equal(doc.storageKey, undefined, 'the key must not be in the DTO');
    assert.ok(!JSON.stringify(doc).includes('hrms/'), 'no storage path in the payload');

    const stored = await HrmsDocument.findById(doc.id).lean();
    assert.ok(!stored.storageKey.includes('..'), 'the key is minted, not built from input');
    assert.ok(stored.storageKey.endsWith('.pdf'));
    // The name is kept for display only, and the multipart parser has already
    // dropped the directory part — so even the display string cannot carry a
    // path. The reference builds its stored filename from this value.
    assert.equal(stored.originalFilename, 'passwd.pdf');
    assert.ok(!stored.originalFilename.includes('/'));
  });
});

test('an oversized upload is refused', async () => {
  const { hr } = await seedOrg();
  const { MAX_DOCUMENT_BYTES } = await import('../modules/hrms/documents/documentUpload.js');
  const huge = Buffer.concat([PDF, Buffer.alloc(MAX_DOCUMENT_BYTES + 1024, 0x20)]);

  await withServer(appFor(hr.user), async (url) => {
    errorBody(await upload(url, { buffer: huge, fields: { name: 'Too big' } }), 400);
  });
});

test('a document cannot belong to a folder AND an employee', async () => {
  const { hr, staff } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const folder = envelope(
      await post(url, `${P}/folders`, { name: 'Contracts', visibility: 'org' }),
      201,
    );
    errorBody(
      await upload(url, {
        fields: {
          name: 'Confused',
          folderId: folder.id,
          employeeId: String(staff.employee._id),
        },
      }),
      400,
    );
  });
});

// ===========================================================================
// Reading — presigned URLs and object-level access
// ===========================================================================

test('a document is read through a short-lived URL, never a key', async () => {
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const doc = envelope(await upload(url, { fields: { name: 'Handbook' } }), 201);

    const link = envelope(await get(url, `${P}/${doc.id}/url`));
    assert.ok(link.url, 'a URL should be issued');
    assert.ok(link.expiresInSeconds > 0, 'and it should expire');
    assert.equal(link.name, 'Handbook');
  });
});

test('the stored bytes are the bytes that were uploaded', async () => {
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const doc = envelope(await upload(url, { fields: { name: 'Handbook' } }), 201);
    const stored = await HrmsDocument.findById(doc.id).lean();

    const stream = await getObjectStream(stored.storageKey);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.ok(Buffer.concat(chunks).equals(PDF));
  });
});

test('one employee cannot read another employee’s personal document', async () => {
  const { hr, staff, other } = await seedOrg();
  let docId;

  await withServer(appFor(hr.user), async (url) => {
    docId = envelope(
      await upload(url, {
        fields: { name: 'Sam contract', employeeId: String(staff.employee._id) },
      }),
      201,
    ).id;
  });

  await withServer(appFor(other.user), async (url) => {
    // Not listed, not readable, and no URL.
    assert.equal(envelope(await get(url, P)).total, 0);
    errorBody(await get(url, `${P}/${docId}`), 404);
    errorBody(await get(url, `${P}/${docId}/url`), 404);
  });

  await withServer(appFor(staff.user), async (url) => {
    assert.equal(envelope(await get(url, `${P}/${docId}`)).name, 'Sam contract');
  });
});

test('a MANAGER has no claim on a report’s personal documents', async () => {
  // The reference's own comment says the reporting chain can see these; its
  // code does not, and the honest rule is the narrow one — a contract or an ID
  // proof is not team-scoped data.
  const { hr, staff, manager } = await seedOrg();
  await Employee.updateOne(
    { _id: staff.employee._id },
    { $set: { reportingManagerId: manager.employee._id, managerChain: [manager.employee._id] } },
  );
  let docId;

  await withServer(appFor(hr.user), async (url) => {
    docId = envelope(
      await upload(url, {
        fields: { name: 'Sam PAN', employeeId: String(staff.employee._id) },
      }),
      201,
    ).id;
  });

  await withServer(appFor(manager.user), async (url) => {
    errorBody(await get(url, `${P}/${docId}`), 404);
  });
});

test('a DEPARTED employee’s documents stay private', async () => {
  // The reference nulls the employee link on delete and then treats a document
  // with no folder and no employee as org-visible — so deleting somebody
  // publishes everything personal they had.
  const { hr, staff, other } = await seedOrg();
  let docId;

  await withServer(appFor(hr.user), async (url) => {
    docId = envelope(
      await upload(url, {
        fields: { name: 'Sam contract', employeeId: String(staff.employee._id) },
      }),
      201,
    ).id;
  });

  await Employee.updateOne(
    { _id: staff.employee._id },
    { $set: { deletedAt: new Date(), status: 'exited' } },
  );

  await withServer(appFor(other.user), async (url) => {
    assert.equal(envelope(await get(url, P)).total, 0, 'still nobody else’s business');
    errorBody(await get(url, `${P}/${docId}`), 404);
  });

  // The record itself survives, still marked personal.
  const stored = await HrmsDocument.findById(docId).lean();
  assert.equal(stored.scope, 'employee');
  assert.equal(String(stored.employeeId), String(staff.employee._id));

  await withServer(appFor(hr.user), async (url) => {
    assert.equal(envelope(await get(url, `${P}/${docId}`)).name, 'Sam contract');
  });
});

test('HR reads any repository; an employee reads only their own via /me', async () => {
  const { hr, staff } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    envelope(
      await upload(url, {
        fields: { name: 'Sam contract', employeeId: String(staff.employee._id) },
      }),
      201,
    );
    const page = envelope(await get(url, `${P}?employeeId=${staff.employee._id}`));
    assert.equal(page.total, 1);
  });

  await withServer(appFor(staff.user), async (url) => {
    assert.equal(envelope(await get(url, `${P}/me`)).total, 1);
    // Asking for somebody else's is refused outright.
    errorBody(await get(url, `${P}?employeeId=${hr.employee._id}`), 403);
  });
});

// ===========================================================================
// Folders and visibility
// ===========================================================================

test('folder visibility governs who sees the documents inside it', async () => {
  const { hr, staff } = await seedOrg();
  const itAdmin = await makePerson([R.IT_ADMIN], { firstName: 'Ivan' });

  await withServer(appFor(hr.user), async (url) => {
    const open = envelope(
      await post(url, `${P}/folders`, { name: 'Everyone', visibility: 'org' }),
      201,
    );
    const restricted = envelope(
      await post(url, `${P}/folders`, {
        name: 'IT only',
        visibility: 'role',
        roleKeys: [R.IT_ADMIN],
      }),
      201,
    );

    envelope(await upload(url, { fields: { name: 'Public doc', folderId: open.id } }), 201);
    envelope(
      await upload(url, { fields: { name: 'Secret doc', folderId: restricted.id } }),
      201,
    );
  });

  await withServer(appFor(staff.user), async (url) => {
    const names = envelope(await get(url, P)).data.map((d) => d.name);
    assert.ok(names.includes('Public doc'));
    assert.ok(!names.includes('Secret doc'), 'a role-scoped folder is not for everyone');
  });

  await withServer(appFor(itAdmin.user), async (url) => {
    const names = envelope(await get(url, P)).data.map((d) => d.name);
    assert.ok(names.includes('Secret doc'));
  });
});

test('a role-scoped folder must name a role', async () => {
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    errorBody(
      await post(url, `${P}/folders`, { name: 'Nobody', visibility: 'role', roleKeys: [] }),
      400,
    );
    errorBody(
      await post(url, `${P}/folders`, { name: 'Nobody', visibility: 'department' }),
      400,
    );
  });
});

test('a folder holding documents or subfolders cannot be deleted', async () => {
  // The reference deletes unconditionally, orphaning every document in it —
  // which by its own visibility fallthrough makes them org-visible.
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const folder = envelope(
      await post(url, `${P}/folders`, { name: 'Contracts', visibility: 'org' }),
      201,
    );
    envelope(await upload(url, { fields: { name: 'A doc', folderId: folder.id } }), 201);

    // Held by a document.
    errorBody(await del(url, `${P}/folders/${folder.id}`), 409, 'DOCUMENT_FOLDER_IN_USE');

    // An empty child deletes cleanly...
    const child = envelope(
      await post(url, `${P}/folders`, {
        name: 'Signed',
        visibility: 'org',
        parentId: folder.id,
      }),
      201,
    );
    envelope(await del(url, `${P}/folders/${child.id}`));

    // ...and a parent is held by its children as well as by its documents.
    const kept = envelope(
      await post(url, `${P}/folders`, {
        name: 'Kept',
        visibility: 'org',
        parentId: folder.id,
      }),
      201,
    );
    const body = errorBody(
      await del(url, `${P}/folders/${folder.id}`),
      409,
      'DOCUMENT_FOLDER_IN_USE',
    );
    assert.equal(body.details.children, 1);
    assert.equal(body.details.documents, 1);
    assert.ok(kept.id);
  });
});

test('a folder cannot be made its own ancestor', async () => {
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const parent = envelope(
      await post(url, `${P}/folders`, { name: 'Parent', visibility: 'org' }),
      201,
    );
    const child = envelope(
      await post(url, `${P}/folders`, {
        name: 'Child',
        visibility: 'org',
        parentId: parent.id,
      }),
      201,
    );

    errorBody(await patch(url, `${P}/folders/${parent.id}`, { parentId: parent.id }), 400);
    errorBody(await patch(url, `${P}/folders/${parent.id}`, { parentId: child.id }), 400);
  });
});

test('an employee cannot create, edit or delete a folder', async () => {
  const { hr, staff } = await seedOrg();
  let folderId;

  await withServer(appFor(hr.user), async (url) => {
    folderId = envelope(
      await post(url, `${P}/folders`, { name: 'Contracts', visibility: 'org' }),
      201,
    ).id;
  });

  await withServer(appFor(staff.user), async (url) => {
    errorBody(await post(url, `${P}/folders`, { name: 'Mine', visibility: 'org' }), 403);
    errorBody(await patch(url, `${P}/folders/${folderId}`, { name: 'Renamed' }), 403);
    errorBody(await del(url, `${P}/folders/${folderId}`), 403);
    // Reading the tree is fine — a document has to be filed somewhere.
    assert.equal(envelope(await get(url, `${P}/folders`)).length, 1);
  });
});

// ===========================================================================
// Editing and deleting
// ===========================================================================

test('an employee renames and deletes their own document, and nobody else’s', async () => {
  const { hr, staff, other } = await seedOrg();
  let docId;

  await withServer(appFor(staff.user), async (url) => {
    docId = envelope(
      await upload(url, {
        fields: { name: 'Draft', employeeId: String(staff.employee._id) },
      }),
      201,
    ).id;

    const renamed = envelope(await patch(url, `${P}/${docId}`, { name: 'PAN card' }));
    assert.equal(renamed.name, 'PAN card');
  });

  await withServer(appFor(other.user), async (url) => {
    errorBody(await patch(url, `${P}/${docId}`, { name: 'Hijacked' }), 404);
    errorBody(await del(url, `${P}/${docId}`), 404);
  });

  await withServer(appFor(staff.user), async (url) => {
    envelope(await del(url, `${P}/${docId}`));
    errorBody(await get(url, `${P}/${docId}`), 404);
  });

  // HR sees it gone too.
  await withServer(appFor(hr.user), async (url) => {
    errorBody(await get(url, `${P}/${docId}`), 404);
  });
});

test('deleting a document removes its OBJECT, not just the row', async () => {
  // The reference deletes the row and leaves the file on disk forever.
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const doc = envelope(await upload(url, { fields: { name: 'Temporary' } }), 201);
    const stored = await HrmsDocument.findById(doc.id).lean();

    envelope(await del(url, `${P}/${doc.id}`));

    await assert.rejects(
      async () => {
        const stream = await getObjectStream(stored.storageKey);
        for await (const _ of stream) break;
      },
      'the object should be gone from storage',
    );

    // The row survives, soft-deleted, so the audit trail still resolves it.
    const after = await HrmsDocument.findById(doc.id).lean();
    assert.ok(after.deletedAt);
  });
});

test('an employee cannot move their document into a shared folder', async () => {
  const { hr, staff } = await seedOrg();
  let folderId;

  await withServer(appFor(hr.user), async (url) => {
    folderId = envelope(
      await post(url, `${P}/folders`, { name: 'Public', visibility: 'org' }),
      201,
    ).id;
  });

  await withServer(appFor(staff.user), async (url) => {
    const doc = envelope(
      await upload(url, {
        fields: { name: 'Mine', employeeId: String(staff.employee._id) },
      }),
      201,
    );
    errorBody(await patch(url, `${P}/${doc.id}`, { folderId }), 403);
  });
});

// ===========================================================================
// Policies
// ===========================================================================

/** Upload a library document and publish it as a policy. */
async function publishedPolicy(url, over = {}) {
  const doc = envelope(await upload(url, { fields: { name: 'Code of conduct' } }), 201);
  const policy = envelope(
    await post(url, `${P}/${doc.id}/policy`, {
      requiresAcknowledgment: true,
      requiresSignature: false,
      effectiveFrom: day(-1),
      targetRoleKeys: [],
      ...over,
    }),
    201,
  );
  return policy;
}

test('HR publishes a policy; an employee cannot', async () => {
  const { hr, staff } = await seedOrg();
  let docId;

  await withServer(appFor(hr.user), async (url) => {
    const policy = await publishedPolicy(url);
    docId = policy.id;
    assert.equal(policy.policy.requiresAcknowledgment, true);
    assert.equal(policy.policy.isLive, true);
    assert.equal(policy.policy.isExpired, false);
  });

  await withServer(appFor(staff.user), async (url) => {
    errorBody(
      await post(url, `${P}/${docId}/policy`, {
        requiresAcknowledgment: true,
        effectiveFrom: day(0),
      }),
      403,
    );
  });
});

test('a document is published as a policy only once, and only a company document', async () => {
  const { hr, staff } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const policy = await publishedPolicy(url);
    errorBody(
      await post(url, `${P}/${policy.id}/policy`, {
        requiresAcknowledgment: true,
        effectiveFrom: day(0),
      }),
      409,
      'DOCUMENT_ALREADY_POLICY',
    );

    const personal = envelope(
      await upload(url, {
        fields: { name: 'Sam contract', employeeId: String(staff.employee._id) },
      }),
      201,
    );
    errorBody(
      await post(url, `${P}/${personal.id}/policy`, {
        requiresAcknowledgment: true,
        effectiveFrom: day(0),
      }),
      400,
    );
  });
});

test('a policy cannot expire before it takes effect', async () => {
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const doc = envelope(await upload(url, { fields: { name: 'Policy' } }), 201);
    errorBody(
      await post(url, `${P}/${doc.id}/policy`, {
        requiresAcknowledgment: true,
        effectiveFrom: day(10),
        expiresAt: day(5),
      }),
      400,
    );
  });
});

test('acknowledging is once, and it is recorded', async () => {
  const { hr, staff } = await seedOrg();
  let docId;

  await withServer(appFor(hr.user), async (url) => {
    docId = (await publishedPolicy(url)).id;
  });

  await withServer(appFor(staff.user), async (url) => {
    const after = envelope(await post(url, `${P}/${docId}/acknowledge`, {}), 201);
    assert.equal(after.acknowledgedByMe, true);
    assert.equal(after.acknowledgmentCount, 1);

    errorBody(
      await post(url, `${P}/${docId}/acknowledge`, {}),
      409,
      'POLICY_ALREADY_ACKNOWLEDGED',
    );
  });
});

test('a policy NOT addressed to you cannot be acknowledged', async () => {
  // The reference lets anyone acknowledge anything.
  const { hr, staff } = await seedOrg();
  let docId;

  await withServer(appFor(hr.user), async (url) => {
    docId = (await publishedPolicy(url, { targetRoleKeys: [R.PAYROLL_ADMIN] })).id;
  });

  await withServer(appFor(staff.user), async (url) => {
    const body = errorBody(await post(url, `${P}/${docId}/acknowledge`, {}), 403);
    assert.match(body.message, /not addressed to you/i);
  });
});

test('a policy cannot be acknowledged before it takes effect or after it expires', async () => {
  // The reference checks neither.
  const { hr, staff } = await seedOrg();
  let future;
  let expired;

  await withServer(appFor(hr.user), async (url) => {
    future = (await publishedPolicy(url, { effectiveFrom: day(7) })).id;

    const doc = envelope(await upload(url, { fields: { name: 'Old policy' } }), 201);
    envelope(
      await post(url, `${P}/${doc.id}/policy`, {
        requiresAcknowledgment: true,
        effectiveFrom: day(-30),
        expiresAt: day(-1),
      }),
      201,
    );
    expired = doc.id;
  });

  await withServer(appFor(staff.user), async (url) => {
    errorBody(await post(url, `${P}/${future}/acknowledge`, {}), 409, 'POLICY_NOT_YET_EFFECTIVE');
    errorBody(await post(url, `${P}/${expired}/acknowledge`, {}), 409, 'POLICY_EXPIRED');
  });
});

test('an expired policy drops out of the policy list unless asked for', async () => {
  // The reference stores expiry and never filters on it.
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const live = envelope(await upload(url, { fields: { name: 'Live policy' } }), 201);
    envelope(
      await post(url, `${P}/${live.id}/policy`, {
        requiresAcknowledgment: true,
        effectiveFrom: day(-2),
      }),
      201,
    );
    const dead = envelope(await upload(url, { fields: { name: 'Dead policy' } }), 201);
    envelope(
      await post(url, `${P}/${dead.id}/policy`, {
        requiresAcknowledgment: true,
        effectiveFrom: day(-30),
        expiresAt: day(-1),
      }),
      201,
    );

    const current = envelope(await get(url, `${P}?policiesOnly=true`));
    assert.deepEqual(current.data.map((d) => d.name), ['Live policy']);

    const all = envelope(await get(url, `${P}?policiesOnly=true&includeExpired=true`));
    assert.equal(all.total, 2);
    assert.equal(all.data.find((d) => d.name === 'Dead policy').policy.isExpired, true);
  });
});

test('a policy needing a signature requires a typed name, and stores the image as an object', async () => {
  const { hr, staff } = await seedOrg();
  let docId;

  await withServer(appFor(hr.user), async (url) => {
    docId = (await publishedPolicy(url, { requiresSignature: true })).id;
  });

  await withServer(appFor(staff.user), async (url) => {
    errorBody(await post(url, `${P}/${docId}/acknowledge`, {}), 400);

    envelope(
      await post(url, `${P}/${docId}/acknowledge`, {
        signatureName: 'Sam Person',
        signatureImage: `data:image/png;base64,${PNG.toString('base64')}`,
      }),
      201,
    );
  });

  const ack = await DocumentAcknowledgment.findOne({ documentId: docId }).lean();
  assert.equal(ack.signatureName, 'Sam Person');
  // Stored as an object, not a base64 blob in the row.
  assert.ok(ack.signatureKey, 'the signature is stored as an object');
  assert.equal(ack.signature, undefined);
  // And the terms agreed to are snapshotted.
  assert.ok(ack.policySnapshot.effectiveFrom);
});

test('a signature that is not really a PNG is refused', async () => {
  const { hr, staff } = await seedOrg();
  let docId;

  await withServer(appFor(hr.user), async (url) => {
    docId = (await publishedPolicy(url, { requiresSignature: true })).id;
  });

  await withServer(appFor(staff.user), async (url) => {
    errorBody(
      await post(url, `${P}/${docId}/acknowledge`, {
        signatureName: 'Sam Person',
        signatureImage: `data:image/png;base64,${HTML.toString('base64')}`,
      }),
      400,
    );
  });
});

test('HR sees who has and has not acknowledged; an employee cannot', async () => {
  const { hr, staff } = await seedOrg();
  let docId;

  await withServer(appFor(hr.user), async (url) => {
    docId = (await publishedPolicy(url)).id;
  });
  await withServer(appFor(staff.user), async (url) => {
    envelope(await post(url, `${P}/${docId}/acknowledge`, {}), 201);
    errorBody(await get(url, `${P}/${docId}/acknowledgments`), 403);
  });

  await withServer(appFor(hr.user), async (url) => {
    const status = envelope(await get(url, `${P}/${docId}/acknowledgments`));
    assert.ok(status.total >= 2, 'everyone is a target when no role is named');
    assert.equal(status.completed, 1);
    assert.ok(status.acknowledged.some((a) => a.name.includes('Sam')));
    assert.ok(status.outstanding.some((o) => o.name.includes('Hana')));
  });
});

test('a policy people have acknowledged cannot be deleted', async () => {
  const { hr, staff } = await seedOrg();
  let docId;

  await withServer(appFor(hr.user), async (url) => {
    docId = (await publishedPolicy(url)).id;
  });
  await withServer(appFor(staff.user), async (url) => {
    envelope(await post(url, `${P}/${docId}/acknowledge`, {}), 201);
  });

  await withServer(appFor(hr.user), async (url) => {
    errorBody(await del(url, `${P}/${docId}`), 409, 'DOCUMENT_POLICY_ACKNOWLEDGED');
  });
});

test('my pending policies exclude what I have signed and what has expired', async () => {
  const { hr, staff } = await seedOrg();
  let signedId;

  await withServer(appFor(hr.user), async (url) => {
    signedId = (await publishedPolicy(url)).id;

    const second = envelope(await upload(url, { fields: { name: 'Second policy' } }), 201);
    envelope(
      await post(url, `${P}/${second.id}/policy`, {
        requiresAcknowledgment: true,
        effectiveFrom: day(-1),
      }),
      201,
    );
    const gone = envelope(await upload(url, { fields: { name: 'Expired policy' } }), 201);
    envelope(
      await post(url, `${P}/${gone.id}/policy`, {
        requiresAcknowledgment: true,
        effectiveFrom: day(-30),
        expiresAt: day(-2),
      }),
      201,
    );
  });

  await withServer(appFor(staff.user), async (url) => {
    let mine = envelope(await get(url, `${P}/policies/pending`));
    assert.equal(mine.pending, 2, 'two live policies, the expired one excluded');

    envelope(await post(url, `${P}/${signedId}/acknowledge`, {}), 201);
    mine = envelope(await get(url, `${P}/policies/pending`));
    assert.equal(mine.pending, 1);
  });
});

// ===========================================================================
// Search, filter, paging
// ===========================================================================

test('the library is searched, filtered and paged by the SERVER', async () => {
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    for (const name of ['Leave policy', 'Travel policy', 'Handbook']) {
      envelope(await upload(url, { fields: { name, tags: 'hr' } }), 201);
    }

    assert.equal(envelope(await get(url, P)).total, 3);
    assert.equal(envelope(await get(url, `${P}?search=policy`)).total, 2);
    assert.equal(envelope(await get(url, `${P}?search=hr`)).total, 3, 'tags are searched too');
    assert.equal(envelope(await get(url, `${P}?scope=company`)).total, 3);

    const paged = envelope(await get(url, `${P}?pageSize=2`));
    assert.equal(paged.data.length, 2);
    assert.equal(paged.total, 3);
  });
});

test('a search term with regex metacharacters is treated as text', async () => {
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    envelope(await upload(url, { fields: { name: 'A.C policy' } }), 201);
    envelope(await upload(url, { fields: { name: 'ABC policy' } }), 201);

    assert.equal(envelope(await get(url, `${P}?search=A.C`)).total, 1);
    assert.equal(envelope(await get(url, `${P}?search=%28%28%28`)).total, 0);
  });
});

// ===========================================================================
// Audit, envelope, access
// ===========================================================================

test('every document action is audited, and a refused one is not', async () => {
  const { hr, staff } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const folder = envelope(
      await post(url, `${P}/folders`, { name: 'Policies', visibility: 'org' }),
      201,
    );
    const doc = envelope(
      await upload(url, { fields: { name: 'Handbook', folderId: folder.id } }),
      201,
    );
    envelope(
      await post(url, `${P}/${doc.id}/policy`, {
        requiresAcknowledgment: true,
        effectiveFrom: day(-1),
      }),
      201,
    );

    const actions = (await AuditLog.find({}).lean()).map((r) => r.action);
    for (const expected of [
      AUDIT_ACTIONS.DOCUMENT_FOLDER_CREATED,
      AUDIT_ACTIONS.DOCUMENT_UPLOADED,
      AUDIT_ACTIONS.DOCUMENT_POLICY_PUBLISHED,
    ]) {
      assert.ok(actions.includes(expected), `${expected} should be audited`);
    }
  });

  await AuditLog.deleteMany({});
  await withServer(appFor(staff.user), async (url) => {
    errorBody(await post(url, `${P}/folders`, { name: 'Nope', visibility: 'org' }), 403);
    assert.equal(await AuditLog.countDocuments({}), 0);
  });
});

test('no storage key or file bytes reach the audit trail', async () => {
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const doc = envelope(await upload(url, { fields: { name: 'Handbook' } }), 201);
    const stored = await HrmsDocument.findById(doc.id).lean();

    for (const entry of await AuditLog.find({}).lean()) {
      const text = JSON.stringify(entry);
      assert.ok(!text.includes(stored.storageKey), 'the key must not be logged');
      assert.ok(!text.includes('%PDF'), 'the bytes must not be logged');
    }
  });
});

test('every document response uses the standard envelope', async () => {
  const { hr, staff } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const folder = envelope(
      await post(url, `${P}/folders`, { name: 'Policies', visibility: 'org' }),
      201,
    );
    const doc = envelope(await upload(url, { fields: { name: 'Handbook' } }), 201);

    for (const res of [
      await get(url, P),
      await get(url, `${P}/me`),
      await get(url, `${P}/folders`),
      await get(url, `${P}/policies/pending`),
      await get(url, `${P}/${doc.id}`),
      await get(url, `${P}/${doc.id}/url`),
      await patch(url, `${P}/${doc.id}`, { name: 'Handbook v2' }),
      await patch(url, `${P}/folders/${folder.id}`, { name: 'Policies 2026' }),
    ]) {
      assert.equal(res.body.success, true, JSON.stringify(res.body));
      assert.ok('data' in res.body, 'the payload must sit under `data`');
    }
  });
  assert.ok(staff);
});

test('the document list returns a page object under `data`', async () => {
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    envelope(await upload(url, { fields: { name: 'Handbook' } }), 201);
    const page = envelope(await get(url, P));
    assert.ok(Array.isArray(page.data));
    assert.equal(typeof page.total, 'number');
    assert.equal(page.page, 1);
    assert.equal(typeof page.pageSize, 'number');
  });
});

test('AD-4: a Customer reaches no document endpoint', async () => {
  const customer = { _id: oid(), role: 'Customer', roles: [], status: 'Active' };

  await withServer(appFor(customer), async (url) => {
    for (const res of [
      await get(url, P),
      await get(url, `${P}/me`),
      await get(url, `${P}/folders`),
      await get(url, `${P}/policies/pending`),
      await post(url, `${P}/folders`, { name: 'x', visibility: 'org' }),
    ]) {
      assert.ok(res.status === 403 || res.status === 401, `got ${res.status}`);
    }
  });
});

test('an unknown id is a 404, and a malformed one is not a 500', async () => {
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    errorBody(await get(url, `${P}/${oid()}`), 404);
    errorBody(await get(url, `${P}/not-an-id`), 404);
    errorBody(await get(url, `${P}/not-an-id/url`), 404);
    errorBody(await del(url, `${P}/folders/not-an-id`), 404);
  });
});
