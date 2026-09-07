import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, UserPlus, X } from "lucide-react";

import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { ErrorState } from "../../../components/hrms/ErrorState";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LoadingSpinner } from "../../../components/ui/LoadingSpinner";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Modal } from "../../../components/ui/Modal";
import {
  requisitionsApi,
  applicationsApi,
  candidatesApi,
  STAGE_LABELS,
} from "../../../services/hrms/hiring";
import {
  APPLICATION_TRANSITIONS,
  CLOSED_APPLICATION_STAGES,
} from "@shared/constants/hiring.js";

/**
 * The pipeline board.
 *
 * ---------------------------------------------------------------------------
 * A board, not a table
 * ---------------------------------------------------------------------------
 * Six columns in the funnel's order, one card per applicant, the whole set
 * loaded at once — the reference's Kanban, and the reason `pipelineBoard` is
 * deliberately unpaginated. A board showing page one of "applied" is not a
 * board.
 *
 * Movement is by BUTTON, not by drag. The reference uses drag-and-drop and
 * allows any column to be dropped on; here a move is forward by exactly one
 * stage or a rejection, because that is what the server's transition table
 * permits and offering a gesture the API will refuse is worse than not
 * offering it. It also keeps the board usable by keyboard and on a phone,
 * which a drag surface is not.
 */
export function PipelineTab({ canEdit = false }) {
  const [requisitions, setRequisitions] = useState([]);
  const [requisitionId, setRequisitionId] = useState(null);
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);

  // The picker lists the requisitions worth looking at — a cancelled one has no
  // live pipeline.
  useEffect(() => {
    let cancelled = false;
    requisitionsApi
      .list({ page: 1, pageSize: 100 })
      .then((res) => {
        if (cancelled) return;
        const rows = (res?.data ?? []).filter((r) => r.status !== "cancelled");
        setRequisitions(rows);
        setRequisitionId((current) => current ?? rows[0]?.id ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    if (!requisitionId) return;
    setLoading(true);
    setError(null);
    try {
      setBoard(await requisitionsApi.pipeline(requisitionId));
    } catch (err) {
      setError(err);
      setBoard(null);
    } finally {
      setLoading(false);
    }
  }, [requisitionId]);

  useEffect(() => {
    load();
  }, [load]);

  const move = useCallback(
    async (application, stage) => {
      setBusy(application.id);
      setFailure(null);
      try {
        await applicationsApi.move(application.id, stage);
        await load();
      } catch (err) {
        // "They have not accepted an offer yet" arrives here, and is a rule the
        // recruiter needs to read rather than a button that does nothing.
        setFailure(err?.message ?? "That candidate could not be moved.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const selected = useMemo(
    () => requisitions.find((r) => r.id === requisitionId) ?? null,
    [requisitions, requisitionId],
  );

  const columns = board?.columns ?? [];
  const notShown = board ? (board.total ?? 0) - (board.loaded ?? 0) : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <SearchableSelect
          className="w-80"
          value={requisitionId}
          onChange={setRequisitionId}
          options={requisitions.map((r) => ({
            value: r.id,
            label: r.title,
            hint: [r.departmentName, r.status].filter(Boolean).join(" · "),
          }))}
          allowClear={false}
          placeholder="Choose a requisition"
        />
        {canEdit && selected && (
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
            <UserPlus size={14} className="mr-1.5" />
            Add candidate to pipeline
          </Button>
        )}
      </div>

      {failure && (
        <p role="alert" className="text-xs text-error-500 font-medium">
          {failure}
        </p>
      )}

      {notShown > 0 && (
        <p className="text-xs text-warning-600 font-medium">
          Showing {board.loaded} of {board.total} applicants. Filter by stage on the Candidates tab
          to see the rest.
        </p>
      )}

      {error ? (
        <ErrorState
          variant={error.isForbidden ? "forbidden" : "error"}
          description={error.message}
          onRetry={load}
        />
      ) : loading ? (
        <div className="flex items-center justify-center min-h-[40vh]">
          <LoadingSpinner size={32} />
        </div>
      ) : !requisitionId ? (
        <EmptyState
          title="No requisitions yet"
          description="A pipeline belongs to a requisition. Raise one first."
        />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {columns.map((column) => (
            <PipelineColumn
              key={column.stage}
              column={column}
              canEdit={canEdit}
              busy={busy}
              onAdvance={move}
              onReject={setRejecting}
            />
          ))}
        </div>
      )}

      <RejectDialog
        application={rejecting}
        onClose={() => setRejecting(null)}
        onDone={() => {
          setRejecting(null);
          load();
        }}
      />

      <AddToPipelineDialog
        open={adding}
        requisition={selected}
        onClose={() => setAdding(false)}
        onDone={() => {
          setAdding(false);
          load();
        }}
      />
    </div>
  );
}

function PipelineColumn({ column, canEdit, busy, onAdvance, onReject }) {
  const { stage, applications } = column;
  /** The single legal forward move, straight from the server's own table. */
  const next = (APPLICATION_TRANSITIONS[stage] ?? []).find((s) => s !== "rejected") ?? null;
  const closed = CLOSED_APPLICATION_STAGES.includes(stage);

  return (
    <section
      aria-label={STAGE_LABELS[stage] ?? stage}
      className="flex flex-col min-w-[248px] w-[248px] shrink-0 bg-slate-50 border border-slate-200 rounded-xl"
    >
      <header className="flex items-center justify-between px-3 py-2.5 border-b border-slate-200">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-600">
          {STAGE_LABELS[stage] ?? stage}
        </span>
        <span className="px-1.5 py-0.5 rounded-full bg-white border border-slate-200 text-[10px] font-bold text-slate-500 tabular-nums">
          {applications.length}
        </span>
      </header>

      <div className="flex flex-col gap-2 p-2 min-h-[120px]">
        {applications.length === 0 ? (
          <p className="px-1 py-6 text-center text-[11px] text-slate-400">Nobody here</p>
        ) : (
          applications.map((application) => (
            <article
              key={application.id}
              className="flex flex-col gap-1.5 p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm"
            >
              <div className="flex flex-col">
                <span className="text-sm font-semibold text-slate-900 leading-tight">
                  {application.candidateName ?? "Unknown candidate"}
                </span>
                <span className="text-[10.5px] text-slate-500 break-all">
                  {application.candidateEmail}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1">
                {application.interviewCount > 0 && (
                  <Badge variant="neutral" className="text-[10px] px-1.5 py-0">
                    {application.interviewCount} interview
                    {application.interviewCount === 1 ? "" : "s"}
                  </Badge>
                )}
                {application.hasOffer && (
                  <Badge variant="warning" className="text-[10px] px-1.5 py-0">
                    Offer
                  </Badge>
                )}
              </div>

              {application.rejectionReason && (
                <p className="text-[10.5px] text-slate-500 leading-snug">
                  {application.rejectionReason}
                </p>
              )}

              {canEdit && !closed && (
                <div className="flex items-center gap-1 pt-1 border-t border-slate-100">
                  {next && (
                    <Button
                      size="xs"
                      variant="outline"
                      className="flex-1"
                      loading={busy === application.id}
                      onClick={() => onAdvance(application, next)}
                    >
                      {STAGE_LABELS[next] ?? next}
                      <ChevronRight size={12} className="ml-0.5" />
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Reject ${application.candidateName}`}
                    className="text-error-500"
                    onClick={() => onReject(application)}
                  >
                    <X size={12} />
                  </Button>
                </div>
              )}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

/** A rejection needs a reason — the shared schema requires one. */
function RejectDialog({ application, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setReason("");
    setFailure(null);
  }, [application]);

  if (!application) return null;

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);
    if (reason.trim().length === 0) {
      setFailure("Give a reason for the rejection.");
      return;
    }
    setSubmitting(true);
    try {
      await applicationsApi.move(application.id, "rejected", reason.trim());
      onDone();
    } catch (err) {
      setFailure(err?.message ?? "That candidate could not be rejected.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Reject ${application.candidateName ?? "candidate"}?`} size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-slate-600 leading-relaxed">
          A rejection is final for this requisition — the candidate can be put forward for a
          different one.
        </p>

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="rejection-reason" className="text-xs font-semibold text-slate-700">
            Reason
          </label>
          <textarea
            id="rejection-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          <span className="text-xs text-slate-500">
            Recorded against the application. Keep it factual — it is auditable.
          </span>
        </div>

        {failure && (
          <p role="alert" className="text-xs text-error-500 font-medium">
            {failure}
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Keep them in
          </Button>
          <Button type="submit" variant="danger" loading={submitting}>
            Reject
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AddToPipelineDialog({ open, requisition, onClose, onDone }) {
  const [candidates, setCandidates] = useState([]);
  const [candidateId, setCandidateId] = useState(null);
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCandidateId(null);
    setFailure(null);
    candidatesApi
      .list({ page: 1, pageSize: 100 })
      .then((res) => setCandidates(res?.data ?? []))
      .catch(() => setFailure("The candidate list could not be loaded."));
  }, [open]);

  if (!open || !requisition) return null;

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);
    if (!candidateId) {
      setFailure("Pick a candidate.");
      return;
    }
    setSubmitting(true);
    try {
      await applicationsApi.create({ candidateId, requisitionId: requisition.id });
      onDone();
    } catch (err) {
      // "Already applied" is the common one, and the unique index is what
      // actually guarantees it.
      setFailure(err?.message ?? "That candidate could not be added.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Add to "${requisition.title}"`} size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <SearchableSelect
          label="Candidate"
          value={candidateId}
          onChange={setCandidateId}
          options={candidates.map((c) => ({ value: c.id, label: c.name, hint: c.email }))}
          placeholder="Search candidates…"
        />

        <p className="text-[11px] text-slate-500">
          They enter at <strong>{STAGE_LABELS.applied}</strong>. A candidate can only be in a
          requisition's pipeline once.
        </p>

        {failure && (
          <p role="alert" className="text-xs text-error-500 font-medium">
            {failure}
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            Add to pipeline
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default PipelineTab;
