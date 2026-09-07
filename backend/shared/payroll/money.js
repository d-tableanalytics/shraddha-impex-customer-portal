/**
 * Payroll money arithmetic.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists at all
 * ---------------------------------------------------------------------------
 * AD-2 forbids JavaScript `Number` for persisted monetary values, and the brief
 * forbids reaching for `Math.round()` as an unnamed stand-in for a payroll
 * rounding rule. Both are about the same failure: money handled by whatever
 * arithmetic happened to be nearby.
 *
 * The split this file draws:
 *
 *   IN THE ENGINE   ordinary numbers, rounded to 2dp after every step. A
 *                   monthly salary line is at most eight digits, so it sits far
 *                   inside the 2^53 integer range where doubles are exact; the
 *                   rounding after each step is what stops 0.1 + 0.2 style
 *                   drift accumulating across forty components.
 *
 *   AT THE BOUNDARY `toDecimalString` hands the persistence layer a STRING,
 *                   which Mongoose turns into a Decimal128. A float never
 *                   reaches the database, and a value read back is exact.
 *
 * That is the same shape `shared/validation/common.js#money` already uses for
 * the wire format, for the same reason.
 *
 * Dependency-free — this is imported by the browser as well as the server.
 */

import { MONEY_DECIMAL_PLACES } from '../constants/payroll.js';

const FACTOR = 10 ** MONEY_DECIMAL_PLACES;

/**
 * Round to 2 decimal places, half AWAY FROM ZERO.
 *
 * `Math.round` alone is half-UP, which is asymmetric about zero: it takes
 * -0.5 to -0 but +0.5 to +1. Payroll has negative amounts — a negative
 * adjustment, a rollback of an overpayment — and rounding them by a different
 * rule than positive ones means a correction does not cancel the thing it
 * corrects. Rounding the magnitude and reapplying the sign is symmetric.
 *
 * The `Number.EPSILON` nudge handles the representation edge: 1.005 is stored
 * as 1.00499999999999989, so a naive `Math.round(1.005 * 100)` gives 100, not
 * 101. Scaling by (1 + EPSILON) before rounding recovers the intended value
 * without disturbing anything that was not already on a boundary.
 */
export function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n === 0) return 0;
  const sign = n < 0 ? -1 : 1;
  const magnitude = Math.abs(n);
  return (sign * Math.round(magnitude * FACTOR * (1 + Number.EPSILON))) / FACTOR;
}

/**
 * Round UP to the whole rupee.
 *
 * ESI's own rule: ESIC requires each side's contribution to be rounded up to
 * the next rupee, so an employee share of ₹112.35 is remitted as ₹113. Named
 * rather than inlined so the one place it is correct is obvious, and so it
 * cannot spread to components where it would simply be wrong.
 */
export const ceilRupee = (value) => Math.ceil(Number(value) || 0);

/** Round to the whole rupee. Professional Tax is a flat rupee amount per slab. */
export const roundRupee = (value) => Math.round(Number(value) || 0);

/**
 * Sum a list under the payroll rounding rule.
 *
 * Rounds ONCE at the end rather than after every addition. Each input is
 * already a rounded 2dp line amount, so the sum is exact and the final round
 * only removes any residue from the addition itself.
 */
export const sumMoney = (values = []) =>
  round2(values.reduce((total, v) => total + (Number(v) || 0), 0));

/**
 * The string a Decimal128 field is built from.
 *
 * ALWAYS a string, never a number: `Decimal128.fromString('1234.56')` is exact,
 * while handing the driver a double reintroduces the float this whole file
 * exists to keep out of the database.
 */
export const toDecimalString = (value) => round2(value).toFixed(MONEY_DECIMAL_PLACES);

/**
 * A Decimal128 (or anything) read back as a number for arithmetic.
 *
 * Safe in the direction it is used: values come out of the database already
 * rounded to 2dp and within the exact-integer range once scaled, so the
 * conversion loses nothing. The rule is that money is a Decimal at REST and a
 * number only inside a calculation.
 */
export const fromDecimal = (value) => {
  if (value === null || value === undefined) return 0;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : 0;
};

export default { round2, ceilRupee, roundRupee, sumMoney, toDecimalString, fromDecimal };
