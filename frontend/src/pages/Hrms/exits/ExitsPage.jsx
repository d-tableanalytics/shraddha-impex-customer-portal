import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { MyExitTab } from "./MyExitTab";
import { ExitRequestsTab } from "./ExitRequestsTab";
import { ClearanceQueueTab } from "./ClearanceQueueTab";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Exits.
 *
 * The reference's `ExitsPage` — three tabs, the same audiences:
 *
 *   My exit          everyone: initiate, track, withdraw
 *   Exit requests    HR and reporting managers
 *   Clearance queue  anyone holding a clearance
 *
 * The tab lives in the URL, as it does for Leave and Expenses, so it is
 * linkable and survives a refresh. The reference keeps it in `useParams` too.
 *
 * These gates decide what is OFFERED. Every endpoint behind them re-checks, and
 * both lists are scoped by the server rather than filtered here.
 */

const TAB_KEYS = ["mine", "requests", "clearances"];

export function ExitsPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  const isHr = can(M.EXITS, A.EDIT, S.ORG);
  const isManager = can(M.EXITS, A.APPROVE, S.TEAM);

  const tabs = useMemo(() => {
    const items = [{ key: "mine", label: "My Exit" }];
    if (isHr || isManager) items.push({ key: "requests", label: "Exit Requests" });
    items.push({ key: "clearances", label: "Clearance Queue" });
    return items;
  }, [isHr, isManager]);

  const active = TAB_KEYS.includes(tab) ? tab : "mine";

  if (!tab) return <Navigate to={`${HRMS_ROUTE_PREFIX}/exits/mine`} replace />;

  return (
    <HrmsPageLayout
      title="Exits"
      subtitle="Resignation and offboarding — approval chain, per-area clearances, full and final settlement, and the relieving letter."
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Exits" },
      ]}
    >
      <TabNav
        tabs={tabs}
        activeKey={active}
        onChange={(key) => navigate(`${HRMS_ROUTE_PREFIX}/exits/${key}`)}
        className="mb-5"
      />

      {active === "mine" && <MyExitTab />}
      {active === "requests" && (isHr || isManager) && <ExitRequestsTab />}
      {active === "clearances" && <ClearanceQueueTab />}

      {/*
        A gated tab reached by URL without the grant for it. Rendered as a
        refusal, and — the point of the `&&` guard above — without the tab
        having mounted and fired a request that would only be refused anyway.
      */}
      {active === "requests" && !isHr && !isManager && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          You do not have access to this view. Exit requests are for reporting managers and HR.
        </p>
      )}
    </HrmsPageLayout>
  );
}

export default ExitsPage;
