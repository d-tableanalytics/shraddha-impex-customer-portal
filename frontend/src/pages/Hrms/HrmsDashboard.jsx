import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  CalendarDays,
  Clock,
  Megaphone,
  BarChart3,
  Palmtree,
  Smartphone,
  PartyPopper,
  UserPlus,
  LogOut,
  ListChecks,
  Activity,
} from "lucide-react";

import { HrmsPageLayout } from "../../components/hrms/HrmsPageLayout";
import { ErrorState } from "../../components/hrms/ErrorState";
import { Badge } from "../../components/ui/Badge";
import {
  SectionTitle,
  WidgetCard,
  StatTile,
  PersonRow,
  QuickAccessTile,
  WidgetSkeleton,
} from "../../components/hrms/dashboard/DashboardPieces";
import { LoginTrendChart } from "../../components/hrms/dashboard/LoginTrendChart";
import {
  WIDGET_ZONES,
  widgetsForZone,
} from "../../components/hrms/dashboard/widgetRegistry";
/*
 * Module widget registrations are imported here for their side effect, so a
 * module can add a card without this file growing an import per feature.
 *
 * Engage's announcements widget is deliberately NOT imported any more: the
 * dashboard now renders announcements itself, from the same aggregation that
 * carries every other widget, and registering the Engage card as well would
 * show the same three announcements twice.
 */

import { useHrmsPermissions } from "../../hooks/useHrmsPermissions";
import {
  dashboardApi,
  greetingFor,
  formatHeroDate,
  formatClock,
  formatShortDay,
  formatDaysUntil,
} from "../../services/hrms/dashboard";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";

const P = HRMS_ROUTE_PREFIX;

/**
 * The HRMS dashboard.
 *
 * ---------------------------------------------------------------------------
 * Structure
 * ---------------------------------------------------------------------------
 * The reference's hierarchy, reproduced: hero, then quick access, then two rows
 * of operational cards, then workforce metrics, then login activity beside
 * pending actions, then new hires beside exits.
 *
 * ---------------------------------------------------------------------------
 * Two requests, not fifteen
 * ---------------------------------------------------------------------------
 * `/dashboard/widgets` and `/dashboard/summary`, in parallel. Each is one
 * server-side aggregation that already knows the caller's scope — this page
 * NEVER filters for authorization. A widget the actor may not see arrives
 * empty, and the card is not rendered.
 *
 * The reference builds the same page from a 589-line file that imports every
 * widget and branches on role. The role branch here lives on the server, where
 * it is also the security boundary; the client renders what it is sent.
 */
export function HrmsDashboard() {
  const { can, usesModule } = useHrmsPermissions();

  const [widgets, setWidgets] = useState(null);
  const [summary, setSummary] = useState(null);
  const [range, setRange] = useState("7d");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [w, s] = await Promise.all([
        dashboardApi.widgets(),
        dashboardApi.summary({ range }),
      ]);
      setWidgets(w ?? null);
      setSummary(s ?? null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  // The clock in the hero ticks, because it says the time.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  /**
    * The greeting name is SERVER-DERIVED — `/hrms/me` returns ids, roles and
    * permissions and deliberately no display name, so there is nothing on the
    * client to greet with that the server did not resolve from the session.
    */
  const firstName = widgets?.viewer?.firstName ?? "";

  const registered = useMemo(
    () =>
      Object.fromEntries(
        Object.values(WIDGET_ZONES).map((zone) => [
          zone,
          widgetsForZone(zone, { can, usesModule }),
        ]),
      ),
    [can, usesModule],
  );

  const celebrations = [
    ...(widgets?.birthdays ?? []).map((b) => ({ ...b, kind: "birthday" })),
    ...(widgets?.anniversaries ?? []).map((a) => ({ ...a, kind: "anniversary" })),
  ].sort((a, b) => a.daysUntil - b.daysUntil);

  const kpis = summary?.kpis ?? [];
  const pendingActions = summary?.pendingActions ?? [];
  const newHires = summary?.newHires ?? [];
  const exits = summary?.exits ?? [];
  const trend = summary?.loginTrend ?? [];
  const team = summary?.team ?? null;

  return (
    <HrmsPageLayout
      title="Dashboard"
      subtitle="Your day, your team, and the company at a glance."
      breadcrumbs={[{ label: "HRMS" }, { label: "Dashboard" }]}
    >
      <div className="flex flex-col gap-6">
        {/* ---------------------------------------------------------------
            Hero. Local time and the viewer's own calendar — never UTC.
        ---------------------------------------------------------------- */}
        <section className="relative overflow-hidden rounded-2xl px-6 py-6 sm:px-8 sm:py-7 bg-gradient-to-br from-primary-800 via-primary-700 to-primary-500 text-white shadow-enterprise">
          <div className="relative flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4 min-w-0">
              <span className="shrink-0 inline-flex items-center justify-center w-14 h-14 rounded-full bg-white/15 border-2 border-white/25 text-xl font-bold">
                {(firstName || "?").charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-wider text-white/80">
                  {greetingFor(now.getHours())}
                </p>
                <h2 className="text-2xl sm:text-3xl font-bold leading-tight truncate">
                  {firstName ? `Hi, ${firstName}` : "Welcome back"}
                </h2>
                <p className="text-[12.5px] text-white/85 mt-1">
                  {formatHeroDate(now)} · Have a productive day.
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              <HeroChip icon={CalendarDays} label="Today" value={formatShortDay(isoLocalDay(now))} />
              <HeroChip icon={Clock} label="Local time" value={formatClock(now)} />
            </div>
          </div>
        </section>

        {error ? (
          <ErrorState
            variant={error.isForbidden ? "forbidden" : "error"}
            description={error.message}
            onRetry={load}
          />
        ) : loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <WidgetSkeleton />
            <WidgetSkeleton />
            <WidgetSkeleton />
          </div>
        ) : (
          <>
            {/* --- Quick access ---------------------------------------- */}
            {(widgets?.quickAccess ?? []).length > 0 && (
              <section>
                <SectionTitle
                  title="Quick access"
                  subtitle="What you can do right now"
                />
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7 gap-3">
                  {widgets.quickAccess.map((item) => (
                    <QuickAccessTile key={item.key} item={item} prefix={P} />
                  ))}
                </div>
              </section>
            )}

            {/* --- Operational row one ---------------------------------- */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              <WidgetCard
                title="Upcoming holidays"
                icon={Palmtree}
                viewAllTo={`${P}/leave/holidays`}
                isEmpty={(widgets?.upcomingHolidays ?? []).length === 0}
                emptyTitle="No holidays ahead"
                emptyDescription="The next public holidays appear here."
              >
                <ul className="flex flex-col divide-y divide-slate-100">
                  {(widgets?.upcomingHolidays ?? []).map((h) => (
                    <li key={h.id} className="flex items-center justify-between gap-3 py-2">
                      <span className="text-[13px] font-semibold text-slate-800 truncate">
                        {h.name}
                      </span>
                      <span className="shrink-0 flex items-center gap-2">
                        {h.isOptional && <Badge variant="neutral">Optional</Badge>}
                        <span className="text-[11px] text-slate-500 tabular-nums">
                          {formatShortDay(h.date)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </WidgetCard>

              <WidgetCard
                title="Announcements"
                icon={Megaphone}
                viewAllTo={`${P}/engage/announcements`}
                isEmpty={(widgets?.announcements ?? []).length === 0}
                emptyTitle="Nothing right now"
                emptyDescription="Company news addressed to you appears here."
              >
                <ul className="flex flex-col gap-3">
                  {(widgets?.announcements ?? []).map((a) => (
                    <li key={a.id} className="flex flex-col gap-0.5 min-w-0">
                      <Link
                        to={`${P}/engage/announcements`}
                        className="text-[13px] font-semibold text-slate-900 hover:text-primary-700 truncate"
                      >
                        {a.title}
                      </Link>
                      <p className="text-[11.5px] text-slate-600 leading-snug line-clamp-2">
                        {a.body}
                      </p>
                      <span className="text-[10.5px] text-slate-400">
                        {a.createdByName ?? "HR"} · {formatShortDay(a.publishedAt?.slice(0, 10))}
                      </span>
                    </li>
                  ))}
                </ul>
              </WidgetCard>

              <WidgetCard
                title="Active polls"
                icon={BarChart3}
                viewAllTo={`${P}/engage/polls`}
                isEmpty={(widgets?.polls ?? []).length === 0}
                emptyTitle="No open polls"
                emptyDescription="When HR runs one, it appears here."
              >
                <ul className="flex flex-col gap-3">
                  {(widgets?.polls ?? []).map((p) => (
                    <li key={p.id} className="flex flex-col gap-1 min-w-0">
                      <Link
                        to={`${P}/engage/polls`}
                        className="text-[13px] font-semibold text-slate-900 hover:text-primary-700 line-clamp-2"
                      >
                        {p.question}
                      </Link>
                      <span>
                        {p.hasResponded ? (
                          <Badge variant="success">Answered</Badge>
                        ) : (
                          <Badge variant="warning">Awaiting your answer</Badge>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </WidgetCard>
            </div>

            {/* --- Operational row two ---------------------------------- */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {widgets?.scope?.team && (
                <>
                  <WidgetCard
                    title="On leave today"
                    icon={CalendarDays}
                    viewAllTo={`${P}/leave/calendar`}
                    isEmpty={(widgets?.onLeaveToday ?? []).length === 0}
                    emptyTitle="Everybody is in"
                    emptyDescription="Approved leave for today shows here."
                  >
                    <div className="flex flex-col divide-y divide-slate-100">
                      {(widgets?.onLeaveToday ?? []).map((p) => (
                        <PersonRow
                          key={p.employeeId}
                          name={p.name}
                          meta={p.leaveTypeCode ?? "Leave"}
                        />
                      ))}
                    </div>
                  </WidgetCard>

                  <WidgetCard
                    // 🔴 Named for what it measures. The reference calls this
                    // "Working Remotely" while querying `source: 'mobile'` —
                    // there is no remote-work state in either codebase.
                    title="Clocked in from mobile"
                    icon={Smartphone}
                    viewAllTo={`${P}/attendance/team`}
                    isEmpty={(widgets?.mobileClockInsToday ?? []).length === 0}
                    emptyTitle="No mobile punches yet"
                    emptyDescription="Today's mobile clock-ins appear here."
                  >
                    <div className="flex flex-col divide-y divide-slate-100">
                      {(widgets?.mobileClockInsToday ?? []).map((p) => (
                        <PersonRow
                          key={p.employeeId}
                          name={p.name}
                          meta={`Clocked in ${formatClock(new Date(p.clockedInAt))}`}
                        />
                      ))}
                    </div>
                  </WidgetCard>
                </>
              )}

              <WidgetCard
                title="Celebrations"
                icon={PartyPopper}
                isEmpty={celebrations.length === 0}
                emptyTitle="Nothing in the next fortnight"
                emptyDescription="Birthdays and work anniversaries appear here."
              >
                <div className="flex flex-col divide-y divide-slate-100">
                  {celebrations.map((c) => (
                    <PersonRow
                      key={`${c.kind}-${c.employeeId}`}
                      name={c.name}
                      meta={
                        c.kind === "birthday"
                          ? `Birthday · ${formatDaysUntil(c.daysUntil)}`
                          : `${c.yearsCount} year${c.yearsCount === 1 ? "" : "s"} · ${formatDaysUntil(c.daysUntil)}`
                      }
                      trailing={
                        <span aria-hidden="true" className="text-base">
                          {c.kind === "birthday" ? "🎂" : "🎉"}
                        </span>
                      }
                    />
                  ))}
                </div>
              </WidgetCard>
            </div>

            {/* --- Workforce metrics ------------------------------------ */}
            {kpis.length > 0 && (
              <section>
                <SectionTitle
                  title="Key metrics"
                  subtitle="Snapshot of your workforce today"
                />
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  {kpis.map((k) => (
                    <StatTile
                      key={k.key}
                      label={k.label}
                      value={k.value}
                      tone={k.tone}
                      to={`${P}${k.href}`}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* --- A manager's own team --------------------------------- */}
            {team && (
              <section>
                <SectionTitle title="Your team" subtitle="How your reports are showing up today" />
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                  <StatTile label="Direct reports" value={team.directReports} to={`${P}/attendance/team`} />
                  <StatTile label="On leave today" value={team.onLeaveToday} tone="warning" to={`${P}/leave/calendar`} />
                  <StatTile
                    label="Pending approvals"
                    value={team.pendingApprovals}
                    tone={team.pendingApprovals > 0 ? "warning" : "neutral"}
                    to={`${P}/leave/approvals`}
                  />
                </div>
              </section>
            )}

            {/* --- Login activity + pending actions --------------------- */}
            {(widgets?.scope?.audit || pendingActions.length > 0) && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {widgets?.scope?.audit && (
                  <WidgetCard title="Login activity" icon={Activity} viewAllTo={`${P}/audit-logs`}>
                    <LoginTrendChart data={trend} range={range} onRangeChange={setRange} />
                  </WidgetCard>
                )}

                {pendingActions.length > 0 && (
                  <WidgetCard title="Pending actions" icon={ListChecks}>
                    <ul className="flex flex-col divide-y divide-slate-100">
                      {pendingActions.map((a) => (
                        <li key={a.key}>
                          <Link
                            to={`${P}${a.href}`}
                            className="flex items-center justify-between gap-3 py-2.5 -mx-2 px-2 rounded-lg hover:bg-slate-50"
                          >
                            <span className="text-[13px] font-semibold text-slate-800">
                              {a.label}
                            </span>
                            <Badge variant={a.value > 0 ? "warning" : "neutral"}>{a.value}</Badge>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </WidgetCard>
                )}
              </div>
            )}

            {/* --- New hires + exits ------------------------------------ */}
            {widgets?.scope?.org && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <WidgetCard
                  title="New hires"
                  icon={UserPlus}
                  viewAllTo={`${P}/employees`}
                  isEmpty={newHires.length === 0}
                  emptyTitle="No new hires"
                  emptyDescription="Joiners in the last 30 days appear here."
                >
                  <div className="flex flex-col divide-y divide-slate-100">
                    {newHires.map((e) => (
                      <PersonRow
                        key={e.employeeId}
                        name={e.name}
                        meta={`${e.department ?? "—"} · ${formatShortDay(e.effectiveOn)}`}
                        to={`${P}/employees/${e.employeeId}`}
                      />
                    ))}
                  </div>
                </WidgetCard>

                <WidgetCard
                  title="Exits"
                  icon={LogOut}
                  viewAllTo={`${P}/exits/requests`}
                  isEmpty={exits.length === 0}
                  emptyTitle="No exits"
                  emptyDescription="Departures in the last 30 days appear here."
                >
                  <div className="flex flex-col divide-y divide-slate-100">
                    {exits.map((e) => (
                      <PersonRow
                        key={e.employeeId}
                        name={e.name}
                        meta={`${e.department ?? "—"} · ${formatShortDay(e.effectiveOn)}`}
                        to={`${P}/employees/${e.employeeId}`}
                      />
                    ))}
                  </div>
                </WidgetCard>
              </div>
            )}

            {/* --- Whatever a module registered for itself -------------- */}
            {Object.values(registered).some((w) => w.length > 0) && (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {Object.values(registered)
                  .flat()
                  .map(({ id, Component }) => (
                    <Component key={id} />
                  ))}
              </div>
            )}
          </>
        )}
      </div>
    </HrmsPageLayout>
  );
}

function HeroChip({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-white/10 border border-white/20 min-w-[124px]">
      <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-white/15">
        <Icon size={15} />
      </span>
      <span className="flex flex-col">
        <span className="text-[10px] text-white/75 tracking-wide">{label}</span>
        <span className="text-[13px] font-bold tabular-nums">{value}</span>
      </span>
    </div>
  );
}

/** The viewer's own calendar day, never `toISOString()`. */
function isoLocalDay(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default HrmsDashboard;
