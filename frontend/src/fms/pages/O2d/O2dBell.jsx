import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";

import { useUserStore } from "../../store/userStore";
import { hasPermission, PERMISSIONS } from "../../utils/permissions";
import { o2dApi, formatDateTime } from "../../services/o2d/orders";
import { o2dRoute } from "@shared/constants/o2d.js";

/**
 * The O2D notification bell.
 *
 * ---------------------------------------------------------------------------
 * POLLED, NOT PUSHED — FOR NOW
 * ---------------------------------------------------------------------------
 *
 * There is no websocket in this portal. Adding one for a badge count would mean
 * a second transport, its own auth, its own reconnection logic and its own
 * failure modes, to shave a minute off how quickly a number changes. A poll on a
 * slow interval is the honest trade at this scale, and the channel abstraction
 * means a push can replace it later without any screen changing.
 *
 * The interval is deliberately slow (60s) and STOPS while the tab is hidden.
 * A tab left open overnight would otherwise make ~500 pointless requests.
 */

const POLL_MS = 60_000;

export function O2dBell() {
  const user = useUserStore((s) => s.user);
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const panelRef = useRef(null);

  const canSee = hasPermission(user, PERMISSIONS.VIEW_O2D);

  const load = useCallback(async () => {
    if (!canSee) return;
    try {
      const { data, unread: count } = await o2dApi.notifications({ limit: 20 });
      setItems(data ?? []);
      setUnread(count ?? 0);
    } catch {
      // A bell that cannot load is a bell that shows nothing. It must never be
      // the reason a page errors — the user came here to do something else.
    }
  }, [canSee]);

  useEffect(() => {
    if (!canSee) return undefined;
    load();

    const tick = () => {
      if (document.visibilityState === "visible") load();
    };
    const id = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [canSee, load]);

  // Close on an outside click, so the panel does not sit over the page.
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (!canSee) return null;

  const markAllRead = async () => {
    // Optimistic: the count is a convenience, and a failed request simply
    // means the next poll restores the truth.
    setUnread(0);
    setItems((rows) => rows.map((r) => ({ ...r, readAt: r.readAt ?? new Date().toISOString() })));
    try {
      await o2dApi.markNotificationsRead([]);
    } catch {
      load();
    }
  };

  const openItem = async (item) => {
    setOpen(false);
    if (!item.readAt) {
      try {
        await o2dApi.markNotificationsRead([item._id]);
      } catch {
        /* the navigation matters more than the read receipt */
      }
      load();
    }
    if (item.order) navigate(`${o2dRoute("orders")}?open=${item.order}`);
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-error-500 px-1 text-[10px] font-semibold text-white">
            {/* Capped, because a three-digit badge does not fit and does not help. */}
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 rounded-lg border border-slate-200 bg-white shadow-enterprise-lg">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <span className="text-sm font-semibold text-slate-900">Order to Dispatch</span>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-xs font-medium text-primary-700 hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-slate-500">Nothing yet.</p>
            ) : (
              <ul>
                {items.map((item) => (
                  <li key={item._id}>
                    <button
                      type="button"
                      onClick={() => openItem(item)}
                      className={`w-full border-b border-slate-50 px-3 py-2 text-left hover:bg-slate-50 ${
                        item.readAt ? "" : "bg-primary-50/40"
                      }`}
                    >
                      <p className="text-sm text-slate-900">{item.title}</p>
                      {item.body && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{item.body}</p>
                      )}
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {formatDateTime(item.createdAt)}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default O2dBell;
