import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Modal } from "../../../components/ui/Modal";
import { Input } from "../../../components/ui/Input";
import { payGroupsApi } from "../../../services/hrms";
import { createPayGroupSchema } from "@shared/schemas/payroll.js";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";

/**
 * Pay groups — the legal entities payroll runs against.
 *
 * The reference's Pay Groups tab: code, name, legal entity, default flag.
 *
 * The form validates with the SERVER's schema, imported from `@shared`, so the
 * rules the browser enforces are literally the rules the API enforces.
 */
export function PayGroupsTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [failure, setFailure] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows((await payGroupsApi.list()) ?? []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = useCallback(
    async (row) => {
      setFailure(null);
      try {
        await payGroupsApi.remove(row.id);
        await load();
      } catch (err) {
        // The commonest refusal is "people are still paid through this group",
        // which is a 409 the person needs to read rather than a silent no-op.
        setFailure(err?.message ?? "That pay group could not be retired.");
      }
    },
    [load],
  );

  const columns = useMemo(
    () => [
      {
        header: "Code",
        className: `${CELL} font-semibold text-slate-900 w-[120px]`,
        headerClassName: HEAD,
        cell: (row) => row.code,
      },
      { header: "Name", className: CELL, headerClassName: HEAD, cell: (row) => row.name },
      {
        header: "Legal entity",
        className: CELL,
        headerClassName: HEAD,
        cell: (row) => <span className="text-slate-600">{row.legalEntityName}</span>,
      },
      {
        header: "Default",
        className: `${CELL} w-[100px]`,
        headerClassName: HEAD,
        cell: (row) =>
          row.isDefault ? <Badge variant="primary">Default</Badge> : <span className="text-slate-400">—</span>,
      },
      {
        header: "",
        className: `${CELL} w-[150px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex gap-1.5">
            <Button size="xs" variant="secondary" onClick={() => setEditing(row)}>
              Edit
            </Button>
            <Button size="xs" variant="ghost" className="text-error-500" onClick={() => remove(row)}>
              Retire
            </Button>
          </div>
        ),
      },
    ],
    [remove],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">
          A payroll run belongs to one pay group. The legal entity is what a payslip is issued
          under.
        </p>
        <Button size="sm" variant="primary" onClick={() => setEditing({})}>
          <Plus size={14} className="mr-1.5" />
          New pay group
        </Button>
      </div>

      {failure && (
        <p role="alert" className="text-xs text-error-500 font-medium">
          {failure}
        </p>
      )}

      <HrmsDataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={load}
        total={rows.length}
        pageSize={rows.length || 1}
        emptyTitle="No pay groups yet"
        emptyDescription="Create one before building salary structures."
      />

      <PayGroupDialog
        row={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          load();
        }}
      />
    </div>
  );
}

function PayGroupDialog({ row, onClose, onSaved }) {
  const [values, setValues] = useState({ code: "", name: "", legalEntityName: "", isDefault: false });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!row) return;
    setValues({
      code: row.code ?? "",
      name: row.name ?? "",
      legalEntityName: row.legalEntityName ?? "",
      isDefault: Boolean(row.isDefault),
    });
    setErrors({});
    setFailure(null);
  }, [row]);

  const set = (key) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const parsed = createPayGroupSchema.safeParse(values);
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
      if (row?.id) await payGroupsApi.update(row.id, parsed.data);
      else await payGroupsApi.create(parsed.data);
      onSaved();
    } catch (err) {
      setFailure(err?.message ?? "The pay group could not be saved.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={Boolean(row)}
      onClose={onClose}
      title={row?.id ? "Edit pay group" : "New pay group"}
      size="sm"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Code"
          aria-label="Code"
          value={values.code}
          onChange={set("code")}
          error={errors.code}
          helperText="Uppercase letters, numbers, hyphen or underscore."
        />
        <Input label="Name" aria-label="Name" value={values.name} onChange={set("name")} error={errors.name} />
        <Input
          label="Legal entity name"
          aria-label="Legal entity name"
          value={values.legalEntityName}
          onChange={set("legalEntityName")}
          error={errors.legalEntityName}
          helperText="As it should appear on a payslip."
        />

        <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
          <input type="checkbox" checked={values.isDefault} onChange={set("isDefault")} />
          Make this the default pay group
        </label>

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
    </Modal>
  );
}

export default PayGroupsTab;
