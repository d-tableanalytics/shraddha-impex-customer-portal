import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { helpdeskApi, formatInstant, TICKET_STATUS_LABELS } from "../../../services/hrms";
import {
  TicketIdentity,
  TicketStatusBadge,
  PriorityBadge,
  SlaIndicator,
} from "./helpdeskShared";
import { RaiseTicketDrawer } from "./RaiseTicketDrawer";
import { TicketDetailDrawer } from "./TicketDetailDrawer";

/**
 * The tickets the signed-in employee raised.
 *
 * The reference's `MyTicketsTab` fetches every ticket the viewer can see and
 * renders the lot; there is no "mine" filter on its endpoint, so a resolver's
 * My Tickets tab shows the entire queue. Here `/tickets/me` returns one
 * person's own, paged.
 */

const PAGE_SIZE = 15;

export function MyTicketsTab() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState({ data: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { page, pageSize: PAGE_SIZE };
      if (status) params.status = status;
      setResult(await helpdeskApi.myTickets(params));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    load();
  }, [load]);

  const columns = [
    {
      header: "Ticket",
      accessorKey: "subject",
      cell: (row) => <TicketIdentity ticket={row} />,
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
    {
      header: "SLA",
      className: "w-28",
      cell: (row) => <SlaIndicator ticket={row} />,
    },
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

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <label htmlFor="my-status-filter" className="sr-only">
            Filter by status
          </label>
          <select
            id="my-status-filter"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">All statuses</option>
            {Object.entries(TICKET_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <Button onClick={() => setRaiseOpen(true)}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Raise a ticket
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
        emptyTitle="You have no tickets"
        emptyDescription="Raise one with HR, Payroll or IT and track it here."
      />

      <RaiseTicketDrawer
        open={raiseOpen}
        onClose={() => setRaiseOpen(false)}
        onCreated={() => {
          setPage(1);
          load();
        }}
      />

      <TicketDetailDrawer
        ticketId={openId}
        onClose={() => setOpenId(null)}
        onChanged={load}
      />
    </div>
  );
}

export default MyTicketsTab;
