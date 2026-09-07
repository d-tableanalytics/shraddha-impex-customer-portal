import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { MyLeaveTab } from "./MyLeaveTab";
import { ApprovalsTab } from "./ApprovalsTab";
import { LeaveCalendarTab } from "./LeaveCalendarTab";
import { HolidaysTab } from "./HolidaysTab";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Leave.
 *
 * One page, four tabs, the tab in the URL — the reference's shape, with the tab
 * moved into the path so it is linkable and survives a refresh (its own
 * `LeavePage` keeps the tab in local state, which loses both).
 *
 * ---------------------------------------------------------------------------
 * Which tabs exist depends on the viewer
 * ---------------------------------------------------------------------------
 * Exactly as the reference decides it:
 *
 *   My Leave    everyone — the self-service baseline
 *   Approvals   anyone who can approve, at team or org scope
 *   Calendar    anyone who can see beyond themselves
 *   Holidays    everyone; reading the calendar is part of the leave baseline
 *
 * These gates decide what is OFFERED. Every endpoint behind them re-checks, and
 * the request list is scoped by the server rather than filtered here.
 */

const TAB_KEYS = ["me", "approvals", "calendar", "holidays"];

export function LeavePage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  const canApprove =
    can(M.LEAVE, A.APPROVE, S.TEAM) || can(M.LEAVE, A.APPROVE, S.ORG);
  const seesOthers = can(M.LEAVE, A.VIEW, S.TEAM) || can(M.LEAVE, A.VIEW, S.ORG);

  const tabs = useMemo(() => {
    const items = [{ key: "me", label: "My Leave" }];
    if (canApprove) items.push({ key: "approvals", label: "Approvals" });
    if (seesOthers) items.push({ key: "calendar", label: "Team Calendar" });
    items.push({ key: "holidays", label: "Holidays" });
    return items;
  }, [canApprove, seesOthers]);

  const active = TAB_KEYS.includes(tab) ? tab : "me";

  if (!tab) return <Navigate to={`${HRMS_ROUTE_PREFIX}/leave/me`} replace />;

  return (
    <HrmsPageLayout
      title="Leave"
      subtitle="Request time off, track your balance and see who is away."
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Leave" },
      ]}
    >
      <TabNav
        tabs={tabs}
        activeKey={active}
        onChange={(key) => navigate(`${HRMS_ROUTE_PREFIX}/leave/${key}`)}
        className="mb-5"
      />

      {active === "me" && <MyLeaveTab />}
      {active === "approvals" && canApprove && <ApprovalsTab />}
      {active === "calendar" && seesOthers && <LeaveCalendarTab />}
      {active === "holidays" && <HolidaysTab />}

      {/*
        A gated tab reached by URL without the grant for it. Rendered as a
        refusal, and — the point of the `&&` guards above — without the tab
        having mounted and fired a request that would only be refused anyway.
      */}
      {((active === "approvals" && !canApprove) || (active === "calendar" && !seesOthers)) && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          You do not have access to this view. Approvals and the team calendar are for reporting
          managers and HR.
        </p>
      )}
    </HrmsPageLayout>
  );
}

export default LeavePage;
