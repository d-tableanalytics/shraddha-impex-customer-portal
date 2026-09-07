import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Check, XCircle } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Modal } from "../../../components/ui/Modal";
import { Input } from "../../../components/ui/Input";
import { requisitionsApi, departmentsApi, locationsApi } from "../../../services/hrms";
import { REQUISITION_STATUS_TONES, formatCtc } from "../../../services/hrms/hiring";
import { createRequisitionSchema } from "@shared/schemas/hiring.js";
import { REQUISITION_STATUSES } from "@shared/constants/hiring.js";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";

const STATUS_OPTIONS = REQUISITION_STATUSES.map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}));

/**
 * Requisitions — the hiring request and its approval.
 *
 * The reference's Requisitions tab: title, department, location, headcount,
 * budget range, status, and the counts of postings and applications hanging off
 * it.
 *
 * Approve and Cancel are the two actions, and both are permission-checked
 * server-side — approve additionally refuses whoever raised the requisition, so
 * a button the UI offers can still be declined and that refusal is shown rather
 * than swallowed.
 */
export function RequisitionsTab() {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(
        (await requisitionsApi.list({ page, pageSize: 25, ...(status ? { status } : {}) })) ?? {
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

  const approve = useCallback(
    async (row) => {
      setBusy(row.id);
      setFailure(null);
      try {
        await requisitionsApi.approve(row.id);
        await load();
      } catch (err) {
        // The commonest refusal is "you raised this one" — a rule the person
        // needs to read rather than a button that quietly does nothing.
        setFailure(err?.message ?? "That requisition could not be approved.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const columns = useMemo(
    () => [
      {
        header: "Role",
        className: `${CELL} font-semibold text-slate-900`,
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-col">
            <span>{row.title}</span>
            <span className="text-[11px] font-normal text-slate-500">
              {[row.departmentName, row.locationName].filter(Boolean).join(" · ") || "—"}
            </span>
          </div>
        ),
      },
      {
        header: "Headcount",
        className: `${CELL} w-[100px] text-right tabular-nums`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => row.headcount,
      },
      {
        header: "Budget",
        className: `${CELL} w-[190px] text-right tabular-nums`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) =>
          row.budgetMin || row.budgetMax ? (
            <span className="text-xs">
              {formatCtc(row.budgetMin)} – {formatCtc(row.budgetMax)}
            </span>
          ) : (
            <span className="text-slate-400">—</span>
          ),
      },
      {
        header: "Status",
        className: `${CELL} w-[110px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-col gap-1">
            <Badge variant={REQUISITION_STATUS_TONES[row.status] ?? "neutral"}>{row.status}</Badge>
            {row.cancellationReason && (
              <span className="text-[10.5px] text-slate-500 leading-snug">
                {row.cancellationReason}
              </span>
            )}
          </div>
        ),
      },
      {
        header: "Pipeline",
        className: `${CELL} w-[110px] text-xs text-slate-600`,
        headerClassName: HEAD,
        cell: (row) => (
          <span>
            {row.applicationCount} applicant{row.applicationCount === 1 ? "" : "s"}
            <span className="block text-[10.5px] text-slate-400">
              {row.postingCount} posting{row.postingCount === 1 ? "" : "s"}
            </span>
          </span>
        ),
      },
      {
        header: "",
        className: `${CELL} w-[190px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-wrap gap-1.5">
            {row.status === "draft" && (
              <Button
                size="xs"
                variant="primary"
                loading={busy === row.id}
                onClick={() => approve(row)}
              >
                <Check size={12} className="mr-1" />
                Approve
              </Button>
            )}
            {!["filled", "cancelled"].includes(row.status) && (
              <Button
                size="xs"
                variant="ghost"
                className="text-error-500"
                onClick={() => setCancelling(row)}
              >
                <XCircle size={12} className="mr-1" />
                Cancel
              </Button>
            )}
          </div>
        ),
      },
    ],
    [approve, busy],
  );

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
            placeholder="Status"
          />
          {status && (
            <Button
              variant="ghost"
              size="sm"
              className="text-slate-500"
              onClick={() => {
                setStatus(null);
                setPage(1);
              }}
            >
              Clear
            </Button>
          )}
        </div>
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          <Plus size={14} className="mr-1.5" />
          Raise requisition
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
        emptyTitle="No requisitions yet"
        emptyDescription="Raise one to start hiring for a role."
      />

      <RequisitionDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
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

function RequisitionDialog({ open, onClose, onSaved }) {
  const [values, setValues] = useState({
    title: "",
    departmentId: null,
    locationId: null,
    headcount: 1,
    budgetMin: "",
    budgetMax: "",
    businessJustification: "",
  });
  const [departments, setDepartments] = useState([]);
  const [locations, setLocations] = useState([]);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({
      title: "",
      departmentId: null,
      locationId: null,
      headcount: 1,
      budgetMin: "",
      budgetMax: "",
      businessJustification: "",
    });
    setErrors({});
    setFailure(null);
    // The two catalogues the form's pickers need. Failing to load them must not
    // block the form — a requisition without a department is valid.
    Promise.all([departmentsApi.list(), locationsApi.list()])
      .then(([d, l]) => {
        setDepartments(d ?? []);
        setLocations(l ?? []);
      })
      .catch(() => {});
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
      departmentId: values.departmentId || undefined,
      locationId: values.locationId || undefined,
      headcount: Number(values.headcount) || 1,
      budgetMin: values.budgetMin || undefined,
      budgetMax: values.budgetMax || undefined,
      businessJustification: values.businessJustification || undefined,
    };

    // The SERVER's schema, imported from @shared — so the rules the form
    // enforces are literally the rules the API enforces.
    const parsed = createRequisitionSchema.safeParse(dto);
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
      await requisitionsApi.create(parsed.data);
      onSaved();
    } catch (err) {
      setFailure(err?.message ?? "The requisition could not be saved.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title="Raise a requisition" size="md">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Role title"
          aria-label="Role title"
          value={values.title}
          onChange={set("title")}
          error={errors.title}
        />

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-700">Department</label>
            <SearchableSelect
              value={values.departmentId}
              onChange={(v) => setValues((prev) => ({ ...prev, departmentId: v }))}
              options={departments.map((d) => ({ value: d.id, label: `${d.code} · ${d.name}` }))}
              placeholder="Optional"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-700">Location</label>
            <SearchableSelect
              value={values.locationId}
              onChange={(v) => setValues((prev) => ({ ...prev, locationId: v }))}
              options={locations.map((l) => ({ value: l.id, label: `${l.code} · ${l.name}` }))}
              placeholder="Optional"
            />
          </div>
        </div>

        <Input
          type="number"
          label="Headcount"
          aria-label="Headcount"
          min={1}
          max={100}
          value={values.headcount}
          onChange={set("headcount")}
          error={errors.headcount}
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Budget from"
            aria-label="Budget from"
            value={values.budgetMin}
            onChange={set("budgetMin")}
            error={errors.budgetMin}
            helperText="Annual CTC"
          />
          <Input
            label="Budget to"
            aria-label="Budget to"
            value={values.budgetMax}
            onChange={set("budgetMax")}
            error={errors.budgetMax}
          />
        </div>

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="requisition-justification" className="text-xs font-semibold text-slate-700">
            Business justification
          </label>
          <textarea
            id="requisition-justification"
            rows={3}
            value={values.businessJustification}
            onChange={set("businessJustification")}
            placeholder="Why is this role needed?"
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none transition-all placeholder-slate-400 text-slate-900 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
        </div>

        <p className="text-[11px] text-slate-500">
          A requisition is raised as a draft. Somebody else must approve it before it can be
          posted.
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
            Raise requisition
          </Button>
        </div>
      </form>
    </Modal>
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
      setFailure("Say why the requisition is being cancelled.");
      return;
    }
    setSubmitting(true);
    try {
      await requisitionsApi.setStatus(row.id, "cancelled", reason);
      onDone();
    } catch (err) {
      setFailure(err?.message ?? "That requisition could not be cancelled.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Cancel "${row.title}"?`} size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-slate-600 leading-relaxed">
          A cancelled requisition is final — it cannot be reopened, and no further applications
          will be accepted.
        </p>

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="cancel-reason" className="text-xs font-semibold text-slate-700">
            Reason
          </label>
          <textarea
            id="cancel-reason"
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
            Cancel requisition
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default RequisitionsTab;
