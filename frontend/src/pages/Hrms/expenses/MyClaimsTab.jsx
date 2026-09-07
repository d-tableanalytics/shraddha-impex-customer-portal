import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Plus, ChevronRight, ChevronDown } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { expensesApi, CLAIM_STATUS_LABELS, formatInstant } from "../../../services/hrms";
import { ClaimStatusBadge, Money } from "./expensesShared";
import { ClaimLines } from "./ClaimLines";
import { NewClaimDrawer } from "./NewClaimDrawer";

/**
 * My claims.
 *
 * The reference's `MyClaims`, with the scope moved to the server. Its version
 * fetches every claim in the organisation and filters in the browser —
 * `claims.filter(c => c.employeeId === me.employee.id)` — so the payload held
 * everyone's claims regardless of who was looking. Here the endpoint returns
 * only what the viewer may see, and the page is a page.
 */

const PAGE_SIZE = 15;

export function MyClaimsTab() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState({ data: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { page, pageSize: PAGE_SIZE };
      if (status) params.status = status;
      setResult(await expensesApi.claims(params));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    load();
  }, [load]);

  const submitClaim = async (claim) => {
    setBusyId(claim.id);
    try {
      await expensesApi.submit(claim.id);
      toast.success("Claim submitted for approval.");
      await load();
    } catch (err) {
      toast.error(err?.message ?? "Could not submit that claim.");
    } finally {
      setBusyId(null);
    }
  };

  /** Replace one claim in place after a receipt upload, without a refetch. */
  const patchClaim = (updated) =>
    setResult((current) => ({
      ...current,
      data: (current.data ?? []).map((row) => (row.id === updated?.id ? updated : row)),
    }));

  const columns = [
    {
      header: "",
      className: "w-10",
      cell: (row) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(expanded === row.id ? null : row.id);
          }}
          aria-expanded={expanded === row.id}
          aria-label={`${expanded === row.id ? "Hide" : "Show"} line items for ${row.title}`}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          {expanded === row.id ? (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      ),
    },
    { header: "Title", accessorKey: "title", cell: (row) => row.title },
    {
      header: "Total",
      className: "w-32",
      headerClassName: "text-right",
      cell: (row) => <Money value={row.total} />,
    },
    {
      header: "Line items",
      className: "w-24",
      cell: (row) => (row.lineItems ?? []).length,
    },
    {
      header: "Status",
      accessorKey: "status",
      className: "w-36",
      cell: (row) => <ClaimStatusBadge status={row.status} />,
    },
    {
      header: "Submitted",
      className: "w-32",
      cell: (row) => formatInstant(row.submittedAt),
    },
    {
      header: "",
      className: "w-28",
      cell: (row) =>
        row.status === "draft" ? (
          <Button
            size="sm"
            disabled={busyId === row.id}
            onClick={(e) => {
              e.stopPropagation();
              submitClaim(row);
            }}
          >
            {busyId === row.id ? "Submitting…" : "Submit"}
          </Button>
        ) : null,
    },
  ];

  const rows = result.data ?? [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <label htmlFor="claim-status-filter" className="sr-only">
            Filter by status
          </label>
          <select
            id="claim-status-filter"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
          >
            <option value="">All statuses</option>
            {Object.entries(CLAIM_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <Button onClick={() => setDrawerOpen(true)}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          New claim
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
        emptyTitle="No expense claims yet"
        emptyDescription="Claim what you spent and it will appear here."
      />

      {/*
        The expanded detail sits under the table rather than inside a row: the
        shared table renders one <tr> per row and has no expandable slot, and
        widening it for one screen would change every other screen that uses it.
      */}
      {expanded && rows.some((row) => row.id === expanded) && (
        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          {(() => {
            const claim = rows.find((row) => row.id === expanded);
            return (
              <ClaimLines
                claim={claim}
                canUpload={claim.status === "draft"}
                onChange={patchClaim}
              />
            );
          })()}
        </div>
      )}

      <NewClaimDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onCreated={() => {
          setPage(1);
          load();
        }}
      />
    </div>
  );
}

export default MyClaimsTab;
