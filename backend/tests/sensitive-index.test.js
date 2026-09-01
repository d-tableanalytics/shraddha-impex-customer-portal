/**
 * Blind-index uniqueness (AD-10).
 *
 * A regression test for a defect found while building Org Structure, the first
 * time HRMS code ran against a real database rather than schema assertions.
 *
 * The plugin declared the blind index `{ unique: true, sparse: true }` with the
 * comment "null must not collide". `sparse` excludes documents where the path
 * is MISSING, but the path has `default: null`, so every employee carried it
 * present and null. The second employee without a PAN collided with the first
 * and could not be created — which is to say, the product could hold exactly
 * one employee whose PAN had not been captured.
 *
 * These need a real MongoDB: the whole behaviour lives in the index.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import Employee from '../models/hrms/Employee.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

before(async () => {
  await startTestMongo();
  await syncIndexes(Employee);
});

after(async () => {
  await stopTestMongo();
});

beforeEach(clearCollections);

let n = 0;
const makeEmployee = async (pan) => {
  n += 1;
  const doc = new Employee({
    employeeCode: `SI-${String(n).padStart(4, '0')}`,
    userId: new mongoose.Types.ObjectId(),
    firstName: 'Test',
    lastName: `Person${n}`,
    dateOfJoining: new Date(),
  });
  if (pan !== undefined) await doc.setSensitive('panNumber', pan);
  await doc.save();
  return doc;
};

test('two employees without a PAN can both exist', async () => {
  // The regression. Most employees are created before their PAN is collected,
  // so this is the ordinary case, not an edge one.
  await makeEmployee();
  await makeEmployee();
  await makeEmployee();

  assert.equal(await Employee.countDocuments({}), 3);
});

test('two employees still cannot share a PAN', async () => {
  // The constraint the index exists for has to survive the fix.
  await makeEmployee('ABCDE1234F');
  await assert.rejects(() => makeEmployee('ABCDE1234F'), (e) => e.code === 11000);
});

test('different PANs coexist', async () => {
  await makeEmployee('ABCDE1234F');
  await makeEmployee('ZYXWV9876K');
  assert.equal(await Employee.countDocuments({}), 2);
});

test('clearing a PAN does not collide with another cleared one', async () => {
  // setSensitive(null) writes an explicit null rather than unsetting the path,
  // so this is the exact shape `sparse` failed to exclude.
  const a = await makeEmployee('ABCDE1234F');
  const b = await makeEmployee('ZYXWV9876K');

  await a.setSensitive('panNumber', null);
  await a.save();
  await b.setSensitive('panNumber', null);
  await b.save();

  assert.equal(await Employee.countDocuments({}), 2);
});

test('a freed PAN can be taken by someone else', async () => {
  const a = await makeEmployee('ABCDE1234F');
  await a.setSensitive('panNumber', null);
  await a.save();

  await makeEmployee('ABCDE1234F');
  assert.equal(await Employee.countDocuments({}), 2);
});

test('the index is partial on $type, not sparse', async () => {
  // Asserted on the live collection, because a schema-level assertion would
  // not have caught the original defect either.
  const indexes = await Employee.collection.indexes();
  const blind = indexes.find((i) => i.name?.startsWith('panNumberIdx'));

  assert.ok(blind, 'the blind index must exist');
  assert.equal(blind.unique, true);
  assert.deepEqual(blind.partialFilterExpression, { panNumberIdx: { $type: 'string' } });
  assert.notEqual(blind.sparse, true, 'sparse does not exclude an explicit null');
});
