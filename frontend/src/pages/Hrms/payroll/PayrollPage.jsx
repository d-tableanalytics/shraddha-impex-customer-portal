import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { PayrollOverviewTab } from "./PayrollOverviewTab";
import { PayslipsTab } from "./PayslipsTab";
import { RunsTab } from "./RunsTab";
import { StructuresTab } from "./StructuresTab";
import { PayGroupsTab } from "./PayGroupsTab";
import { StatutoryTab } from "./StatutoryTab";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Payroll.
 *
 * ---------------------------------------------------------------------------
 * The reference's tab set, role-scoped the way it scopes them
 * ---------------------------------------------------------------------------
 * `PayrollPage.tsx:22-42`:
 *
 *   Overview + Payslips            everyone
 *   Pay Groups + Structures        payroll:structure:edit:org
 *   Runs                           payroll:run:org
 *   Statutory                      payroll:structure:edit:org
 *
 * The reference also has an "Advance Salary" tab for its loan module, which is
 * not built here — see the module's report. It is omitted rather than shown
 * empty: a tab that leads nowhere is worse than one that is absent.
 *
 * The tab lives in the URL (`/payroll/:tab`), as it does in the reference and
 * as Attendance, Leave and Org Structure already do here, so a tab is linkable
 * and survives a refresh.
 */
const TAB_KEYS = ["overview", "payslips", "runs", "structures", "pay-groups", "statutory"];

export function PayrollPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  const canRun = can(M.PAYROLL, A.RUN, S.ORG);
  const canEditStructures = can(M.PAYROLL_STRUCTURE, A.EDIT, S.ORG);
  const seesCompanyPayroll = can(M.PAYROLL, A.VIEW, S.ORG);

  const tabs = useMemo(() => {
    // Overview and Payslips first, because most people who open Payroll are
    // here for their own slip rather than to run the month.
    const items = [
      { key: "overview", label: "Overview" },
      { key: "payslips", label: "Payslips" },
    ];
    if (canRun) items.push({ key: "runs", label: "Runs" });
    if (canEditStructures) {
      items.push(
        { key: "structures", label: "Structures" },
        { key: "pay-groups", label: "Pay Groups" },
        { key: "statutory", label: "Statutory" },
      );
    }
    return items;
  }, [canRun, canEditStructures]);

  const active = TAB_KEYS.includes(tab) ? tab : "overview";

  if (!tab) return <Navigate to={`${HRMS_ROUTE_PREFIX}/payroll/overview`} replace />;

  /**
   * A tab reached by URL without the grant for it.
   *
   * Redirected rather than rendered as a refusal, and — the point of guarding
   * here rather than only in the tab strip — without the component having
   * mounted and fired its request first.
   */
  const guard = (allowed, element) =>
    allowed ? element : <Navigate to={`${HRMS_ROUTE_PREFIX}/payroll/overview`} replace />;

  return (
    <HrmsPageLayout
      title="Payroll"
      subtitle="Salary structures, statutory compliance (PF · ESI · PT · LWF · TDS), monthly runs and payslips."
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Payroll" },
      ]}
    >
      <TabNav
        tabs={tabs}
        activeKey={active}
        onChange={(key) => navigate(`${HRMS_ROUTE_PREFIX}/payroll/${key}`)}
        className="mb-4"
      />

      {active === "overview" && <PayrollOverviewTab seesCompanyPayroll={seesCompanyPayroll} />}
      {active === "payslips" && <PayslipsTab />}
      {active === "runs" && guard(canRun, <RunsTab />)}
      {active === "structures" && guard(canEditStructures, <StructuresTab />)}
      {active === "pay-groups" && guard(canEditStructures, <PayGroupsTab />)}
      {active === "statutory" && guard(canEditStructures, <StatutoryTab />)}
    </HrmsPageLayout>
  );
}

export default PayrollPage;
