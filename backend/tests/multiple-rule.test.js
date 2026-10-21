/**
 * The Multiple rule (formerly "MOQ"): a non-MSIL customer books a product in
 * multiples of its Multiple. Decided 2026-10-19; before then it was a minimum.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { moqError, enforceMoq } from '../utils/moq.js';

const customer = { role: 'Customer', email: 'buyer@acme.com' };
const product = { skuCode: 'SKU-1', moq: 10 };

describe('Multiple', () => {
  test('multiples are allowed', () => {
    for (const q of [10, 20, 30, 500]) assert.equal(moqError(customer, product, q), null, `${q}`);
  });

  test('anything else is refused, with the reason and examples', () => {
    for (const q of [1, 9, 15, 25]) {
      assert.equal(moqError(customer, product, q), 'Quantity must be a multiple of 10 for SKU-1 (e.g. 10, 20, 30).', `${q}`);
    }
    assert.throws(() => enforceMoq(customer, product, 15), /multiple of 10/);
  });

  test('a Multiple of 0 or 1 restricts nothing', () => {
    assert.equal(moqError(customer, { moq: 1 }, 7), null);
    assert.equal(moqError(customer, { moq: 0 }, 7), null);
  });

  test('MSIL customers, company staff and SKIP accounts are exempt, as before', () => {
    assert.equal(moqError({ customerCategory: 'MSIL', email: 'x@maruti.com' }, product, 3), null);
    assert.equal(moqError({ email: 'desk@shraddhaimpex.net' }, product, 3), null);
    assert.equal(moqError({ email: 'x@acme.com', moq: 'SKIP' }, product, 3), null);
  });
});
