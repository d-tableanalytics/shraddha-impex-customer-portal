import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { LogOut, FileText, Loader2 } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { ErrorState } from "../../../components/hrms/ErrorState";
import { SkeletonLoader } from "../../../components/ui/SkeletonLoader";
import {
  exitsApi,
  formatDay,
  formatInstant,
  formatMoney,
  EXIT_REASON_LABELS,
  CLEARANCE_AREA_LABELS,
} from "../../../services/hrms";
import {
  ExitStatusBadge,
  ClearanceStatusBadge,
  ExitProgress,
  ClearanceProgress,
  Field,
} from "./exitsShared";
import { InitiateExitDrawer } from "./InitiateExitDrawer";

/**
 * The signed-in employee's own exit.
 *
 * The reference's `MyExitTab`, with one structural difference: it downloads
 * every exit request the viewer can see and picks its own out in the browser.
 * There is a `/exits/me` endpoint here, so one row comes back.
 */

const TERMINAL = new Set(["closed", "cancelled"]);

export function MyExitTab() {
  const [exit, setExit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setExit(await exitsApi.mine());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const withdraw = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      setExit(await exitsApi.cancel(exit.id));
      toast.success("Your exit request has been withdrawn.");
    } catch (err) {
      toast.error(err?.message ?? "That request could not be withdrawn.");
    } finally {
      setBusy(false);
    }
  };

  const viewLetter = async () => {
    setBusy(true);
    try {
      const { url } = await exitsApi.relievingLetterUrl(exit.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err?.message ?? "That letter could not be opened.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SkeletonLoader className="h-64" />;
  if (error) {
    return (
      <ErrorState
        title="Could not load your exit"
        description={error?.message ?? "Something went wrong."}
        onRetry={load}
      />
    );
  }

  // Nothing filed, or the last one is finished — offer a new one.
  if (!exit || TERMINAL.has(exit.status)) {
    return (
      <div>
        {exit && <PastExit exit={exit} onViewLetter={viewLetter} busy={busy} />}

        <div className="rounded-lg border border-slate-200 bg-white px-6 py-10 text-center">
          <LogOut className="mx-auto h-8 w-8 text-slate-300" aria-hidden="true" />
          <h3 className="mt-3 text-sm font-semibold text-slate-900">
            You have no active exit request
          </h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            Resigning starts a formal process: your manager and HR approve it, each area signs
            off a clearance, and your full and final settlement is computed.
          </p>
          <Button className="mt-4" onClick={() => setDrawerOpen(true)}>
            Initiate resignation
          </Button>
        </div>

        <InitiateExitDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onCreated={load}
        />
      </div>
    );
  }

  const canWithdraw = !["cleared", "f_and_f_pending"].includes(exit.status);

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-slate-900">My exit request</h3>
            <ExitStatusBadge status={exit.status} />
          </div>
          {canWithdraw ? (
            <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
              Withdraw
            </Button>
          ) : (
            <span className="text-xs text-slate-500">
              Your clearances are complete — ask HR to withdraw this.
            </span>
          )}
        </div>

        <div className="mb-6 overflow-x-auto">
          <ExitProgress status={exit.status} />
        </div>

        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Reason category">
            {EXIT_REASON_LABELS[exit.reasonCategory] ?? exit.reasonCategory}
          </Field>
          <Field label="Requested last day">{formatDay(exit.requestedLastDay)}</Field>
          <Field label="Actual last day">
            {exit.actualLastDay ? formatDay(exit.actualLastDay) : "Not confirmed yet"}
          </Field>
          <Field label="Initiated">{formatInstant(exit.initiatedAt)}</Field>
          <Field label="Manager approved">{formatInstant(exit.managerApprovedAt)}</Field>
          <Field label="HR approved">{formatInstant(exit.hrApprovedAt)}</Field>
          <Field label="Reason" wide>
            {exit.reason}
          </Field>
          {exit.transferNotes && (
            <Field label="Handover notes" wide>
              {exit.transferNotes}
            </Field>
          )}
          {exit.replacementEmployeeName && (
            <Field label="Handing over to">{exit.replacementEmployeeName}</Field>
          )}
        </dl>
      </div>

      {exit.clearances.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-900">Clearances</h3>
          <ClearanceProgress clearances={exit.clearances} />
          <ul className="mt-4 divide-y divide-slate-100">
            {exit.clearances.map((clearance) => (
              <li key={clearance.id} className="flex items-center justify-between py-2">
                <span className="text-sm text-slate-700">
                  <span className="font-medium">
                    {CLEARANCE_AREA_LABELS[clearance.area] ?? clearance.area}
                  </span>
                  {clearance.assigneeName && (
                    <span className="ml-2 text-slate-500">{clearance.assigneeName}</span>
                  )}
                </span>
                <ClearanceStatusBadge status={clearance.status} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {exit.fullAndFinal && <SettlementCard fnf={exit.fullAndFinal} />}

      <ConfirmationDialog
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={withdraw}
        title="Withdraw your exit request?"
        description="Your manager and HR will be notified. You can raise a new request later if you need to."
        confirmText="Withdraw request"
        variant="danger"
      />
    </div>
  );
}

/** A finished or withdrawn exit, shown above the offer to file a new one. */
function PastExit({ exit, onViewLetter, busy }) {
  return (
    <div className="mb-5 rounded-lg border border-slate-200 bg-white p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-900">Your previous exit request</h3>
        <ExitStatusBadge status={exit.status} />
      </div>
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Last working day">
          {formatDay(exit.actualLastDay ?? exit.requestedLastDay)}
        </Field>
        <Field label="Closed">{formatInstant(exit.closedAt ?? exit.cancelledAt)}</Field>
      </dl>

      {exit.relievingLetter && (
        <div className="mt-4 flex items-center justify-between rounded-lg border border-primary-200 bg-primary-50 px-4 py-3">
          <span className="text-sm text-primary-700">Your relieving letter is available.</span>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onViewLetter}>
            {busy ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <FileText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            )}
            View letter
          </Button>
        </div>
      )}
    </div>
  );
}

/** The settlement, as the leaver sees it. */
export function SettlementCard({ fnf, title = "Full and final settlement" }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <h3 className="mb-4 text-sm font-semibold text-slate-900">{title}</h3>

      <div className="mb-4 grid grid-cols-3 gap-4">
        {[
          ["Gross", fnf.gross, "text-slate-900"],
          ["Deductions", fnf.deductions, "text-slate-900"],
          ["Net payable", fnf.netPayable, "text-success-600"],
        ].map(([label, value, tone]) => (
          <div key={label}>
            <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
            <div className={`mt-0.5 text-base font-semibold tabular-nums ${tone}`}>
              {formatMoney(value)}
            </div>
          </div>
        ))}
      </div>

      <LineTable title="Earnings" lines={fnf.earnings} />
      {fnf.deductionLines.length > 0 && (
        <LineTable title="Deductions" lines={fnf.deductionLines} />
      )}

      <p className="mt-3 text-xs text-slate-500">
        {fnf.disbursedAt
          ? `Disbursed on ${formatInstant(fnf.disbursedAt)}.`
          : "Awaiting disbursement."}
      </p>
    </div>
  );
}

function LineTable({ title, lines }) {
  if (!lines?.length) return null;
  return (
    <div className="mt-3">
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h4>
      <table className="w-full text-sm">
        <tbody>
          {lines.map((line) => (
            <tr key={line.code} className="border-b border-slate-100 last:border-0">
              <td className="py-1.5 text-slate-700">{line.label}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-900">
                {formatMoney(line.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default MyExitTab;
