import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles, Lock } from "lucide-react";

import { HrmsPageLayout } from "../../components/hrms/HrmsPageLayout";
import {
  WIDGET_ZONES,
  widgetsForZone,
} from "../../components/hrms/dashboard/widgetRegistry";
import { DashboardWidget } from "../../components/hrms/dashboard/DashboardWidget";
import { plannedHrmsNavItems } from "../../components/hrms/navItems";
import { useHrmsPermissions } from "../../hooks/useHrmsPermissions";
import { companyApi, HrmsApiError } from "../../services/hrms";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";

/**
 * The HRMS dashboard.
 *
 * ---------------------------------------------------------------------------
 * A layout with extension points, not a page of widgets
 * ---------------------------------------------------------------------------
 * The reference's dashboard is one 589-line file that imports every widget and
 * branches on role to assemble them, so it ends up depending on attendance,
 * leave, engage and payroll all at once. Here the zones are fixed and each
 * module registers its own widget, so this file does not grow as the product
 * does.
 *
 * Nothing is registered in Phase 1, which is why this shows an honest empty
 * state. No placeholder headcount, no sample chart: a fabricated number on an
 * HR dashboard is indistinguishable from a real one, and someone will act on it.
 */
export function HrmsDashboard() {
  const { can, usesModule, roleKeys, implementedModules } = useHrmsPermissions();
  const [company, setCompany] = useState(null);
  const [companyError, setCompanyError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    companyApi
      .get()
      .then((data) => !cancelled && setCompany(data))
      .catch((err) => !cancelled && setCompanyError(err instanceof HrmsApiError ? err : null));
    return () => {
      cancelled = true;
    };
  }, []);

  const zones = Object.fromEntries(
    Object.values(WIDGET_ZONES).map((zone) => [zone, widgetsForZone(zone, { can, usesModule })]),
  );

  const hasAnyWidget = Object.values(zones).some((w) => w.length > 0);
  const planned = plannedHrmsNavItems(can, implementedModules);

  // Tailwind's JIT scans source for literal class names, so a template string
  // like `lg:col-span-${span}` is never generated and the widget would silently
  // render at one column. The spans are enumerated instead.
  const SPAN_CLASS = { 1: undefined, 2: "lg:col-span-2", 3: "lg:col-span-3" };

  const renderZone = (zone, className) =>
    zones[zone].length > 0 && (
      <div className={className}>
        {zones[zone].map(({ id, Component, span }) => (
          <div key={id} className={SPAN_CLASS[span] ?? undefined}>
            <Component />
          </div>
        ))}
      </div>
    );

  return (
    <HrmsPageLayout
      title="HR Dashboard"
      subtitle={
        company?.displayName
          ? `Human resources for ${company.displayName}.`
          : "Human resources overview."
      }
      breadcrumbs={[{ label: "HRMS" }, { label: "Dashboard" }]}
    >
      <div className="flex flex-col gap-6">
        {renderZone(WIDGET_ZONES.PRIMARY, "grid grid-cols-1 gap-4")}
        {renderZone(
          WIDGET_ZONES.METRICS,
          "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4",
        )}

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {renderZone(
            WIDGET_ZONES.CONTENT,
            "xl:col-span-2 grid grid-cols-1 lg:grid-cols-2 gap-4",
          )}
          {renderZone(WIDGET_ZONES.ASIDE, "grid grid-cols-1 gap-4")}
        </div>

        {!hasAnyWidget && (
          <DashboardWidget
            title="Your dashboard is being built"
            description="Widgets appear here as each HRMS module ships."
          >
            <EmptyState
              icon={<Sparkles className="w-10 h-10 text-primary-400 stroke-[1.5]" />}
              title="No widgets yet"
              description="The HRMS foundation is in place. Attendance, leave, payroll and the rest will add their own cards here as they land — no figures are shown until there is real data behind them."
              className="border-0"
            />
          </DashboardWidget>
        )}

        {/*
          What is coming, for the modules THIS person would be entitled to use.
          Shown as plain cards rather than nav links: a link to a page that does
          not exist is worse than no link at all.
        */}
        {planned.length > 0 && (
          <Card className="p-5">
            <div className="flex items-center gap-2 mb-1">
              <Lock size={14} className="text-slate-400" />
              <h3 className="text-sm font-bold text-slate-900">Modules arriving later</h3>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              You will have access to these once they are built. They are not in the menu yet
              because there is nothing behind them.
            </p>
            <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {planned.map((item) => {
                const Icon = item.icon;
                return (
                  <li
                    key={item.key}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-50 border border-slate-100 text-xs font-semibold text-slate-500"
                  >
                    <Icon size={14} className="shrink-0 text-slate-400" />
                    <span className="truncate">{item.label}</span>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {/* Signed-in context, so an HR admin can confirm which hat they are wearing. */}
        <p className="text-xs text-slate-400">
          Signed in with {roleKeys.length} HRMS role{roleKeys.length === 1 ? "" : "s"}
          {roleKeys.length > 0 && `: ${roleKeys.join(", ")}`}.{" "}
          {companyError && "Company profile could not be loaded."}{" "}
          <Link to="/" className="text-primary-600 hover:underline font-semibold">
            Back to the portal
          </Link>
        </p>
      </div>
    </HrmsPageLayout>
  );
}

export default HrmsDashboard;
