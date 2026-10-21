/**
 * What a new SKU created by an inventory import must state.
 *
 * Only Brand and Available Stock are mandatory (decided 2026-10-19); MOQ, Lead
 * Time, Safety Factor and Box Number are optional — blank means "not set" —
 * but anything that IS given must still be a valid value.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseNewSkuDetails, isNewSkuComplete, incompleteNewSkus, NEW_SKU_FIELDS,
} from '../modules/inventory/newSku.rules.js';

describe('new SKU details', () => {
  test('Brand and Available Stock alone are enough', () => {
    const { ok, values } = parseNewSkuDetails({ brand: 'Koken', availableStock: '25' });
    assert.equal(ok, true);
    assert.deepEqual(values, {
      brand: 'Koken', availableStock: 25, moq: null, leadTime: null, safetyFactor: null, boxNo: null,
    });
    assert.equal(isNewSkuComplete({ brand: 'Koken', availableStock: 0 }), true, 'zero stock is a real answer');
  });

  test('Brand and Available Stock are still required', () => {
    const { ok, problems } = parseNewSkuDetails({ moq: '10', leadTime: '45', safetyFactor: '1.2', boxNo: 'B-12' });
    assert.equal(ok, false);
    assert.deepEqual(Object.keys(problems).sort(), ['availableStock', 'brand']);
    assert.equal(isNewSkuComplete({ brand: 'Koken' }), false);
  });

  test('an optional field that is filled in must still be valid', () => {
    const { problems } = parseNewSkuDetails({
      brand: 'Koken', availableStock: '5', moq: '0', leadTime: 'soon', safetyFactor: '-1',
    });
    assert.deepEqual(problems, {
      moq: 'Multiple must be 1 or more',
      leadTime: 'Lead Time "soon" is not a number',
      safetyFactor: 'Safety Factor must be greater than 0',
    });
  });

  test('all four optional values are kept when given', () => {
    const { ok, values } = parseNewSkuDetails({
      brand: 'BIX', availableStock: '3', moq: '10', leadTime: '45', safetyFactor: '1.2', boxNo: ' B-12 ',
    });
    assert.equal(ok, true);
    assert.deepEqual(values, { brand: 'BIX', availableStock: 3, moq: 10, leadTime: 45, safetyFactor: 1.2, boxNo: 'B-12' });
  });

  test('the import is held only for SKUs missing a mandatory field', () => {
    const list = [
      { skuCode: 'A', brand: 'Koken', availableStock: 4, moq: null, leadTime: null, safetyFactor: null, boxNo: null },
      { skuCode: 'B', brand: null, availableStock: 4 },
      { skuCode: 'C', brand: 'Koken', availableStock: null },
    ];
    assert.deepEqual(incompleteNewSkus(list).map((s) => s.skuCode), ['B', 'C']);
  });

  test('the field list marks exactly two as required', () => {
    assert.deepEqual(NEW_SKU_FIELDS.filter((f) => f.required).map((f) => f.field), ['brand', 'availableStock']);
  });
});
