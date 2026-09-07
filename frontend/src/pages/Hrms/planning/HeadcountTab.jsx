import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Users, Target, IndianRupee } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Input } from "../../../components/ui/Input";
import { UtilizationBar } from "./UtilizationBar";
import { headcountPlansApi, formatPlanMoney } from "../../../services/hrms/planning";
import { departmentsApi } from "../../../services/hrms/org";
import {
  createHeadcountPlanSchema,
  updateHeadcountPlanSchema,
} from "@shared/schemas/planning.js";
import {
  financialYearFor,
  FINANCIAL_YEAR_HINT,
} from "@shared/constants/planning.js";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";
const PAGE_SIZE = 25;

/**
 * Headcount — planned people and budget per financial year.
 *
 * ---------------------------------------------------------------------------
 * What is different from the reference, and why
 * ---------------------------------------------------------------------------
 * 1. THE YEAR IS A PICKER, NOT A TEXT BOX. `PlanningPage.tsx` filters on an
 *    uncontrolled `<Input>` that refires the query on every keystroke, against
 *    a free-text column — so "FY2026", "fy2026" and "FY 2026" are three
 *    different years and a plan can vanish from its own filter. The year has a
 *    shape now, and this offers the years that have plans.
 *
 * 2. THE TILES ARE SERVER-SUMMED. The reference reduces over the rows it
 *    happened to fetch, which stops being the year's total the moment the list
 *    is paginated — and it is, here.
 *
 * 3. A PLAN CAN BE CORRECTED. The reference offers no way to edit one, so a
 *    typo in a planned number is permanent.
 *
 * 4. Actual headcount for an ORG-WIDE plan is the whole company. The reference
 *    hardcodes it to zero for any plan without a department — which its own
 *    drawer produces by default.
 */
export function HeadcountTab({ canManage = false }) {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: PAGE_SIZE });
  const [summary, setSummary] = useState(null);
  const [years, setYears] = useState([]);
  const [year, setYear] = useState(financialYearFor());
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { page, pageSize: PAGE_SIZE, ...(year ? { financialYear: year } : {}) };
      const [rows, totals] = await Promise.all([
        headcountPlansApi.list(params),
        headcountPlansApi.summary(year ? { financialYear: year } : {}),
      ]);
      setResult(rows ?? { data: [], total: 0 });
      setSummary(totals ?? null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, year]);

  useEffect(() => {
    load();
  }, [load]);

  /** The years that actually have plans, plus the current one so it is selectable. */
  useEffect(() => {
    headcountPlansApi
      .years()
      .then((list) => setYears(Array.isArray(list) ? list : []))
      .catch(() => setYears([]));
  }, [result.total]);

  const yearOptions = useMemo(() => {
    const current = financialYearFor();
    const all = [...new Set([current, ...years])].sort().reverse();
    return all.map((y) => ({ value: y, label: y }));
  }, [years]);

  const columns = useMemo(
    () => [
      {
        header: "Department",
        className: `${CELL} font-semibold text-slate-900`,
        headerClassName: HEAD,
        cell: (row) =>
          row.orgWide ? (
            // The reference's own label for a plan with no department.
            <Badge variant="neutral">Org-wide</Badge>
          ) : (
            (row.departmentName ?? "—")
          ),
      },
      {
        header: "Planned",
        className: `${CELL} tabular-nums text-right`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => row.plannedHeadcount,
      },
      {
        header: "Actual",
        className: `${CELL} tabular-nums text-right`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => row.actualHeadcount,
      },
      {
        header: "Utilization",
        className: `${CELL} w-[160px]`,
        headerClassName: `${HEAD} w-[160px]`,
        cell: (row) => (
          <UtilizationBar actual={row.actualHeadcount} planned={row.plannedHeadcount} />
        ),
      },
      {
        header: "Budget / head",
        className: `${CELL} tabular-nums text-right`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => formatPlanMoney(row.budgetPerHead),
      },
      {
        header: "Total budget",
        className: `${CELL} tabular-nums text-right font-semibold text-slate-900`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => formatPlanMoney(row.totalBudget),
      },
      ...(canManage
        ? [
            {
              header: "",
              className: `${CELL} w-[52px] text-right`,
              headerClassName: `${HEAD} w-[52px]`,
              cell: (row) => (
                <button
                  type="button"
                  aria-label={`Edit the plan for ${row.orgWide ? "the whole company" : row.departmentName}`}
                  onClick={() => setEditing(row)}
                  className="p-1 rounded text-slate-400 hover:text-primary-700 hover:bg-slate-100"
                >
                  <Pencil size={14} />
                </button>
              ),
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
            label="Financial year"
            value={year}
            onChange={(v) => {
              setYear(v ?? null);
              setPage(1);
            }}
            options={yearOptions}
            placeholder="All years"
          />
        </div>

        {canManage && (
          <Button size="sm" variant="primary" onClick={() => setEditing({})}>
            <Plus size={14} className="mr-1.5" />
            New plan
          </Button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryTile
          icon={<Target size={15} />}
          label="Planned headcount"
          value={summary ? summary.plannedHeadcount.toLocaleString("en-IN") : "—"}
        />
        <SummaryTile
          icon={<Users size={15} />}
          label="Actual headcount"
          value={summary ? summary.actualHeadcount.toLocaleString("en-IN") : "—"}
          footer={
            summary ? (
              <UtilizationBar
                actual={summary.actualHeadcount}
                planned={summary.plannedHeadcount}
              />
            ) : null
          }
        />
        <SummaryTile
          icon={<IndianRupee size={15} />}
          label="Total budget"
          value={summary ? formatPlanMoney(summary.totalBudget) : "—"}
        />
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
        emptyTitle="No headcount plans"
        emptyDescription={
          canManage
            ? "Plan a department's headcount and budget for the year."
            : "Plans appear here once HR has made them."
        }
      />

      <PlanDrawer
        plan={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          load();
        }}
        defaultYear={year ?? financialYearFor()}
      />
    </div>
  );
}

function SummaryTile({ icon, label, value, footer = null }) {
  return (
    <div className="flex flex-col gap-1.5 p-4 bg-white border border-slate-200 rounded-xl shadow-enterprise">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
        {icon}
        {label}
      </span>
      <span className="text-xl font-bold text-slate-900 tabular-nums">{value}</span>
      {footer}
    </div>
  );
}

/**
 * The create/edit drawer.
 *
 * 480px, as the reference's is. `plan` being `{}` means create; a row means
 * edit. The year and the department are read-only when editing, because
 * together they ARE the plan's identity — moving one to another department is
 * making a different plan, and the unique index says so.
 */
function PlanDrawer({ plan, onClose, onSaved, defaultYear }) {
  const isEdit = Boolean(plan?.id);

  const [form, setForm] = useState({
    financialYear: defaultYear,
    departmentId: null,
    plannedHeadcount: "",
    budgetPerHead: "",
    notes: "",
  });
  const [departments, setDepartments] = useState([]);
  const [failure, setFailure] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!plan) return;
    setFailure(null);
    setForm({
      financialYear: plan.financialYear ?? defaultYear,
      departmentId: plan.departmentId ?? null,
      plannedHeadcount: plan.plannedHeadcount === undefined ? "" : String(plan.plannedHeadcount),
      budgetPerHead:
        plan.budgetPerHead === undefined || plan.budgetPerHead === null
          ? ""
          : String(plan.budgetPerHead),
      notes: plan.notes ?? "",
    });
  }, [plan, defaultYear]);

  useEffect(() => {
    if (!plan) return;
    departmentsApi
      .list()
      .then((rows) => setDepartments(rows ?? []))
      .catch(() => setDepartments([]));
  }, [plan]);

  if (!plan) return null;

  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const payload = isEdit
      ? {
          plannedHeadcount: form.plannedHeadcount,
          budgetPerHead: form.budgetPerHead === "" ? null : form.budgetPerHead,
          notes: form.notes || null,
        }
      : {
          financialYear: form.financialYear,
          departmentId: form.departmentId || null,
          plannedHeadcount: form.plannedHeadcount,
          budgetPerHead: form.budgetPerHead === "" ? null : form.budgetPerHead,
          notes: form.notes || null,
        };

    // The SAME schema the server validates with (AD-6), so the rules cannot
    // drift between the form and the API.
    const schema = isEdit ? updateHeadcountPlanSchema : createHeadcountPlanSchema;
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      setFailure(parsed.error.issues[0]?.message ?? "Check the form.");
      return;
    }

    setSaving(true);
    try {
      if (isEdit) await headcountPlansApi.update(plan.id, parsed.data);
      else await headcountPlansApi.create(parsed.data);
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
      title={isEdit ? "Edit headcount plan" : "New headcount plan"}
      maxWidth="max-w-[480px]"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {isEdit ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-bold text-slate-500">Plan</span>
            <span className="text-sm font-semibold text-slate-900">
              {plan.financialYear} · {plan.orgWide ? "Org-wide" : plan.departmentName}
            </span>
          </div>
        ) : (
          <>
            <Input
              label="Financial year"
              aria-label="Financial year"
              value={form.financialYear}
              onChange={set("financialYear")}
              placeholder="FY2026"
              helperText={FINANCIAL_YEAR_HINT}
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
              placeholder="Org-wide"
            />
          </>
        )}

        <Input
          label="Planned headcount"
          aria-label="Planned headcount"
          type="number"
          min="0"
          step="1"
          value={form.plannedHeadcount}
          onChange={set("plannedHeadcount")}
          required
        />

        <Input
          label="Budget per head"
          aria-label="Budget per head"
          type="number"
          min="0"
          step="0.01"
          value={form.budgetPerHead}
          onChange={set("budgetPerHead")}
          helperText="Annual cost per person. The total is calculated for you."
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

export default HeadcountTab;
