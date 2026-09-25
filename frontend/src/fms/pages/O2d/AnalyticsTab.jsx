import { useState, useEffect, useCallback } from "react";
import { AlertTriangle, Download } from "lucide-react";

import { Button } from "../../components/ui/Button";
import { LoadingSpinner } from "../../components/ui/LoadingSpinner";
import { o2dApi, formatWorkingMinutes } from "../../services/o2d/orders";
import { O2dApiError } from "../../services/o2d/client";
import { Section, Field } from "./o2dShared";

/**
 * The FMS dashboard (§38-41).
 *
 * ---------------------------------------------------------------------------
 * 🔴 THE COVERAGE NOTE IS NOT A FOOTNOTE
 * ---------------------------------------------------------------------------
 *
 * The 2,315 migrated orders carry actual dates only and have no recorded
 * deadlines, so they cannot be scored for on-time performance — but they CAN be
 * measured for cycle time. The two figures on this screen therefore have
 * different denominators.
 *
 * That is not a caveat to put at the bottom in grey. "94% on-time" is a false
 * statement if the reader does not know it covers 300 of 2,615 orders, so the
 * coverage banner renders IMMEDIATELY BESIDE the percentage, before the reader
 * can act on it. A screen that separates a number from the reason it is partial
 * is how a decision gets made on a figure nobody understood.
 */

/** A big number with its label. `null` shows as "—", never as zero. */
function Stat({ label, value, suffix = "", tone = "default", hint }) {
  const tones = {
    default: "text-slate-900",
    danger: "text-error-600",
    warning: "text-amber-600",
    success: "text-emerald-600",
  };
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tones[tone]}`}>
        {value === null || value === undefined ? "—" : value}
        {value !== null && value !== undefined && suffix ? (
          <span className="ml-0.5 text-base font-normal text-slate-400">{suffix}</span>
        ) : null}
      </p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/**
 * The banner that must appear next to any SLA figure.
 *
 * Renders nothing when coverage is complete — a permanent banner saying
 * "everything is included" is one people stop reading, and then miss the day it
 * says something different.
 */
function CoverageBanner({ coverage }) {
  if (!coverage || coverage.complete) return null;

  return (
    <div
      role="note"
      className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3"
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
      <div>
        <p className="text-sm font-medium text-amber-900">
          On-time figures cover {coverage.ordersScored} of {coverage.ordersInRange} orders.
        </p>
        <p className="mt-0.5 text-xs text-amber-800">{coverage.note}</p>
      </div>
    </div>
  );
}

export function AnalyticsTab() {
  const [data, setData] = useState(null);
  const [range, setRange] = useState({ from: "", to: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await o2dApi.analytics({
          ...(range.from ? { from: new Date(`${range.from}T00:00:00+05:30`).toISOString() } : {}),
          ...(range.to ? { to: new Date(`${range.to}T23:59:59+05:30`).toISOString() } : {}),
        }),
      );
    } catch (err) {
      setError(err instanceof O2dApiError ? err : new O2dApiError(err.message));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Download via a blob, not a plain link.
   *
   * The export endpoint needs the Authorization header, which an `<a href>`
   * cannot carry — a direct link would hit the route unauthenticated and
   * download a 401 as a file called `orders.xlsx`.
   */
  const download = async (dataset) => {
    setDownloading(true);
    try {
      const blob = await o2dApi.exportDataset(dataset, {
        format: "xlsx",
        ...(range.from ? { from: new Date(`${range.from}T00:00:00+05:30`).toISOString() } : {}),
        ...(range.to ? { to: new Date(`${range.to}T23:59:59+05:30`).toISOString() } : {}),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `o2d-${dataset}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(new O2dApiError("That export could not be generated."));
    } finally {
      setDownloading(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="rounded-lg border border-slate-200 p-6">
        <p className="text-sm text-slate-600">{error.message}</p>
        <Button size="sm" variant="secondary" className="mt-3" onClick={load}>
          Try again
        </Button>
      </div>
    );
  }

  const { summary, sla, delays, roles, cycle, customers } = data ?? {};
  const input =
    "rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-primary-500";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-600">
          From
          <input
            type="date"
            className={`${input} ml-2`}
            value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          />
        </label>
        <label className="text-xs text-slate-600">
          To
          <input
            type="date"
            className={`${input} ml-2`}
            value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          />
        </label>
        <Button size="sm" variant="secondary" disabled={downloading} onClick={() => download("orders")}>
          <Download size={14} className="mr-1" />
          Orders
        </Button>
        <Button size="sm" variant="secondary" disabled={downloading} onClick={() => download("stages")}>
          <Download size={14} className="mr-1" />
          Stages
        </Button>
      </div>

      {/* ── Volume ───────────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Open orders" value={summary?.open} />
        <Stat label="On hold" value={summary?.onHold} tone={summary?.onHold ? "warning" : "default"} />
        <Stat
          label="Overdue stages"
          value={summary?.overdueStages}
          tone={summary?.overdueStages ? "danger" : "success"}
        />
        <Stat label="Dispatched" value={summary?.dispatched} />
      </div>

      {/* ── SLA, with its coverage attached ──────────────────────────────── */}
      <Section title="On-time performance">
        <div className="flex flex-col gap-3">
          <CoverageBanner coverage={sla?.coverage} />

          <div className="grid gap-3 sm:grid-cols-3">
            <Stat
              label="On time"
              value={sla?.onTimePercentage}
              suffix="%"
              tone={
                sla?.onTimePercentage === null
                  ? "default"
                  : sla?.onTimePercentage >= 90
                    ? "success"
                    : "warning"
              }
              hint={
                sla?.onTimePercentage === null
                  ? "Nothing in this range could be scored."
                  : `${sla?.onTime} of ${sla?.completed} stages`
              }
            />
            <Stat label="Stages completed" value={sla?.completed} />
            <Stat label="Stages late" value={sla?.late} tone={sla?.late ? "warning" : "default"} />
          </div>

          {sla?.byStage?.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                    <th className="py-1.5 pr-2">Stage</th>
                    <th className="py-1.5 pr-2">Owner</th>
                    <th className="py-1.5 pr-2">Done</th>
                    <th className="py-1.5 pr-2">On time</th>
                    <th className="py-1.5">Avg delay when late</th>
                  </tr>
                </thead>
                <tbody>
                  {sla.byStage.map((s) => (
                    <tr key={s.stageNumber} className="border-b border-slate-100">
                      <td className="py-1.5 pr-2">
                        {s.stageNumber}. {s.stageName}
                      </td>
                      <td className="py-1.5 pr-2 text-slate-500">{s.ownerRole}</td>
                      <td className="py-1.5 pr-2">{s.completed}</td>
                      <td className="py-1.5 pr-2">
                        {s.onTimePercentage === null ? "—" : `${s.onTimePercentage}%`}
                      </td>
                      <td className="py-1.5 text-slate-600">
                        {formatWorkingMinutes(s.averageDelayMinutes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Section>

      {/* ── Cycle time — a different denominator, said out loud ──────────── */}
      <Section title="Cycle time (PO to dispatch)">
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat
            label="Median"
            value={cycle?.medianHours}
            suffix=" hrs"
            hint="What a typical order actually took"
          />
          <Stat label="Average" value={cycle?.averageHours} suffix=" hrs" />
          <Stat label="Orders measured" value={cycle?.count} />
        </div>
        {cycle?.includesMigrated && (
          <p className="mt-2 text-xs text-slate-500">
            Includes {cycle.migratedCount} migrated order(s). Cycle time needs only actual dates, so
            historical orders can be measured here even though they cannot be scored above.
          </p>
        )}
      </Section>

      {/* ── Where the time goes ──────────────────────────────────────────── */}
      <Section title="Worst delays, by total time lost">
        {delays?.data?.length > 0 ? (
          <ul className="space-y-1.5">
            {delays.data.map((d) => (
              <li
                key={d.stageNumber}
                className="flex items-center justify-between gap-2 border-b border-slate-100 pb-1.5 text-sm"
              >
                <span>
                  {d.stageNumber}. {d.stageName}
                  <span className="ml-1 text-xs text-slate-500">{d.ownerRole}</span>
                </span>
                <span className="text-slate-600">
                  {formatWorkingMinutes(d.totalDelayMinutes)} across {d.lateCount} late
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">Nothing was late in this range.</p>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="By team">
          {roles?.data?.length > 0 ? (
            <ul className="space-y-1.5 text-sm">
              {roles.data.map((r) => (
                <li key={r.role} className="flex justify-between border-b border-slate-100 pb-1.5">
                  <span>{r.role}</span>
                  <span className="text-slate-600">
                    {r.onTimePercentage}% of {r.completed}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">Nothing scorable in this range.</p>
          )}
        </Section>

        <Section title="Slowest customers, by average cycle">
          {customers?.data?.length > 0 ? (
            <ul className="space-y-1.5 text-sm">
              {customers.data.slice(0, 8).map((c) => (
                <li
                  key={c.customerKey}
                  className="flex justify-between border-b border-slate-100 pb-1.5"
                >
                  <span>{c.customerName}</span>
                  <span className="text-slate-600">
                    {c.averageHours} hrs · {c.orders} order(s)
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">No dispatched orders in this range.</p>
          )}
        </Section>
      </div>
    </div>
  );
}

export default AnalyticsTab;
