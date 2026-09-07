import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { MyClaimsTab } from "./MyClaimsTab";
import { ApprovalQueueTab } from "./ApprovalQueueTab";
import { CategoriesTab } from "./CategoriesTab";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Expenses.
 *
 * The reference's `ExpensesPage` — one page, tabs, the approver queue nested
 * inside Claims — with three differences:
 *
 *   1. THE TAB IS IN THE URL, as it is for Leave, so a tab is linkable and
 *      survives a refresh. The reference keeps its inner Claims tab in local
 *      state and loses both.
 *
 *   2. THE QUEUE IS A TOP-LEVEL TAB rather than a nested one. The reference
 *      nests Tabs inside Tabs; flattening keeps one row of tabs and makes the
 *      approver's queue linkable too.
 *
 *   3. TRAVEL AND REIMBURSEMENT BATCHES ARE NOT HERE. Batches are driven by a
 *      payroll run, which belongs to a module being built separately; travel
 *      requests are a distinct workflow rather than part of claims. Neither is
 *      stubbed, so nothing offers a control that does nothing.
 *
 * These gates decide what is OFFERED. Every endpoint behind them re-checks, and
 * the claim list is scoped by the server rather than filtered here.
 */

const TAB_KEYS = ["claims", "queue", "categories"];

export function ExpensesPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  const canApprove =
    can(M.EXPENSES, A.APPROVE, S.TEAM) || can(M.EXPENSES, A.APPROVE, S.ORG);
  const isAdmin = can(M.EXPENSES, A.APPROVE, S.ORG);

  const tabs = useMemo(() => {
    const items = [{ key: "claims", label: "My Claims" }];
    if (canApprove) items.push({ key: "queue", label: "Approval Queue" });
    if (isAdmin) items.push({ key: "categories", label: "Categories" });
    return items;
  }, [canApprove, isAdmin]);

  const active = TAB_KEYS.includes(tab) ? tab : "claims";

  if (!tab) return <Navigate to={`${HRMS_ROUTE_PREFIX}/expenses/claims`} replace />;

  return (
    <HrmsPageLayout
      title="Expenses"
      subtitle="Claim what you spent, attach the receipt, and track it through approval to reimbursement."
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Expenses" },
      ]}
    >
      <TabNav
        tabs={tabs}
        activeKey={active}
        onChange={(key) => navigate(`${HRMS_ROUTE_PREFIX}/expenses/${key}`)}
        className="mb-5"
      />

      {active === "claims" && <MyClaimsTab />}
      {active === "queue" && canApprove && <ApprovalQueueTab />}
      {active === "categories" && isAdmin && <CategoriesTab />}

      {/*
        A gated tab reached by URL without the grant for it. Rendered as a
        refusal, and — the point of the `&&` guards above — without the tab
        having mounted and fired a request that would only be refused anyway.
      */}
      {((active === "queue" && !canApprove) || (active === "categories" && !isAdmin)) && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          You do not have access to this view. The approval queue is for reporting managers and
          finance; the category catalogue is for finance and HR.
        </p>
      )}
    </HrmsPageLayout>
  );
}

export default ExpensesPage;
