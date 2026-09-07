import { useCallback, useEffect, useState } from "react";
import { Search, AlertTriangle } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import {
  helpdeskApi,
  formatInstant,
  TICKET_STATUS_LABELS,
  TICKET_PRIORITY_LABELS,
} from "../../../services/hrms";
import {
  TicketIdentity,
  TicketStatusBadge,
  PriorityBadge,
  TeamBadge,
  SlaIndicator,
} from "./helpdeskShared";
import { TicketDetailDrawer } from "./TicketDetailDrawer";

/**
 * The resolver queue.
 *
 * The reference's `QueueTab` — status and priority filters over a list — plus
 * a category filter, a search box and a breached-only toggle, and with the rows
 * coming from a query scoped to the teams the viewer actually answers for.
 *
 * The reference sends every resolver every ticket, because it ORs its three
 * per-team grants into one boolean. Nothing here needs to filter in the
 * browser: what arrives is what this person may see.
 */

const PAGE_SIZE = 15;

export function QueueTab() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [breachedOnly, setBreachedOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");

  const [result, setResult] = useState({ data: [], total: 0 });
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { page, pageSize: PAGE_SIZE };
      if (status) params.status = status;
      if (priority) params.priority = priority;
      if (categoryId) params.categoryId = categoryId;
      if (breachedOnly) params.breachedOnly = "true";
      if (applied) params.search = applied;
      setResult(await helpdeskApi.tickets(params));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, status, priority, categoryId, breachedOnly, applied]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    helpdeskApi
      .categories()
      .then((rows) => setCategories(Array.isArray(rows) ? rows : []))
      .catch(() => setCategories([]));
  }, []);

  const columns = [
    {
      header: "Ticket",
      accessorKey: "subject",
      cell: (row) => <TicketIdentity ticket={row} />,
    },
    {
      header: "Raised by",
      className: "w-40",
      cell: (row) => row.requesterName ?? "—",
    },
    {
      header: "Team",
      className: "w-24",
      cell: (row) => <TeamBadge resolverModule={row.resolverModule} />,
    },
    {
      header: "Assigned to",
      className: "w-40",
      cell: (row) =>
        row.assigneeName ?? <span className="text-slate-400">Unassigned</span>,
    },
    {
      header: "Status",
      accessorKey: "status",
      className: "w-32",
      cell: (row) => <TicketStatusBadge status={row.status} />,
    },
    {
      header: "Priority",
      className: "w-28",
      cell: (row) => <PriorityBadge priority={row.priority} />,
    },
    { header: "SLA", className: "w-28", cell: (row) => <SlaIndicator ticket={row} /> },
    { header: "Raised", className: "w-32", cell: (row) => formatInstant(row.createdAt) },
    {
      header: "",
      className: "w-24",
      cell: (row) => (
        <Button size="xs" variant="secondary" onClick={() => setOpenId(row.id)}>
          Open
        </Button>
      ),
    },
  ];

  const select = (id, label, value, onChange, options) => (
    <div>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setPage(1);
        }}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
      >
        {options}
      </select>
    </div>
  );

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
          <label htmlFor="queue-search" className="sr-only">
            Search tickets
          </label>
          <Input
            id="queue-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Subject or ticket number…"
            className="w-56"
          />
          <Button type="submit" size="sm" variant="secondary">
            <Search className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Search</span>
          </Button>
        </form>

        {select(
          "queue-status-filter",
          "Filter by status",
          status,
          setStatus,
          <>
            <option value="">All statuses</option>
            {Object.entries(TICKET_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </>,
        )}

        {select(
          "queue-priority-filter",
          "Filter by priority",
          priority,
          setPriority,
          <>
            <option value="">All priorities</option>
            {Object.entries(TICKET_PRIORITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </>,
        )}

        {select(
          "queue-category-filter",
          "Filter by category",
          categoryId,
          setCategoryId,
          <>
            <option value="">All my categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </>,
        )}

        <Button
          size="sm"
          variant={breachedOnly ? "primary" : "secondary"}
          onClick={() => {
            setBreachedOnly((v) => !v);
            setPage(1);
          }}
        >
          <AlertTriangle className="mr-1 h-4 w-4" aria-hidden="true" />
          Breached only
        </Button>
      </div>

      <HrmsDataTable
        columns={columns}
        rows={result.data ?? []}
        loading={loading}
        error={error}
        onRetry={load}
        page={page}
        pageSize={PAGE_SIZE}
        total={result.total ?? 0}
        onPageChange={setPage}
        emptyTitle={breachedOnly ? "Nothing has breached" : "Nothing in your queue"}
        emptyDescription={
          breachedOnly
            ? "Every open ticket in your categories is still within its SLA."
            : "Tickets raised in the categories your team answers for will appear here."
        }
      />

      <TicketDetailDrawer
        ticketId={openId}
        onClose={() => setOpenId(null)}
        onChanged={load}
      />
    </div>
  );
}

export default QueueTab;
