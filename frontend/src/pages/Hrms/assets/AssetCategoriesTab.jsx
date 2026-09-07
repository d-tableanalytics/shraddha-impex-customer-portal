import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Plus, Pencil, Trash2 } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { assetsApi } from "../../../services/hrms";
import { createAssetCategorySchema } from "@shared/schemas/asset.js";

/**
 * The category catalogue.
 *
 * The reference's `CategoriesTab`: Code / Name / Requires serial / Lifespan /
 * item count. Same columns, plus editing — the reference can only create and
 * delete, so a typo in a name is permanent.
 */

export function AssetCategoriesTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await assetsApi.categories();
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
      await assetsApi.removeCategory(target.id);
      toast.success(`${target.name} deleted.`);
      await load();
    } catch (err) {
      // The server refuses while items or requests still point at it, and says
      // how many of each.
      toast.error(err?.message ?? "That category could not be deleted.");
    }
  };

  const columns = [
    {
      header: "Code",
      accessorKey: "code",
      className: "w-36",
      cell: (row) => (
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
          {row.code}
        </span>
      ),
    },
    { header: "Name", accessorKey: "name", cell: (row) => row.name },
    {
      header: "Serial required",
      className: "w-36",
      cell: (row) =>
        row.requiresSerialNumber ? (
          <Badge variant="primary">Required</Badge>
        ) : (
          <Badge variant="neutral">Optional</Badge>
        ),
    },
    {
      header: "Expected life",
      className: "w-32",
      cell: (row) => `${row.defaultLifespanMonths} months`,
    },
    {
      header: "Items",
      className: "w-20",
      cell: (row) => row.itemCount,
    },
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
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-slate-500">
          The kinds of thing the company issues. A category decides whether a
          serial number is required.
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
        emptyTitle="No asset categories yet"
        emptyDescription="Add the kinds of asset the company issues — laptops, phones, ID cards."
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
        description="A category that assets or requests are booked to cannot be deleted. Its code is freed for reuse."
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
    requiresSerialNumber: category?.requiresSerialNumber ?? true,
    defaultLifespanMonths: String(category?.defaultLifespanMonths ?? 36),
  });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const submit = async (event) => {
    event.preventDefault();
    const payload = {
      code: form.code.trim().toUpperCase(),
      name: form.name.trim(),
      requiresSerialNumber: form.requiresSerialNumber,
      defaultLifespanMonths: form.defaultLifespanMonths,
    };

    const parsed = createAssetCategorySchema.safeParse(payload);
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) next[issue.path.join(".")] = issue.message;
      setErrors(next);
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        // The code identifies the category on every asset booked to it, so it
        // is fixed once created.
        const { code: _code, ...rest } = parsed.data;
        await assetsApi.updateCategory(category.id, rest);
        toast.success("Category updated.");
      } else {
        await assetsApi.createCategory(parsed.data);
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
      title={isEdit ? "Edit category" : "New asset category"}
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
            placeholder="e.g. LAPTOP"
            disabled={isEdit}
            maxLength={40}
          />
          {isEdit && (
            <p className="mt-1 text-xs text-slate-500">
              The code cannot change — assets are booked against it.
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
            placeholder="e.g. Laptop"
            maxLength={80}
          />
          {errors.name && <p className="mt-1 text-xs text-error-600">{errors.name}</p>}
        </div>

        <div>
          <label htmlFor="cat-life" className="mb-1 block text-sm font-medium text-slate-700">
            Expected life (months)
          </label>
          <Input
            id="cat-life"
            type="number"
            min={1}
            max={600}
            value={form.defaultLifespanMonths}
            onChange={(e) => set({ defaultLifespanMonths: e.target.value })}
          />
          <p className="mt-1 text-xs text-slate-500">
            Guidance for planning replacements. Nothing is retired automatically.
          </p>
          {errors.defaultLifespanMonths && (
            <p className="mt-1 text-xs text-error-600">{errors.defaultLifespanMonths}</p>
          )}
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.requiresSerialNumber}
            onChange={(e) => set({ requiresSerialNumber: e.target.checked })}
            className="mt-0.5 h-4 w-4 rounded border-slate-300"
          />
          <span>
            A serial number is required
            <span className="block text-xs text-slate-500">
              Leave off for things like cables and adapters that have none.
            </span>
          </span>
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

export default AssetCategoriesTab;
