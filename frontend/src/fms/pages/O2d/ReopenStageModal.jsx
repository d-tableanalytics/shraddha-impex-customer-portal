import { useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";

import { Button } from "../../components/ui/Button";
import { o2dApi } from "../../services/o2d/orders";
import { STAGES } from "@shared/constants/o2d.js";

/**
 * Send a completed stage back for rework.
 *
 * The server keeps the previous completion in the stage history and audit log;
 * this form only collects the reason and whether later completed stages are
 * redone too.
 */
export function ReopenStageModal({ order, stage, onClose, onReopened }) {
  const [reason, setReason] = useState("");
  const [resetDownstream, setResetDownstream] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!stage) return null;

  const resetsStage5 = stage.stageNumber === STAGES.ADVANCE_DECISION;

  const submit = async () => {
    if (!reason.trim()) {
      setError("A reason is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await o2dApi.reopenStage(order._id, stage.stageNumber, {
        reason: reason.trim(),
        resetDownstream,
      });
      onReopened?.();
      onClose();
    } catch (err) {
      setError(err?.message ?? "That stage could not be reopened.");
    } finally {
      setBusy(false);
    }
  };

  const input =
    "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none " +
    "focus:border-primary-500 focus:ring-1 focus:ring-primary-500";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div role="dialog" aria-modal="true" className="w-full max-w-lg rounded-xl bg-white shadow-enterprise-lg">
        <div className="border-b border-slate-100 px-5 py-4">
          <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <RotateCcw size={15} className="text-amber-600" />
            Send stage {stage.stageNumber} back for rework — {stage.stageName}
          </h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {order?.poNumber} · The stage becomes the current task again for {stage.ownerRole}
            {stage.assignedToName ? ` (${stage.assignedToName})` : ""}. Its previous completion stays in
            the history.
          </p>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          <div>
            <label
              htmlFor="rs-reason"
              className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500"
            >
              Reason<span className="ml-0.5 text-error-600">*</span>
            </label>
            <textarea
              id="rs-reason"
              rows={3}
              maxLength={500}
              className={`${input} ${error && !reason.trim() ? "border-error-500" : ""}`}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setError(null);
              }}
            />
          </div>

          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={resetDownstream}
              onChange={(e) => setResetDownstream(e.target.checked)}
            />
            <span>
              Also redo every later completed stage
              <span className="block text-[11px] text-slate-500">
                Unticked, later completed stages are kept and only the next unfinished stage waits for this
                rework.
                {resetsStage5 && " Stage 5 is always reset, because this decision determines it."}
              </span>
            </span>
          </label>

          {error && (
            <p className="rounded-lg border border-error-200 bg-error-50 px-3 py-2 text-[11px] font-semibold text-error-700">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <Button size="sm" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy && <Loader2 size={14} className="mr-1 animate-spin" />}
            Send back for rework
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ReopenStageModal;
