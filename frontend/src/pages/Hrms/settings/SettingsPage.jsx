import { useMemo } from "react";
import { useNavigate, useParams, Navigate } from "react-router-dom";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";
import { CompanyProfileTab } from "./CompanyProfileTab";
import { RolesTab } from "./RolesTab";
import { SsoTab } from "./SsoTab";
import { IntegrationsTab } from "./IntegrationsTab";

/**
 * Settings.
 *
 * The reference's four tabs, in its order — Company Profile, Roles &
 * Permissions, Single Sign-On, Integrations — with the tab in the URL, as it
 * already is there and in every other module here.
 *
 * The route guard is `settings`, which only a super admin holds. The SSO and
 * Integrations tabs additionally require `settings:integrations:edit:org`;
 * today the same role holds both, so the extra check changes nothing — but it
 * means the two permissions can diverge later without the screen quietly
 * showing a tab whose endpoints would refuse it.
 */

const TAB_KEYS = ["company", "roles", "sso", "integrations"];

export function SettingsPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  const canIntegrations = can(M.SETTINGS_INTEGRATIONS, A.EDIT, S.ORG);

  const tabs = useMemo(() => {
    const items = [
      { key: "company", label: "Company Profile" },
      { key: "roles", label: "Roles & Permissions" },
    ];
    if (canIntegrations) {
      items.push({ key: "sso", label: "Single Sign-On" });
      items.push({ key: "integrations", label: "Integrations" });
    }
    return items;
  }, [canIntegrations]);

  if (!tab) return <Navigate to={`${HRMS_ROUTE_PREFIX}/settings/company`} replace />;

  const active = TAB_KEYS.includes(tab) ? tab : "company";
  const gated = (active === "sso" || active === "integrations") && !canIntegrations;

  return (
    <HrmsPageLayout
      title="Settings"
      subtitle="Company identity and branding, the permission matrix, sign-on providers and third-party integrations."
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Settings" },
      ]}
    >
      <TabNav
        tabs={tabs}
        activeKey={active}
        onChange={(key) => navigate(`${HRMS_ROUTE_PREFIX}/settings/${key}`)}
        className="mb-5"
      />

      {active === "company" && <CompanyProfileTab />}
      {active === "roles" && <RolesTab />}
      {active === "sso" && canIntegrations && <SsoTab />}
      {active === "integrations" && canIntegrations && <IntegrationsTab />}

      {/*
        A gated tab reached by URL. Rendered as a refusal, and — the point of
        the `&&` guards above — without the tab having mounted and fired a
        request that would only be refused anyway.
      */}
      {gated && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          You do not have access to this view. Sign-on providers and integrations hold
          credentials, so they need the integrations permission specifically.
        </p>
      )}
    </HrmsPageLayout>
  );
}

export default SettingsPage;
