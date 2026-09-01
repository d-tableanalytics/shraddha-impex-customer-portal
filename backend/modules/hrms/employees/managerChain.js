/**
 * Reporting hierarchy: deriving `managerChain`, and refusing cycles.
 *
 * `reportingManagerId` is the source of truth. `managerChain` is a
 * denormalisation of it — [directManager, skipLevel, …], nearest first — and is
 * never accepted from a caller or an import (AD-11).
 *
 * It exists because every `team`-scope permission check asks "is the actor
 * anywhere above this employee". With the chain that is one indexed array
 * lookup; without it, a recursive walk on every request.
 *
 * ---------------------------------------------------------------------------
 * The reference has NO cycle detection — this is a deliberate correction
 * ---------------------------------------------------------------------------
 * Its `computeManagerChain` prepends the manager id to the manager's chain and
 * returns. Given A→B, B→C, C→A it would build a chain from whatever partial
 * state happened to be stored, and `rebuildDescendantChains` — which walks the
 * tree top-down assuming a tree — would not terminate on a real cycle.
 *
 * A cycle is not a cosmetic problem. `managerChain` decides who may read
 * someone's salary and approve their leave, so a corrupt chain is an
 * authorization fault. Every path that can change a manager therefore goes
 * through `assertNoCycle` first.
 */

import Employee from '../../../models/hrms/Employee.js';
import { HrmsConflictError, HrmsValidationError } from '../hrms.errors.js';

/**
 * Depth ceiling.
 *
 * A guard against a cycle that already exists in the data — from a direct
 * database edit, or a bug predating this check. Without it, a corrupt row would
 * turn a walk into an infinite loop inside a request. No real org chart is
 * anywhere near this deep.
 */
export const MAX_CHAIN_DEPTH = 100;

const idStr = (v) => (v === null || v === undefined ? null : String(v));

/**
 * Walk up from `startId`, returning the ancestor ids nearest-first.
 *
 * Stops and throws if it revisits a node, so a pre-existing cycle surfaces as a
 * clear error rather than a hang.
 *
 * @param {string|null} startId
 * @param {object} [options]
 * @param {Map<string,string|null>} [options.overrides] pending manager changes
 *        not yet written, so a proposed edit can be validated before it is saved
 * @param {Function} [options.getParent] resolves an id to its manager id.
 *        Injectable so the cycle rules can be tested against an in-memory graph
 *        — the reference has no cycle detection at all, so these rules are new
 *        code and need to be verifiable without a database.
 * @returns {Promise<string[]>}
 */
export async function walkUp(startId, { overrides = new Map(), getParent = dbParent } = {}) {
  const chain = [];
  const seen = new Set();
  let current = idStr(startId);

  while (current) {
    if (seen.has(current)) {
      throw new HrmsConflictError(
        `The reporting line contains a cycle at employee ${current}.`,
        { code: 'MANAGER_CYCLE' },
      );
    }
    seen.add(current);
    chain.push(current);

    if (chain.length > MAX_CHAIN_DEPTH) {
      throw new HrmsConflictError(
        `The reporting line is deeper than ${MAX_CHAIN_DEPTH} levels, which almost certainly means the data is corrupt.`,
        { code: 'MANAGER_CHAIN_TOO_DEEP' },
      );
    }

    if (overrides.has(current)) {
      current = idStr(overrides.get(current));
      continue;
    }

    current = await getParent(current);
  }

  return chain;
}

/** The default parent resolver: one indexed lookup, one field. */
async function dbParent(id) {
  const row = await Employee.findOne({ _id: id, deletedAt: null })
    .select('reportingManagerId')
    .lean();
  return row ? idStr(row.reportingManagerId) : null;
}

/**
 * Refuse a manager assignment that would create a cycle.
 *
 * Three ways it can go wrong, and all three are caught:
 *   - reporting to yourself
 *   - reporting to one of your own descendants
 *   - a longer loop, A→B→C→A
 *
 * @param {string} employeeId          the employee being changed
 * @param {string|null} newManagerId
 */
export async function assertNoCycle(employeeId, newManagerId, options = {}) {
  const self = idStr(employeeId);
  const manager = idStr(newManagerId);

  if (!manager) return; // top of the org: no chain, no cycle

  if (manager === self) {
    throw new HrmsConflictError('An employee cannot report to themselves.', {
      code: 'MANAGER_SELF_REFERENCE',
    });
  }

  // Walk up from the PROPOSED manager. If we reach the employee, the employee
  // is already above them — so making them the manager closes a loop.
  const ancestors = await walkUp(manager, options);
  if (ancestors.includes(self)) {
    throw new HrmsConflictError(
      'That would create a reporting cycle: the chosen manager already reports to this employee, directly or indirectly.',
      { code: 'MANAGER_CYCLE' },
    );
  }
}

/**
 * The chain an employee should have, given a manager.
 *
 * Call `assertNoCycle` first: this trusts that the assignment is already known
 * to be safe, and `walkUp` is its own last line of defence.
 *
 * @returns {Promise<string[]>} ancestor ids, nearest first. Empty at top of org.
 */
export async function computeManagerChain(newManagerId, options = {}) {
  if (!newManagerId) return [];
  return walkUp(newManagerId, options);
}

/**
 * Rewrite `managerChain` for everyone below `rootId`.
 *
 * When someone's own chain changes, every descendant inherits a new prefix.
 * Skipping this is the classic silent RBAC bug: a stale chain means a manager
 * quietly stops being able to see or approve for their reports.
 *
 * Breadth-first, one query per level rather than one per employee, so the cost
 * is the DEPTH of the tree — a handful of round trips at any realistic size.
 *
 * @param {string} rootId
 * @param {object} [options]
 * @param {import('mongoose').ClientSession|null} [options.session]
 * @returns {Promise<number>} how many descendants were rewritten
 */
export async function rebuildDescendantChains(rootId, { session = null } = {}) {
  const root = await Employee.findOne({ _id: rootId, deletedAt: null })
    .select('managerChain')
    .session(session)
    .lean();
  if (!root) return 0;

  // Each node's chain, cached as it is computed, so a child never re-walks its
  // parent's line.
  const chainOf = new Map([[idStr(rootId), (root.managerChain ?? []).map(idStr)]]);

  let frontier = [idStr(rootId)];
  const visited = new Set(frontier);
  let updated = 0;
  let depth = 0;

  while (frontier.length > 0) {
    if (depth++ > MAX_CHAIN_DEPTH) {
      throw new HrmsConflictError(
        'Reporting tree is deeper than expected while rebuilding chains; the data may contain a cycle.',
        { code: 'MANAGER_CHAIN_TOO_DEEP' },
      );
    }

    const children = await Employee.find({
      reportingManagerId: { $in: frontier },
      deletedAt: null,
    })
      .select('_id reportingManagerId')
      .session(session)
      .lean();

    if (children.length === 0) break;

    const next = [];
    const writes = [];

    for (const child of children) {
      const childId = idStr(child._id);
      // A cycle would bring us back to a node already handled. Refuse rather
      // than loop: the caller's assertNoCycle should have prevented this, so
      // reaching here means the stored data is already corrupt.
      if (visited.has(childId)) {
        throw new HrmsConflictError(
          `Reporting cycle detected while rebuilding chains at employee ${childId}.`,
          { code: 'MANAGER_CYCLE' },
        );
      }
      visited.add(childId);

      const parentId = idStr(child.reportingManagerId);
      const parentChain = chainOf.get(parentId) ?? [];
      const chain = parentId ? [parentId, ...parentChain] : [];
      chainOf.set(childId, chain);

      writes.push({
        updateOne: { filter: { _id: child._id }, update: { $set: { managerChain: chain } } },
      });
      next.push(childId);
    }

    if (writes.length > 0) {
      await Employee.bulkWrite(writes, session ? { session } : {});
      updated += writes.length;
    }
    frontier = next;
  }

  return updated;
}

/**
 * Recompute every chain from scratch.
 *
 * Used by the import pipeline's third pass (AD-11), and available as a repair
 * for data written before this module existed. Starts from the roots and works
 * down, so a node is only ever computed after its parent.
 *
 * @returns {Promise<number>} how many employees were rewritten
 */
export async function rebuildAllManagerChains({ session = null } = {}) {
  const roots = await Employee.find({
    deletedAt: null,
    $or: [{ reportingManagerId: null }, { reportingManagerId: { $exists: false } }],
  })
    .select('_id')
    .session(session)
    .lean();

  // Roots have an empty chain by definition; write it so a previously-wrong
  // value cannot survive a rebuild.
  if (roots.length > 0) {
    await Employee.bulkWrite(
      roots.map((r) => ({
        updateOne: { filter: { _id: r._id }, update: { $set: { managerChain: [] } } },
      })),
      session ? { session } : {},
    );
  }

  let updated = roots.length;
  for (const root of roots) {
    updated += await rebuildDescendantChains(root._id, { session });
  }

  // An employee not reached from any root is in a cycle — it has a manager, but
  // no path up to a top-level node. Reported rather than left half-rebuilt.
  const total = await Employee.countDocuments({ deletedAt: null }).session(session);
  if (updated < total) {
    throw new HrmsValidationError(
      `${total - updated} employee(s) are not reachable from any top-level manager, which means the reporting data contains a cycle.`,
      { unreachable: total - updated },
    );
  }

  return updated;
}

export default {
  walkUp,
  assertNoCycle,
  computeManagerChain,
  rebuildDescendantChains,
  rebuildAllManagerChains,
  MAX_CHAIN_DEPTH,
};
