/**
 * Org chart data.
 *
 * Ported from the reference's `OrganizationService.getOrgTree`
 * (`organization.service.ts:77-119`). Like the reference this returns a FLAT
 * list and lets the client assemble the tree — the reference's `buildTree` runs
 * in the browser, and keeping the wire shape flat means the layout engine can
 * be ported unchanged.
 *
 * There is no OrgChart collection and there never should be: the chart is a
 * projection of `Employee.reportingManagerId`, and a second copy of the
 * hierarchy is a second thing to keep correct.
 *
 * ---------------------------------------------------------------------------
 * Scope
 * ---------------------------------------------------------------------------
 * Mirrors the reference exactly. Org-wide for anyone holding
 * `employees:view:org` or `org-structure:edit:org`; otherwise the actor's own
 * subtree, found through the denormalised `managerChain` in one indexed query
 * rather than a recursive walk.
 *
 * Note which permission widens it: `org-structure:EDIT:org`, not `view`. A
 * manager holds `org-structure:view:org` and is still correctly limited to
 * their own reports — that is the reference's behaviour and the comment in its
 * matrix ("team hierarchy / org chart visibility") agrees.
 *
 * ---------------------------------------------------------------------------
 * Where this is deliberately safer than the reference
 * ---------------------------------------------------------------------------
 * The reference's client-side `buildTree` does:
 *
 *     if (n.reportingManagerId && map.has(n.reportingManagerId)) attach
 *     else roots.push(node)
 *
 * which means anyone whose manager is missing from the payload — deleted, or
 * simply outside the caller's scope — silently becomes a top-level node. On an
 * org chart that reads as "this person reports to nobody", which is a claim
 * about the company, not a rendering detail.
 *
 * Worse, a genuine cycle (A→B→C→A) leaves every node with a parent, so no node
 * becomes a root and the reference's renderer draws NOTHING — the corruption
 * hides the very people it affects.
 *
 * Both are resolved here, on the server, where the whole set is visible:
 *   - a manager who is not in the payload is reported as `managerOutsideView`
 *     with a null parent, so the client can say "reports to someone not shown"
 *   - a cycle is broken at exactly one node, flagged `managerCycleBroken`, so
 *     everyone still appears and the corrupt edge is visible rather than fatal
 */

import Employee from '../../../models/hrms/Employee.js';
import Department from '../../../models/hrms/Department.js';
import {
  hasHrmsPermission,
} from '../../../shared/permissions/has-permission.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));

/** Fields the chart card actually renders, and nothing else. */
const CHART_FIELDS = '_id firstName lastName designation status reportingManagerId departmentId';

/**
 * Does this actor see the whole organisation?
 *
 * The same two grants the reference checks. Kept as one function so the route
 * guard and the query can never disagree about what "org-wide" means.
 */
export function seesWholeOrg(actor) {
  return (
    hasHrmsPermission(actor, M.EMPLOYEES, A.VIEW, S.ORG) ||
    hasHrmsPermission(actor, M.ORG_STRUCTURE, A.EDIT, S.ORG)
  );
}

/**
 * Break every reporting cycle, at one node each.
 *
 * Iterative DFS with an explicit path, so a corrupt chain cannot recurse into
 * a stack overflow. Where a cycle closes, that node's parent is cleared and it
 * becomes a root — visible and flagged, rather than invisible.
 *
 * @returns {number} how many cycles were broken
 */
function breakCycles(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map(); // id -> 'visiting' | 'done'
  let broken = 0;

  for (const start of nodes) {
    if (state.get(start.id) === 'done') continue;

    const path = [];
    let current = start;

    while (current) {
      const seen = state.get(current.id);
      if (seen === 'done') break;

      if (seen === 'visiting') {
        // The chain has returned to a node still on this path: a cycle. Cut it
        // here so everyone below stays reachable.
        current.reportingManagerId = null;
        current.managerCycleBroken = true;
        broken += 1;
        break;
      }

      state.set(current.id, 'visiting');
      path.push(current);
      current = current.reportingManagerId ? byId.get(current.reportingManagerId) : null;
    }

    for (const node of path) state.set(node.id, 'done');
  }

  return broken;
}

/**
 * The org chart, as a flat list.
 *
 * @param {object} actor the HRMS actor from `attachHrmsActor`
 * @returns {Promise<object[]>}
 */
export async function getOrgChart(actor) {
  const filter = { deletedAt: null };

  if (!seesWholeOrg(actor)) {
    if (!actor?.employeeId) {
      // Permitted to see a team, but not linked to an employee record, so there
      // is no team to anchor on. An empty chart is the truthful answer.
      return [];
    }
    // The actor plus everyone beneath them. `managerChain` is indexed, so this
    // is one lookup rather than a recursive walk per request.
    filter.$or = [{ _id: actor.employeeId }, { managerChain: actor.employeeId }];
  }

  const rows = await Employee.find(filter)
    .select(CHART_FIELDS)
    // The reference sorts by status then first name. `_id` is appended so the
    // order is fully deterministic - two people sharing a status and a first
    // name would otherwise come back in whatever order the storage engine felt
    // like, and the chart would reshuffle between reloads.
    .sort({ status: 1, firstName: 1, _id: 1 })
    .lean();

  if (rows.length === 0) return [];

  // Department names for display. Retired departments are included on purpose:
  // an employee may still be assigned to one, and showing a blank where a name
  // used to be is worse than showing the retired name.
  const departmentIds = [...new Set(rows.map((r) => idStr(r.departmentId)).filter(Boolean))];
  const departments = departmentIds.length
    ? await Department.find({ _id: { $in: departmentIds } }).select('_id name').lean()
    : [];
  const departmentName = new Map(departments.map((d) => [idStr(d._id), d.name]));

  const present = new Set(rows.map((r) => idStr(r._id)));

  const nodes = rows.map((row) => {
    const managerId = idStr(row.reportingManagerId);
    // A manager outside the payload cannot be drawn. Reporting the edge anyway
    // would make the client silently treat this person as top-level.
    const managerVisible = managerId !== null && present.has(managerId);

    return {
      id: idStr(row._id),
      displayName: `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim(),
      designation: row.designation ?? null,
      departmentName: departmentName.get(idStr(row.departmentId)) ?? null,
      status: row.status,
      reportingManagerId: managerVisible ? managerId : null,
      /** Has a manager, but not one in this payload — deleted or out of scope. */
      managerOutsideView: managerId !== null && !managerVisible,
      /** Set when this node's edge was cut to break a reporting cycle. */
      managerCycleBroken: false,
    };
  });

  breakCycles(nodes);

  return nodes;
}

export default { getOrgChart, seesWholeOrg };
