/**
 * The salary-component formula evaluator.
 *
 * Ported from the reference's `salary-formula.ts`, node for node. A formula is
 * a small JSON AST, never an expression string:
 *
 *   { amount: 15000 }                        a fixed monthly figure
 *   { of: 'BASIC', percent: 40 }             40% of another component
 *   { of: 'BASIC', proportion: 0.4 }         the same, as a decimal
 *   { pct_of_annual: 'CTC', percent: 50 }    a share of annual CTC, monthlyised
 *   { op: 'min'|'max'|'sum'|'sub', args: [] } arithmetic over nested nodes
 *
 * ---------------------------------------------------------------------------
 * Why an AST and not an expression
 * ---------------------------------------------------------------------------
 * The reference states the reason and it is the right one: the surface stays
 * small, there is no `eval()` anywhere near a salary, and every operation is
 * auditable. It is worth restating because a formula is admin-supplied data
 * that decides what people are paid — accepting `"BASIC * 0.4"` would put a
 * parser, and eventually an interpreter, on the far side of an admin text box.
 *
 * Components with `calculationType: 'statutory'` never reach here; they are
 * resolved from the statutory bundle.
 *
 * Pure and dependency-free apart from the rounding rule.
 */

import { round2 } from './money.js';

/**
 * Evaluate one formula node.
 *
 * Unknown or malformed nodes evaluate to 0 rather than throwing. That is the
 * reference's behaviour and it is the right default here too: a payroll run
 * covering two hundred people must not abort because one component carries a
 * typo'd formula. The zero is visible on the payslip as a zero line, which is
 * noticed; an exception mid-run leaves the whole month uncomputed.
 *
 * @param {unknown} node
 * @param {{ monthly: Record<string, number>, annualCtc: number }} context
 *   `monthly` holds component amounts resolved so far, keyed by code.
 * @returns {number}
 */
export function evalFormula(node, context) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return 0;

  const monthly = context?.monthly ?? {};
  const annualCtc = Number(context?.annualCtc) || 0;

  // { amount: 15000 }
  if (typeof node.amount === 'number') return round2(node.amount);

  // { of: 'BASIC', percent: 40 }
  if (typeof node.of === 'string' && typeof node.percent === 'number') {
    return round2((monthly[node.of] ?? 0) * (node.percent / 100));
  }

  // { of: 'BASIC', proportion: 0.4 }
  if (typeof node.of === 'string' && typeof node.proportion === 'number') {
    return round2((monthly[node.of] ?? 0) * node.proportion);
  }

  // { pct_of_annual: 'CTC', percent: 50 } — a share of the ANNUAL figure,
  // divided back down to a month. Only 'CTC' is meaningful; any other name
  // falls back to a monthly component so a mistyped key is a zero, not a throw.
  if (typeof node.pct_of_annual === 'string' && typeof node.percent === 'number') {
    const base = node.pct_of_annual === 'CTC' ? annualCtc : (monthly[node.pct_of_annual] ?? 0);
    return round2((base * node.percent) / 100 / 12);
  }

  // { op: 'min', args: [ ... ] }
  if (typeof node.op === 'string' && Array.isArray(node.args)) {
    const values = node.args.map((arg) => evalFormula(arg, context));
    if (values.length === 0) return 0;
    switch (node.op) {
      case 'min':
        return round2(Math.min(...values));
      case 'max':
        return round2(Math.max(...values));
      case 'sum':
        return round2(values.reduce((a, b) => a + b, 0));
      case 'sub':
        return round2(values.slice(1).reduce((a, b) => a - b, values[0]));
      default:
        return 0;
    }
  }

  return 0;
}

/**
 * Is this a formula the evaluator recognises?
 *
 * Used by the component schema to refuse a malformed formula AT THE BOUNDARY
 * rather than storing one that silently evaluates to zero on payday. The
 * reference has no such check — its `formulaSchema` is
 * `z.record(z.string(), z.unknown())`, so any object at all is accepted and the
 * mistake only surfaces as an unexplained ₹0 line weeks later.
 *
 * An EMPTY formula is valid: a statutory component carries `{}`, and so does a
 * structure component that takes its calculation from the structure rather than
 * from the component definition.
 */
export function isValidFormula(node) {
  if (node === null || node === undefined) return true;
  if (typeof node !== 'object' || Array.isArray(node)) return false;
  if (Object.keys(node).length === 0) return true;

  if (typeof node.amount === 'number') return Number.isFinite(node.amount);
  if (typeof node.of === 'string') {
    if (typeof node.percent === 'number') return Number.isFinite(node.percent);
    if (typeof node.proportion === 'number') return Number.isFinite(node.proportion);
    return false;
  }
  if (typeof node.pct_of_annual === 'string') return typeof node.percent === 'number';
  if (typeof node.op === 'string') {
    if (!['min', 'max', 'sum', 'sub'].includes(node.op)) return false;
    if (!Array.isArray(node.args) || node.args.length === 0) return false;
    return node.args.every(isValidFormula);
  }
  return false;
}

/**
 * Component codes a formula depends on.
 *
 * Lets the structure service refuse a component that references one the
 * structure does not contain — which in the reference evaluates to zero and
 * quietly underpays. Recursive, so nested `op` nodes are covered.
 */
export function formulaDependencies(node, found = new Set()) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return found;
  if (typeof node.of === 'string') found.add(node.of);
  if (typeof node.pct_of_annual === 'string' && node.pct_of_annual !== 'CTC') {
    found.add(node.pct_of_annual);
  }
  if (Array.isArray(node.args)) for (const arg of node.args) formulaDependencies(arg, found);
  return found;
}

export default { evalFormula, isValidFormula, formulaDependencies };
