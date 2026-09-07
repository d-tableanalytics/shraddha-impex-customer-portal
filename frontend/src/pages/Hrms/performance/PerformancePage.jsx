import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { GoalsTab } from "./GoalsTab";
import { ReviewsTab } from "./ReviewsTab";
import { FeedbackTab } from "./FeedbackTab";
import { OneOnOnesTab } from "./OneOnOnesTab";
import { CyclesTab } from "./CyclesTab";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Performance.
 *
 * ---------------------------------------------------------------------------
 * The reference's tab set, role-scoped the way it scopes them
 * ---------------------------------------------------------------------------
 * `PerformancePage.tsx:18-31`:
 *
 *   My goals, Reviews, Feedback, 1:1s   everyone
 *   Cycles & calibration                performance:approve:org
 *
 * The default is `goals`, as it is there. The tab lives in the URL
 * (`/performance/:tab`), as it does in the reference and as every other
 * multi-tab HRMS module here does, so a tab is linkable and survives a refresh.
 */
const TAB_KEYS = ["goals", "reviews", "feedback", "one-on-ones", "cycles"];

export function PerformancePage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  const isHr = can(M.PERFORMANCE, A.APPROVE, S.ORG);
  /** A manager can open a review for a report and schedule 1:1s. */
  const isManager = can(M.PERFORMANCE, A.APPROVE, S.TEAM);

  const tabs = useMemo(() => {
    const items = [
      { key: "goals", label: "My goals" },
      { key: "reviews", label: "Reviews" },
      { key: "feedback", label: "Feedback" },
      { key: "one-on-ones", label: "1:1s" },
    ];
    if (isHr) items.push({ key: "cycles", label: "Cycles & calibration" });
    return items;
  }, [isHr]);

  const active = TAB_KEYS.includes(tab) ? tab : "goals";

  if (!tab) return <Navigate to={`${HRMS_ROUTE_PREFIX}/performance/goals`} replace />;

  /**
   * A tab reached by URL without the grant for it.
   *
   * Redirected rather than rendered as a refusal, and — the point of guarding
   * here rather than only in the tab strip — without the component having
   * mounted and fired its request first.
   */
  const guard = (allowed, element) =>
    allowed ? element : <Navigate to={`${HRMS_ROUTE_PREFIX}/performance/goals`} replace />;

  return (
    <HrmsPageLayout
      title="Performance"
      subtitle="Cascading goals (OKR-style), review cycles with panels, continuous feedback, and shared 1:1 notes."
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Performance" },
      ]}
    >
      <TabNav
        tabs={tabs}
        activeKey={active}
        onChange={(key) => navigate(`${HRMS_ROUTE_PREFIX}/performance/${key}`)}
        className="mb-4"
      />

      {active === "goals" && <GoalsTab />}
      {active === "reviews" && <ReviewsTab canAssign={isHr || isManager} isHr={isHr} />}
      {active === "feedback" && <FeedbackTab />}
      {active === "one-on-ones" && <OneOnOnesTab canSchedule={isHr || isManager} />}
      {active === "cycles" && guard(isHr, <CyclesTab />)}
    </HrmsPageLayout>
  );
}

export default PerformancePage;
