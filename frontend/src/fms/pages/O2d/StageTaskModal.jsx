import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "../../components/ui/Button";
import { o2dApi } from "../../services/o2d/orders";
import { TERMINAL_STAGE_STATUSES } from "@shared/constants/o2d.js";
import { CompleteStageModal } from "./CompleteStageModal";

/**
 * Open one O2D stage's completion form from a task list (My Tasks, Checklist).
 *
 * Loads the order first so the form gets the real stage row — its stored
 * evidence, owner, deadline and assignee — rather than the thin copy a task row
 * carries. Completion itself is `CompleteStageModal`, unchanged: the same form,
 * validation and API Order Tracker uses.
 */
export function StageTaskModal({ orderId, stageNumber, onClose, onCompleted }) {
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    o2dApi.get(orderId)
      .then((full) => {
        if (!live) return;
        const stage = (full?.stages ?? []).find((s) => s.stageNumber === Number(stageNumber));
        if (!stage) setError("That stage is not visible to you on this order.");
        else if (TERMINAL_STAGE_STATUSES.includes(stage.status)) setError(`${stage.stageName} is already complete.`);
        else setLoaded({ order: full.order, stage });
      })
      .catch((err) => live && setError(err?.message ?? "Could not load that order."));
    return () => { live = false; };
  }, [orderId, stageNumber]);

  if (loaded) {
    return (
      <CompleteStageModal
        order={loaded.order}
        stage={loaded.stage}
        onClose={onClose}
        onCompleted={onCompleted}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div role="dialog" aria-modal="true" className="w-full max-w-sm rounded-xl bg-white p-5 shadow-enterprise-lg">
        {error ? (
          <>
            <p className="text-sm text-slate-700">{error}</p>
            <div className="mt-3 flex justify-end">
              <Button size="sm" variant="secondary" onClick={onClose}>Close</Button>
            </div>
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm text-slate-600">
            <Loader2 size={15} className="animate-spin" /> Loading stage…
          </p>
        )}
      </div>
    </div>
  );
}

export default StageTaskModal;
