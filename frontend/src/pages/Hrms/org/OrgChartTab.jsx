import { useCallback, useEffect, useMemo, useState } from "react";
import { CornerLeftUp, Unlink } from "lucide-react";

import { ErrorState } from "../../../components/hrms/ErrorState";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Badge } from "../../../components/ui/Badge";
import { LoadingSpinner } from "../../../components/ui/LoadingSpinner";
import { orgChartApi, HrmsApiError } from "../../../services/hrms";
import {
  buildForest,
  layoutForest,
  edgePath,
  initialsOf,
  CARD_W,
  CARD_H,
} from "./orgLayout";

/**
 * Org Chart.
 *
 * One request to `GET /hrms/org/tree`, which returns a FLAT list; the tree is
 * assembled here, exactly as the reference does it. No request per node, no
 * per-node department or employee lookup, no polling — the endpoint already
 * carries every field a card renders.
 *
 * ---------------------------------------------------------------------------
 * The server owns the truth; this only draws it
 * ---------------------------------------------------------------------------
 * Scope, cycle-breaking and dangling managers are all decided server-side and
 * arrive resolved. Nothing here recomputes who may be seen, and nothing invents
 * a relationship the payload does not state:
 *
 *   managerOutsideView  the person HAS a manager, who is not in this payload —
 *                       deleted, or outside the caller's scope. The reference
 *                       would render them as top-level, which reads as "reports
 *                       to nobody". They are drawn as a root and labelled.
 *
 *   managerCycleBroken  the server cut one edge of a reporting cycle so nobody
 *                       vanished. The cut is shown rather than hidden.
 *
 * The reference's chart has no click-through and no expand/collapse — cards are
 * `cursor: default` with a hover shadow — so neither is added here.
 */

const STATUS_LABEL = {
  invited: "Invited",
  probation: "Probation",
  active: "Active",
  notice: "Notice",
  exited: "Exited",
};

/** A single person. Presentational; every value is already resolved. */
function OrgCard({ card }) {
  const { node, left, top } = card;

  const detail = [node.designation, node.departmentName].filter(Boolean).join(" · ");
  const label = [
    node.displayName,
    detail,
    node.status !== "active" ? STATUS_LABEL[node.status] ?? node.status : null,
    node.managerOutsideView ? "reports to someone not shown here" : null,
    node.managerCycleBroken ? "reporting line contains a cycle" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      role="group"
      aria-label={label}
      style={{ left, top, width: CARD_W, minHeight: CARD_H }}
      className="absolute flex flex-col items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-center shadow-sm transition-shadow hover:shadow-md"
    >
      <div
        aria-hidden="true"
        className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-600 text-[11px] font-bold text-white"
      >
        {initialsOf(node.displayName)}
      </div>

      <span className="text-[13px] font-semibold leading-tight text-slate-900 break-words">
        {node.displayName}
      </span>

      {node.designation && (
        <span className="text-[11px] leading-tight text-slate-500">{node.designation}</span>
      )}

      {node.departmentName && (
        <Badge variant="primary" className="mt-0.5 px-1.5 py-0 text-[10px]">
          {node.departmentName}
        </Badge>
      )}

      {/* The reference shows a status tag only when the status is not active. */}
      {node.status !== "active" && (
        <Badge
          variant={node.status === "probation" ? "warning" : "neutral"}
          className="mt-0.5 px-1.5 py-0 text-[10px]"
        >
          {STATUS_LABEL[node.status] ?? node.status}
        </Badge>
      )}

      {/* Text as well as an icon: colour alone must not carry the meaning. */}
      {node.managerOutsideView && (
        <span
          className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-medium text-slate-400"
          title="Their manager is outside what you can see"
        >
          <CornerLeftUp size={10} aria-hidden="true" />
          Manager not shown
        </span>
      )}

      {node.managerCycleBroken && (
        <span
          className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-medium text-error-600"
          title="The stored reporting line loops back on itself; one link was ignored so everyone stays visible"
        >
          <Unlink size={10} aria-hidden="true" />
          Reporting loop
        </span>
      )}
    </div>
  );
}

export function OrgChartTab() {
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setNodes(await orgChartApi.tree());
    } catch (err) {
      setError(err instanceof HrmsApiError ? err : new HrmsApiError(err.message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const { cards, edges, width, height, detached } = useMemo(() => {
    const forest = buildForest(nodes);
    return { ...layoutForest(forest.roots), detached: forest.detached };
  }, [nodes]);

  if (loading) {
    return (
      <div className="flex min-h-[260px] items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (error) {
    // A 403 is NOT an empty organisation, and must never be shown as one.
    return (
      <ErrorState
        variant={error.isForbidden ? "forbidden" : error.isNotImplemented ? "unavailable" : "error"}
        description={
          error.isForbidden
            ? "Viewing the reporting hierarchy needs org-wide access or a team of your own."
            : error.message
        }
        onRetry={error.isForbidden ? undefined : load}
      />
    );
  }

  if (nodes.length === 0) {
    return (
      <EmptyState
        title="No hierarchy to show"
        description="No employee records are visible to you yet, so there is no reporting structure to draw."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-slate-500">
        Reporting lines come from each employee&apos;s manager. Everyone you can see is drawn;
        people whose manager is outside your view appear at the top.
      </p>

      {detached > 0 && (
        <p className="text-xs font-medium text-error-600">
          {detached} employee{detached === 1 ? "" : "s"} could not be placed under a manager and
          {detached === 1 ? " is" : " are"} shown at the top level.
        </p>
      )}

      {/*
        Scrolls in both directions rather than shrinking the cards: an org chart
        that fits by becoming unreadable has not fitted.
      */}
      <div className="w-full overflow-auto rounded-xl border border-slate-200 bg-slate-50">
        <div className="relative" style={{ width, height, minWidth: "100%" }}>
          {/*
            `data-org-edges` so a test can count connectors without also
            counting the paths inside every icon on the page.
          */}
          <svg
            aria-hidden="true"
            data-org-edges=""
            width={width}
            height={height}
            className="pointer-events-none absolute inset-0 overflow-visible"
          >
            {edges.map((edge) => (
              <path
                key={edge.key}
                d={edgePath(edge)}
                fill="none"
                strokeWidth={2}
                className="stroke-slate-300"
              />
            ))}
          </svg>

          {cards.map((card) => (
            <OrgCard key={card.node.id} card={card} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default OrgChartTab;
