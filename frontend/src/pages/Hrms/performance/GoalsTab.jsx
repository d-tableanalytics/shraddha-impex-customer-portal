import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, ChevronRight, ChevronDown } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Modal } from "../../../components/ui/Modal";
import { Input } from "../../../components/ui/Input";
import { DateField } from "../../../components/ui/DateField";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import {
  goalsApi,
  cyclesApi,
  GOAL_STATUS_TONES,
  formatPerfDay,
  formatMeasure,
} from "../../../services/hrms/performance";
import { ProgressMeter } from "./ProgressMeter";
import { createGoalSchema } from "@shared/schemas/performance.js";
import {
  GOAL_STATUSES,
  GOAL_STATUS_LABELS,
  GOAL_TRANSITIONS,
} from "@shared/constants/performance.js";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";

const STATUS_OPTIONS = GOAL_STATUSES.map((value) => ({
  value,
  label: GOAL_STATUS_LABELS[value] ?? value,
}));

/**
 * Goals — OKR-style, cascading through a parent.
 *
 * The reference's Goals tab: Title, Cycle, Parent, a progress bar,
 * Current/Target, Weight, Due, Status, and per-row actions. The expandable row
 * shows the description.
 *
 * Two deliberate departures from its action cell:
 *
 *   - the status picker offers only the transitions the SERVER permits, rather
 *     than every status but the current one; and
 *   - progress is recorded in a small dialog rather than by a bare number input
 *     that fires a PATCH on every keystroke.
 */
export function GoalsTab() {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [creating, setCreating] = useState(false);
  const [progressOn, setProgressOn] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(
        (await goalsApi.list({ page, pageSize: 25, ...(status ? { status } : {}) })) ?? {
          data: [],
          total: 0,
        },
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

  const setGoalStatus = useCallback(
    async (row, next) => {
      setBusy(row.id);
      setFailure(null);
      try {
        await goalsApi.update(row.id, { status: next });
        await load();
      } catch (err) {
        // "Only the owner or HR can update it" arrives here — a rule the person
        // needs to read rather than a control that quietly does nothing.
        setFailure(err?.message ?? "That goal could not be updated.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const columns = useMemo(
    () => [
      {
        header: "",
        className: `${CELL} w-[42px]`,
        headerClassName: `${HEAD} w-[42px]`,
        cell: (row) => (
          <button
            type="button"
            aria-label={expanded === row.id ? `Hide details for ${row.title}` : `Show details for ${row.title}`}
            aria-expanded={expanded === row.id}
            onClick={() => setExpanded((c) => (c === row.id ? null : row.id))}
            className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            {expanded === row.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        ),
      },
      {
        header: "Title",
        className: `${CELL} font-semibold text-slate-900`,
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-col">
            <span>{row.title}</span>
            <span className="text-[11px] font-normal text-slate-500">{row.employeeName}</span>
          </div>
        ),
      },
      {
        header: "Cycle",
        className: `${CELL} w-[160px] text-xs text-slate-600`,
        headerClassName: HEAD,
        cell: (row) => row.cycleName || <span className="text-slate-400">—</span>,
      },
      {
        header: "Parent",
        className: `${CELL} w-[180px] text-xs text-slate-600`,
        headerClassName: HEAD,
        cell: (row) => row.parentGoalTitle || <span className="text-slate-400">—</span>,
      },
      {
        header: "Progress",
        className: `${CELL} w-[170px]`,
        headerClassName: HEAD,
        cell: (row) =>
          row.progressPercent === null ? (
            <span className="text-slate-400">—</span>
          ) : (
            <ProgressMeter percent={row.progressPercent} />
          ),
      },
      {
        header: "Current / Target",
        className: `${CELL} w-[160px] text-right text-xs tabular-nums`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) =>
          row.targetValue === null ? (
            <span className="text-slate-400">—</span>
          ) : (
            <span>
              {formatMeasure(row.currentValue)} / {formatMeasure(row.targetValue, row.unit)}
            </span>
          ),
      },
      {
        header: "Weight",
        className: `${CELL} w-[80px] text-right tabular-nums text-xs text-slate-600`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => row.weight,
      },
      {
        header: "Due",
        className: `${CELL} w-[130px] text-xs text-slate-600 tabular-nums`,
        headerClassName: HEAD,
        cell: (row) => formatPerfDay(row.dueDate),
      },
      {
        header: "Status",
        className: `${CELL} w-[120px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <Badge variant={GOAL_STATUS_TONES[row.status] ?? "neutral"}>
            {GOAL_STATUS_LABELS[row.status] ?? row.status}
          </Badge>
        ),
      },
      {
        header: "",
        className: `${CELL} w-[250px]`,
        headerClassName: HEAD,
        cell: (row) => {
          /**
           * Only the moves the SERVER permits.
           *
           * The reference offers every status but the current one, so most
           * choices come straight back as an error.
           */
          const next = GOAL_TRANSITIONS[row.status] ?? [];
          return (
            <div className="flex flex-wrap items-center gap-1.5">
              {next.length > 0 && (
                <SearchableSelect
                  className="w-[124px]"
                  value={null}
                  onChange={(value) => value && setGoalStatus(row, value)}
                  options={next.map((value) => ({
                    value,
                    label: GOAL_STATUS_LABELS[value] ?? value,
                  }))}
                  allowClear={false}
                  loading={busy === row.id}
                  placeholder="Set status"
                />
              )}
              {row.targetValue !== null && (
                <Button size="xs" variant="outline" onClick={() => setProgressOn(row)}>
                  Progress
                </Button>
              )}
              <Button
                size="xs"
                variant="ghost"
                className="text-error-500"
                aria-label={`Delete ${row.title}`}
                title={
                  row.childCount > 0
                    ? "Goals cascade from this one. Cancel it instead."
                    : undefined
                }
                disabled={row.childCount > 0}
                onClick={() => setDeleting(row)}
              >
                <Trash2 size={13} />
              </Button>
            </div>
          );
        },
      },
    ],
    [busy, expanded, setGoalStatus],
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
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          <Plus size={14} className="mr-1.5" />
          New goal
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
        emptyTitle="No goals yet"
        emptyDescription="Set one to say what you are working towards this cycle."
      />

      {expandedRow && (
        <section
          aria-label={`Details for ${expandedRow.title}`}
          className="p-4 bg-white border border-slate-200 rounded-xl shadow-enterprise"
        >
          <h4 className="text-xs font-bold uppercase tracking-wide text-slate-600">Description</h4>
          <p className="mt-1.5 text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
            {expandedRow.description || "No description."}
          </p>
          {expandedRow.childCount > 0 && (
            <p className="mt-2 text-[11px] text-slate-500">
              {expandedRow.childCount} goal{expandedRow.childCount === 1 ? "" : "s"} cascade from
              this one.
            </p>
          )}
        </section>
      )}

      <GoalDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          load();
        }}
      />

      <ProgressDialog
        goal={progressOn}
        onClose={() => setProgressOn(null)}
        onDone={() => {
          setProgressOn(null);
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
            await goalsApi.remove(row.id);
            await load();
          } catch (err) {
            setFailure(err?.message ?? "That goal could not be deleted.");
          }
        }}
        title="Delete this goal?"
        description={
          deleting
            ? `"${deleting.title}" will be removed. A goal that others cascade from cannot be deleted — cancel it instead.`
            : ""
        }
        confirmText="Delete goal"
        variant="danger"
      />
    </div>
  );
}

function GoalDrawer({ open, onClose, onSaved }) {
  const [cycles, setCycles] = useState([]);
  const [parents, setParents] = useState([]);
  const [values, setValues] = useState({
    title: "",
    description: "",
    cycleId: null,
    parentGoalId: null,
    targetValue: "",
    unit: "",
    weight: 1,
    dueDate: "",
  });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({
      title: "",
      description: "",
      cycleId: null,
      parentGoalId: null,
      targetValue: "",
      unit: "",
      weight: 1,
      dueDate: "",
    });
    setErrors({});
    setFailure(null);

    Promise.all([
      cyclesApi.list({ page: 1, pageSize: 100 }),
      goalsApi.list({ page: 1, pageSize: 100 }),
    ])
      .then(([c, g]) => {
        // A closed cycle cannot take a new goal; the server refuses it, so it
        // is not offered.
        setCycles((c?.data ?? []).filter((x) => x.phase !== "closed"));
        setParents(g?.data ?? []);
      })
      .catch(() => setFailure("The cycle or goal list could not be loaded."));
  }, [open]);

  const set = (key) => (event) => {
    setValues((v) => ({ ...v, [key]: event.target.value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const dto = {
      title: values.title,
      description: values.description || undefined,
      cycleId: values.cycleId || undefined,
      parentGoalId: values.parentGoalId || undefined,
      targetValue: values.targetValue || undefined,
      unit: values.unit || undefined,
      weight: Number(values.weight) || 1,
      dueDate: values.dueDate || undefined,
    };

    // The SERVER's schema, imported from @shared — the rules the form enforces
    // are literally the rules the API enforces.
    const parsed = createGoalSchema.safeParse(dto);
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
      await goalsApi.create(parsed.data);
      onSaved();
    } catch (err) {
      setFailure(err?.message ?? "That goal could not be saved.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <Drawer isOpen onClose={onClose} title="New goal" maxWidth="max-w-xl">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Title"
          aria-label="Title"
          placeholder="e.g. Ship the P6 modules by end of Q3"
          value={values.title}
          onChange={set("title")}
          error={errors.title}
        />

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="goal-description" className="text-xs font-semibold text-slate-700">
            Description
          </label>
          <textarea
            id="goal-description"
            rows={3}
            value={values.description}
            onChange={set("description")}
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <SearchableSelect
            label="Cycle"
            value={values.cycleId}
            onChange={(v) => setValues((prev) => ({ ...prev, cycleId: v }))}
            options={cycles.map((c) => ({ value: c.id, label: c.name, hint: c.phase }))}
            placeholder="(no cycle)"
            error={errors.cycleId}
          />
          <SearchableSelect
            label="Parent goal"
            value={values.parentGoalId}
            onChange={(v) => setValues((prev) => ({ ...prev, parentGoalId: v }))}
            options={parents.map((g) => ({ value: g.id, label: g.title, hint: g.employeeName }))}
            placeholder="(no parent)"
            error={errors.parentGoalId}
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Input
            label="Target value"
            aria-label="Target value"
            value={values.targetValue}
            onChange={set("targetValue")}
            error={errors.targetValue}
          />
          <Input
            label="Unit"
            aria-label="Unit"
            placeholder="e.g. modules, %"
            value={values.unit}
            onChange={set("unit")}
            error={errors.unit}
          />
          <Input
            type="number"
            min={1}
            max={10}
            label="Weight"
            aria-label="Weight"
            value={values.weight}
            onChange={set("weight")}
            error={errors.weight}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-slate-700">Due date</label>
          <DateField
            value={values.dueDate}
            onChange={(dueDate) => {
              setValues((v) => ({ ...v, dueDate }));
              setErrors((e) => ({ ...e, dueDate: undefined }));
            }}
          />
          {errors.dueDate && (
            <span className="text-xs text-error-500 font-medium">{errors.dueDate}</span>
          )}
        </div>

        <p className="text-[11px] text-slate-500 leading-relaxed">
          A target value makes progress measurable — without one the goal is tracked by status
          alone. Weight is recorded for your own reference; nothing is scored from it.
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
            Save
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/**
 * Recording progress.
 *
 * A dialog rather than the reference's bare number input, which fires a PATCH
 * on every keystroke — typing "12" writes 1 and then 12, and a backspace writes
 * a value nobody intended.
 */
function ProgressDialog({ goal, onClose, onDone }) {
  const [value, setValue] = useState("");
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setValue(goal ? String(goal.currentValue ?? "") : "");
    setFailure(null);
  }, [goal]);

  if (!goal) return null;

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);
    if (value.trim() === "") {
      setFailure("Enter the value reached so far.");
      return;
    }
    setSubmitting(true);
    try {
      await goalsApi.update(goal.id, { currentValue: value.trim() });
      onDone();
    } catch (err) {
      setFailure(err?.message ?? "That progress could not be recorded.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Progress — ${goal.title}`} size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label={`Reached so far${goal.unit ? ` (${goal.unit})` : ""}`}
          aria-label="Reached so far"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          helperText={`Target: ${formatMeasure(goal.targetValue, goal.unit)}`}
        />

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
            Record
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default GoalsTab;
