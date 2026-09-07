import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm, FormProvider, useFormContext } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Pencil, Trash2, Users } from "lucide-react";
import toast from "react-hot-toast";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { PermissionGate } from "../../../components/hrms/PermissionGate";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Drawer } from "../../../components/ui/Drawer";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { departmentsApi, HrmsApiError } from "../../../services/hrms";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { createDepartmentSchema } from "@shared/schemas/org.js";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Departments — the first Org Structure tab.
 *
 * Follows the reference's `DepartmentsTab`: an unpaginated table ordered by the
 * server, a right-hand drawer for create and edit, and a confirmation dialog
 * for delete. Two visible fields only; the reference's `parentId` and
 * `headEmployeeId` are in its DTO and in none of its UI, so they are in neither
 * here (O-1, O-2).
 *
 * ---------------------------------------------------------------------------
 * Deletion is the server's decision, not this component's
 * ---------------------------------------------------------------------------
 * The reference DISABLES its delete button when `employeeCount > 0`. That is a
 * guess made from a number fetched earlier: someone assigned in the meantime is
 * invisible to it, and its own count includes soft-deleted employees, so a
 * department whose staff have all been deactivated can never be removed at all.
 *
 * Here the request is always sent and the server answers. A 409 carries the
 * live count and the sentence to show. The check that matters runs once, on the
 * side that owns the data.
 */

/**
 * The table is unpaginated, as the reference's is - these are catalogues of
 * tens of rows. `HrmsDataTable` hides its pager when `total <= pageSize`, so a
 * pageSize far above any real catalogue keeps it hidden while still giving the
 * loading skeleton a sensible row count.
 */
const UNPAGINATED = 1000;

const emptyDepartment = { code: "", name: "" };

function DepartmentFields() {
  const { register } = useFormContext();
  return (
    <div className="flex flex-col gap-4">
      <Field label="Code" required hint="Shown in tables and dropdowns, and used by the import.">
        <Input {...register("code")} placeholder="e.g. ENG" className="uppercase" />
      </Field>
      <Field label="Name" required>
        <Input {...register("name")} placeholder="e.g. Engineering" />
      </Field>
    </div>
  );
}

/** Label + error, matching the Employee form's field shape. */
export function Field({ label, required, hint, name, children }) {
  const {
    formState: { errors },
  } = useFormContext();
  const key = name ?? label?.toLowerCase();
  const error = errors[key];

  return (
    <div>
      <label className="text-xs font-semibold text-slate-700 select-none block mb-1.5">
        {label}
        {required && <span className="text-error-500 ml-0.5">*</span>}
      </label>
      {children}
      {error?.message && (
        <span className="text-xs text-error-500 font-medium mt-1 block">{error.message}</span>
      )}
      {!error?.message && hint && (
        <span className="text-xs text-slate-400 mt-1 block">{hint}</span>
      )}
    </div>
  );
}

export function DepartmentsTab() {
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [drawer, setDrawer] = useState(null); // { mode, target }
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null); // the row awaiting deletion
  const [deleting, setDeleting] = useState(false);

  const canEdit = can(M.ORG_STRUCTURE, A.EDIT, S.ORG);
  const canViewEmployees =
    can(M.EMPLOYEES, A.VIEW, S.ORG) || can(M.EMPLOYEES, A.VIEW, S.TEAM);

  const methods = useForm({
    resolver: zodResolver(createDepartmentSchema),
    defaultValues: emptyDepartment,
    mode: "onBlur",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await departmentsApi.list());
    } catch (err) {
      setError(err instanceof HrmsApiError ? err : new HrmsApiError(err.message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    methods.reset(emptyDepartment);
    setDrawer({ mode: "create" });
  };

  const openEdit = (row) => {
    methods.reset({ code: row.code, name: row.name });
    setDrawer({ mode: "edit", target: row });
  };

  const submit = methods.handleSubmit(async (values) => {
    setSaving(true);
    try {
      if (drawer.mode === "create") {
        await departmentsApi.create(values);
        toast.success("Department created.");
      } else {
        await departmentsApi.update(drawer.target.id, values);
        toast.success("Department updated.");
      }
      setDrawer(null);
      // Reload rather than patching local state: `employeeCount` is computed
      // server-side, so a locally spliced row would show a stale one.
      await load();
    } catch (err) {
      toast.error(err.message ?? "Could not save the department.");
    } finally {
      setSaving(false);
    }
  });

  const remove = async () => {
    setDeleting(true);
    try {
      await departmentsApi.remove(confirm.id);
      toast.success(`${confirm.name} deleted.`);
      setConfirm(null);
      await load();
    } catch (err) {
      // The server's message already names the count and what to do about it.
      toast.error(err.message ?? "Could not delete the department.");
      setConfirm(null);
    } finally {
      setDeleting(false);
    }
  };

  const openEmployees = (row) =>
    navigate(`${HRMS_ROUTE_PREFIX}/employees?departmentId=${row.id}`);

  const columns = useMemo(() => {
    const base = [
      {
        header: "Code",
        accessorKey: "code",
        className: "w-32",
        cell: (row) => <Badge>{row.code}</Badge>,
      },
      { header: "Name", accessorKey: "name" },
      {
        header: "Employees",
        accessorKey: "employeeCount",
        className: "text-right w-36",
        headerClassName: "text-right",
        cell: (row) =>
          canViewEmployees && row.employeeCount > 0 ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openEmployees(row);
              }}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary-600 hover:text-primary-800"
              title={`View the ${row.employeeCount} employee${row.employeeCount === 1 ? "" : "s"} in ${row.name}`}
            >
              <Users size={13} />
              {row.employeeCount.toLocaleString()}
            </button>
          ) : (
            <span className="text-slate-600">{row.employeeCount.toLocaleString()}</span>
          ),
      },
    ];

    if (canEdit) {
      base.push({
        header: "",
        className: "w-24 text-right",
        cell: (row) => (
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => openEdit(row)}
              aria-label={`Edit ${row.name}`}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              onClick={() => setConfirm(row)}
              aria-label={`Delete ${row.name}`}
              className="p-1.5 rounded-lg text-slate-400 hover:text-error-600 hover:bg-error-50 transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ),
      });
    }

    return base;
  }, [canEdit, canViewEmployees]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-slate-500 max-w-xl">
          Departments group employees for reporting and access. Assigning one to an employee is
          optional, and a department cannot be deleted while anyone is still assigned to it.
        </p>
        <PermissionGate module={M.ORG_STRUCTURE} action={A.EDIT} scope={S.ORG}>
          <Button onClick={openCreate}>
            <Plus size={15} className="mr-1.5" />
            New Department
          </Button>
        </PermissionGate>
      </div>

      <HrmsDataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={load}
        total={rows.length}
        pageSize={UNPAGINATED}
        onRowClick={
          canViewEmployees ? (row) => row.employeeCount > 0 && openEmployees(row) : undefined
        }
        emptyTitle="No departments yet"
        emptyDescription={
          canEdit
            ? "Add the first department to start grouping employees."
            : "No departments have been set up yet."
        }
      />

      <Drawer
        isOpen={drawer !== null}
        onClose={saving ? () => {} : () => setDrawer(null)}
        title={drawer?.mode === "create" ? "New Department" : "Edit Department"}
        maxWidth="max-w-md"
      >
        <FormProvider {...methods}>
          <form onSubmit={submit} noValidate className="flex flex-col gap-6">
            <DepartmentFields />
            <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
              <Button type="button" variant="secondary" onClick={() => setDrawer(null)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" loading={saving}>
                Save
              </Button>
            </div>
          </form>
        </FormProvider>
      </Drawer>

      <ConfirmationDialog
        isOpen={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={remove}
        loading={deleting}
        variant="danger"
        title={confirm ? `Delete "${confirm.name}"?` : ""}
        description="The department is retired and stops appearing as a choice. Employees still assigned to it keep the assignment, so the server will refuse while anyone is."
        confirmText="Delete"
      />
    </div>
  );
}

export default DepartmentsTab;
