import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Plus } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Drawer } from "../../../components/ui/Drawer";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import {
  assetsApi,
  formatInstant,
  ASSET_REQUEST_STATUS_LABELS,
} from "../../../services/hrms";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";
import { createAssetRequestSchema } from "@shared/schemas/asset.js";
import { RequestStatusBadge } from "./assetsShared";

/**
 * Asset requests.
 *
 * The reference's `RequestsTab`: one table whose Employee column appears only
 * for an administrator, with Decide on `submitted` and Fulfil on `approved`,
 * and Cancel for the requester. Same shape, with the list scoped and paged by
 * the server rather than by role-branching over a full download.
 */

const PAGE_SIZE = 15;

export function AssetRequestsTab() {
  const { can } = useHrmsPermissions();
  const isAdmin = can(M.ASSETS, A.ASSIGN, S.ORG);

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState({ data: [], total: 0 });
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [decideOn, setDecideOn] = useState(null);
  const [fulfillOn, setFulfillOn] = useState(null);
  const [cancelOn, setCancelOn] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { page, pageSize: PAGE_SIZE };
      if (status) params.status = status;
      setResult(await assetsApi.requests(params));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    assetsApi
      .categories()
      .then((rows) => setCategories(Array.isArray(rows) ? rows : []))
      .catch(() => setCategories([]));
  }, []);

  const doCancel = async () => {
    const target = cancelOn;
    setCancelOn(null);
    setBusyId(target.id);
    try {
      await assetsApi.cancelRequest(target.id);
      toast.success("Request cancelled.");
      await load();
    } catch (err) {
      toast.error(err?.message ?? "That request could not be cancelled.");
    } finally {
      setBusyId(null);
    }
  };

  const rows = result.data ?? [];

  const columns = [
    // The reference adds this column only for an administrator, and so does this.
    ...(isAdmin
      ? [
          {
            header: "Employee",
            accessorKey: "employeeName",
            className: "w-44",
            cell: (row) => (
              <span className="font-medium text-slate-900">{row.employeeName ?? "—"}</span>
            ),
          },
        ]
      : []),
    { header: "Category", className: "w-40", cell: (row) => row.categoryName ?? "—" },
    {
      header: "Justification",
      cell: (row) => <span className="line-clamp-2 text-slate-600">{row.justification}</span>,
    },
    {
      header: "Status",
      accessorKey: "status",
      className: "w-32",
      cell: (row) => <RequestStatusBadge status={row.status} />,
    },
    {
      header: "Fulfilled with",
      className: "w-40",
      cell: (row) =>
        row.fulfilledSerialNumber ? (
          <span className="font-mono text-xs">{row.fulfilledSerialNumber}</span>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    { header: "Submitted", className: "w-32", cell: (row) => formatInstant(row.createdAt) },
    {
      header: "",
      className: "w-40",
      cell: (row) => {
        const actions = [];
        // An administrator never decides the request they raised — the server
        // refuses it, so it is not offered.
        if (isAdmin && row.status === "submitted" && !row.isOwnRequest) {
          actions.push(
            <Button key="d" size="xs" disabled={busyId === row.id} onClick={() => setDecideOn(row)}>
              Decide
            </Button>,
          );
        }
        if (isAdmin && row.status === "approved") {
          actions.push(
            <Button key="f" size="xs" disabled={busyId === row.id} onClick={() => setFulfillOn(row)}>
              Fulfil
            </Button>,
          );
        }
        if (["submitted", "approved"].includes(row.status)) {
          actions.push(
            <Button
              key="c"
              size="xs"
              variant="secondary"
              disabled={busyId === row.id}
              onClick={() => setCancelOn(row)}
            >
              Cancel
            </Button>,
          );
        }
        return <div className="flex justify-end gap-2">{actions}</div>;
      },
    },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <label htmlFor="request-status-filter" className="sr-only">
            Filter by status
          </label>
          <select
            id="request-status-filter"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">All statuses</option>
            {Object.entries(ASSET_REQUEST_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Request an asset
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
        emptyTitle={isAdmin ? "No asset requests" : "You have no asset requests"}
        emptyDescription={
          isAdmin
            ? "Requests raised by employees will appear here."
            : "Ask IT for a laptop, phone or anything else you need to work."
        }
      />

      <RequestDrawer
        open={createOpen}
        categories={categories}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setPage(1);
          load();
        }}
      />

      {decideOn && (
        <DecideDrawer
          request={decideOn}
          onClose={() => setDecideOn(null)}
          onDecided={() => {
            setDecideOn(null);
            load();
          }}
        />
      )}

      {fulfillOn && (
        <FulfillDrawer
          request={fulfillOn}
          onClose={() => setFulfillOn(null)}
          onFulfilled={() => {
            setFulfillOn(null);
            load();
          }}
        />
      )}

      <ConfirmationDialog
        isOpen={cancelOn !== null}
        onClose={() => setCancelOn(null)}
        onConfirm={doCancel}
        title="Cancel this asset request?"
        description="You can raise a new request for the same category afterwards."
        confirmText="Cancel request"
        variant="danger"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function RequestDrawer({ open, categories, onClose, onCreated }) {
  const [form, setForm] = useState({ categoryId: "", justification: "" });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({ categoryId: "", justification: "" });
      setErrors({});
    }
  }, [open]);

  const submit = async (event) => {
    event.preventDefault();
    const parsed = createAssetRequestSchema.safeParse({
      categoryId: form.categoryId,
      justification: form.justification.trim(),
    });
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) next[issue.path.join(".")] = issue.message;
      setErrors(next);
      return;
    }

    setSaving(true);
    try {
      await assetsApi.createRequest(parsed.data);
      toast.success("Request submitted.");
      onCreated?.();
      onClose?.();
    } catch (err) {
      toast.error(err?.message ?? "That request could not be submitted.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen={open}
      onClose={saving ? () => {} : onClose}
      title="Request an asset"
      maxWidth="max-w-lg"
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label
            htmlFor="request-category"
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            What do you need?
          </label>
          <select
            id="request-category"
            value={form.categoryId}
            onChange={(e) => setForm((c) => ({ ...c, categoryId: e.target.value }))}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">Select a category…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {errors.categoryId && (
            <p className="mt-1 text-xs text-error-600">{errors.categoryId}</p>
          )}
        </div>

        <div>
          <label
            htmlFor="request-justification"
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            Why do you need it?
          </label>
          <textarea
            id="request-justification"
            rows={4}
            maxLength={2000}
            value={form.justification}
            onChange={(e) => setForm((c) => ({ ...c, justification: e.target.value }))}
            placeholder="e.g. My current machine cannot run the build."
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-slate-500">
            IT reviews this and issues something from stock if it is approved.
          </p>
          {errors.justification && (
            <p className="mt-1 text-xs text-error-600">{errors.justification}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Submitting…" : "Submit request"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------

function DecideDrawer({ request, onClose, onDecided }) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const decide = async (decision) => {
    if (decision === "reject" && !reason.trim()) {
      toast.error("Say why, so the employee knows.");
      return;
    }
    setSaving(true);
    try {
      await assetsApi.decideRequest(request.id, decision, reason.trim() || null);
      toast.success(decision === "approve" ? "Request approved." : "Request rejected.");
      onDecided?.();
    } catch (err) {
      toast.error(err?.message ?? "That decision could not be recorded.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen
      onClose={saving ? () => {} : onClose}
      title={`${request.categoryName ?? "Asset"} for ${request.employeeName ?? "an employee"}`}
      maxWidth="max-w-lg"
    >
      <div className="space-y-4">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Justification
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-900">
            {request.justification}
          </p>
        </div>

        <div>
          <label htmlFor="decide-reason" className="mb-1 block text-xs font-medium text-slate-600">
            Reason <span className="font-normal text-slate-400">(required to reject)</span>
          </label>
          <textarea
            id="decide-reason"
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="danger" disabled={saving} onClick={() => decide("reject")}>
            Reject
          </Button>
          <Button disabled={saving} onClick={() => decide("approve")}>
            Approve
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------

/** Issue a specific in-stock item against an approved request. */
function FulfillDrawer({ request, onClose, onFulfilled }) {
  const [items, setItems] = useState([]);
  const [assetItemId, setAssetItemId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    assetsApi
      .items({ categoryId: request.categoryId, status: "available", pageSize: 100 })
      .then((page) => {
        if (!cancelled) setItems(page.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [request.categoryId]);

  const submit = async (event) => {
    event.preventDefault();
    if (!assetItemId) {
      toast.error("Pick the asset to issue.");
      return;
    }
    setSaving(true);
    try {
      await assetsApi.fulfillRequest(request.id, assetItemId);
      toast.success("Request fulfilled and the asset issued.");
      onFulfilled?.();
    } catch (err) {
      toast.error(err?.message ?? "That request could not be fulfilled.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen
      onClose={saving ? () => {} : onClose}
      title={`Fulfil — ${request.categoryName ?? "asset"}`}
      maxWidth="max-w-lg"
    >
      <form onSubmit={submit} className="space-y-4">
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          Issuing to {request.employeeName}. Only available{" "}
          {request.categoryName ?? "assets"} are listed — the server refuses
          anything from another category.
        </p>

        {loading ? (
          <p className="text-sm text-slate-500">Loading stock…</p>
        ) : items.length === 0 ? (
          <p className="rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-600">
            Nothing available in this category. Add stock in the Inventory tab first.
          </p>
        ) : (
          <div>
            <label htmlFor="fulfill-item" className="mb-1 block text-xs font-medium text-slate-600">
              Asset to issue
            </label>
            <select
              id="fulfill-item"
              value={assetItemId}
              onChange={(e) => setAssetItemId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Select an asset…</option>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.serialNumber ?? "No serial"}
                  {[item.brand, item.model].filter(Boolean).length
                    ? ` · ${[item.brand, item.model].filter(Boolean).join(" ")}`
                    : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || items.length === 0}>
            {saving ? "Issuing…" : "Issue asset"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default AssetRequestsTab;
