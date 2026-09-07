import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Lock } from "lucide-react";

import { Drawer } from "../../../components/ui/Drawer";
import { Button } from "../../../components/ui/Button";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { SkeletonLoader } from "../../../components/ui/SkeletonLoader";
import {
  helpdeskApi,
  employeesApi,
  formatInstant,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
} from "../../../services/hrms";
import {
  TicketStatusBadge,
  PriorityBadge,
  TeamBadge,
  SlaIndicator,
  Field,
} from "./helpdeskShared";

/**
 * One ticket, its conversation, and whatever the viewer may do to it.
 *
 * The reference's `TicketDetailDrawer` offers a bare status `Select` and
 * nothing else — `assignedToUserId`, `priority` and `resolutionNotes` are all
 * in its update DTO and unreachable from its UI. It also renders the status
 * select to any resolver for any ticket, because its permission check is the
 * union of all three teams.
 *
 * Here the server says what this viewer may do (`canResolve`, `isMine`) and the
 * drawer offers exactly that.
 */

/** Which moves the server will accept from here. Mirrors TICKET_TRANSITIONS. */
const NEXT = {
  open: ["in_progress", "resolved"],
  assigned: ["in_progress", "resolved"],
  in_progress: ["resolved"],
  resolved: ["closed", "in_progress"],
  closed: [],
};

export function TicketDetailDrawer({ ticketId, onClose, onChanged }) {
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!ticketId) return;
    setLoading(true);
    setError(null);
    try {
      setTicket(await helpdeskApi.ticket(ticketId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (run, done) => {
    setBusy(true);
    try {
      const updated = await run();
      setTicket(updated);
      toast.success(done);
      onChanged?.();
    } catch (err) {
      toast.error(err?.message ?? "That action could not be completed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      isOpen={Boolean(ticketId)}
      onClose={busy ? () => {} : onClose}
      title={ticket ? ticket.subject : "Ticket"}
      maxWidth="max-w-3xl"
    >
      {loading ? (
        <SkeletonLoader className="h-64" />
      ) : error ? (
        <p className="rounded-lg border border-error-200 bg-error-50 px-4 py-3 text-sm text-error-600">
          {error?.message ?? "That ticket could not be loaded."}
        </p>
      ) : !ticket ? null : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-slate-500">{ticket.ticketNumber}</span>
            <TicketStatusBadge status={ticket.status} />
            <PriorityBadge priority={ticket.priority} />
            <TeamBadge resolverModule={ticket.resolverModule} />
            <SlaIndicator ticket={ticket} />
          </div>

          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Raised by">{ticket.requesterName}</Field>
            <Field label="Raised">{formatInstant(ticket.createdAt)}</Field>
            <Field label="Category">{ticket.categoryName}</Field>
            <Field label="Assigned to">
              {ticket.assigneeName ?? (
                <span className="text-slate-400">Nobody yet</span>
              )}
            </Field>
            <Field label="Details" wide>
              <p className="whitespace-pre-wrap">{ticket.body}</p>
            </Field>
            {ticket.resolutionNotes && (
              <Field label="Resolution" wide>
                <p className="whitespace-pre-wrap">{ticket.resolutionNotes}</p>
              </Field>
            )}
          </dl>

          {ticket.canResolve && ticket.status !== "closed" && (
            <ResolverPanel ticket={ticket} busy={busy} act={act} />
          )}

          <RequesterActions ticket={ticket} busy={busy} act={act} />

          <Conversation ticket={ticket} busy={busy} act={act} />
        </div>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------

/** Assign, reprioritise, and move the ticket on. */
function ResolverPanel({ ticket, busy, act }) {
  const [people, setPeople] = useState([]);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    let cancelled = false;
    employeesApi
      .list({ pageSize: 100, status: "active" })
      .then((page) => {
        if (cancelled) return;
        setPeople(
          (page.data ?? []).map((row) => ({
            value: row.id,
            label: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim(),
          })),
        );
      })
      .catch(() => setPeople([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const moves = NEXT[ticket.status] ?? [];

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Resolver actions
      </h4>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <SearchableSelect
            label="Assign to"
            value={ticket.assigneeEmployeeId ?? null}
            onChange={(value) =>
              act(
                () => helpdeskApi.assign(ticket.id, value ?? null),
                value ? "Ticket assigned." : "Ticket returned to the queue.",
              )
            }
            options={people}
            placeholder="Nobody yet…"
          />
          <p className="mt-1 text-xs text-slate-500">
            Only somebody who can resolve this category may be assigned.
          </p>
        </div>

        <div>
          <label
            htmlFor="ticket-priority-change"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Priority
          </label>
          <select
            id="ticket-priority-change"
            value={ticket.priority}
            disabled={busy}
            onChange={(e) =>
              act(
                () => helpdeskApi.update(ticket.id, { priority: e.target.value }),
                "Priority updated.",
              )
            }
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            {Object.entries(TICKET_PRIORITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {moves.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {moves.map((next) =>
            next === "resolved" ? (
              <Button key={next} size="sm" disabled={busy} onClick={() => setResolveOpen(true)}>
                Resolve
              </Button>
            ) : (
              <Button
                key={next}
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  act(
                    () => helpdeskApi.changeStatus(ticket.id, next),
                    `Moved to ${TICKET_STATUS_LABELS[next].toLowerCase()}.`,
                  )
                }
              >
                {next === "in_progress" ? "Start work" : TICKET_STATUS_LABELS[next]}
              </Button>
            ),
          )}
        </div>
      )}

      {resolveOpen && (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <label
            htmlFor="resolution-notes"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            How was it resolved?
          </label>
          <textarea
            id="resolution-notes"
            rows={3}
            maxLength={10_000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What you did, so the requester and the next person both know."
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-slate-500">Required — a resolution needs a reason.</p>
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => setResolveOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || !notes.trim()}
              onClick={() =>
                act(
                  () => helpdeskApi.changeStatus(ticket.id, "resolved", notes.trim()),
                  "Ticket resolved.",
                ).then(() => {
                  setResolveOpen(false);
                  setNotes("");
                })
              }
            >
              Resolve
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * What the requester may do with their own resolved ticket.
 *
 * The reference gives the requester nothing — its update endpoint requires a
 * resolver grant, so they cannot even accept the resolution.
 */
function RequesterActions({ ticket, busy, act }) {
  if (!ticket.isMine || ticket.status !== "resolved") return null;

  return (
    <div className="rounded-lg border border-primary-200 bg-primary-50 p-4">
      <p className="text-sm text-primary-700">
        This ticket has been resolved. Close it if that fixed it, or reopen it if it did
        not.
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            act(() => helpdeskApi.changeStatus(ticket.id, "closed"), "Ticket closed. Thank you.")
          }
        >
          Close it
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            act(
              () =>
                helpdeskApi.changeStatus(
                  ticket.id,
                  "in_progress",
                  "Reopened by the requester.",
                ),
              "Ticket reopened.",
            )
          }
        >
          Reopen
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Conversation({ ticket, busy, act }) {
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);

  const comments = ticket.comments ?? [];
  const closed = ticket.status === "closed";

  return (
    <div>
      <h4 className="mb-3 text-sm font-semibold text-slate-900">Conversation</h4>

      {comments.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing said yet.</p>
      ) : (
        <ul className="space-y-3">
          {comments.map((comment) => (
            <li
              key={comment.id}
              className={[
                "rounded-lg border p-3",
                comment.internal
                  ? "border-warning-200 bg-warning-50"
                  : "border-slate-200 bg-white",
              ].join(" ")}
            >
              <div className="mb-1 flex items-center gap-2 text-xs">
                <span className="font-medium text-slate-700">{comment.authorName}</span>
                <span className="text-slate-400">{formatInstant(comment.createdAt)}</span>
                {comment.internal && (
                  <span className="inline-flex items-center gap-1 text-warning-600">
                    <Lock className="h-3 w-3" aria-hidden="true" />
                    Internal
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm text-slate-800">{comment.body}</p>
            </li>
          ))}
        </ul>
      )}

      {closed ? (
        <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
          This ticket is closed. Raise a new one if you need more help.
        </p>
      ) : (
        <form
          className="mt-4 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!body.trim()) return;
            act(
              () => helpdeskApi.comment(ticket.id, body.trim(), internal),
              internal ? "Internal note added." : "Comment added.",
            ).then(() => {
              setBody("");
              setInternal(false);
            });
          }}
        >
          <label htmlFor="new-comment" className="sr-only">
            Add a comment
          </label>
          <textarea
            id="new-comment"
            rows={3}
            maxLength={10_000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add a comment…"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
          <div className="flex items-center justify-between">
            {/*
              Offered only to the team that owns this ticket. The reference
              shows the checkbox to any resolver and accepts `internal` from
              anybody at all, so a requester can write into the private channel.
            */}
            {ticket.canResolve ? (
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(e) => setInternal(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-300"
                />
                Internal note — the requester will not see this
              </label>
            ) : (
              <span />
            )}
            <Button type="submit" size="sm" disabled={busy || !body.trim()}>
              Send
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

export default TicketDetailDrawer;
