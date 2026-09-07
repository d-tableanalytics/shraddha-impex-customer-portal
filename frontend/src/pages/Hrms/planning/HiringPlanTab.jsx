import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Pencil, AlertTriangle } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { HrmsStatusBadge } from "../../../components/hrms/HrmsStatusBadge";
import { Button } from "../../../components/ui/Button";
import { Drawer } from "../../../components/ui/Drawer";
import { Input } from "../../../components/ui/Input";
import { hiringPlansApi, formatPlanDay } from "../../../services/hrms/planning";
import { departmentsApi } from "../../../services/hrms/org";
import { requisitionsApi } from "../../../services/hrms/hiring";
import {
  createHiringPlanSchema,
  updateHiringPlanSchema,
  hiringPlanStatusSchema,
} from "@shared/schemas/planning.js";
import {
  HIRING_PLAN_STATUSES,
  HIRING_PLAN_STATUS_LABELS,
} from "@shared/constants/planning.js";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";
const PAGE_SIZE = 25;

/**
 * Hiring Plan — the roles to be filled, and by when.
 *
 * ---------------------------------------------------------------------------
 * The status column finally means something
 * ---------------------------------------------------------------------------
 * The reference renders a Status tag with a five-colour map and an "Actual By"
 * column, over a table where no row can ever be anything but `planned` with an
 * empty actual date — because it ships no update endpoint at all. Both columns
 * are decoration there.
 *
 * Here the move is a real request against a server-enforced transition table,
 * and each row carries `allowedTransitions` so this offers exactly the moves
 * the server will accept — the client never decides legality.
 *
 * The status FILTER is new too. The reference's list has no filter of any kind,
 * on a table whose whole point is the status.
 */
export function HiringPlanTab({ canManage = false }) {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: PAGE_SIZE });
  const [status, setStatus] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [moving, setMoving] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(
        (await hiringPlansApi.list({
          page,
          pageSize: PAGE_SIZE,
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

  const columns = useMemo(
    () => [
      {
        header: "Role",
        className: `${CELL} font-semibold text-slate-900`,
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-col gap-0.5">
            <span>{row.role}</span>
            {(row.departmentName || row.requisitionTitle) && (
              <span className="text-[11px] font-normal text-slate-500">
                {[row.departmentName, row.requisitionTitle].filter(Boolean).join(" · ")}
              </span>
            )}
          </div>
        ),
      },
      {
        header: "Planned by",
        className: `${CELL} tabular-nums whitespace-nowrap`,
        headerClassName: HEAD,
        cell: (row) => (
          <span className="inline-flex items-center gap-1.5">
            {formatPlanDay(row.plannedByDate)}
            {row.overdue && (
              <span
                title="Past its target date"
                aria-label="Past its target date"
                className="inline-flex text-warning-600"
              >
                <AlertTriangle size={12} />
              </span>
            )}
          </span>
        ),
      },
      {
        header: "Actual by",
        className: `${CELL} tabular-nums whitespace-nowrap text-slate-600`,
        headerClassName: HEAD,
        cell: (row) => formatPlanDay(row.actualByDate),
      },
      {
        header: "Status",
        className: CELL,
        headerClassName: HEAD,
        // `in_progress`, `completed` and `cancelled` are in the shared status
        // map already; `planned` and `delayed` fall through to its titleised
        // neutral default, which is the point of that fallback.
        cell: (row) => <HrmsStatusBadge status={row.status} />,
      },
      ...(canManage
        ? [
            {
              header: "",
              className: `${CELL} w-[132px] text-right`,
              headerClassName: `${HEAD} w-[132px]`,
              // No transitions left means the plan is completed or cancelled,
              // and the server refuses to edit or move it — a closed plan is a
              // record of what happened, so neither control is offered.
              cell: (row) =>
                row.allowedTransitions?.length > 0 ? (
                  <div className="flex items-center justify-end gap-1.5">
                    <Button size="xs" variant="outline" onClick={() => setMoving(row)}>
                      Move
                    </Button>
                    <button
                      type="button"
                      aria-label={`Edit the hiring plan for ${row.role}`}
                      onClick={() => setEditing(row)}
                      className="p-1 rounded text-slate-400 hover:text-primary-700 hover:bg-slate-100"
                    >
                      <Pencil size={14} />
                    </button>
                  </div>
                ) : null,
            },
          ]
        : []),
    ],
    [canManage],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-[220px]">
          <SearchableSelect
            label="Status"
            value={status}
            onChange={(v) => {
              setStatus(v ?? null);
              setPage(1);
            }}
            options={HIRING_PLAN_STATUSES.map((s) => ({
              value: s,
              label: HIRING_PLAN_STATUS_LABELS[s],
            }))}
            placeholder="All statuses"
          />
        </div>

        {canManage && (
          <Button size="sm" variant="primary" onClick={() => setEditing({})}>
            <Plus size={14} className="mr-1.5" />
            New hiring plan
          </Button>
        )}
      </div>

      <HrmsDataTable
        columns={columns}
        rows={result.data}
        loading={loading}
        error={error}
        onRetry={load}
        page={result.page ?? page}
        pageSize={result.pageSize ?? PAGE_SIZE}
        total={result.total ?? 0}
        onPageChange={setPage}
        emptyTitle="No hiring plans"
        emptyDescription={
          canManage
            ? "Plan a role and the date it needs to be filled by."
            : "Plans appear here once HR has made them."
        }
      />

      <HiringPlanDrawer
        plan={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          load();
        }}
      />

      <MoveDrawer
        plan={moving}
        onClose={() => setMoving(null)}
        onMoved={() => {
          setMoving(null);
          load();
        }}
      />
    </div>
  );
}

/**
 * The create/edit drawer. 480px, as the reference's is.
 *
 * The status is NOT here: a transition is a different act with its own legality
 * check and its own audit entry, and it is the only thing that may stamp the
 * actual date. Folding it into a general edit form is how a state machine stops
 * being one.
 */
function HiringPlanDrawer({ plan, onClose, onSaved }) {
  const isEdit = Boolean(plan?.id);

  const [form, setForm] = useState({
    role: "",
    plannedByDate: "",
    departmentId: null,
    requisitionId: null,
    notes: "",
  });
  const [departments, setDepartments] = useState([]);
  const [requisitions, setRequisitions] = useState([]);
  const [failure, setFailure] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!plan) return;
    setFailure(null);
    setForm({
      role: plan.role ?? "",
      plannedByDate: plan.plannedByDate ?? "",
      departmentId: plan.departmentId ?? null,
      requisitionId: plan.requisitionId ?? null,
      notes: plan.notes ?? "",
    });
  }, [plan]);

  useEffect(() => {
    if (!plan) return;
    departmentsApi
      .list()
      .then((rows) => setDepartments(rows ?? []))
      .catch(() => setDepartments([]));
    requisitionsApi
      .list({ page: 1, pageSize: 100 })
      .then((res) => setRequisitions(res?.data ?? []))
      .catch(() => setRequisitions([]));
  }, [plan]);

  if (!plan) return null;

  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const payload = {
      role: form.role,
      plannedByDate: form.plannedByDate,
      departmentId: form.departmentId || null,
      requisitionId: form.requisitionId || null,
      notes: form.notes || null,
    };

    // The SAME schema the server validates with (AD-6).
    const schema = isEdit ? updateHiringPlanSchema : createHiringPlanSchema;
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      setFailure(parsed.error.issues[0]?.message ?? "Check the form.");
      return;
    }

    setSaving(true);
    try {
      if (isEdit) await hiringPlansApi.update(plan.id, parsed.data);
      else await hiringPlansApi.create(parsed.data);
      onSaved();
    } catch (err) {
      setFailure(err?.message ?? "That plan could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen
      onClose={onClose}
      title={isEdit ? "Edit hiring plan" : "New hiring plan"}
      maxWidth="max-w-[480px]"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Role"
          aria-label="Role"
          value={form.role}
          onChange={set("role")}
          placeholder="Senior Backend Engineer"
          required
        />

        <SearchableSelect
          label="Department"
          value={form.departmentId}
          onChange={(v) => setForm((f) => ({ ...f, departmentId: v }))}
          options={departments.map((d) => ({
            value: d.id,
            label: d.code ? `${d.code} · ${d.name}` : d.name,
          }))}
          placeholder="Not department-specific"
        />

        <SearchableSelect
          label="Requisition"
          value={form.requisitionId}
          onChange={(v) => setForm((f) => ({ ...f, requisitionId: v }))}
          options={requisitions.map((r) => ({ value: r.id, label: r.title }))}
          placeholder="Not linked to a requisition"
        />

        <Input
          label="Planned by"
          aria-label="Planned by"
          type="date"
          value={form.plannedByDate}
          onChange={set("plannedByDate")}
          required
        />

        <Input label="Notes" aria-label="Notes" value={form.notes} onChange={set("notes")} />

        {failure && (
          <p role="alert" className="text-xs font-semibold text-error-600">
            {failure}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={saving}>
            {isEdit ? "Save changes" : "Create plan"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/**
 * The transition drawer.
 *
 * Offers exactly the moves the SERVER says this plan can make — the row's
 * `allowedTransitions`, not a hardcoded list here. The actual date appears only
 * when completing, because that is the only status that fills it.
 */
function MoveDrawer({ plan, onClose, onMoved }) {
  const [status, setStatus] = useState(null);
  const [actualByDate, setActualByDate] = useState("");
  const [notes, setNotes] = useState("");
  const [failure, setFailure] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setStatus(null);
    setActualByDate("");
    setNotes("");
    setFailure(null);
  }, [plan]);

  if (!plan) return null;

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const parsed = hiringPlanStatusSchema.safeParse({
      status,
      actualByDate: status === "completed" && actualByDate ? actualByDate : null,
      notes: notes || null,
    });
    if (!parsed.success) {
      setFailure(parsed.error.issues[0]?.message ?? "Pick a status.");
      return;
    }

    setSaving(true);
    try {
      await hiringPlansApi.changeStatus(plan.id, parsed.data);
      onMoved();
    } catch (err) {
      setFailure(err?.message ?? "That plan could not be moved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer isOpen onClose={onClose} title={`Move ${plan.role}`} maxWidth="max-w-[420px]">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <span className="font-semibold text-slate-500">Currently</span>
          <HrmsStatusBadge status={plan.status} />
        </div>

        <SearchableSelect
          label="Move to"
          value={status}
          onChange={setStatus}
          options={(plan.allowedTransitions ?? []).map((s) => ({
            value: s,
            label: HIRING_PLAN_STATUS_LABELS[s],
          }))}
          placeholder="Pick a status"
        />

        {status === "completed" && (
          <Input
            label="Filled on"
            aria-label="Filled on"
            type="date"
            value={actualByDate}
            onChange={(e) => setActualByDate(e.target.value)}
            helperText="Left blank, today is recorded."
          />
        )}

        <Input label="Notes" aria-label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />

        {failure && (
          <p role="alert" className="text-xs font-semibold text-error-600">
            {failure}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={saving}>
            Move plan
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default HiringPlanTab;
