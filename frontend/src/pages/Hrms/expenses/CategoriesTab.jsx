import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Plus, Pencil, Trash2 } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { expensesApi } from "../../../services/hrms";
import {
  createExpenseCategorySchema,
  upsertExpensePolicySchema,
} from "@shared/schemas/expense.js";
import { formatMoney } from "../../../services/hrms";

/**
 * The category catalogue and its policies.
 *
 * The reference's two-panel `CategoriesTab`: the catalogue on the left, the
 * policy for whichever category is selected on the right. Same arrangement.
 *
 * ---------------------------------------------------------------------------
 * A policy is GUIDANCE, and the screen says so
 * ---------------------------------------------------------------------------
 * The reference stores every policy field and reads none of them: no limit is
 * checked and nothing is auto-approved anywhere in its claim service. Its UI
 * still presents them as though they bite, and its auto-approve field is
 * labelled "Phase 4 rollout" — a control for a feature that does not exist.
 *
 * The fields are kept, because finance uses them to tell people what the rules
 * are. What changed is that the screen no longer implies enforcement.
 */

export function CategoriesTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await expensesApi.categories({ includeInactive: true });
      setRows(Array.isArray(data) ? data : []);
      // Keep the selection pointed at fresh data rather than a stale copy.
      setSelected((current) =>
        current ? (data.find((row) => row.id === current.id) ?? null) : null,
      );
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
      await expensesApi.removeCategory(target.id);
      toast.success(`${target.name} deleted.`);
      if (selected?.id === target.id) setSelected(null);
      await load();
    } catch (err) {
      // The server refuses while claims still book to it, and says how many.
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
      header: "Active",
      className: "w-24",
      cell: (row) =>
        row.active ? (
          <Badge variant="success">Active</Badge>
        ) : (
          <Badge variant="neutral">Inactive</Badge>
        ),
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
            onClick={(e) => {
              e.stopPropagation();
              setEditing(row);
            }}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Delete ${row.name}`}
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(row);
            }}
          >
            <Trash2 className="h-3.5 w-3.5 text-error-600" aria-hidden="true" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      <div className="lg:col-span-7">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Expense categories</h3>
          <Button size="sm" onClick={() => setEditing({})}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
            New
          </Button>
        </div>

        <HrmsDataTable
          columns={columns}
          rows={rows}
          loading={loading}
          error={error}
          onRetry={load}
          onRowClick={setSelected}
          emptyTitle="No expense categories yet"
          emptyDescription="Add the categories people can book expenses against."
        />
      </div>

      <div className="lg:col-span-5">
        <PolicyPanel category={selected} onSaved={load} />
      </div>

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
        description="A category that existing claims book to cannot be deleted — deactivate it instead so it stops appearing on new claims."
        confirmText="Delete"
        variant="danger"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category create / edit
// ---------------------------------------------------------------------------

function CategoryDrawer({ category, onClose, onSaved }) {
  const isEdit = Boolean(category?.id);
  const [form, setForm] = useState({
    code: category?.code ?? "",
    name: category?.name ?? "",
    glCode: category?.glCode ?? "",
    tallyLedger: category?.tallyLedger ?? "",
    active: category?.active ?? true,
  });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  const submit = async (event) => {
    event.preventDefault();

    const payload = {
      code: form.code.trim().toUpperCase(),
      name: form.name.trim(),
      glCode: form.glCode.trim() || null,
      tallyLedger: form.tallyLedger.trim() || null,
      active: form.active,
    };

    const parsed = createExpenseCategorySchema.safeParse(payload);
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) next[issue.path.join(".")] = issue.message;
      setErrors(next);
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        // The code identifies the category in every historical claim, so it is
        // fixed once created — as the reference also disables it on edit.
        const { code: _code, ...rest } = parsed.data;
        await expensesApi.updateCategory(category.id, rest);
        toast.success("Category updated.");
      } else {
        await expensesApi.createCategory(parsed.data);
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
      title={isEdit ? "Edit category" : "New category"}
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
            placeholder="e.g. TRAVEL_LOCAL"
            disabled={isEdit}
            maxLength={30}
          />
          {isEdit && (
            <p className="mt-1 text-xs text-slate-500">
              The code cannot change — existing claims are booked against it.
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
            placeholder="e.g. Local Travel"
            maxLength={120}
          />
          {errors.name && <p className="mt-1 text-xs text-error-600">{errors.name}</p>}
        </div>

        <div>
          <label htmlFor="cat-gl" className="mb-1 block text-sm font-medium text-slate-700">
            GL code <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <Input
            id="cat-gl"
            value={form.glCode}
            onChange={(e) => set({ glCode: e.target.value })}
            placeholder="e.g. 500-1200"
            maxLength={30}
          />
        </div>

        <div>
          <label htmlFor="cat-tally" className="mb-1 block text-sm font-medium text-slate-700">
            Tally ledger <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <Input
            id="cat-tally"
            value={form.tallyLedger}
            onChange={(e) => set({ tallyLedger: e.target.value })}
            placeholder="e.g. Local Travel Expenses"
            maxLength={160}
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => set({ active: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300"
          />
          Active — offered when filing a claim
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

// ---------------------------------------------------------------------------
// Policy panel
// ---------------------------------------------------------------------------

function PolicyPanel({ category, onSaved }) {
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!category) {
      setForm(null);
      return;
    }
    const policy = category.policy;
    setErrors({});
    setForm({
      dailyLimit: policy?.dailyLimit ?? "",
      monthlyLimit: policy?.monthlyLimit ?? "",
      autoApproveBelow: policy?.autoApproveBelow ?? "",
      requiresReceipt: policy?.requiresReceipt ?? true,
      requiresApproval: policy?.requiresApproval ?? true,
    });
  }, [category]);

  if (!category || !form) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
        Select a category to view or edit its policy.
      </div>
    );
  }

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  const submit = async (event) => {
    event.preventDefault();

    const payload = {
      categoryId: category.id,
      dailyLimit: form.dailyLimit.trim() === "" ? null : form.dailyLimit.trim(),
      monthlyLimit: form.monthlyLimit.trim() === "" ? null : form.monthlyLimit.trim(),
      autoApproveBelow:
        form.autoApproveBelow.trim() === "" ? null : form.autoApproveBelow.trim(),
      requiresReceipt: form.requiresReceipt,
      requiresApproval: form.requiresApproval,
    };

    const parsed = upsertExpensePolicySchema.safeParse(payload);
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) next[issue.path.join(".")] = issue.message;
      setErrors(next);
      return;
    }

    setSaving(true);
    try {
      await expensesApi.savePolicy(parsed.data);
      toast.success("Policy saved.");
      onSaved?.();
    } catch (err) {
      toast.error(err?.message ?? "That policy could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const amountField = (id, label, value, key, placeholder) => (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => set({ [key]: e.target.value })}
        placeholder={placeholder}
      />
      {value && !errors[key] && (
        <p className="mt-1 text-xs text-slate-500">{formatMoney(value)}</p>
      )}
      {errors[key] && <p className="mt-1 text-xs text-error-600">{errors[key]}</p>}
    </div>
  );

  return (
    <form onSubmit={submit} className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="mb-1 text-sm font-semibold text-slate-900">
        Policy for{" "}
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">
          {category.code}
        </span>{" "}
        {category.name}
      </h3>

      {/*
        Said plainly, because the reference's screen implies the opposite.
      */}
      <p className="mb-4 rounded border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-600">
        These are published guidance for claimants and approvers. They are recorded against the
        category and shown here — they do not automatically block or approve a claim.
      </p>

      <div className="space-y-4">
        {amountField("policy-daily", "Daily limit (₹)", form.dailyLimit, "dailyLimit", "No limit")}
        {amountField(
          "policy-monthly",
          "Monthly limit (₹)",
          form.monthlyLimit,
          "monthlyLimit",
          "No limit",
        )}
        {amountField(
          "policy-auto",
          "Suggested auto-approval threshold (₹)",
          form.autoApproveBelow,
          "autoApproveBelow",
          "None",
        )}

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.requiresReceipt}
            onChange={(e) => set({ requiresReceipt: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300"
          />
          A receipt is expected
        </label>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.requiresApproval}
            onChange={(e) => set({ requiresApproval: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300"
          />
          Approval is expected
        </label>
      </div>

      <div className="mt-5 flex justify-end border-t border-slate-200 pt-4">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save policy"}
        </Button>
      </div>
    </form>
  );
}

export default CategoriesTab;
