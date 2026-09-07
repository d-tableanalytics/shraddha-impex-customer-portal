import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { EmptyState } from "../../../components/ui/EmptyState";
import { DepartmentsTab } from "./DepartmentsTab";
import { LocationsTab } from "./LocationsTab";
import { CustomFieldsTab } from "./CustomFieldsTab";
import { OrgChartTab } from "./OrgChartTab";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Org Structure.
 *
 * One page, four tabs, the tab in the URL — the reference's shape exactly
 * (`OrgSettingsPage.tsx`, route `/org/:tab`). Putting the tab in the path is
 * what makes it linkable, survive a refresh, and work with the back button;
 * the Departments tab's employee-count link depends on the first of those.
 *
 * ---------------------------------------------------------------------------
 * Which tabs exist depends on the viewer
 * ---------------------------------------------------------------------------
 * The reference shows the three editing tabs only to someone holding
 * `org-structure:edit:org`, and defaults everyone else to Org Chart:
 *
 *     const activeTab = tab ?? (canEdit ? 'departments' : 'org-chart');
 *
 * That is followed, with one correction. The reference's own tree endpoint
 * requires `org-structure:view:org` OR `employees:view:team`, which an ordinary
 * employee holds neither of — so the reference defaults exactly the people who
 * cannot use that tab onto it, and they get a 403. Here a viewer who cannot
 * reach the chart is told so on the tab rather than defaulted into an error.
 *
 * ---------------------------------------------------------------------------
 * All four tabs are live
 * ---------------------------------------------------------------------------
 * Custom Fields edits the definitions Employee Master already owns - the same
 * model, service and endpoints, with only the screen added here, which is where
 * the reference puts it too. Org Chart draws the flat list `/org/tree` returns.
 */

const TAB_KEYS = ["departments", "locations", "custom-fields", "org-chart"];

/** What a not-yet-built tab shows if it is somehow reached by URL. */
function NotBuiltYet({ title, description }) {
  return (
    <EmptyState
      title={title}
      description={description}
      className="mt-2"
    />
  );
}

export function OrgStructurePage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  const canEdit = can(M.ORG_STRUCTURE, A.EDIT, S.ORG);
  // Whether the org chart is READABLE is not computed here. The tree endpoint
  // owns that rule, and re-deriving it in the browser would give two answers
  // that could drift. The tab is offered; a refusal is rendered as a refusal.

  const tabs = useMemo(() => {
    const items = [];

    if (canEdit) {
      items.push(
        { key: "departments", label: "Departments" },
        { key: "locations", label: "Locations" },
        { key: "custom-fields", label: "Custom Fields" },
      );
    }

    // Always present, as in the reference - it is the only tab a non-editor
    // gets. Whether the data behind it is readable is the server's call, and a
    // 403 is rendered as a refusal rather than as an empty company.
    items.push({ key: "org-chart", label: "Org Chart" });

    return items;
  }, [canEdit]);

  /**
   * The landing tab. An editor starts on Departments as the reference does; a
   * viewer has no working tab, and is shown that plainly rather than dropped
   * onto one that would fail.
   */
  const fallback = canEdit ? "departments" : "org-chart";
  const active = TAB_KEYS.includes(tab) ? tab : fallback;

  if (!tab) return <Navigate to={`${HRMS_ROUTE_PREFIX}/org/${fallback}`} replace />;

  return (
    <HrmsPageLayout
      title="Org Structure"
      subtitle="Reporting hierarchy and organizational configuration."
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Org Structure" },
      ]}
    >
      <TabNav
        tabs={tabs}
        activeKey={active}
        onChange={(key) => navigate(`${HRMS_ROUTE_PREFIX}/org/${key}`)}
        className="mb-5"
      />

      {canEdit && active === "departments" && <DepartmentsTab />}
      {canEdit && active === "locations" && <LocationsTab />}
      {canEdit && active === "custom-fields" && <CustomFieldsTab />}

      {active === "org-chart" && <OrgChartTab />}

      {/*
        An editor-only tab reached by URL without the grant for it. Rendered as
        a refusal, and - the point of the `canEdit &&` guards above - without
        the tab having mounted and fired its request first.
      */}
      {!canEdit && active !== "org-chart" && (
        <NotBuiltYet
          title="You cannot change the org structure"
          description="Departments, locations and custom fields can only be edited by an HR or system administrator."
        />
      )}
    </HrmsPageLayout>
  );
}

export default OrgStructurePage;
