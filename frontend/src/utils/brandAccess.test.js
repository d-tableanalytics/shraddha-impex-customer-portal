import { describe, test, expect, beforeEach } from 'vitest';

import { setBrandRegistry, allBrands, allowedBrands, canAccessBrand, defaultBrand } from './brandAccess';

const BUILT_IN = [
  { name: 'Koken', key: 'koken', hiddenFromMsil: false },
  { name: 'BIX', key: 'bix', hiddenFromMsil: false },
  { name: 'IMADA', key: 'imada', hiddenFromMsil: true },
];

describe('brandAccess (UI mirror)', () => {
  beforeEach(() => setBrandRegistry(BUILT_IN));

  test('a brand from /auth/me reaches every dropdown that calls allowedBrands', () => {
    setBrandRegistry([...BUILT_IN, { name: 'Stanley', key: 'stanley', hiddenFromMsil: false }]);
    expect(allBrands()).toEqual(['Koken', 'BIX', 'IMADA', 'Stanley']);
    expect(allowedBrands({ role: 'Customer', brandAccess: { stanley: true } })).toEqual(['Stanley']);
    expect(canAccessBrand({ role: 'Customer', brandAccess: { stanley: true } }, 'stanley')).toBe(true);
    expect(defaultBrand({ role: 'Customer', brandAccess: { stanley: true } })).toBe('stanley');
  });

  test('admins and inventory staff see every brand, as the server serves them', () => {
    setBrandRegistry([...BUILT_IN, { name: 'Stanley', key: 'stanley' }]);
    expect(allowedBrands({ role: 'Inventory Manager', brandAccess: {} })).toContain('Stanley');
  });

  test('hiddenFromMsil applies to MSIL customers only', () => {
    setBrandRegistry([...BUILT_IN, { name: 'Taparia', key: 'taparia', hiddenFromMsil: true }]);
    const access = { koken: true, imada: true, taparia: true };
    expect(allowedBrands({ role: 'Customer', customerCategory: 'MSIL', brandAccess: access })).toEqual(['Koken']);
    expect(allowedBrands({ role: 'Customer', brandAccess: access })).toEqual(['Koken', 'IMADA', 'Taparia']);
  });

  test('a response without a brand list leaves the current one alone', () => {
    setBrandRegistry(undefined);
    setBrandRegistry(null);
    expect(allBrands()).toEqual(['Koken', 'BIX', 'IMADA']);
  });

  test('an EMPTY list is taken as it is — the next sign-in never keeps the previous brands', () => {
    setBrandRegistry([]);
    expect(allBrands()).toEqual([]);
    setBrandRegistry([{ nope: true }]);
    expect(allBrands()).toEqual([]);
  });

  test('an inherited property name never reads as a granted brand', () => {
    setBrandRegistry([...BUILT_IN, { name: 'Constructor', key: 'constructor' }]);
    expect(allowedBrands({ role: 'Customer', brandAccess: {} })).toEqual([]);
  });
});

describe('canAccessBrand accepts a brand by name or key', () => {
  test('multi-word brand', () => {
    setBrandRegistry([...BUILT_IN, { name: 'Stanley Tools', key: 'stanleytools' }]);
    const u = { role: 'Customer', brandAccess: { stanleytools: true } };
    for (const spelling of ['Stanley Tools', 'stanley tools', 'stanleytools']) {
      expect(canAccessBrand(u, spelling)).toBe(true);
    }
    expect(canAccessBrand(u, 'koken')).toBe(false);
  });
});
