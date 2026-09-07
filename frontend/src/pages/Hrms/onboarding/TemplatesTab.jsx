import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, ChevronRight, ChevronDown } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Input } from "../../../components/ui/Input";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { onboardingTemplatesApi } from "../../../services/hrms/onboarding";
import { createTemplateSchema } from "@shared/schemas/onboarding.js";
import { ASSIGN_TO, ASSIGN_TO_LABELS } from "@shared/constants/onboarding.js";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";

const ASSIGN_TO_OPTIONS = ASSIGN_TO.map((value) => ({
  value,
  label: ASSIGN_TO_LABELS[value] ?? value,
}));

const emptyTask = (order) => ({ title: "", description: "", dueDays: 1, assignTo: "hr", order });

/**
 * Templates — the reusable task lists an onboarding is stamped from.
 *
 * The reference's Templates tab: Name, "Applies to", task count, an Active tag
 * and a delete with confirmation, with an expandable row revealing the task
 * templates (Order, Title, Assign to, Due days, Description).
 *
 * One behavioural difference, and it is deliberate: a template that has been
 * used to start an onboarding cannot be deleted. The reference hard-deletes and
 * silently orphans every checklist that ran from it. The column shows the usage
 * count so the reason is visible before the button is pressed.
 */
export function TemplatesTab() {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [failure, setFailure] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(
        (await onboardingTemplatesApi.list({ page, pageSize: 25 })) ?? { data: [], total: 0 },
      );
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
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
            aria-label={expanded === row.id ? `Hide tasks in ${row.name}` : `Show tasks in ${row.name}`}
            aria-expanded={expanded === row.id}
            onClick={() => setExpanded((c) => (c === row.id ? null : row.id))}
            className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            {expanded === row.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        ),
      },
      {
        header: "Name",
        className: `${CELL} font-semibold text-slate-900`,
        headerClassName: HEAD,
        cell: (row) => row.name,
      },
      {
        header: "Applies to",
        className: `${CELL} text-xs text-slate-600`,
        headerClassName: HEAD,
        cell: (row) => {
          const parts = [];
          if (row.appliesToRoleKey) parts.push(`Role: ${row.appliesToRoleKey}`);
          if (row.appliesToDepartmentName) parts.push(row.appliesToDepartmentName);
          else if (row.appliesToDepartmentId) parts.push("Department");
          return parts.length > 0 ? parts.join(" · ") : "All hires";
        },
      },
      {
        header: "Tasks",
        className: `${CELL} w-[80px] text-right tabular-nums`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => row.taskCount,
      },
      {
        header: "Used",
        className: `${CELL} w-[90px] text-right tabular-nums text-xs text-slate-600`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => row.checklistCount,
      },
      {
        header: "Active",
        className: `${CELL} w-[100px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <Badge variant={row.active ? "success" : "neutral"}>
            {row.active ? "Active" : "Inactive"}
          </Badge>
        ),
      },
      {
        header: "",
        className: `${CELL} w-[80px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <Button
            size="xs"
            variant="ghost"
            className="text-error-500"
            aria-label={`Delete ${row.name}`}
            // A used template cannot be deleted, and the count beside it says
            // why — a disabled button with a reason beats a 409 after a click.
            disabled={row.checklistCount > 0}
            title={
              row.checklistCount > 0
                ? "This template has been used. Mark it inactive instead."
                : undefined
            }
            onClick={() => setDeleting(row)}
          >
            <Trash2 size={13} />
          </Button>
        ),
      },
    ],
    [expanded],
  );

  const expandedRow = result.data.find((r) => r.id === expanded) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          <Plus size={14} className="mr-1.5" />
          New template
        </Button>
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
        emptyTitle="No templates yet"
        emptyDescription="Create one to describe what a new hire's first week looks like."
      />

      {expandedRow && (
        <section
          aria-label={`Tasks in ${expandedRow.name}`}
          className="bg-white border border-slate-200 rounded-xl shadow-enterprise overflow-hidden"
        >
          <header className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-600">
              Tasks · {expandedRow.name}
            </span>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-500 border-b border-slate-200">
                  <th className="px-4 py-2 w-[70px]">Order</th>
                  <th className="px-4 py-2">Title</th>
                  <th className="px-4 py-2 w-[110px]">Assign to</th>
                  <th className="px-4 py-2 w-[100px] text-right">Due (days)</th>
                  <th className="px-4 py-2">Description</th>
                </tr>
              </thead>
              <tbody>
                {expandedRow.tasks.map((task) => (
                  <tr key={task.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2.5 text-xs text-slate-500 tabular-nums">{task.order}</td>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{task.title}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">
                      {ASSIGN_TO_LABELS[task.assignTo] ?? task.assignTo}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-600 text-right tabular-nums">
                      {task.dueDays}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      {task.description || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <TemplateDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          load();
        }}
      />

      <ConfirmationDialog
        isOpen={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          const row = deleting;
          setDeleting(null);
          if (!row) return;
          setFailure(null);
          try {
            await onboardingTemplatesApi.remove(row.id);
            await load();
          } catch (err) {
            setFailure(err?.message ?? "That template could not be deleted.");
          }
        }}
        title="Delete this template?"
        description={
          deleting
            ? `"${deleting.name}" has never been used, so deleting it affects nothing. A template that has started an onboarding cannot be deleted — mark it inactive instead.`
            : ""
        }
        confirmText="Delete template"
        variant="danger"
      />
    </div>
  );
}

function TemplateDrawer({ open, onClose, onSaved }) {
  const [values, setValues] = useState({ name: "", appliesToRoleKey: "", active: true });
  const [tasks, setTasks] = useState([emptyTask(0)]);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({ name: "", appliesToRoleKey: "", active: true });
    setTasks([emptyTask(0)]);
    setErrors({});
    setFailure(null);
  }, [open]);

  const setTask = (index, patch) =>
    setTasks((list) => list.map((t, i) => (i === index ? { ...t, ...patch } : t)));

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const dto = {
      name: values.name,
      appliesToRoleKey: values.appliesToRoleKey || undefined,
      active: values.active,
      tasks: tasks.map((t, i) => ({
        title: t.title,
        description: t.description || undefined,
        dueDays: Number(t.dueDays) || 0,
        assignTo: t.assignTo,
        order: Number.isInteger(Number(t.order)) ? Number(t.order) : i,
      })),
    };

    const parsed = createTemplateSchema.safeParse(dto);
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path?.[0];
        // A task-level issue is reported against the task list as a whole —
        // the row it belongs to is named in the message.
        const key = field === "tasks" ? "tasks" : field;
        if (key && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }

    setSubmitting(true);
    try {
      await onboardingTemplatesApi.create(parsed.data);
      onSaved();
    } catch (err) {
      setFailure(err?.message ?? "That template could not be saved.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <Drawer isOpen onClose={onClose} title="New onboarding template" maxWidth="max-w-3xl">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label="Name"
            aria-label="Name"
            placeholder="e.g. Engineering onboarding"
            value={values.name}
            onChange={(e) => {
              setValues((v) => ({ ...v, name: e.target.value }));
              setErrors((x) => ({ ...x, name: undefined }));
            }}
            error={errors.name}
          />
          <Input
            label="Applies to role"
            aria-label="Applies to role"
            placeholder="e.g. software_engineer"
            value={values.appliesToRoleKey}
            onChange={(e) => setValues((v) => ({ ...v, appliesToRoleKey: e.target.value }))}
            error={errors.appliesToRoleKey}
            helperText="A label for your own reference — nothing is selected automatically from it."
          />
        </div>

        <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 select-none">
          <input
            type="checkbox"
            checked={values.active}
            onChange={(e) => setValues((v) => ({ ...v, active: e.target.checked }))}
            className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
          />
          Active — only an active template can start an onboarding
        </label>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-bold uppercase tracking-wide text-slate-600">
            Task templates
          </span>

          {tasks.map((task, index) => (
            <div
              key={index}
              className="flex flex-col gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg"
            >
              <div className="grid grid-cols-[1fr_130px_100px_90px_auto] gap-2 items-end">
                <Input
                  label="Title"
                  aria-label={`Task ${index + 1} title`}
                  placeholder="e.g. Collect ID proof"
                  value={task.title}
                  onChange={(e) => {
                    setTask(index, { title: e.target.value });
                    setErrors((x) => ({ ...x, tasks: undefined }));
                  }}
                />
                <SearchableSelect
                  label="Assign to"
                  value={task.assignTo}
                  onChange={(v) => setTask(index, { assignTo: v ?? "hr" })}
                  options={ASSIGN_TO_OPTIONS}
                  allowClear={false}
                />
                <Input
                  type="number"
                  min={0}
                  max={365}
                  label="Due (days)"
                  aria-label={`Task ${index + 1} due days`}
                  value={task.dueDays}
                  onChange={(e) => setTask(index, { dueDays: e.target.value })}
                />
                <Input
                  type="number"
                  min={0}
                  label="Order"
                  aria-label={`Task ${index + 1} order`}
                  value={task.order}
                  onChange={(e) => setTask(index, { order: e.target.value })}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-error-500 mb-0.5"
                  aria-label={`Remove task ${index + 1}`}
                  // The last row cannot go: a template needs at least one task,
                  // and the server refuses an empty one.
                  disabled={tasks.length === 1}
                  onClick={() => setTasks((list) => list.filter((_, i) => i !== index))}
                >
                  <Trash2 size={13} />
                </Button>
              </div>

              <div className="w-full flex flex-col gap-1.5">
                <label
                  htmlFor={`task-description-${index}`}
                  className="text-xs font-semibold text-slate-700"
                >
                  Description
                </label>
                <textarea
                  id={`task-description-${index}`}
                  rows={2}
                  value={task.description}
                  onChange={(e) => setTask(index, { description: e.target.value })}
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                />
              </div>
            </div>
          ))}

          {errors.tasks && (
            <span role="alert" className="text-xs text-error-500 font-medium">
              {errors.tasks}
            </span>
          )}

          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => setTasks((list) => [...list, emptyTask(list.length)])}
          >
            <Plus size={14} className="mr-1.5" />
            Add task
          </Button>
        </div>

        <p className="text-[11px] text-slate-500 leading-relaxed">
          Due days count forward from the day the onboarding starts. Editing a template later never
          rewrites checklists already running from it.
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
            Create
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default TemplatesTab;
