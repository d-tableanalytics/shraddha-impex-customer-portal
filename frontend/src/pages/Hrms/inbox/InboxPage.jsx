import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CheckCheck, Archive, MailOpen, Mail } from "lucide-react";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { ErrorState } from "../../../components/hrms/ErrorState";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LoadingSpinner } from "../../../components/ui/LoadingSpinner";
import { Pagination } from "../../../components/ui/Pagination";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { inboxApi, INBOX_CATEGORY_TONES, formatInboxTime } from "../../../services/hrms/inbox";
import {
  INBOX_CATEGORIES,
  INBOX_LIST_POLL_MS,
  INBOX_TYPE_META,
} from "@shared/constants/inbox.js";

const PAGE_SIZE = 25;
const STATES = ["all", "unread", "read"];

/**
 * Inbox — the notification centre.
 *
 * ---------------------------------------------------------------------------
 * What the reference's page is, and what is different
 * ---------------------------------------------------------------------------
 * `InboxPage.tsx` is an AntD `<List>` of every item, a "Mark all as read"
 * button, and a coloured tag showing the RAW type string. Clicking a row marks
 * it read and navigates to the item's stored `href`.
 *
 * Kept: the list, the read/unread weight and tint, the relative timestamp, the
 * "action needed" hint, mark-all, and click-to-open.
 *
 * Different:
 *  1. THE TAG READS LIKE ENGLISH. 🔴 The reference renders `item.type`
 *     verbatim, so a person sees "attendance.correction.pending" in a pill, and
 *     colours it through a five-entry map over the fourteen values its
 *     producers actually emit — nine of them grey.
 *  2. IT PAGES. 🔴 The reference fetches the newest 100 and stops. With no
 *     delete, no archive and no retention behind it, every active employee
 *     eventually reaches that ceiling and silently stops seeing older items.
 *  3. IT FILTERS — unread/read and by category, which is what the stored flags
 *     were always for.
 *  4. ARCHIVE EXISTS, and marking read is reversible.
 *  5. THE LINK IS SERVER-DERIVED, so a row cannot carry a navigation target
 *     nobody computed.
 */
export function InboxPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const state = STATES.includes(params.get("state")) ? params.get("state") : "all";
  const category = params.get("category") ?? null;
  const archived = params.get("archived") === "true";

  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: PAGE_SIZE, unread: 0 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const res = await inboxApi.list({
          page,
          pageSize: PAGE_SIZE,
          state,
          archived: String(archived),
          ...(category ? { category } : {}),
        });
        setResult(res ?? { data: [], total: 0, unread: 0 });
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [page, state, archived, category],
  );

  useEffect(() => {
    load();
  }, [load]);

  /**
   * The reference refetches the list every 30 seconds. Same interval, but only
   * while the tab is actually being looked at — a background tab polling an
   * endpoint nobody is reading is just load.
   */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") load({ quiet: true });
    };
    const id = setInterval(tick, INBOX_LIST_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value === null || value === "all" || value === false) next.delete(key);
    else next.set(key, String(value));
    setParams(next, { replace: true });
    setPage(1);
  };

  const openItem = async (item) => {
    // Navigate regardless: a failed mark-read must not swallow the click. The
    // TARGET page enforces its own authorisation — a deep link is a
    // convenience, never a grant.
    if (!item.read) {
      try {
        await inboxApi.markRead(item.id);
      } catch {
        /* non-blocking, as the reference treats it */
      }
    }
    navigate(item.href);
  };

  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
      await load({ quiet: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const tabs = useMemo(
    () => [
      { key: "all", label: "All" },
      { key: "unread", label: "Unread", badge: result.unread || undefined },
      { key: "read", label: "Read" },
    ],
    [result.unread],
  );

  const categoryOptions = useMemo(
    () =>
      Object.values(INBOX_CATEGORIES).map((value) => ({
        value,
        label: value.charAt(0).toUpperCase() + value.slice(1),
      })),
    [],
  );

  return (
    <HrmsPageLayout
      title="Inbox"
      subtitle="What needs your attention, and what has happened since you last looked."
      breadcrumbs={[{ label: "HRMS", to: "/hrms/dashboard" }, { label: "Inbox" }]}
    >
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <TabNav tabs={tabs} activeKey={state} onChange={(key) => setParam("state", key)} />

        <div className="flex items-end gap-2">
          <div className="w-[180px]">
            <SearchableSelect
              label="Category"
              value={category}
              onChange={(v) => setParam("category", v ?? null)}
              options={categoryOptions}
              placeholder="All categories"
            />
          </div>

          <Button
            size="sm"
            variant={archived ? "primary" : "outline"}
            onClick={() => setParam("archived", !archived)}
          >
            <Archive size={14} className="mr-1.5" />
            Archived
          </Button>

          <Button
            size="sm"
            variant="outline"
            disabled={busy || result.unread === 0}
            onClick={() => act(() => inboxApi.markAllRead())}
          >
            <CheckCheck size={14} className="mr-1.5" />
            Mark all read
          </Button>
        </div>
      </div>

      {error ? (
        <ErrorState
          variant={error.isForbidden ? "forbidden" : "error"}
          description={error.message}
          onRetry={load}
        />
      ) : loading ? (
        <div className="flex items-center justify-center min-h-[30vh]">
          <LoadingSpinner size={32} />
        </div>
      ) : result.data.length === 0 ? (
        <div className="p-6 bg-white border border-slate-200 rounded-xl shadow-enterprise">
          <EmptyState
            title={archived ? "Nothing archived" : "You are all caught up"}
            description={
              archived
                ? "Items you file away appear here."
                : "Approvals, decisions and company news land here as they happen."
            }
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {result.data.map((item) => (
            <InboxRow
              key={item.id}
              item={item}
              busy={busy}
              onOpen={() => openItem(item)}
              onToggleRead={() =>
                act(() => (item.read ? inboxApi.markUnread(item.id) : inboxApi.markRead(item.id)))
              }
              onArchive={() => act(() => inboxApi.archive([item.id]))}
            />
          ))}

          {result.total > PAGE_SIZE && (
            /**
             * `page` / `pageSize` / `totalItems` — the props this component
             * actually declares. Passing `currentPage` / `totalPages` leaves
             * `totalItems` undefined, and the bar renders "Showing NaN to NaN
             * of NaN" with dead controls. See the report: six existing call
             * sites in Engage and Performance do exactly that.
             */
            <Pagination
              page={result.page ?? page}
              pageSize={result.pageSize ?? PAGE_SIZE}
              totalItems={result.total ?? 0}
              onPageChange={setPage}
            />
          )}
        </div>
      )}
    </HrmsPageLayout>
  );
}

function InboxRow({ item, busy, onOpen, onToggleRead, onArchive }) {
  const meta = INBOX_TYPE_META[item.type];

  return (
    <article
      className={`flex items-start justify-between gap-4 p-4 border rounded-xl shadow-enterprise transition-colors ${
        item.read ? "bg-white border-slate-200" : "bg-primary-50/40 border-primary-100"
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex flex-col gap-1.5 min-w-0 text-left flex-1 focus:outline-none"
      >
        <div className="flex items-center gap-2 flex-wrap">
          {/* 🔴 The label, not the raw machine type the reference renders. */}
          <Badge variant={INBOX_CATEGORY_TONES[item.category] ?? "neutral"}>
            {item.typeLabel ?? meta?.label ?? "Notification"}
          </Badge>
          <span
            className={`text-sm text-slate-900 ${item.read ? "font-normal" : "font-bold"}`}
          >
            {item.title}
          </span>
        </div>

        {item.body && <p className="text-xs text-slate-600 leading-snug">{item.body}</p>}

        <span className="text-[10.5px] text-slate-400">
          {formatInboxTime(item.createdAt)}
          {item.actionable && " · action needed"}
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={onToggleRead}
          aria-label={item.read ? `Mark "${item.title}" unread` : `Mark "${item.title}" read`}
          className="p-1.5 rounded text-slate-400 hover:text-primary-700 hover:bg-slate-100 disabled:opacity-50"
        >
          {item.read ? <Mail size={14} /> : <MailOpen size={14} />}
        </button>

        {!item.archived && (
          <button
            type="button"
            disabled={busy}
            onClick={onArchive}
            aria-label={`Archive "${item.title}"`}
            className="p-1.5 rounded text-slate-400 hover:text-primary-700 hover:bg-slate-100 disabled:opacity-50"
          >
            <Archive size={14} />
          </button>
        )}
      </div>
    </article>
  );
}

export default InboxPage;
