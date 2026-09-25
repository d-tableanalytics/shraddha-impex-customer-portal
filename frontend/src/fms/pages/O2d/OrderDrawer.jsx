import { useState, useEffect, useCallback } from "react";
import toast from "react-hot-toast";

import { Drawer } from "../../components/ui/Drawer";
import { Button } from "../../components/ui/Button";
import { LoadingSpinner } from "../../components/ui/LoadingSpinner";
import { useUserStore } from "../../store/userStore";
import { hasPermission, PERMISSIONS } from "../../utils/permissions";
import {
  o2dApi,
  STAGE_STATUS_LABELS,
  HOLD_REASON_OPTIONS,
  DOCUMENT_TYPE_OPTIONS,
  DOCUMENT_TYPE_LABELS,
  formatDateTime,
  formatDate,
  formatRelative,
} from "../../services/o2d/orders";
import { O2dApiError } from "../../services/o2d/client";
import { StageTimeline, StageProgress, OrderStatusBadge, Field, Section } from "./o2dShared";
import { STAGES, ORDER_STATUS } from "@shared/constants/o2d.js";
import { CompleteStageModal } from "./CompleteStageModal";
import { ReopenStageModal } from "./ReopenStageModal";
import { openFile } from "../../services/fileUrl";
import { delegationService } from "../../services/delegation";

/**
 * Order 360 (§22) — everything about one order, in one place.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SCREEN DOES NOT DECIDE
 * ---------------------------------------------------------------------------
 *
 * Which stages this user may close is NOT computed here. `GET /o2d/tasks`
 * returns an `actionable` list resolved from the stage master, which an
 * administrator can edit without a deploy (§37). A copy of that mapping in the
 * browser would be wrong the first time somebody reassigns a stage, and would
 * show a Complete button that the server then refuses.
 *
 * Likewise the advance decision at stage 4 renders as two explicit buttons
 * rather than a generic Complete, because "no" also skips stage 5 — a
 * consequence the person clicking should see named.
 */

const TABS = [
  { key: "progress", label: "Progress" },
  { key: "items", label: "Items" },
  { key: "documents", label: "Documents" },
  { key: "history", label: "History" },
];

export function OrderDrawer({ orderId, onClose, onChanged }) {
  const user = useUserStore((s) => s.user);
  const [tab, setTab] = useState("progress");
  const [payload, setPayload] = useState(null);
  const [actionable, setActionable] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [history, setHistory] = useState([]);
  // Every status change, including the ones nobody performed.
  const [stageEvents, setStageEvents] = useState([]);
  /** The stage whose completion form is open, if any. */
  const [completing, setCompleting] = useState(null);
  /** The completed stage being sent back for rework, if any. */
  const [reopening, setReopening] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  /** Who a stage can be handed to — loaded once, reused across every stage row. */
  const [assignableUsers, setAssignableUsers] = useState(null);
  /** The stage number currently mid-assign/unassign, so its own control disables. */
  const [assigningStage, setAssigningStage] = useState(null);

  const canWork = hasPermission(user, PERMISSIONS.WORK_O2D_STAGE);
  const canHold = hasPermission(user, PERMISSIONS.HOLD_O2D);
  const canExit = hasPermission(user, PERMISSIONS.EXIT_O2D);
  const canOverride = hasPermission(user, PERMISSIONS.OVERRIDE_O2D);

  const load = useCallback(async () => {
    if (!orderId) return;
    setLoading(true);
    setError(null);
    try {
      const [full, tasks, docs] = await Promise.all([
        o2dApi.get(orderId),
        // Asked for so the drawer knows which stages THIS user may close.
        o2dApi.myTasks({ pageSize: 1 }).catch(() => ({ actionable: [] })),
        // For each completed stage's attachments in its details view.
        o2dApi.documents(orderId).catch(() => []),
      ]);
      setPayload(full);
      setActionable(tasks?.actionable ?? []);
      setDocuments(docs ?? []);
    } catch (err) {
      setError(err instanceof O2dApiError ? err : new O2dApiError(err.message));
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Who a stage can be handed to — loaded once, lazily, and only for somebody
   * who could actually use the control. Reused across the whole stage list
   * rather than fetched per row: it is the same "everyone but a customer"
   * roster the Delegation screen's own assignee picker already uses.
   */
  useEffect(() => {
    if (!canWork || assignableUsers) return;
    delegationService.getUsers().then(setAssignableUsers).catch(() => setAssignableUsers([]));
  }, [canWork, assignableUsers]);

  // Loaded lazily: most people open the drawer to see progress, and fetching
  // three tabs' worth of data for every click is three requests wasted.
  useEffect(() => {
    if (!orderId) return;
    if (tab === "documents") o2dApi.documents(orderId).then(setDocuments).catch(() => setDocuments([]));
    if (tab === "history") {
      o2dApi.activity(orderId).then(setHistory).catch(() => setHistory([]));
      o2dApi.stageHistory(orderId).then(setStageEvents).catch(() => setStageEvents([]));
    }
  }, [tab, orderId]);

  /** Run a mutation, report it, and refresh both this drawer and its caller. */
  const act = async (run, doneMessage) => {
    setBusy(true);
    try {
      await run();
      toast.success(doneMessage);
      await load();
      onChanged?.();
    } catch (err) {
      // A refusal the user can act on is shown as-is: the backend's messages are
      // written as sentences for exactly this (§44).
      toast.error(err?.message ?? "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  const order = payload?.order ?? null;
  const stages = payload?.stages ?? [];
  const items = payload?.items ?? [];
  const activeHold = (order?.holds ?? []).find((h) => !h.resumedAt) ?? null;

  /**
   * Open the stage's own completion form.
   *
   * This used to be a `window.prompt` for a remark, which collected none of the
   * information the specification says each stage must capture - an AWB number,
   * an invoice value, the PO copy - and could validate none of it. The modal
   * renders only the fields that stage declares.
   */
  const completeStage = (stage) => setCompleting(stage);

  /**
   * Hand a stage to one named person. Their My Work / All Tasks picks it up as
   * a real task from this one call — see `o2dDelegationSync.service.js`.
   */
  const assignStage = async (stage, userId) => {
    setAssigningStage(stage.stageNumber);
    const name = assignableUsers?.find((u) => u._id === userId)?.user ?? "the selected teammate";
    await act(() => o2dApi.assignStage(orderId, stage.stageNumber, userId), `${stage.stageName} assigned to ${name}.`);
    setAssigningStage(null);
  };

  const unassignStage = async (stage) => {
    setAssigningStage(stage.stageNumber);
    await act(() => o2dApi.unassignStage(orderId, stage.stageNumber), `${stage.stageName} unassigned.`);
    setAssigningStage(null);
  };

  const decideAdvance = (advanceRequired) =>
    act(
      () => o2dApi.advanceDecision(orderId, { advanceRequired }),
      advanceRequired
        ? "Recorded: this order needs an advance. Stage 5 is now with Accounts."
        : "Recorded: no advance needed. Stage 5 has been skipped.",
    );

  /**
   * Raise the Zoho invoice.
   *
   * No confirmation prompt, unlike the destructive actions below: the server
   * cannot be made to issue two, because the idempotency key is derived from
   * the order. What it CAN do is fail, and `act` surfaces that — an invoice
   * nobody knows is missing is worse than one that visibly did not send.
   */
  const raiseInvoice = () =>
    act(() => o2dApi.createInvoice(orderId), "Invoice raised in Zoho.");

  const placeHold = () => {
    const reason = window.prompt(
      `Why is this order on hold?\n${HOLD_REASON_OPTIONS.map((o) => o.value).join(", ")}`,
      "STOCK_UNAVAILABLE",
    );
    if (!reason) return;
    const note = window.prompt("Add a note (optional).", "") ?? null;
    act(() => o2dApi.hold(orderId, { reason, note }), "Order placed on hold.");
  };

  const exitOrder = (kind) => {
    const reason = window.prompt(
      kind === "void"
        ? "Void this order? It will be recorded as an entry error, not a lost order. Reason:"
        : "Cancel this order? Reason:",
      "",
    );
    if (!reason) return;
    act(
      () => (kind === "void" ? o2dApi.void(orderId, { reason }) : o2dApi.cancel(orderId, { reason })),
      kind === "void" ? "Order voided." : "Order cancelled.",
    );
  };

  const openDocument = async (doc) => {
    try {
      const { url } = await o2dApi.documentUrl(doc._id);
      openFile(url);
    } catch (err) {
      toast.error(err?.message ?? "Could not open that document.");
    }
  };

  const uploadDocument = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const docType = window.prompt(
      `Document type?\n${DOCUMENT_TYPE_OPTIONS.map((o) => o.value).join(", ")}`,
      "PO",
    );
    // Reset first, so re-picking the same file fires `change` again.
    event.target.value = "";
    if (!docType) return;

    const form = new FormData();
    form.append("file", file);
    form.append("docType", docType);

    setBusy(true);
    try {
      await o2dApi.uploadDocument(orderId, form);
      toast.success("Document attached.");
      setDocuments(await o2dApi.documents(orderId));
    } catch (err) {
      toast.error(err?.message ?? "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  const atAdvanceDecision =
    order?.currentStage === STAGES.ADVANCE_DECISION
    && actionable.includes(STAGES.ADVANCE_DECISION)
    && order?.status === ORDER_STATUS.OPEN;

  const exited = order?.status === ORDER_STATUS.CANCELLED || order?.status === ORDER_STATUS.VOID;

  return (
    <Drawer
      isOpen={Boolean(orderId)}
      onClose={onClose}
      title={order ? `${order.poNumber} · ${order.customerName}` : "Order"}
      maxWidth="max-w-3xl"
    >
      {loading && (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      )}

      {error && !loading && (
        <div className="p-6">
          <p className="text-sm text-slate-600">{error.message}</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={load}>
            Try again
          </Button>
        </div>
      )}

      {order && !loading && (
        <div className="flex flex-col gap-4 p-4">
          {/* ── Header ─────────────────────────────────────────────────── */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <OrderStatusBadge status={order.status} />
              <span className="text-xs text-slate-500">
                {order.status === ORDER_STATUS.CLOSED
                  ? `All ${stages.length} stages completed`
                  : `Stage ${order.currentStage} of ${stages.length}`}
              </span>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="PO date">{formatDate(order.poDate)}</Field>
              <Field label="Promise date">
                {order.promiseDate ? (
                  <>
                    {formatDate(order.promiseDate)}
                    <span className="ml-1 text-xs text-slate-500">
                      ({formatRelative(order.promiseDate)})
                    </span>
                  </>
                ) : (
                  // Shown as the attributed exception it is, not as a blank.
                  <span className="text-amber-700" title={order.promiseDateOverrideReason ?? ""}>
                    None — overridden
                  </span>
                )}
              </Field>
              <Field label="Dispatched">{formatDateTime(order.dispatchedAt)}</Field>
              <Field label="Invoice">{order.invoiceNumber}</Field>
              <Field label="Ordered qty">{order.totalOrderedQty ?? 0}</Field>
              <Field label="Dispatched qty">{order.totalDispatchedQty ?? 0}</Field>
              {/*
                §3 — where this order came from.
                Rendered only when there IS a booking: an order keyed from an
                emailed PO legitimately has none, and an empty "Booking —" cell
                reads as missing data rather than as an absent relationship.
              */}
              {order.sourceBooking && (
                <Field label="Customer booking">
                  {order.sourceBooking.bookingId}
                  {order.sourceBooking.bookingStatusAtLink && (
                    <span
                      className="ml-1 text-xs text-slate-500"
                      // The booking's status WHEN LINKED, not now — the customer
                      // side keeps moving it, and the tooltip says so rather
                      // than letting a stale-looking word confuse the reader.
                      title={`Booking status when it was linked on ${formatDate(order.sourceBooking.linkedAt)}`}
                    >
                      ({order.sourceBooking.bookingStatusAtLink} at link)
                    </span>
                  )}
                </Field>
              )}
            </dl>

            {order.promiseDateOverrideReason && (
              <p className="mt-2 text-xs text-amber-700">
                No promise date: {order.promiseDateOverrideReason}
              </p>
            )}
          </div>

          {/* ── Hold banner ────────────────────────────────────────────── */}
          {activeHold && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm font-medium text-amber-900">
                On hold — {activeHold.reason}
              </p>
              {activeHold.note && <p className="mt-0.5 text-xs text-amber-800">{activeHold.note}</p>}
              <p className="mt-0.5 text-xs text-amber-700">
                Since {formatDateTime(activeHold.startedAt)}. SLA deadlines are frozen.
              </p>
              {canHold && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  disabled={busy}
                  onClick={() => act(() => o2dApi.resume(orderId), "Order resumed.")}
                >
                  Resume
                </Button>
              )}
            </div>
          )}

          {exited && (
            <div className="rounded-lg border border-slate-300 bg-slate-100 p-3">
              <p className="text-sm font-medium text-slate-800">
                This order was {order.status.toLowerCase()} and is out of the workflow.
              </p>
              {canExit && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt("Why is this order coming back?", "");
                    if (!reason) return;
                    act(() => o2dApi.revive(orderId, { reason }), "Order revived.");
                  }}
                >
                  Revive
                </Button>
              )}
            </div>
          )}

          {/* ── The stage-4 fork ───────────────────────────────────────── */}
          {atAdvanceDecision && (
            <div className="rounded-lg border border-primary-200 bg-primary-50 p-3">
              <p className="text-sm font-medium text-primary-900">Does this order need an advance?</p>
              <p className="mt-0.5 text-xs text-primary-800">
                Answering “no” skips stage 5 and moves straight to the order list.
              </p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => decideAdvance(true)}>
                  Yes — advance required
                </Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => decideAdvance(false)}>
                  No — skip stage 5
                </Button>
              </div>
            </div>
          )}

          {/* ── Tabs ───────────────────────────────────────────────────── */}
          <div role="tablist" className="flex gap-1 border-b border-slate-200">
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`px-3 py-2 text-sm font-medium ${
                  tab === t.key
                    ? "border-b-2 border-primary-600 text-primary-700"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "progress" && (
            <Section title="Progress">
              <StageProgress stages={stages} />
              <StageTimeline
                stages={stages}
                currentStage={order.currentStage}
                actionableStages={
                  // No stage is workable while the order is held or has exited,
                  // and stage 4 has its own buttons above.
                  canWork && order.status === ORDER_STATUS.OPEN
                    ? actionable.filter((n) => n !== STAGES.ADVANCE_DECISION)
                    : []
                }
                onAct={completeStage}
                assignableUsers={assignableUsers}
                onAssign={assignStage}
                onUnassign={unassignStage}
                assigningStage={assigningStage}
                documents={documents}
                onOpenDocument={openDocument}
                onReopen={
                  canOverride
                  && (order.status === ORDER_STATUS.OPEN || order.status === ORDER_STATUS.CLOSED)
                    ? setReopening
                    : undefined
                }
              />
            </Section>
          )}

          {tab === "items" && (
            <Section title={`Items (${items.length})`}>
              {items.length === 0 ? (
                <p className="text-sm text-slate-500">No lines were recorded for this order.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                        <th className="py-1.5 pr-2">#</th>
                        <th className="py-1.5 pr-2">SKU</th>
                        <th className="py-1.5 pr-2">Ordered</th>
                        <th className="py-1.5 pr-2">Dispatched</th>
                        <th className="py-1.5">Remaining</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item._id} className="border-b border-slate-100">
                          <td className="py-1.5 pr-2 text-slate-400">{item.lineSeq}</td>
                          <td className="py-1.5 pr-2">
                            <span className="font-medium text-slate-900">{item.skuCode}</span>
                            {item.productName && (
                              <span className="ml-1 text-xs text-slate-500">{item.productName}</span>
                            )}
                          </td>
                          <td className="py-1.5 pr-2">{item.orderedQty}</td>
                          <td className="py-1.5 pr-2">{item.dispatchedQty ?? 0}</td>
                          <td className="py-1.5">{item.remainingQty ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          )}

          {tab === "documents" && (
            <Section
              title={`Documents (${documents.length})`}
              actions={
                hasPermission(user, PERMISSIONS.CREATE_O2D_ORDER) && (
                  <label className="cursor-pointer rounded-md bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200">
                    Attach
                    <input type="file" className="sr-only" onChange={uploadDocument} disabled={busy} />
                  </label>
                )
              }
            >
              {documents.length === 0 ? (
                <p className="text-sm text-slate-500">Nothing attached to this order yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {documents.map((doc) => (
                    <li
                      key={doc._id}
                      className="flex items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm text-slate-900">
                          {DOCUMENT_TYPE_LABELS[doc.docType] ?? doc.docType}
                          {doc.originalName && (
                            <span className="ml-1 text-xs text-slate-500">{doc.originalName}</span>
                          )}
                        </p>
                        <p className="text-xs text-slate-400">
                          {formatDateTime(doc.uploadedAt)}
                          {doc.uploadedByName ? ` · ${doc.uploadedByName}` : ""}
                        </p>
                      </div>
                      <Button size="xs" variant="secondary" onClick={() => openDocument(doc)}>
                        Open
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}

          {tab === "history" && (
            <>
              {/*
                ── STAGE HISTORY ────────────────────────────────────────────
                What each STAGE did, including the transitions no person
                performed — a deadline passing, a hold freezing the board, the
                resume thawing it. Those are most of the timeline of any order
                that ran late, and they appear in no audit log, because nobody
                did them.

                Shown as the RAW statuses, not the two-state name: "In Progress
                → In Progress" would describe nothing, and this view exists
                precisely for the reader who needs the detail the task list
                deliberately hides.

                Grouped by stage rather than flattened, because the question
                being asked is almost always about one stage ("why was stage 7
                late?"), and a flat list of 40 transitions across 12 stages
                makes the reader do the grouping by eye.
              */}
              <Section title="Stage history">
                {stageEvents.length === 0 ? (
                  <p className="text-sm text-slate-500">No status changes recorded.</p>
                ) : (
                  <div className="space-y-4">
                    {Object.entries(
                      stageEvents.reduce((acc, e) => {
                        (acc[`${e.stageNumber}. ${e.stageName}`] ??= []).push(e);
                        return acc;
                      }, {}),
                    ).map(([label, events]) => (
                      <div key={label}>
                        <p className="text-xs font-semibold text-slate-700">{label}</p>
                        <ul className="mt-1 space-y-1">
                          {events.map((e) => (
                            <li key={e._id} className="border-l-2 border-slate-200 pl-3">
                              <p className="text-xs text-slate-900">
                                {e.from ? (
                                  <>
                                    <span className="text-slate-500">
                                      {STAGE_STATUS_LABELS[e.from] ?? e.from}
                                    </span>
                                    <span className="mx-1 text-slate-400">→</span>
                                  </>
                                ) : null}
                                <span className="font-semibold">
                                  {STAGE_STATUS_LABELS[e.to] ?? e.to}
                                </span>
                                {e.reason ? (
                                  <span className="text-slate-500"> · {e.reason}</span>
                                ) : null}
                              </p>
                              <p className="text-[11px] text-slate-400">
                                {formatDateTime(e.at)}
                                {/* Naming the source removes the guess a bare
                                    missing actor would leave: "the sweep did
                                    it" and "we failed to record who" look
                                    identical otherwise. */}
                                {e.actorName
                                  ? ` · ${e.actorName}${e.actorRole ? ` (${e.actorRole})` : ""}`
                                  : ` · ${e.source.toLowerCase()}`}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              {/*
                The audit trail is a DIFFERENT record and is kept separate: it
                says what a person did, which is what an investigation into
                conduct reads. Neither can be reconstructed from the other.
              */}
              <Section title="Activity">
                {history.length === 0 ? (
                  <p className="text-sm text-slate-500">No recorded activity.</p>
                ) : (
                  <ul className="space-y-2">
                    {history.map((row) => (
                      <li key={row._id} className="border-l-2 border-slate-200 pl-3">
                        <p className="text-sm text-slate-900">{row.remarks}</p>
                        <p className="text-xs text-slate-400">
                          {formatDateTime(row.createdAt)}
                          {row.user?.user ? ` · ${row.user.user}` : " · system"}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </>
          )}

          {/* ── Order-level actions ────────────────────────────────────── */}
          {!exited && (
            <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
              {canHold && !activeHold && order.status === ORDER_STATUS.OPEN && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={placeHold}>
                  Place on hold
                </Button>
              )}
              {/*
                Offered only while there is no invoice yet. The server is
                idempotent regardless — it returns the existing number rather
                than raising a second invoice — but a button that silently does
                nothing teaches people to press it twice.
              */}
              {canWork && !order.invoiceNumber && order.status === ORDER_STATUS.OPEN && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={raiseInvoice}>
                  Create invoice
                </Button>
              )}
              {canExit && (
                <>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => exitOrder("cancel")}>
                    Cancel order
                  </Button>
                  {/* Separate from Cancel on purpose: one is a lost order, the
                      other an entry error, and analytics counts them apart. */}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => exitOrder("void")}>
                    Void (entry error)
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {completing && (
        <CompleteStageModal
          order={order}
          stage={completing}
          onClose={() => setCompleting(null)}
          onCompleted={() => {
            load();
            onChanged?.();
          }}
        />
      )}

      {reopening && (
        <ReopenStageModal
          order={order}
          stage={reopening}
          onClose={() => setReopening(null)}
          onReopened={() => {
            toast.success(`${reopening.stageName} sent back for rework.`);
            load();
            onChanged?.();
          }}
        />
      )}
    </Drawer>
  );
}

export default OrderDrawer;
