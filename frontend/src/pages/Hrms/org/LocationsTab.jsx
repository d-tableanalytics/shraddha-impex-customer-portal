import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm, FormProvider, useFormContext, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Pencil, Trash2 } from "lucide-react";
import toast from "react-hot-toast";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { PermissionGate } from "../../../components/hrms/PermissionGate";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Drawer } from "../../../components/ui/Drawer";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { locationsApi, HrmsApiError } from "../../../services/hrms";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { Field } from "./DepartmentsTab";
import { createLocationSchema } from "@shared/schemas/org.js";
import { TIME_ZONES, DEFAULT_TIME_ZONE } from "@shared/constants/timezones.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Locations — the second Org Structure tab.
 *
 * The mirror of Departments: unpaginated, server-ordered, drawer for create and
 * edit, confirmation for delete, and the same rule that the server decides
 * whether a location may be retired.
 *
 * The one field with real behaviour is `timezone`. The reference offers seven
 * hardcoded zones in a Select and accepts any 60-character string on its
 * server. Here the picker is fed from the runtime's own IANA list and the value
 * is validated on both sides - see shared/constants/timezones.js for why the
 * offered list and the accepted set are deliberately not identical.
 */

const UNPAGINATED = 1000;

const emptyLocation = {
  code: "",
  name: "",
  city: "",
  country: "",
  address: "",
  timezone: DEFAULT_TIME_ZONE,
};

/** 419 zones, so the select's search box is doing real work here. */
const TIMEZONE_OPTIONS = TIME_ZONES.map((tz) => ({ value: tz, label: tz }));

function TimezoneSelect() {
  const { control, setValue } = useFormContext();
  const value = useWatch({ control, name: "timezone" });

  return (
    <SearchableSelect
      value={value ?? null}
      onChange={(v) => setValue("timezone", v ?? DEFAULT_TIME_ZONE, { shouldDirty: true })}
      options={TIMEZONE_OPTIONS}
      placeholder="Select a timezone"
      searchPlaceholder="Search zones…"
      emptyText="No matching zone"
    />
  );
}

function LocationFields() {
  const { register } = useFormContext();

  // Field order follows the reference: Code, Name, City, Country, Address,
  // Timezone.
  return (
    <div className="flex flex-col gap-4">
      <Field label="Code" required hint="Shown in tables and dropdowns, and used by the import.">
        <Input {...register("code")} placeholder="e.g. BLR" className="uppercase" />
      </Field>
      <Field label="Name" required>
        <Input {...register("name")} placeholder="e.g. Bangalore" />
      </Field>
      <Field label="City" name="city">
        <Input {...register("city")} placeholder="Optional" />
      </Field>
      <Field label="Country" name="country">
        <Input {...register("country")} placeholder="Optional" />
      </Field>
      <Field label="Address" name="address">
        <textarea
          {...register("address")}
          rows={2}
          placeholder="Optional"
          className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none transition-all placeholder-slate-400 text-slate-900 focus:border-primary-500 focus:ring-1 focus:ring-primary-500 resize-y"
        />
      </Field>
      <Field label="Timezone" required name="timezone">
        <TimezoneSelect />
      </Field>
    </div>
  );
}

export function LocationsTab() {
  const { can } = useHrmsPermissions();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [drawer, setDrawer] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const canEdit = can(M.ORG_STRUCTURE, A.EDIT, S.ORG);

  const methods = useForm({
    resolver: zodResolver(createLocationSchema),
    defaultValues: emptyLocation,
    mode: "onBlur",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await locationsApi.list());
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
    methods.reset(emptyLocation);
    setDrawer({ mode: "create" });
  };

  const openEdit = (row) => {
    // Nulls become empty strings for the inputs; the schema turns them back.
    methods.reset({
      code: row.code,
      name: row.name,
      city: row.city ?? "",
      country: row.country ?? "",
      address: row.address ?? "",
      timezone: row.timezone,
    });
    setDrawer({ mode: "edit", target: row });
  };

  const submit = methods.handleSubmit(async (values) => {
    setSaving(true);
    try {
      if (drawer.mode === "create") {
        await locationsApi.create(values);
        toast.success("Location created.");
      } else {
        await locationsApi.update(drawer.target.id, values);
        toast.success("Location updated.");
      }
      setDrawer(null);
      await load();
    } catch (err) {
      toast.error(err.message ?? "Could not save the location.");
    } finally {
      setSaving(false);
    }
  });

  const remove = async () => {
    setDeleting(true);
    try {
      await locationsApi.remove(confirm.id);
      toast.success(`${confirm.name} deleted.`);
      setConfirm(null);
      await load();
    } catch (err) {
      toast.error(err.message ?? "Could not delete the location.");
      setConfirm(null);
    } finally {
      setDeleting(false);
    }
  };

  const columns = useMemo(() => {
    const base = [
      {
        header: "Code",
        accessorKey: "code",
        className: "w-28",
        cell: (row) => <Badge>{row.code}</Badge>,
      },
      { header: "Name", accessorKey: "name" },
      { header: "City", accessorKey: "city", cell: (row) => row.city ?? "—" },
      { header: "Country", accessorKey: "country", cell: (row) => row.country ?? "—" },
      { header: "Timezone", accessorKey: "timezone", className: "w-44" },
      {
        header: "Employees",
        accessorKey: "employeeCount",
        className: "text-right w-32",
        headerClassName: "text-right",
        cell: (row) => (
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
  }, [canEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-slate-500 max-w-xl">
          Locations carry the timezone used when attendance and shifts are displayed. Assigning one
          to an employee is optional, and a location cannot be deleted while anyone is assigned.
        </p>
        <PermissionGate module={M.ORG_STRUCTURE} action={A.EDIT} scope={S.ORG}>
          <Button onClick={openCreate}>
            <Plus size={15} className="mr-1.5" />
            New Location
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
        emptyTitle="No locations yet"
        emptyDescription={
          canEdit
            ? "Add the first location to record where people work."
            : "No locations have been set up yet."
        }
      />

      <Drawer
        isOpen={drawer !== null}
        onClose={saving ? () => {} : () => setDrawer(null)}
        title={drawer?.mode === "create" ? "New Location" : "Edit Location"}
        maxWidth="max-w-lg"
      >
        <FormProvider {...methods}>
          <form onSubmit={submit} noValidate className="flex flex-col gap-6">
            <LocationFields />
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
        description="The location is retired and stops appearing as a choice. Employees still assigned to it keep the assignment, so the server will refuse while anyone is."
        confirmText="Delete"
      />
    </div>
  );
}

export default LocationsTab;
