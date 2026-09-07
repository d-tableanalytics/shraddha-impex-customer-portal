import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { Button } from "../../../components/ui/Button";
import { ClockCard } from "./ClockCard";
import { ConsentPanel } from "./ConsentPanel";
import { CorrectionDrawer } from "./CorrectionDrawer";
import { SelfieThumb } from "./SelfieThumb";
import { StatusCell, CELL, HEAD_CELL, PAGE_SIZE } from "./attendanceTable";
import {
  attendanceApi,
  attendanceConsentApi,
  attendanceCorrectionsApi,
} from "../../../services/hrms";
import { formatDate, formatTime, formatHoursDecimal, formatLocation } from "./attendanceFormat";

/**
 * "My Attendance" — the clock card and the caller's own history.
 *
 * ---------------------------------------------------------------------------
 * Laid out as the reference lays it out
 * ---------------------------------------------------------------------------
 * `<Row gutter={16}><Col span={8}>…</Col><Col span={16}>…</Col></Row>` — a 1:2
 * split with a 16px gutter, the clock card and its "Request correction" button
 * stacked on the left, the history table filling the right
 * (`AttendancePage.tsx:249-260`). Collapses to one column below `lg`, card
 * first, which is the order that matters on a phone.
 *
 * ---------------------------------------------------------------------------
 * The derived status comes from the SERVER
 * ---------------------------------------------------------------------------
 * `row.derived` is computed by `@shared/attendance/status.js`, the same module
 * the API imports. The reference computes Full day / Half day / Present in the
 * browser only, so its API says `present` for all three and any other consumer
 * would have to restate the 7h45m rule. Rendering what the server derived means
 * there is one answer.
 */
export function MyAttendanceTab({ drawerSignal }) {
  const [record, setRecord] = useState(null);
  const [consent, setConsent] = useState(null);
  const [history, setHistory] = useState({ data: [], total: 0, page: 1, pageSize: PAGE_SIZE });
  const [pendingDates, setPendingDates] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerDate, setDrawerDate] = useState(null);
  const [drawerRecord, setDrawerRecord] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fired together rather than in sequence: the card, the consent strip and
      // the table are independent, and awaiting each in turn would make the
      // page appear in three visible steps.
      const [today, consentState, list, corrections] = await Promise.all([
        attendanceApi.today(),
        attendanceConsentApi.get(),
        attendanceApi.list({ page, pageSize: PAGE_SIZE }),
        attendanceCorrectionsApi.list({ status: "pending", pageSize: 100 }),
      ]);

      setRecord(today);
      setConsent(consentState);
      setHistory(list ?? { data: [], total: 0, page, pageSize: PAGE_SIZE });
      setPendingDates(new Set((corrections?.data ?? []).map((c) => c.date)));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const openCorrection = useCallback((row) => {
    setDrawerDate(row?.date ?? null);
    setDrawerRecord(row ?? null);
    setDrawerOpen(true);
  }, []);

  /**
   * The page header's "Request correction" button lives above the tabs, so it
   * cannot reach this tab's drawer directly. It bumps a counter instead and the
   * drawer opens here, where the record it should prefill is known.
   */
  useEffect(() => {
    // 0 is the initial value, so this cannot fire on mount.
    if (drawerSignal) openCorrection(null);
  }, [drawerSignal, openCorrection]);

  const changeConsent = async (purpose, granted) => {
    await attendanceConsentApi.set(purpose, granted);
    // A withdrawal ERASES already-captured photos and coordinates, so the table
    // beside this strip is stale the moment it returns. Reloading is not
    // optional politeness — it is the difference between the screen agreeing
    // with the database and showing a photo that no longer exists.
    await load();
  };

  /**
   * A missing punch offers a correction link, unless one is already queued.
   *
   * The reference swaps the link for a "Correction pending" chip purely in the
   * browser, and its API still accepts a duplicate. Here the chip is a courtesy
   * and the server's partial unique index is the actual guarantee.
   */
  const punchCell = useCallback((iso, row) => {
    if (iso) return <span className="tabular-nums">{formatTime(iso)}</span>;
    if (pendingDates.has(row.date)) {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-primary-50 text-primary-700 border border-primary-200">
          Correction pending
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={() => openCorrection(row)}
        className="text-xs text-primary-600 hover:text-primary-700 hover:underline font-medium focus:outline-none focus:ring-2 focus:ring-primary-500 rounded"
      >
        Add correction
      </button>
    );
  }, [pendingDates, openCorrection]);

  const columns = useMemo(
    () => [
      {
        header: "Date",
        accessorKey: "date",
        className: `${CELL} w-[140px] font-semibold text-slate-900`,
        headerClassName: HEAD_CELL,
        cell: (row) => formatDate(row.date),
      },
      {
        header: "Clock in",
        className: `${CELL} w-[150px]`,
        headerClassName: HEAD_CELL,
        cell: (row) => punchCell(row.clockIn, row),
      },
      {
        header: "Clock out",
        className: `${CELL} w-[150px]`,
        headerClassName: HEAD_CELL,
        cell: (row) => punchCell(row.clockOut, row),
      },
      {
        header: "Hours",
        className: `${CELL} w-[90px] tabular-nums`,
        headerClassName: HEAD_CELL,
        cell: (row) => formatHoursDecimal(row.hoursWorked),
      },
      {
        header: "Source",
        className: `${CELL} w-[100px]`,
        headerClassName: HEAD_CELL,
        cell: (row) => (
          <span className="inline-flex items-center gap-1">
            <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-600 border border-slate-200">
              {row.source}
            </span>
            {row.corrected && (
              <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-warning-50 text-warning-600 border border-warning-200">
                corrected
              </span>
            )}
          </span>
        ),
      },
      {
        header: "Status",
        className: `${CELL} w-[200px]`,
        headerClassName: HEAD_CELL,
        cell: (row) => <StatusCell derived={row.derived} />,
      },
      {
        header: "Selfie / Location",
        className: `${CELL} w-[170px]`,
        headerClassName: HEAD_CELL,
        cell: (row) => {
          const location = formatLocation(row.clockInCapture) ?? formatLocation(row.clockOutCapture);
          const hasSelfie = row.clockInCapture?.hasSelfie || row.clockOutCapture?.hasSelfie;
          if (!hasSelfie && !location) return <span className="text-slate-400">—</span>;

          return (
            <div className="flex flex-col gap-1">
              {hasSelfie && (
                <div className="flex gap-1">
                  {row.clockInCapture?.hasSelfie && (
                    <SelfieThumb recordId={row.id} punch="in" label="In" />
                  )}
                  {row.clockOutCapture?.hasSelfie && (
                    <SelfieThumb recordId={row.id} punch="out" label="Out" />
                  )}
                </div>
              )}
              {location && (
                <span className="text-[11px] text-slate-500 leading-snug line-clamp-2" title={location}>
                  {location}
                </span>
              )}
            </div>
          );
        },
      },
    ],
    // `punchCell` already closes over `pendingDates` and `openCorrection`, so
    // it is the only dependency the columns actually have.
    [punchCell],
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
      <div className="lg:col-span-1 flex flex-col gap-3">
        <ClockCard
          record={record}
          consent={consent}
          onPunched={(updated) => {
            setRecord(updated);
            // The new punch belongs at the top of the history too, and the
            // hours on an existing row change on clock-out.
            load();
          }}
          onError={(err) => setError(err)}
        />

        <Button variant="secondary" onClick={() => openCorrection(null)} className="w-full">
          <Pencil size={14} className="mr-1.5" />
          Request correction
        </Button>

        <ConsentPanel consent={consent} onChange={changeConsent} />
      </div>

      <div className="lg:col-span-2 min-w-0">
        <HrmsDataTable
          columns={columns}
          rows={history.data}
          loading={loading}
          error={error}
          onRetry={load}
          page={history.page ?? page}
          pageSize={history.pageSize ?? PAGE_SIZE}
          total={history.total ?? 0}
          onPageChange={setPage}
          emptyTitle="No attendance yet"
          emptyDescription="Once you clock in, your days appear here."
        />
      </div>

      <CorrectionDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        initialDate={drawerDate}
        existingRecord={drawerRecord}
        onSubmitted={load}
      />
    </div>
  );
}

export default MyAttendanceTab;
