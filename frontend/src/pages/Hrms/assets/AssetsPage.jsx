import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { MyAssetsTab } from "./MyAssetsTab";
import { AssetRequestsTab } from "./AssetRequestsTab";
import { InventoryTab } from "./InventoryTab";
import { AssetCategoriesTab } from "./AssetCategoriesTab";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Assets.
 *
 * The reference's `AssetsPage` — four tabs, the same audiences:
 *
 *   My assets   everyone: what is issued to me, and what I have returned
 *   Requests    everyone: mine, or the whole queue if I administer assets
 *   Inventory   `assets:assign:org`
 *   Categories  `assets:assign:org`
 *
 * The tab lives in the URL, as it does for Leave, Expenses and Exits.
 *
 * These gates decide what is OFFERED. Every endpoint behind them re-checks, and
 * both lists are scoped by the server rather than filtered here.
 */

const TAB_KEYS = ["mine", "requests", "inventory", "categories"];

export function AssetsPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  const isAdmin = can(M.ASSETS, A.ASSIGN, S.ORG);

  const tabs = useMemo(() => {
    const items = [
      { key: "mine", label: "My Assets" },
      { key: "requests", label: "Requests" },
    ];
    if (isAdmin) {
      items.push({ key: "inventory", label: "Inventory" });
      items.push({ key: "categories", label: "Categories" });
    }
    return items;
  }, [isAdmin]);

  const active = TAB_KEYS.includes(tab) ? tab : "mine";

  if (!tab) return <Navigate to={`${HRMS_ROUTE_PREFIX}/assets/mine`} replace />;

  return (
    <HrmsPageLayout
      title="Assets"
      subtitle="Company inventory, who is holding what, and self-service asset requests."
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Assets" },
      ]}
    >
      <TabNav
        tabs={tabs}
        activeKey={active}
        onChange={(key) => navigate(`${HRMS_ROUTE_PREFIX}/assets/${key}`)}
        className="mb-5"
      />

      {active === "mine" && <MyAssetsTab />}
      {active === "requests" && <AssetRequestsTab />}
      {active === "inventory" && isAdmin && <InventoryTab />}
      {active === "categories" && isAdmin && <AssetCategoriesTab />}

      {/*
        A gated tab reached by URL without the grant for it. Rendered as a
        refusal, and — the point of the `&&` guards above — without the tab
        having mounted and fired a request that would only be refused anyway.
      */}
      {(active === "inventory" || active === "categories") && !isAdmin && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          You do not have access to this view. The inventory and the category
          catalogue are for IT and HR.
        </p>
      )}
    </HrmsPageLayout>
  );
}

export default AssetsPage;
