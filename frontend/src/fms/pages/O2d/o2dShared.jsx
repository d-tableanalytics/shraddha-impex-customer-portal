import { useState } from "react";
import { Check, Lock, SkipForward, Paperclip } from "lucide-react";

import { Badge } from "../../components/ui/Badge";
import { STAGE_FIELD_TYPES, fieldsForStage } from "@shared/constants/o2dStageFields.js";
import {
  STAGE_STATUS_LABELS,
  displayStatus,
  displayTone,
  stageFlags,
  ORDER_STATUS_LABELS,
  BUCKET_LABELS,
  stageTone,
  bucketTone,
  formatDateTime,
  formatDelay,
  formatDate,
} from "../../services/o2d/orders";
import { STAGE_STATUS, TERMINAL_STAGE_STATUSES } from "@shared/constants/o2d.js";

/**
 * Presentation shared by the O2D screens.
 *
 * Kept beside the pages rather than in `components/`, the way each HRMS module
 * keeps its `<module>Shared.jsx`: these know about stages and SLAs and are not
 * reusable outside O2D, and promoting them to the shared component folder would
 * invite somebody to make them general and break both callers.
 */

/** Unknown statuses render their raw value rather than vanishing. */
/**
 * A stage's status, as two working states.
 *
 * The timing is NOT in the badge any more - it is a separate marker beside it
 * (see StageFlags). A stage used to be able to say only one thing, so an
 * overdue stage read "Overdue" and a finished-late one read "Done late", which
 * made the status a verdict rather than a state. Now it says what the work is,
 * and the clock speaks for itself next to it.
 */
export const StageBadge = ({ status, className }) => (
  <Badge variant={displayTone(status)} className={className}>
    {status === STAGE_STATUS.LOCKED && <Lock size={10} className="mr-1" aria-hidden="true" />}
    {TERMINAL_STAGE_STATUSES.includes(status) && (
      <Check size={10} strokeWidth={3} className="mr-1" aria-hidden="true" />
    )}
    {displayStatus(status)}
  </Badge>
);

/**
 * The facts the two-state badge drops, as their own markers.
 *
 * Rendered beside the badge rather than inside it, so "In Progress" and a red
 * OVERDUE marker can be true at once - which is the thing the desk actually
 * needs to see and the old single-status vocabulary could not express.
 *
 * Renders nothing on a stage that is simply proceeding, which is most of them:
 * a row of markers that is always present is a row nobody reads.
 */
export const StageFlags = ({ stage, className = "" }) => {
  const f = stageFlags(stage ?? {});
  const chips = [
    f.overdue && ["Overdue", "bg-error-50 text-error-700 border-error-200"],
    f.dueSoon && ["Due soon", "bg-amber-50 text-amber-700 border-amber-200"],
    f.held && ["On hold", "bg-slate-100 text-slate-600 border-slate-200"],
    f.skipped && ["Skipped", "bg-slate-100 text-slate-500 border-slate-200"],
    // `formatDelay` already renders "3h 5m late"; it is only reached when the
    // stage IS late, so its "On time" branch cannot fire here.
    f.late && [
      f.delayMinutes ? formatDelay(f.delayMinutes) : "Late",
      "bg-amber-50 text-amber-700 border-amber-200",
    ],
  ].filter(Boolean);

  if (chips.length === 0) return null;

  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className}`}>
      {chips.map(([label, tone]) => (
        <span
          key={label}
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}
        >
          {label}
        </span>
      ))}
    </span>
  );
};

export const OrderStatusBadge = ({ status, className }) => (
  <Badge
    variant={
      { OPEN: "primary", ON_HOLD: "warning", CLOSED: "success", CANCELLED: "danger", VOID: "neutral" }[
        status
      ] ?? "neutral"
    }
    className={className}
  >
    {ORDER_STATUS_LABELS[status] ?? status ?? "Unknown"}
  </Badge>
);

export const BucketBadge = ({ bucket, className }) => (
  <Badge variant={bucketTone(bucket)} className={className}>
    {BUCKET_LABELS[bucket] ?? bucket}
  </Badge>
);

/**
 * Which Work Queue list an assigned stage's task actually appears on.
 *
 * Read from the stage's own link fields rather than recomputed from the
 * stage number: the server decided this when it created the mirror, and a
 * second opinion here could disagree with the row the assignee is looking at.
 * Exactly one of the two is ever set — see O2dOrderStage.js.
 */
export const mirrorSurfaceOf = (stage) => {
  if (stage?.checklistOccurrenceId) return 'Checklist';
  if (stage?.delegationId) return 'Delegation list';
  return 'Work Queue';
};

/**
 * The twelve stages as a vertical timeline — the heart of Order 360 (§22).
 *
 * Renders EVERY stage, including the ones still locked, because "where is this
 * order and what is left" is the question the screen exists to answer, and a
 * list that shows only what has happened answers half of it.
 *
 * Three things are deliberately shown that a simpler stepper would drop:
 *
 *   the DEADLINE on an open stage, so the next action has a time attached;
 *   the DELAY on a late one, because "done" and "done four hours late" are
 *     different facts and the SLA engine exists to tell them apart;
 *   the REASON on a skipped one, since a skip with no reason is
 *     indistinguishable on screen from work that was never done.
 */
export function StageTimeline({
  stages = [],
  currentStage,
  onAct,
  actionableStages = [],
  assignableUsers,
  onAssign,
  onUnassign,
  assigningStage,
  onReopen,
  documents = [],
  onOpenDocument,
}) {
  const [expanded, setExpanded] = useState(null);

  if (stages.length === 0) {
    return <p className="text-sm text-slate-500">No stages recorded for this order.</p>;
  }

  return (
    <ol className="relative space-y-0" aria-label="Order progress">
      {stages.map((stage, index) => {
        const done = TERMINAL_STAGE_STATUSES.includes(stage.status);
        const locked = stage.status === STAGE_STATUS.LOCKED;
        // Any open stage, not just the order's cursor — an out-of-order override
        // can leave an earlier stage open behind it.
        const active = !done && !locked;
        const isCurrent = stage.stageNumber === currentStage;
        const skipped = stage.status === STAGE_STATUS.SKIPPED;
        const canAct = actionableStages.includes(stage.stageNumber) && isCurrent;
        // Stage 1 is the order itself; a skip is undone by reopening its deciding stage.
        const canReopen = Boolean(onReopen) && done && !skipped && stage.stageNumber > 1;
        const last = index === stages.length - 1;
        // Only the first locked row after open work names what it waits on.
        const prev = stages[index - 1];
        const blocker = locked && prev && prev.status !== STAGE_STATUS.LOCKED
          ? stages.slice(0, index).reverse().find((s) => !TERMINAL_STAGE_STATUSES.includes(s.status))
          : null;

        return (
          <li
            key={stage.stageNumber}
            className="relative flex gap-3 pb-5"
            aria-current={active ? "step" : undefined}
            data-stage-state={done ? "completed" : active ? "active" : "locked"}
          >
            {/* The connector, drawn between dots rather than under the last. */}
            {!last && (
              <span
                aria-hidden="true"
                className={`absolute left-[11px] top-6 bottom-0 w-px ${
                  done ? "bg-emerald-300" : "bg-slate-200"
                }`}
              />
            )}

            <span
              aria-hidden="true"
              className={`relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
                skipped
                  ? "border-slate-300 bg-slate-100 text-slate-400"
                  : done
                    ? "border-emerald-600 bg-emerald-600 text-white"
                    : active
                      ? "border-primary-600 bg-primary-600 text-white ring-4 ring-primary-100"
                      : "border-slate-200 bg-slate-50 text-slate-400"
              }`}
            >
              {skipped ? (
                <SkipForward size={12} />
              ) : done ? (
                <Check size={13} strokeWidth={3} />
              ) : locked ? (
                <Lock size={11} />
              ) : (
                stage.stageNumber
              )}
            </span>

            <div
              className={`min-w-0 flex-1 ${
                active ? "-mx-2 -mt-1 rounded-lg border border-primary-200 bg-primary-50/50 px-2 pb-2 pt-1" : ""
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`text-sm font-medium ${
                    skipped
                      ? "text-slate-400 line-through"
                      : locked
                        ? "text-slate-400"
                        : "text-slate-900"
                  }`}
                >
                  <span className="mr-1 tabular-nums text-slate-400">{stage.stageNumber}.</span>
                  {stage.stageName}
                </span>
                <StageBadge status={stage.status} />
                {active && (
                  <span className="rounded border border-primary-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-primary-700">
                    Current task
                  </span>
                )}
                {/* Beside the badge, not inside it: a stage can be In Progress
                    AND overdue, and the old single-status vocabulary had to
                    choose one of those to say. */}
                <StageFlags stage={stage} />
                {stage.overridden && (
                  <Badge variant="warning" title={stage.overrideReason ?? undefined}>
                    Out of order
                  </Badge>
                )}
              </div>

              <p className={`mt-0.5 text-xs ${locked ? "text-slate-400" : "text-slate-500"}`}>
                {stage.ownerRole}
              </p>

              {blocker && (
                <p className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-400">
                  <Lock size={10} /> Unlocks when {blocker.stageName} is completed
                </p>
              )}

              <dl className="mt-1 space-y-0.5 text-xs text-slate-600">
                {done && !skipped && (
                  <div className="flex gap-1.5">
                    <dt className="text-slate-400">Finished</dt>
                    <dd>
                      {formatDateTime(stage.actualCompletion)}
                      {stage.completedByName ? ` · ${stage.completedByName}` : ""}
                      {stage.delayMinutes > 0 && (
                        <span className="ml-1 text-amber-700">({formatDelay(stage.delayMinutes)})</span>
                      )}
                    </dd>
                  </div>
                )}

                {stage.reopenCount > 0 && (
                  <div className="flex gap-1.5">
                    <dt className="text-slate-400">Reworked</dt>
                    <dd className="text-amber-700">
                      {stage.reopenCount === 1 ? "once" : `${stage.reopenCount} times`}
                      {stage.lastReopenReason ? ` · ${stage.lastReopenReason}` : ""}
                    </dd>
                  </div>
                )}

                {skipped && stage.skipReason && (
                  <div className="flex gap-1.5">
                    <dt className="text-slate-400">Skipped</dt>
                    <dd className="italic">{stage.skipReason}</dd>
                  </div>
                )}

                {!done && stage.plannedCompletion && (
                  <div className="flex gap-1.5">
                    <dt className="text-slate-400">Due</dt>
                    <dd>{formatDateTime(stage.plannedCompletion)}</dd>
                  </div>
                )}

                {/*
                  Back-fill, surfaced rather than hidden. The two timestamps are
                  equal on an ordinary completion, so this line appears only when
                  the work was recorded after the fact.
                */}
                {done
                  && stage.recordedAt
                  && stage.actualCompletion
                  && new Date(stage.recordedAt).getTime() !== new Date(stage.actualCompletion).getTime() && (
                    <div className="flex gap-1.5">
                      <dt className="text-slate-400">Recorded</dt>
                      <dd className="text-slate-500">{formatDateTime(stage.recordedAt)} (back-filled)</dd>
                    </div>
                  )}
              </dl>

              {stage.assignedToName && (
                <p className="mt-1 flex items-center gap-1 text-xs text-slate-600">
                  <span className="text-slate-400">Assigned to</span>
                  <span className="font-medium text-slate-800">{stage.assignedToName}</span>
                  {/*
                    This is not just a label — the same person's Work Queue
                    carries this exact task, kept in sync in both directions.
                    WHICH list it landed on depends on the stage: one that needs
                    evidence recorded becomes a Checklist item, one that needs a
                    decision becomes a Delegation. Naming the actual list beats
                    "somewhere in their Work Queue", because the next question
                    after "assigned to whom" is always "where do they find it".
                    See stageMirror.service.js.
                  */}
                  <span className="text-slate-400">· in their {mirrorSurfaceOf(stage)}</span>
                </p>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                {canAct && onAct && (
                  <button
                    type="button"
                    onClick={() => onAct(stage)}
                    className="rounded-md bg-primary-600 px-3 py-1 text-xs font-medium text-white hover:bg-primary-700"
                  >
                    Complete this stage
                  </button>
                )}

                {/*
                  The assign control sits on the same row `canAct` governs —
                  whoever can complete a stage themselves is exactly who may
                  hand it to somebody else, per `assertMayAssign` on the
                  backend. A LOCKED future stage cannot be pre-assigned from
                  here yet, only the stage currently open for work.
                */}
                {canAct && onAssign && Array.isArray(assignableUsers) && (
                  <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
                    <span className="text-slate-400">
                      {stage.assignedTo ? "Reassign to" : "Assign to"}
                    </span>
                    <select
                      value=""
                      disabled={assigningStage === stage.stageNumber}
                      onChange={(e) => {
                        if (e.target.value) onAssign(stage, e.target.value);
                        e.target.value = "";
                      }}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 disabled:opacity-50"
                    >
                      <option value="">Choose…</option>
                      {assignableUsers.map((u) => (
                        <option key={u._id} value={u._id}>
                          {u.user || u.email}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {canAct && stage.assignedTo && onUnassign && (
                  <button
                    type="button"
                    onClick={() => onUnassign(stage)}
                    disabled={assigningStage === stage.stageNumber}
                    className="text-xs font-medium text-slate-500 underline decoration-dotted hover:text-slate-700 disabled:opacity-50"
                  >
                    Unassign
                  </button>
                )}

                {done && !skipped && (
                  <button
                    type="button"
                    aria-expanded={expanded === stage.stageNumber}
                    onClick={() => setExpanded((n) => (n === stage.stageNumber ? null : stage.stageNumber))}
                    className="text-xs font-medium text-primary-700 underline decoration-dotted hover:text-primary-800"
                  >
                    {expanded === stage.stageNumber ? "Hide details" : "View details"}
                  </button>
                )}

                {canReopen && (
                  <button
                    type="button"
                    onClick={() => onReopen(stage)}
                    className="text-xs font-medium text-amber-700 underline decoration-dotted hover:text-amber-800"
                  >
                    Send back for rework
                  </button>
                )}
              </div>

              {expanded === stage.stageNumber && (
                <StageDetails stage={stage} documents={documents} onOpenDocument={onOpenDocument} />
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const formatFieldValue = (field, value) => {
  if (value === undefined || value === null || value === "") return "—";
  if (field.type === STAGE_FIELD_TYPES.DATE) return formatDate(value);
  if (field.type === STAGE_FIELD_TYPES.BOOLEAN) return value ? "Yes" : "No";
  return String(value);
};

/**
 * What a completed stage recorded, read back from the server: the form values,
 * the files, the remarks, and who closed it when.
 */
export function StageDetails({ stage, documents = [], onOpenDocument }) {
  const fields = fieldsForStage(stage.stageNumber);
  const evidence = stage.evidence ?? {};
  const valueFields = fields.filter((f) => f.type !== STAGE_FIELD_TYPES.DOCUMENT);

  // The file each document field relied on, plus anything uploaded against this stage.
  const files = new Map();
  for (const field of fields.filter((f) => f.type === STAGE_FIELD_TYPES.DOCUMENT)) {
    const ref = evidence[field.key];
    if (ref?.documentId) {
      files.set(String(ref.documentId), { _id: ref.documentId, label: field.label, name: ref.originalName });
    }
  }
  for (const doc of documents) {
    if (doc.stageNumber === stage.stageNumber && !doc.deletedAt && !files.has(String(doc._id))) {
      files.set(String(doc._id), { _id: doc._id, label: doc.docType, name: doc.originalName });
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs" aria-label={`${stage.stageName} details`}>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
        <div>
          <dt className="text-slate-400">Completed by</dt>
          <dd className="text-slate-800">
            {stage.completedByName ?? "—"}
            {stage.completedByRole ? ` (${stage.completedByRole})` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Completed at</dt>
          <dd className="text-slate-800">{formatDateTime(stage.actualCompletion)}</dd>
        </div>
        {typeof evidence.advanceRequired === "boolean" && (
          <div>
            <dt className="text-slate-400">Advance required</dt>
            <dd className="text-slate-800">{evidence.advanceRequired ? "Yes" : "No"}</dd>
          </div>
        )}
        {valueFields.map((field) => (
          <div key={field.key}>
            <dt className="text-slate-400">{field.label}</dt>
            <dd className="text-slate-800">{formatFieldValue(field, evidence[field.key])}</dd>
          </div>
        ))}
      </dl>

      {files.size > 0 && (
        <div className="mt-2">
          <p className="text-slate-400">Attachments</p>
          <ul className="mt-0.5 space-y-0.5">
            {[...files.values()].map((file) => (
              <li key={String(file._id)} className="flex items-center gap-1 text-slate-800">
                <Paperclip size={11} className="text-slate-400" />
                <span>{file.label}</span>
                {file.name && <span className="text-slate-500">· {file.name}</span>}
                {onOpenDocument && (
                  <button
                    type="button"
                    onClick={() => onOpenDocument(file)}
                    className="ml-1 font-medium text-primary-700 underline decoration-dotted"
                  >
                    Open
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {stage.remarks && (
        <div className="mt-2">
          <p className="text-slate-400">Remarks</p>
          <p className="whitespace-pre-line text-slate-800">{stage.remarks}</p>
        </div>
      )}

      {stage.overridden && stage.overrideReason && (
        <p className="mt-2 text-amber-700">Completed out of order: {stage.overrideReason}</p>
      )}
    </div>
  );
}

/** "5 of 12 stages completed", a bar, and the key to the timeline's markers. */
export function StageProgress({ stages = [] }) {
  if (stages.length === 0) return null;
  const completed = stages.filter((s) => TERMINAL_STAGE_STATUSES.includes(s.status)).length;

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
        <span>
          <span className="font-semibold text-slate-900">{completed}</span> of {stages.length} stages completed
        </span>
        <span className="flex items-center gap-3 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1">
            <Check size={11} className="text-emerald-600" /> Completed
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-primary-600" /> Active
          </span>
          <span className="inline-flex items-center gap-1">
            <Lock size={11} className="text-slate-400" /> Locked
          </span>
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={stages.length}
        aria-valuenow={completed}
        aria-label="Stages completed"
      >
        <div
          className="h-full rounded-full bg-emerald-500 transition-all"
          style={{ width: `${(completed / stages.length) * 100}%` }}
        />
      </div>
    </div>
  );
}

/** A label/value pair, for the detail cards. */
export const Field = ({ label, children, className = "" }) => (
  <div className={className}>
    <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
    <dd className="mt-0.5 text-sm text-slate-900">{children ?? "—"}</dd>
  </div>
);

export const Section = ({ title, actions, children }) => (
  <section className="rounded-lg border border-slate-200 bg-white p-4">
    <div className="mb-3 flex items-center justify-between gap-2">
      <h4 className="text-sm font-semibold text-slate-900">{title}</h4>
      {actions}
    </div>
    {children}
  </section>
);

export default { StageBadge, StageFlags, OrderStatusBadge, BucketBadge, StageTimeline, Field, Section };
