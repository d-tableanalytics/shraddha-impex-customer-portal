import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { NewHirePortalTab } from "./NewHirePortalTab";
import { ChecklistsTab } from "./ChecklistsTab";
import { TemplatesTab } from "./TemplatesTab";
import { OfferLettersTab } from "./OfferLettersTab";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Onboarding.
 *
 * ---------------------------------------------------------------------------
 * The reference's tab set, role-scoped the way it scopes them
 * ---------------------------------------------------------------------------
 * `OnboardingPage.tsx:19-33`:
 *
 *   My onboarding   always visible — it is the new hire's own portal
 *   Checklists      onboarding:edit:org OR onboarding:view:team
 *   Templates       onboarding:edit:org
 *   Offer letters   onboarding:edit:org
 *
 * The default is `portal`, as it is there: most people who open Onboarding are
 * the new hire, not the HR admin who set it up.
 *
 * The tab lives in the URL (`/onboarding/:tab`), as it does in the reference
 * and as every other multi-tab HRMS module here does, so a tab is linkable and
 * survives a refresh.
 */
const TAB_KEYS = ["portal", "checklists", "templates", "offers"];

export function OnboardingPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  const isHr = can(M.ONBOARDING, A.EDIT, S.ORG);
  const isManager = can(M.ONBOARDING, A.VIEW, S.TEAM);

  const tabs = useMemo(() => {
    const items = [{ key: "portal", label: "My onboarding" }];
    if (isHr || isManager) items.push({ key: "checklists", label: "Checklists" });
    if (isHr) {
      items.push(
        { key: "templates", label: "Templates" },
        { key: "offers", label: "Offer letters" },
      );
    }
    return items;
  }, [isHr, isManager]);

  const active = TAB_KEYS.includes(tab) ? tab : "portal";

  if (!tab) return <Navigate to={`${HRMS_ROUTE_PREFIX}/onboarding/portal`} replace />;

  /**
   * A tab reached by URL without the grant for it.
   *
   * Redirected rather than rendered as a refusal, and — the point of guarding
   * here rather than only in the tab strip — without the component having
   * mounted and fired its request first.
   */
  const guard = (allowed, element) =>
    allowed ? element : <Navigate to={`${HRMS_ROUTE_PREFIX}/onboarding/portal`} replace />;

  return (
    <HrmsPageLayout
      title="Onboarding"
      subtitle="Template-driven task lists, offer letters with e-signature, and a self-service portal for new hires."
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Onboarding" },
      ]}
    >
      <TabNav
        tabs={tabs}
        activeKey={active}
        onChange={(key) => navigate(`${HRMS_ROUTE_PREFIX}/onboarding/${key}`)}
        className="mb-4"
      />

      {active === "portal" && <NewHirePortalTab />}
      {active === "checklists" && guard(isHr || isManager, <ChecklistsTab canEdit={isHr} />)}
      {active === "templates" && guard(isHr, <TemplatesTab />)}
      {active === "offers" && guard(isHr, <OfferLettersTab />)}
    </HrmsPageLayout>
  );
}

export default OnboardingPage;
