import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  registerDashboardWidget,
  WIDGET_ZONES,
} from "../../../components/hrms/dashboard/widgetRegistry";
import { DashboardWidget } from "../../../components/hrms/dashboard/DashboardWidget";
import { announcementsApi, formatEngageDay } from "../../../services/hrms/engage";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * The announcements widget.
 *
 * ---------------------------------------------------------------------------
 * Reproducing the reference's ONE genuine cross-module integration
 * ---------------------------------------------------------------------------
 * `widgets.service.ts:102-107` reads the three most recent PUBLISHED
 * announcements for the dashboard. That is the only place outside Engage that
 * touches an engage table — its poll widget is the same query for polls, and
 * the seeder's `deleteMany` is the only other reference in the whole codebase.
 *
 * The reference's dashboard imports every widget directly, which is why that
 * file reaches 589 lines and ends up depending on attendance, leave, engage and
 * payroll at once. Here Engage registers its own widget through the registry
 * built for exactly this, and the dashboard stays a layout.
 *
 * The widget wraps itself in `DashboardWidget`, because the dashboard renders
 * `<Component />` bare — the card, and its loading/error/empty states, belong
 * to the widget.
 *
 * Targeting is applied by the SERVER, so a reader sees the three most recent
 * announcements ADDRESSED TO THEM. The reference's widget query has no
 * visibility filter at all, so its dashboard shows announcements aimed at other
 * departments to everybody.
 */
function AnnouncementsWidget() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      // The reference takes three. So does this.
      const res = await announcementsApi.list({ page: 1, pageSize: 3, state: "published" });
      setRows(res?.data ?? []);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <DashboardWidget
      title="Announcements"
      loading={rows === null && !error}
      error={error}
      onRetry={load}
      isEmpty={rows !== null && rows.length === 0}
      emptyTitle="Nothing right now"
      emptyDescription="Company news appears here when there is some."
      action={
        <Link
          to={`${HRMS_ROUTE_PREFIX}/engage/announcements`}
          className="text-[11px] font-bold text-primary-700 hover:underline"
        >
          All
        </Link>
      }
    >
      <ul className="flex flex-col gap-3">
        {(rows ?? []).map((row) => (
          <li key={row.id} className="flex flex-col gap-0.5">
            <Link
              to={`${HRMS_ROUTE_PREFIX}/engage/announcements`}
              className="text-sm font-semibold text-slate-900 hover:text-primary-700"
            >
              {row.title}
            </Link>
            <p className="text-xs text-slate-600 leading-snug line-clamp-2">{row.body}</p>
            <span className="text-[10.5px] text-slate-400 tabular-nums">
              {formatEngageDay(row.publishedAt?.slice(0, 10))}
            </span>
          </li>
        ))}
      </ul>
    </DashboardWidget>
  );
}

/**
 * Registered on import.
 *
 * The dashboard imports this module for its side effect. The widget then
 * disappears on its own if Engage is not a built module, or if the viewer holds
 * no engage grant — `widgetsForZone` checks both, so this cannot show a card
 * for a module somebody cannot use.
 */
registerDashboardWidget({
  id: "engage-announcements",
  zone: WIDGET_ZONES.CONTENT,
  Component: AnnouncementsWidget,
  module: M.ENGAGE,
  requires: [{ module: M.ENGAGE, action: A.VIEW, scope: S.SELF }],
  order: 10,
  span: 1,
});

export { AnnouncementsWidget };
