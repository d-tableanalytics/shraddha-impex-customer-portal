import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, ChevronRight, ChevronDown, XCircle } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Modal } from "../../../components/ui/Modal";
import { employeesApi } from "../../../services/hrms";
import {
  onboardingChecklistsApi,
  onboardingTemplatesApi,
  CHECKLIST_STATUS_TONES,
  TASK_STATUS_TONES,
  formatDay,
} from "../../../services/hrms/onboarding";
import { ProgressBar } from "./ProgressBar";
import { startChecklistSchema } from "@shared/schemas/onboarding.js";
import {
  CHECKLIST_STATUSES,
  TASK_STATUS_LABELS,
  ASSIGN_TO_LABELS,
  CLOSED_TASK_STATUSES,
} from "@shared/constants/onboarding.js";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";

const STATUS_OPTIONS = CHECKLIST_STATUSES.map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}));

/**
 * Checklists — HR's and the manager's view of every onboarding in flight.
 *
 * The reference's Checklists tab: a row per new hire with template, start date,
 * a progress bar and a status tag, and an EXPANDABLE row that reveals the tasks
 * with Start / Done / Skip against each. Both are reproduced, including the
 * expansion, because the tab is unusable without it — the task list is the
 * whole point of the screen.
 *
 * A manager sees their reports; HR sees everybody. That narrowing happens on
 * the server, not here.
 */
export function ChecklistsTab({ canEdit = false }) {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [failure, setFailure] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(
        (await onboardingChecklistsApi.list({
          page,
          pageSize: 25,
          ...(status ? { status } : {}),
        })) ?? { data: [], total: 0 },
      );
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * A task change refreshes the whole page rather than patching one row.
   *
   * The server recomputes the checklist's own status from its tasks on every
   * update — completing the last one closes the checklist, reopening one
   * reopens it — so the row beside the task is exactly what a local patch would
   * get wrong.
   */
  const onTaskChanged = useCallback(async () => {
    await load();
  }, [load]);

  const columns = useMemo(
    () => [
      {
        header: "",
        className: `${CELL} w-[42px]`,
        headerClassName: `${HEAD} w-[42px]`,
        cell: (row) => (
          <button
            type="button"
            aria-label={expanded === row.id ? `Hide tasks for ${row.employeeName}` : `Show tasks for ${row.employeeName}`}
            aria-expanded={expanded === row.id}
            onClick={() => setExpanded((c) => (c === row.id ? null : row.id))}
            className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            {expanded === row.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        ),
      },
      {
        header: "Employee",
        className: `${CELL} font-semibold text-slate-900`,
        headerClassName: HEAD,
        cell: (row) => row.employeeName ?? "—",
      },
      {
        header: "Template",
        className: `${CELL} text-xs text-slate-600`,
        headerClassName: HEAD,
        cell: (row) => row.templateName || <span className="text-slate-400">—</span>,
      },
      {
        header: "Started",
        className: `${CELL} w-[130px] text-xs text-slate-600 tabular-nums`,
        headerClassName: HEAD,
        cell: (row) => formatDay(row.startedAt?.slice(0, 10)),
      },
      {
        header: "Progress",
        className: `${CELL} w-[190px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <ProgressBar completed={row.progress?.completed ?? 0} total={row.progress?.total ?? 0} />
        ),
      },
      {
        header: "Status",
        className: `${CELL} w-[120px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-col gap-1">
            <Badge variant={CHECKLIST_STATUS_TONES[row.status] ?? "neutral"}>{row.status}</Badge>
            {row.cancellationReason && (
              <span className="text-[10.5px] text-slate-500 leading-snug">
                {row.cancellationReason}
              </span>
            )}
          </div>
        ),
      },
      {
        header: "",
        className: `${CELL} w-[110px]`,
        headerClassName: HEAD,
        cell: (row) =>
          canEdit && row.status !== "cancelled" ? (
            <Button
              size="xs"
              variant="ghost"
              className="text-error-500"
              onClick={() => setCancelling(row)}
            >
              <XCircle size={12} className="mr-1" />
              Cancel
            </Button>
          ) : null,
      },
    ],
    [canEdit, expanded],
  );

  const expandedRow = result.data.find((r) => r.id === expanded) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <SearchableSelect
            className="w-44"
            value={status}
            onChange={(value) => {
              setStatus(value);
              // Filtering while on page 4 would land on an empty table with no
              // visible cause.
              setPage(1);
            }}
            options={STATUS_OPTIONS}
            placeholder="Any status"
          />
        </div>
        {canEdit && (
          <Button size="sm" variant="primary" onClick={() => setStarting(true)}>
            <Plus size={14} className="mr-1.5" />
            Start onboarding
          </Button>
        )}
      </div>

      {failure && (
        <p role="alert" className="text-xs text-error-500 font-medium">
          {failure}
        </p>
      )}

      <HrmsDataTable
        columns={columns}
        rows={result.data}
        loading={loading}
        error={error}
        onRetry={load}
        page={result.page ?? page}
        pageSize={result.pageSize ?? 25}
        total={result.total ?? 0}
        onPageChange={setPage}
        emptyTitle="No onboarding in progress"
        emptyDescription="Start one from a template when a new hire joins."
      />

      {expandedRow && (
        <ChecklistTasks
          checklist={expandedRow}
          canEdit={canEdit}
          onChanged={onTaskChanged}
          onFailure={setFailure}
        />
      )}

      <StartChecklistDrawer
        open={starting}
        onClose={() => setStarting(false)}
        onStarted={() => {
          setStarting(false);
          load();
        }}
      />

      <CancelDialog
        row={cancelling}
        onClose={() => setCancelling(null)}
        onDone={() => {
          setCancelling(null);
          load();
        }}
      />
    </div>
  );
}

/**
 * The expanded task list.
 *
 * Rendered beneath the table rather than inside the row: `HrmsDataTable` has no
 * expandable-row slot, and adding one would change a component six other
 * modules already render. The heading names the person, so the panel is never
 * ambiguous about which row it belongs to.
 */
function ChecklistTasks({ checklist, canEdit, onChanged, onFailure }) {
  const [busy, setBusy] = useState(null);

  const change = async (task, status) => {
    setBusy(task.id);
    onFailure(null);
    try {
      await onboardingChecklistsApi.updateTask(checklist.id, task.id, { status });
      await onChanged();
    } catch (err) {
      onFailure(err?.message ?? "That task could not be updated.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      aria-label={`Tasks for ${checklist.employeeName}`}
      className="bg-white border border-slate-200 rounded-xl shadow-enterprise overflow-hidden"
    >
      <header className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-200">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-600">
          Tasks · {checklist.employeeName}
        </span>
        <ProgressBar
          className="w-48"
          completed={checklist.progress?.completed ?? 0}
          total={checklist.progress?.total ?? 0}
        />
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2">Title</th>
              <th className="px-4 py-2 w-[170px]">Assignee</th>
              <th className="px-4 py-2 w-[100px]">Role</th>
              <th className="px-4 py-2 w-[120px]">Due</th>
              <th className="px-4 py-2 w-[120px]">Status</th>
              <th className="px-4 py-2 w-[220px]" />
            </tr>
          </thead>
          <tbody>
            {checklist.tasks.map((task) => {
              const closed = CLOSED_TASK_STATUSES.includes(task.status);
              return (
                <tr key={task.id} className="border-b border-slate-100 last:border-0 align-top">
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-slate-900">{task.title}</span>
                    {task.description && (
                      <span className="block text-[11px] text-slate-500 leading-snug">
                        {task.description}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">
                    {task.assigneeName || <span className="text-warning-600">Unassigned</span>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">
                    {ASSIGN_TO_LABELS[task.assignTo] ?? task.assignTo}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600 tabular-nums">
                    {formatDay(task.dueDate)}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={TASK_STATUS_TONES[task.status] ?? "neutral"}>
                      {TASK_STATUS_LABELS[task.status] ?? task.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    {!canEdit || checklist.status === "cancelled" ? null : closed ? (
                      // Reopening is legal, and is the only move out of a
                      // closed task — the server's transition table says so.
                      <Button
                        size="xs"
                        variant="ghost"
                        loading={busy === task.id}
                        onClick={() => change(task, "pending")}
                      >
                        Reopen
                      </Button>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {task.status === "pending" && (
                          <Button
                            size="xs"
                            variant="outline"
                            loading={busy === task.id}
                            onClick={() => change(task, "in_progress")}
                          >
                            Start
                          </Button>
                        )}
                        <Button
                          size="xs"
                          variant="primary"
                          loading={busy === task.id}
                          onClick={() => change(task, "completed")}
                        >
                          Done
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          loading={busy === task.id}
                          onClick={() => change(task, "skipped")}
                        >
                          Skip
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StartChecklistDrawer({ open, onClose, onStarted }) {
  const [employees, setEmployees] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [employeeId, setEmployeeId] = useState(null);
  const [templateId, setTemplateId] = useState(null);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEmployeeId(null);
    setTemplateId(null);
    setErrors({});
    setFailure(null);

    Promise.all([
      employeesApi.list({ page: 1, pageSize: 200 }),
      onboardingTemplatesApi.list({ page: 1, pageSize: 100, active: true }),
    ])
      .then(([emps, tmpls]) => {
        setEmployees(emps?.data ?? []);
        // Only an active template can start an onboarding; the server refuses
        // the rest, so they are not offered.
        setTemplates((tmpls?.data ?? []).filter((t) => t.active));
      })
      .catch(() => setFailure("The employee or template list could not be loaded."));
  }, [open]);

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    // The SERVER's schema, imported from @shared — the rules the form enforces
    // are literally the rules the API enforces.
    const parsed = startChecklistSchema.safeParse({ employeeId, templateId });
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path?.[0];
        if (field && !next[field]) next[field] = issue.message;
      }
      setErrors(next);
      return;
    }

    setSubmitting(true);
    try {
      await onboardingChecklistsApi.start(parsed.data);
      onStarted();
    } catch (err) {
      // "Already has an active onboarding checklist" arrives here, and is a
      // rule the person needs to read rather than a button that does nothing.
      setFailure(err?.message ?? "That onboarding could not be started.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <Drawer isOpen onClose={onClose} title="Start onboarding" maxWidth="max-w-lg">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <SearchableSelect
          label="Employee"
          value={employeeId}
          onChange={(v) => {
            setEmployeeId(v);
            setErrors((e) => ({ ...e, employeeId: undefined }));
          }}
          options={employees.map((e) => ({
            value: e.id,
            label: `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim(),
            hint: e.employeeCode,
          }))}
          placeholder="Search employees…"
          error={errors.employeeId}
        />

        <SearchableSelect
          label="Template"
          value={templateId}
          onChange={(v) => {
            setTemplateId(v);
            setErrors((e) => ({ ...e, templateId: undefined }));
          }}
          options={templates.map((t) => ({
            value: t.id,
            label: t.name,
            hint: `${t.taskCount} task${t.taskCount === 1 ? "" : "s"}`,
          }))}
          placeholder="An active template"
          error={errors.templateId}
        />

        <p className="text-[11px] text-slate-500 leading-relaxed">
          Tasks are created for HR, IT, the manager, the new hire and a buddy according to the
          template&apos;s assign-to rules, with due dates counted from today. A role nobody holds
          leaves its task unassigned so the gap is visible — you can assign it afterwards.
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
            Start
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/** Cancelling requires a reason — the server refuses one without. */
function CancelDialog({ row, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setReason("");
    setFailure(null);
  }, [row]);

  if (!row) return null;

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);
    if (reason.trim().length === 0) {
      setFailure("Say why onboarding is being cancelled.");
      return;
    }
    setSubmitting(true);
    try {
      await onboardingChecklistsApi.cancel(row.id, reason.trim());
      onDone();
    } catch (err) {
      setFailure(err?.message ?? "That onboarding could not be cancelled.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Cancel onboarding for ${row.employeeName}?`} size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-slate-600 leading-relaxed">
          The remaining tasks are closed and cannot be worked on. This frees the employee to be
          onboarded again from a fresh template later.
        </p>

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="cancel-onboarding-reason" className="text-xs font-semibold text-slate-700">
            Reason
          </label>
          <textarea
            id="cancel-onboarding-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
        </div>

        {failure && (
          <p role="alert" className="text-xs text-error-500 font-medium">
            {failure}
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Keep it open
          </Button>
          <Button type="submit" variant="danger" loading={submitting}>
            Cancel onboarding
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default ChecklistsTab;
