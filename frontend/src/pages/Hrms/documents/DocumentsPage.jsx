import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { LibraryTab } from "./LibraryTab";
import { PoliciesTab } from "./PoliciesTab";
import { MyDocumentsTab } from "./MyDocumentsTab";
import { FoldersTab } from "./FoldersTab";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Documents.
 *
 * The reference's `DocumentsPage` — four tabs, the same audiences:
 *
 *   Company library  everyone; what they see is filtered by folder visibility
 *   Policies         everyone; publishing is HR's
 *   My documents     everyone
 *   Folders          `documents:edit:org`
 *
 * The tab lives in the URL, as it does for every other module here.
 *
 * These gates decide what is OFFERED. Every endpoint behind them re-checks, and
 * all three lists are scoped by the server rather than filtered in the browser.
 */

const TAB_KEYS = ["library", "policies", "mine", "folders"];

export function DocumentsPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  const isHr = can(M.DOCUMENTS, A.EDIT, S.ORG);

  const tabs = useMemo(() => {
    const items = [
      { key: "library", label: "Company Library" },
      { key: "policies", label: "Policies" },
      { key: "mine", label: "My Documents" },
    ];
    if (isHr) items.push({ key: "folders", label: "Folders" });
    return items;
  }, [isHr]);

  const active = TAB_KEYS.includes(tab) ? tab : "library";

  if (!tab) return <Navigate to={`${HRMS_ROUTE_PREFIX}/documents/library`} replace />;

  return (
    <HrmsPageLayout
      title="Documents"
      subtitle="The company library, your own records, and the policies you need to acknowledge."
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Documents" },
      ]}
    >
      <TabNav
        tabs={tabs}
        activeKey={active}
        onChange={(key) => navigate(`${HRMS_ROUTE_PREFIX}/documents/${key}`)}
        className="mb-5"
      />

      {active === "library" && <LibraryTab />}
      {active === "policies" && <PoliciesTab />}
      {active === "mine" && <MyDocumentsTab />}
      {active === "folders" && isHr && <FoldersTab />}

      {/*
        A gated tab reached by URL without the grant for it. Rendered as a
        refusal, and — the point of the `&&` guard above — without the tab
        having mounted and fired a request that would only be refused anyway.
      */}
      {active === "folders" && !isHr && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          You do not have access to this view. Folders and their visibility are managed by HR.
        </p>
      )}
    </HrmsPageLayout>
  );
}

export default DocumentsPage;
