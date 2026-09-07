import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm, FormProvider, useFormContext } from "react-hook-form";
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
import { holidaysApi, HrmsApiError, formatDay } from "../../../services/hrms";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { upsertHolidaySchema, HOLIDAY_TYPES } from "@shared/schemas/leave.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Holidays — the yearly calendar, read by everyone and edited by HR.
 *
 * Governed by the LEAVE permission keys, as in the reference: `leave:view:self`
 * to read (the apply form needs the calendar to price a request) and
 * `leave:edit:org` to change it. There is no separate holidays module.
 *
 * Deletion is soft and the server decides it; there is no client-side guard.
 */

const UNPAGINATED = 1000;

const TYPE_OPTIONS = HOLIDAY_TYPES.map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}));

const emptyHoliday = (year) => ({
  name: "",
  date: `${year}-01-01`,
  type: "public",
  region: "",
  description: "",
  isOptional: false,
});

function Field({ label, required, hint, name, children }) {
  const {
    formState: { errors },
  } = useFormContext();
  const error = errors[name];

  return (
    <div>
      <label className="mb-1.5 block select-none text-xs font-semibold text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-error-500">*</span>}
      </label>
      {children}
      {error?.message && (
        <span className="mt-1 block text-xs font-medium text-error-500">{error.message}</span>
      )}
      {!error?.message && hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </div>
  );
}

function HolidayFields() {
  const { register, watch, setValue } = useFormContext();
  const type = watch("type");

  return (
    <div className="flex flex-col gap-4">
      <Field label="Name" required name="name">
        <Input {...register("name")} placeholder="e.g. Republic Day" />
      </Field>
      <Field label="Date" required name="date">
        <Input type="date" {...register("date")} />
      </Field>
      <Field label="Type" required name="type">
        <SearchableSelect
          value={type ?? "public"}
          onChange={(v) => setValue("type", v ?? "public", { shouldDirty: true })}
          options={TYPE_OPTIONS}
          placeholder="Choose a type"
        />
      </Field>
      <Field label="Region" name="region" hint="Leave empty when it applies to everyone.">
        <Input {...register("region")} placeholder="Optional, e.g. IN-MP" />
      </Field>
      <Field label="Description" name="description">
        <Input {...register("description")} placeholder="Optional" />
      </Field>
      <Field
        label="Optional holiday"
        name="isOptional"
        hint="A restricted holiday employees may choose to take. It is NOT automatically a day off, so it does not reduce a leave request."
      >
        <label className="flex items-center gap-2 pt-1.5 text-sm text-slate-700">
          <input type="checkbox" {...register("isOptional")} className="rounded border-slate-300" />
          Employees opt in
        </label>
      </Field>
    </div>
  );
}

export function HolidaysTab() {
  const { can } = useHrmsPermissions();
  const canEdit = can(M.LEAVE, A.EDIT, S.ORG);

  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [years, setYears] = useState([]);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [drawer, setDrawer] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const methods = useForm({
    resolver: zodResolver(upsertHolidaySchema),
    defaultValues: emptyHoliday(thisYear),
    mode: "onBlur",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, available] = await Promise.all([
        holidaysApi.list(year),
        holidaysApi.years().catch(() => []),
      ]);
      setRows(list);
      setYears(available);
    } catch (err) {
      setError(err instanceof HrmsApiError ? err : new HrmsApiError(err.message));
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    methods.reset(emptyHoliday(year));
    setDrawer({ mode: "create" });
  };

  const openEdit = (row) => {
    methods.reset({
      name: row.name,
      date: row.date,
      type: row.type,
      region: row.region ?? "",
      description: row.description ?? "",
      isOptional: row.isOptional,
    });
    setDrawer({ mode: "edit", target: row });
  };

  const submit = methods.handleSubmit(async (values) => {
    setSaving(true);
    try {
      if (drawer.mode === "create") {
        await holidaysApi.create(values);
        toast.success("Holiday added.");
      } else {
        await holidaysApi.update(drawer.target.id, values);
        toast.success("Holiday updated.");
      }
      setDrawer(null);
      // The year may have changed with the date; follow it.
      setYear(Number(values.date.slice(0, 4)));
      await load();
    } catch (err) {
      // The drawer stays open so nothing typed is lost.
      toast.error(err.message ?? "Could not save the holiday.");
    } finally {
      setSaving(false);
    }
  });

  const remove = async () => {
    setDeleting(true);
    try {
      await holidaysApi.remove(confirm.id);
      toast.success(`${confirm.name} removed.`);
      setConfirm(null);
      await load();
    } catch (err) {
      toast.error(err.message ?? "Could not remove the holiday.");
      setConfirm(null);
    } finally {
      setDeleting(false);
    }
  };

  const yearOptions = useMemo(() => {
    const known = new Set(years.map((y) => y.year));
    for (const y of [thisYear - 1, thisYear, thisYear + 1]) known.add(y);
    return [...known]
      .sort((a, b) => b - a)
      .map((y) => ({ value: String(y), label: String(y) }));
  }, [years, thisYear]);

  const columns = useMemo(() => {
    const base = [
      {
        header: "Date",
        accessorKey: "date",
        className: "w-40",
        cell: (row) => <span className="font-medium text-slate-800">{formatDay(row.date)}</span>,
      },
      { header: "Name", accessorKey: "name" },
      {
        header: "Type",
        accessorKey: "type",
        className: "w-32",
        cell: (row) => (
          <Badge variant={row.isOptional ? "warning" : "neutral"}>
            {row.type}
            {row.isOptional ? " · optional" : ""}
          </Badge>
        ),
      },
      {
        header: "Region",
        accessorKey: "region",
        className: "w-32",
        cell: (row) => row.region ?? "—",
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
              className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              onClick={() => setConfirm(row)}
              aria-label={`Remove ${row.name}`}
              className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-error-50 hover:text-error-600"
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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-end gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-700">Year</label>
            <SearchableSelect
              className="w-32"
              value={String(year)}
              onChange={(v) => setYear(Number(v ?? thisYear))}
              options={yearOptions}
              placeholder="Year"
            />
          </div>
          <p className="pb-2 text-xs text-slate-500">
            Holidays are free days for everyone. An optional one is offered, not automatic.
          </p>
        </div>

        <PermissionGate module={M.LEAVE} action={A.EDIT} scope={S.ORG}>
          <Button onClick={openCreate}>
            <Plus size={15} className="mr-1.5" />
            Add holiday
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
        emptyTitle={`No holidays recorded for ${year}`}
        emptyDescription={
          canEdit
            ? "Add the year's holidays so leave requests are priced correctly."
            : "HR has not published this year's holiday calendar yet."
        }
      />

      <Drawer
        isOpen={drawer !== null}
        onClose={saving ? () => {} : () => setDrawer(null)}
        title={drawer?.mode === "create" ? "Add holiday" : "Edit holiday"}
        maxWidth="max-w-lg"
      >
        <FormProvider {...methods}>
          <form onSubmit={submit} noValidate className="flex flex-col gap-6">
            <HolidayFields />
            <div className="flex justify-end gap-3 border-t border-slate-100 pt-4">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setDrawer(null)}
                disabled={saving}
              >
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
        title={confirm ? `Remove "${confirm.name}"?` : ""}
        description="The holiday stops counting as a free day for future leave requests. Requests already priced against it keep the days they were given."
        confirmText="Remove"
      />
    </div>
  );
}

export default HolidaysTab;
