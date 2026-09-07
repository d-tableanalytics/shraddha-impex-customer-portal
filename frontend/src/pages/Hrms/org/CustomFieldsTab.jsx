import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm, FormProvider, useFormContext, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Pencil, Trash2, X } from "lucide-react";
import toast from "react-hot-toast";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { PermissionGate } from "../../../components/hrms/PermissionGate";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Drawer } from "../../../components/ui/Drawer";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { employeeCustomFieldsApi, HrmsApiError } from "../../../services/hrms";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { Field } from "./DepartmentsTab";
import { createCustomFieldSchema } from "@shared/schemas/employee.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Custom Fields — the third Org Structure tab.
 *
 * The definitions it manages belong to Employee Master: the model, service and
 * API already exist at `/hrms/employees/custom-fields`, and nothing here adds a
 * second collection, service or endpoint. Only the screen is new — which is
 * exactly where the reference puts it too: its tab lives under Org Structure
 * while its API sits under employees.
 *
 * ---------------------------------------------------------------------------
 * The permission is `employees:edit:org`, not `org-structure:edit:org`
 * ---------------------------------------------------------------------------
 * These definitions shape the employee form, so the reference gates them on
 * employee editing (`CustomFieldsTab.tsx:47`), and the existing Shraddha routes
 * agree. The TAB is revealed by `org-structure:edit:org`, as the reference's
 * tab list is; the ACTIONS inside need the employee grant. Both are held by
 * super_admin and hr_admin, so the distinction is invisible in practice and
 * still worth getting right.
 *
 * ---------------------------------------------------------------------------
 * Lifecycle: delete, and only delete
 * ---------------------------------------------------------------------------
 * `deleteCustomField` removes the DEFINITION. Values already stored under
 * `employee.customFieldValues` are untouched, because they live on the employee
 * row — so history survives and the field simply stops appearing on the form.
 * There is no active/inactive flag on the model, and none is invented here.
 */

const UNPAGINATED = 1000;

/** The reference's seven types, with its labels. */
const TYPE_OPTIONS = [
  { value: "text", label: "Text" },
  { value: "textarea", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "boolean", label: "Yes / No" },
  { value: "select", label: "Select (single)" },
  { value: "multiselect", label: "Select (multi)" },
];

const TYPE_LABEL = Object.fromEntries(TYPE_OPTIONS.map((t) => [t.value, t.label]));

const CHOICE_TYPES = ["select", "multiselect"];

const emptyField = {
  name: "",
  label: "",
  type: "text",
  options: [],
  required: false,
  order: 0,
};

/**
 * The options editor for select / multiselect.
 *
 * The reference uses an Ant `Select mode="tags"`; there is no tag input in this
 * project, so this is the smallest faithful equivalent — type, press Enter,
 * remove with the chip's button. Kept local to this tab rather than promoted to
 * a shared primitive, because nothing else needs one yet.
 */
function OptionsEditor() {
  const { control, setValue } = useFormContext();
  const options = useWatch({ control, name: "options" }) ?? [];
  const [draft, setDraft] = useState("");

  const add = () => {
    const value = draft.trim();
    if (!value || options.includes(value)) {
      setDraft("");
      return;
    }
    setValue("options", [...options, value], { shouldDirty: true, shouldValidate: true });
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-2">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // Enter adds an option; it must not submit the drawer's form.
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        aria-label="Add an option"
        placeholder="Type an option and press Enter"
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition-all placeholder-slate-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
      />

      {options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {options.map((option) => (
            <span
              key={option}
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700"
            >
              {option}
              <button
                type="button"
                aria-label={`Remove option ${option}`}
                onClick={() =>
                  setValue(
                    "options",
                    options.filter((o) => o !== option),
                    { shouldDirty: true, shouldValidate: true },
                  )
                }
                className="text-slate-400 transition-colors hover:text-error-600"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomFieldFormFields({ mode }) {
  const { register, control } = useFormContext();
  const type = useWatch({ control, name: "type" });
  const isEdit = mode === "edit";

  return (
    <div className="flex flex-col gap-4">
      <Field label="Label" required hint="What the employee form shows above the input.">
        <Input {...register("label")} placeholder="e.g. Blood group" />
      </Field>

      <Field
        label="Name (key)"
        name="name"
        required
        hint={
          isEdit
            ? "Immutable: values are stored under this key, so renaming it would orphan every one."
            : "Stored as the key on the employee record. Lowercase snake_case."
        }
      >
        <Input
          {...register("name")}
          placeholder="e.g. blood_group"
          disabled={isEdit}
          className="font-mono"
        />
      </Field>

      <Field label="Type" name="type" required>
        <select
          {...register("type")}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition-all focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
        >
          {TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      {/* Only a choice type has options, exactly as in the reference. */}
      {CHOICE_TYPES.includes(type) && (
        <Field label="Options" name="options" required hint="What the dropdown offers.">
          <OptionsEditor />
        </Field>
      )}

      <Field label="Required" name="required">
        <label className="flex items-center gap-2 pt-1.5 text-sm text-slate-700">
          <input type="checkbox" {...register("required")} className="rounded border-slate-300" />
          Must be filled in on the employee form
        </label>
      </Field>

      <Field label="Order" name="order" required hint="Lower numbers appear first.">
        <Input {...register("order", { valueAsNumber: true })} type="number" min={0} />
      </Field>
    </div>
  );
}

export function CustomFieldsTab() {
  const { can } = useHrmsPermissions();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [drawer, setDrawer] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const canEdit = can(M.EMPLOYEES, A.EDIT, S.ORG);

  const methods = useForm({
    resolver: zodResolver(createCustomFieldSchema),
    defaultValues: emptyField,
    mode: "onBlur",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await employeeCustomFieldsApi.list());
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
    // The reference seeds the next order as `list.length + 1`.
    methods.reset({ ...emptyField, order: rows.length + 1 });
    setDrawer({ mode: "create" });
  };

  const openEdit = (row) => {
    methods.reset({
      name: row.name,
      label: row.label,
      type: row.type,
      options: row.options ?? [],
      required: row.required,
      order: row.order,
    });
    setDrawer({ mode: "edit", target: row });
  };

  const submit = methods.handleSubmit(async (values) => {
    setSaving(true);
    try {
      if (drawer.mode === "create") {
        await employeeCustomFieldsApi.create(values);
        toast.success("Custom field created.");
      } else {
        // `name` is immutable and the update schema is `.strict()`, so sending
        // it would be a 400 rather than being ignored.
        const { name: _immutable, ...rest } = values;
        await employeeCustomFieldsApi.update(drawer.target.id, rest);
        toast.success("Custom field updated.");
      }
      setDrawer(null);
      await load();
    } catch (err) {
      // The drawer stays open so the typed values are not lost.
      toast.error(err.message ?? "Could not save the field.");
    } finally {
      setSaving(false);
    }
  });

  const remove = async () => {
    setDeleting(true);
    try {
      await employeeCustomFieldsApi.remove(confirm.id);
      toast.success(`${confirm.label} removed.`);
      setConfirm(null);
      await load();
    } catch (err) {
      toast.error(err.message ?? "Could not remove the field.");
      setConfirm(null);
    } finally {
      setDeleting(false);
    }
  };

  const columns = useMemo(() => {
    const base = [
      { header: "Order", accessorKey: "order", className: "w-20" },
      { header: "Label", accessorKey: "label" },
      {
        header: "Name (key)",
        accessorKey: "name",
        cell: (row) => (
          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
            {row.name}
          </code>
        ),
      },
      {
        header: "Type",
        accessorKey: "type",
        className: "w-40",
        cell: (row) => <Badge>{TYPE_LABEL[row.type] ?? row.type}</Badge>,
      },
      {
        header: "Required",
        accessorKey: "required",
        className: "w-28",
        cell: (row) =>
          row.required ? <Badge variant="primary">Required</Badge> : <span>—</span>,
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
              aria-label={`Edit ${row.label}`}
              className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              onClick={() => setConfirm(row)}
              aria-label={`Remove ${row.label}`}
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
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-xl text-xs text-slate-500">
          Custom fields appear on every employee&apos;s form. Values are stored on the employee
          record under the field&apos;s key, so keys are lowercase{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">snake_case</code>{" "}
          and cannot be changed once created.
        </p>
        <PermissionGate module={M.EMPLOYEES} action={A.EDIT} scope={S.ORG}>
          <Button onClick={openCreate}>
            <Plus size={15} className="mr-1.5" />
            New Field
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
        emptyTitle="No custom fields yet"
        emptyDescription={
          canEdit
            ? "Add a field to capture something the standard employee form does not."
            : "No extra employee fields have been defined."
        }
      />

      <Drawer
        isOpen={drawer !== null}
        onClose={saving ? () => {} : () => setDrawer(null)}
        title={drawer?.mode === "create" ? "New Custom Field" : "Edit Custom Field"}
        maxWidth="max-w-lg"
      >
        <FormProvider {...methods}>
          <form onSubmit={submit} noValidate className="flex flex-col gap-6">
            <CustomFieldFormFields mode={drawer?.mode} />
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
        title={confirm ? `Remove field "${confirm.label}"?` : ""}
        description="Values already recorded on employee records are kept, so nothing is lost from history. The field simply stops appearing on the employee form."
        confirmText="Remove"
      />
    </div>
  );
}

export default CustomFieldsTab;
