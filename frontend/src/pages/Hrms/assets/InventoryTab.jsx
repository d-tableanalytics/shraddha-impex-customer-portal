import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Plus, Search } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Drawer } from "../../../components/ui/Drawer";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import {
  assetsApi,
  employeesApi,
  formatDay,
  formatMoney,
  ASSET_STATUS_LABELS,
  SETTABLE_ASSET_STATUSES,
} from "../../../services/hrms";
import { createAssetItemSchema } from "@shared/schemas/asset.js";
import { AssetStatusBadge, AssetIdentity } from "./assetsShared";

/**
 * The inventory grid.
 *
 * The reference's `InventoryTab`, with the same column order — Category /
 * Serial / Brand + Model / Warranty / Assigned to / Status / actions — and
 * three differences:
 *
 *   1. Filtering, searching and paging happen on the SERVER. The reference has
 *      no filter and no search at all, and pages a full download in the browser.
 *
 *   2. A return asks for the condition. The reference's Return button posts an
 *      empty body, so the "Condition on return" column it renders elsewhere can
 *      only ever show a dash.
 *
 *   3. The status picker cannot set `assigned`, and a destructive change is
 *      confirmed. The reference fires on change, straight from a Select.
 */

const PAGE_SIZE = 15;

export function InventoryTab() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");

  const [result, setResult] = useState({ data: [], total: 0 });
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [assignOn, setAssignOn] = useState(null);
  const [returnOn, setReturnOn] = useState(null);
  const [statusChange, setStatusChange] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { page, pageSize: PAGE_SIZE };
      if (status) params.status = status;
      if (categoryId) params.categoryId = categoryId;
      if (applied) params.search = applied;
      setResult(await assetsApi.items(params));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, status, categoryId, applied]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    assetsApi
      .categories()
      .then((rows) => setCategories(Array.isArray(rows) ? rows : []))
      .catch(() => setCategories([]));
  }, []);

  const applyStatusChange = async () => {
    const { row, next } = statusChange;
    setStatusChange(null);
    setBusyId(row.id);
    try {
      await assetsApi.setStatus(row.id, next);
      toast.success(`Marked ${ASSET_STATUS_LABELS[next] ?? next}.`);
      await load();
    } catch (err) {
      toast.error(err?.message ?? "That status could not be set.");
    } finally {
      setBusyId(null);
    }
  };

  const rows = result.data ?? [];

  const columns = [
    {
      header: "Asset",
      className: "w-64",
      cell: (row) => (
        <AssetIdentity
          serialNumber={row.serialNumber}
          brand={row.brand}
          model={row.model}
          categoryName={row.categoryName}
        />
      ),
    },
    {
      header: "Warranty",
      className: "w-32",
      cell: (row) => (row.warrantyEnd ? formatDay(row.warrantyEnd) : "—"),
    },
    {
      header: "Value",
      className: "w-32",
      headerClassName: "text-right",
      cell: (row) => (
        <span className="block text-right tabular-nums">
          {row.purchasePrice ? formatMoney(row.purchasePrice) : "—"}
        </span>
      ),
    },
    {
      header: "Assigned to",
      className: "w-48",
      cell: (row) =>
        row.currentAssignment ? (
          row.currentAssignment.employeeName
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      header: "Status",
      accessorKey: "status",
      className: "w-32",
      cell: (row) => <AssetStatusBadge status={row.status} />,
    },
    {
      header: "",
      className: "w-64",
      cell: (row) => (
        <div className="flex flex-wrap justify-end gap-2">
          {row.status === "available" && (
            <Button size="xs" disabled={busyId === row.id} onClick={() => setAssignOn(row)}>
              Assign
            </Button>
          )}
          {row.status === "assigned" && (
            <Button
              size="xs"
              variant="secondary"
              disabled={busyId === row.id}
              onClick={() => setReturnOn(row)}
            >
              Return
            </Button>
          )}
          <label className="sr-only" htmlFor={`status-${row.id}`}>
            Set status for {row.serialNumber ?? row.id}
          </label>
          <select
            id={`status-${row.id}`}
            value=""
            disabled={busyId === row.id || ["retired", "lost"].includes(row.status)}
            onChange={(e) =>
              e.target.value && setStatusChange({ row, next: e.target.value })
            }
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs disabled:bg-slate-50 disabled:text-slate-400"
          >
            <option value="">Set status…</option>
            {SETTABLE_ASSET_STATUSES.filter((s) => s !== row.status).map((s) => (
              <option key={s} value={s}>
                {ASSET_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(search.trim());
            setPage(1);
          }}
        >
          <label htmlFor="asset-search" className="sr-only">
            Search assets
          </label>
          <Input
            id="asset-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Serial, brand or model…"
            className="w-56"
          />
          <Button type="submit" size="sm" variant="secondary">
            <Search className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Search</span>
          </Button>
        </form>

        <label htmlFor="asset-category-filter" className="sr-only">
          Filter by category
        </label>
        <select
          id="asset-category-filter"
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <label htmlFor="asset-status-filter" className="sr-only">
          Filter by status
        </label>
        <select
          id="asset-status-filter"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">All statuses</option>
          {Object.entries(ASSET_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        <Button className="ml-auto" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Add asset
        </Button>
      </div>

      <HrmsDataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={load}
        page={page}
        pageSize={PAGE_SIZE}
        total={result.total ?? 0}
        onPageChange={setPage}
        emptyTitle="No assets yet"
        emptyDescription="Add the laptops, phones and cards the company owns."
      />

      <AddAssetDrawer
        open={createOpen}
        categories={categories}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setPage(1);
          load();
        }}
      />

      {assignOn && (
        <AssignDrawer
          item={assignOn}
          onClose={() => setAssignOn(null)}
          onAssigned={() => {
            setAssignOn(null);
            load();
          }}
        />
      )}

      {returnOn && (
        <ReturnDrawer
          item={returnOn}
          onClose={() => setReturnOn(null)}
          onReturned={() => {
            setReturnOn(null);
            load();
          }}
        />
      )}

      <ConfirmationDialog
        isOpen={statusChange !== null}
        onClose={() => setStatusChange(null)}
        onConfirm={applyStatusChange}
        title={
          statusChange
            ? `Mark this asset ${ASSET_STATUS_LABELS[statusChange.next]?.toLowerCase()}?`
            : ""
        }
        description={
          statusChange && statusChange.row.currentAssignment
            ? `${statusChange.row.currentAssignment.employeeName} is holding this asset. Their assignment will be closed.`
            : "Retiring or losing an asset is final — it cannot return to circulation."
        }
        confirmText="Confirm"
        variant={
          statusChange && ["retired", "lost"].includes(statusChange.next)
            ? "danger"
            : "primary"
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function AddAssetDrawer({ open, categories, onClose, onCreated }) {
  const empty = {
    categoryId: "",
    serialNumber: "",
    brand: "",
    model: "",
    purchaseDate: "",
    warrantyEnd: "",
    amcEnd: "",
    purchasePrice: "",
    notes: "",
  };
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(empty);
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (patch) => setForm((c) => ({ ...c, ...patch }));
  const category = categories.find((c) => c.id === form.categoryId);

  const submit = async (event) => {
    event.preventDefault();
    const payload = {
      categoryId: form.categoryId,
      serialNumber: form.serialNumber.trim() || null,
      brand: form.brand.trim() || null,
      model: form.model.trim() || null,
      purchaseDate: form.purchaseDate || null,
      warrantyEnd: form.warrantyEnd || null,
      amcEnd: form.amcEnd || null,
      // A price is a string all the way down, so what was typed is what is
      // stored — and 0 is a price, not an absent one.
      purchasePrice: form.purchasePrice.trim() || null,
      notes: form.notes.trim() || null,
    };

    const parsed = createAssetItemSchema.safeParse(payload);
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) next[issue.path.join(".")] = issue.message;
      setErrors(next);
      return;
    }
    if (category?.requiresSerialNumber && !payload.serialNumber) {
      setErrors({ serialNumber: `A serial number is required for ${category.name}.` });
      return;
    }

    setSaving(true);
    try {
      await assetsApi.createItem(parsed.data);
      toast.success("Asset added.");
      onCreated?.();
      onClose?.();
    } catch (err) {
      toast.error(err?.message ?? "That asset could not be added.");
    } finally {
      setSaving(false);
    }
  };

  const text = (id, label, key, extra = {}) => (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-600">
        {label}
      </label>
      <Input id={id} value={form[key]} onChange={(e) => set({ [key]: e.target.value })} {...extra} />
      {errors[key] && <p className="mt-1 text-xs text-error-600">{errors[key]}</p>}
    </div>
  );

  return (
    <Drawer
      isOpen={open}
      onClose={saving ? () => {} : onClose}
      title="Add asset"
      maxWidth="max-w-2xl"
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="asset-category" className="mb-1 block text-xs font-medium text-slate-600">
            Category
          </label>
          <select
            id="asset-category"
            value={form.categoryId}
            onChange={(e) => set({ categoryId: e.target.value })}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">Select a category…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.name}
              </option>
            ))}
          </select>
          {errors.categoryId && (
            <p className="mt-1 text-xs text-error-600">{errors.categoryId}</p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="sm:col-span-3">
            {text("asset-serial", "Serial number", "serialNumber", {
              placeholder: "e.g. C02XL0FQJG5H",
            })}
            {category?.requiresSerialNumber && (
              <p className="mt-1 text-xs text-slate-500">
                Required for {category.name}.
              </p>
            )}
          </div>
          {text("asset-brand", "Brand", "brand", { placeholder: "Dell" })}
          {text("asset-model", "Model", "model", { placeholder: "XPS 15" })}
          {text("asset-price", "Purchase price (₹)", "purchasePrice", {
            type: "text",
            inputMode: "decimal",
            placeholder: "0.00",
          })}
          {text("asset-purchased", "Purchase date", "purchaseDate", { type: "date" })}
          {text("asset-warranty", "Warranty end", "warrantyEnd", { type: "date" })}
          {text("asset-amc", "AMC end", "amcEnd", { type: "date" })}
        </div>

        <div>
          <label htmlFor="asset-notes" className="mb-1 block text-xs font-medium text-slate-600">
            Notes
          </label>
          <textarea
            id="asset-notes"
            rows={3}
            maxLength={2000}
            value={form.notes}
            onChange={(e) => set({ notes: e.target.value })}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Add asset"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------

function AssignDrawer({ item, onClose, onAssigned }) {
  const [employeeId, setEmployeeId] = useState("");
  const [condition, setCondition] = useState("");
  const [people, setPeople] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    employeesApi
      .list({ pageSize: 100, status: "active" })
      .then((page) => {
        if (cancelled) return;
        setPeople(
          (page.data ?? []).map((row) => ({
            value: row.id,
            label: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim(),
          })),
        );
      })
      .catch(() => setPeople([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (!employeeId) {
      toast.error("Choose who this asset is going to.");
      return;
    }
    setSaving(true);
    try {
      await assetsApi.assign(item.id, employeeId, condition.trim() || null);
      toast.success("Asset assigned.");
      onAssigned?.();
    } catch (err) {
      toast.error(err?.message ?? "That asset could not be assigned.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen
      onClose={saving ? () => {} : onClose}
      title={`Assign ${item.categoryName ?? "asset"} · ${item.serialNumber ?? "no serial"}`}
      maxWidth="max-w-lg"
    >
      <form onSubmit={submit} className="space-y-4">
        <SearchableSelect
          label="Assign to"
          value={employeeId || null}
          onChange={(value) => setEmployeeId(value ?? "")}
          options={people}
          placeholder="Select an employee…"
        />

        <div>
          <label
            htmlFor="condition-on-assign"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Condition on issue <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <textarea
            id="condition-on-assign"
            rows={3}
            maxLength={500}
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            placeholder="e.g. Screen has a minor scratch on the top-right corner"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-slate-500">
            Recorded against the assignment, and shown to the employee.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Assigning…" : "Assign"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------

/**
 * Taking an asset back.
 *
 * A drawer rather than a bare button, because the condition on return is the
 * whole point of the record — the reference's Return button posts nothing.
 */
function ReturnDrawer({ item, onClose, onReturned }) {
  const [condition, setCondition] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      await assetsApi.returnItem(item.id, condition.trim() || null);
      toast.success("Asset returned.");
      onReturned?.();
    } catch (err) {
      toast.error(err?.message ?? "That return could not be recorded.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen
      onClose={saving ? () => {} : onClose}
      title={`Return ${item.serialNumber ?? "asset"}`}
      maxWidth="max-w-lg"
    >
      <form onSubmit={submit} className="space-y-4">
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          {item.currentAssignment?.employeeName ?? "Someone"} is handing this back. It returns
          to the available pool.
        </p>

        <div>
          <label
            htmlFor="condition-on-return"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Condition on return <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <textarea
            id="condition-on-return"
            rows={3}
            maxLength={500}
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            placeholder="e.g. Charger missing, casing scuffed"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Recording…" : "Record return"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default InventoryTab;
