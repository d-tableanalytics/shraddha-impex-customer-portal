import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { HeadcountTab } from "./HeadcountTab";
import { HiringPlanTab } from "./HiringPlanTab";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Planning — headcount forecasting and the hiring calendar.
 *
 * Two tabs, which is exactly what the reference has: `PlanningPage.tsx` renders
 * "Headcount" and "Hiring Plan" and nothing else. The subtitle below is its
 * own, word for word.
 *
 * ---------------------------------------------------------------------------
 * The tab is in the URL
 * ---------------------------------------------------------------------------
 * The reference holds the active tab in component state on a single `/planning`
 * route, so neither tab can be linked to and a refresh always lands back on
 * Headcount. Every multi-tab HRMS screen here puts the tab in the path, and
 * this one does too.
 *
 * There is no self or team scope in this module, in either codebase — planning
 * the company's headcount and budget is an org-wide act. `planning:view:org`
 * gets both tabs read-only; `planning:edit:org` adds the write controls, which
 * the server enforces regardless of what this renders.
 */
const TAB_KEYS = ["headcount", "hiring"];

export function PlanningPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  const canManage = can(M.PLANNING, A.EDIT, S.ORG);

  const tabs = useMemo(
    () => [
      { key: "headcount", label: "Headcount" },
      { key: "hiring", label: "Hiring Plan" },
    ],
    [],
  );

  const active = TAB_KEYS.includes(tab) ? tab : "headcount";

  if (!tab) return <Navigate to={`${HRMS_ROUTE_PREFIX}/planning/headcount`} replace />;

  return (
    <HrmsPageLayout
      title="Planning"
      subtitle="Headcount forecasting per department, budgeting, and hiring plans vs pipeline."
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Planning" },
      ]}
    >
      <TabNav
        tabs={tabs}
        activeKey={active}
        onChange={(key) => navigate(`${HRMS_ROUTE_PREFIX}/planning/${key}`)}
        className="mb-4"
      />

      {active === "headcount" && <HeadcountTab canManage={canManage} />}
      {active === "hiring" && <HiringPlanTab canManage={canManage} />}
    </HrmsPageLayout>
  );
}

export default PlanningPage;
