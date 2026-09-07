import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Plus, Pencil, Trash2 } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { helpdeskApi, RESOLVER_TEAM_LABELS } from "../../../services/hrms";
import { createTicketCategorySchema } from "@shared/schemas/helpdesk.js";

/**
 * The ticket catalogue.
 *
 * The reference has no screen and no endpoint for this, which is why its own
 * Raise Ticket form falls back to hardcoded `'hr-placeholder'` values that its
 * validator then rejects. A category decides two things that nothing else can:
 * which team is answerable for a class of question, and how quickly.
 */

export function TicketCategoriesTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await helpdeskApi.categories({ includeInactive: "true" });
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async () => {
    const target = confirming;
    setConfirming(null);
    try {
      await helpdeskApi.removeCategory(target.id);
      toast.success(`${target.name} deleted.`);
      await load();
    } catch (err) {
      // The server refuses while open tickets still belong to it.
      toast.error(err?.message ?? "That category could not be deleted.");
    }
  };

  const columns = [
    {
      header: "Code",
      accessorKey: "code",
      className: "w-32",
      cell: (row) => (
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
          {row.code}
        </span>
      ),
    },
    { header: "Name", accessorKey: "name", cell: (row) => row.name },
    {
      header: "Answered by",
      className: "w-36",
      cell: (row) => (
        <Badge variant="primary">
          {RESOLVER_TEAM_LABELS[row.resolverModule] ?? row.resolverModule}
        </Badge>
      ),
    },
    { header: "SLA", className: "w-28", cell: (row) => `${row.slaHours} hours` },
    {
      header: "Active",
      className: "w-24",
      cell: (row) =>
        row.active ? (
          <Badge variant="success">Active</Badge>
        ) : (
          <Badge variant="neutral">Inactive</Badge>
        ),
    },
    { header: "Tickets", className: "w-24", cell: (row) => row.ticketCount },
    {
      header: "",
      className: "w-24",
      cell: (row) => (
        <div className="flex justify-end gap-1">
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Edit ${row.name}`}
            onClick={() => setEditing(row)}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Delete ${row.name}`}
            onClick={() => setConfirming(row)}
          >
            <Trash2 className="h-3.5 w-3.5 text-error-600" aria-hidden="true" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          A category decides which team answers a question, and how quickly.
        </p>
        <Button onClick={() => setEditing({})}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          New category
        </Button>
      </div>

      <HrmsDataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={load}
        emptyTitle="No ticket categories yet"
        emptyDescription="Add HR, Payroll and IT so people have somewhere to raise a ticket."
      />

      {editing && (
        <CategoryDrawer
          category={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      <ConfirmationDialog
        isOpen={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={remove}
        title={confirming ? `Delete ${confirming.name}?` : ""}
        description="A category with open tickets cannot be deleted — deactivate it instead so it stops appearing when raising one."
        confirmText="Delete"
        variant="danger"
      />
    </div>
  );
}

function CategoryDrawer({ category, onClose, onSaved }) {
  const isEdit = Boolean(category?.id);
  const [form, setForm] = useState({
    code: category?.code ?? "",
    name: category?.name ?? "",
    resolverModule: category?.resolverModule ?? "helpdesk:it",
    slaHours: String(category?.slaHours ?? 24),
    active: category?.active ?? true,
  });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const submit = async (event) => {
    event.preventDefault();
    const payload = {
      code: form.code.trim().toUpperCase(),
      name: form.name.trim(),
      resolverModule: form.resolverModule,
      slaHours: form.slaHours,
      active: form.active,
    };

    const parsed = createTicketCategorySchema.safeParse(payload);
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) next[issue.path.join(".")] = issue.message;
      setErrors(next);
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        // The code identifies the category on every ticket booked to it.
        const { code: _code, ...rest } = parsed.data;
        await helpdeskApi.updateCategory(category.id, rest);
        toast.success("Category updated.");
      } else {
        await helpdeskApi.createCategory(parsed.data);
        toast.success("Category created.");
      }
      onSaved?.();
    } catch (err) {
      toast.error(err?.message ?? "That category could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen
      onClose={saving ? () => {} : onClose}
      title={isEdit ? "Edit category" : "New ticket category"}
      maxWidth="max-w-md"
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="cat-code" className="mb-1 block text-sm font-medium text-slate-700">
            Code
          </label>
          <Input
            id="cat-code"
            value={form.code}
            onChange={(e) => set({ code: e.target.value.toUpperCase() })}
            placeholder="e.g. IT_HARDWARE"
            disabled={isEdit}
            maxLength={40}
          />
          {isEdit && (
            <p className="mt-1 text-xs text-slate-500">
              The code cannot change — tickets are booked against it.
            </p>
          )}
          {errors.code && <p className="mt-1 text-xs text-error-600">{errors.code}</p>}
        </div>

        <div>
          <label htmlFor="cat-name" className="mb-1 block text-sm font-medium text-slate-700">
            Name
          </label>
          <Input
            id="cat-name"
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="e.g. IT — Hardware"
            maxLength={100}
          />
          {errors.name && <p className="mt-1 text-xs text-error-600">{errors.name}</p>}
        </div>

        <div>
          <label htmlFor="cat-team" className="mb-1 block text-sm font-medium text-slate-700">
            Answered by
          </label>
          <select
            id="cat-team"
            value={form.resolverModule}
            onChange={(e) => set({ resolverModule: e.target.value })}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            {Object.entries(RESOLVER_TEAM_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">
            Only that team sees tickets in this category.
          </p>
        </div>

        <div>
          <label htmlFor="cat-sla" className="mb-1 block text-sm font-medium text-slate-700">
            SLA (hours)
          </label>
          <Input
            id="cat-sla"
            type="number"
            min={1}
            max={168}
            value={form.slaHours}
            onChange={(e) => set({ slaHours: e.target.value })}
          />
          <p className="mt-1 text-xs text-slate-500">
            Between 1 and 168. Existing tickets keep the SLA they were raised under.
          </p>
          {errors.slaHours && <p className="mt-1 text-xs text-error-600">{errors.slaHours}</p>}
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => set({ active: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300"
          />
          Active — offered when raising a ticket
        </label>

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default TicketCategoriesTab;
