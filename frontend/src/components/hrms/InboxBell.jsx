import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Inbox as InboxIcon } from "lucide-react";

import { useHrmsPermissions } from "../../hooks/useHrmsPermissions";
import { inboxApi } from "../../services/hrms/inbox";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import { INBOX_BADGE_MAX, INBOX_BADGE_POLL_MS } from "@shared/constants/inbox.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * The unread badge in the top bar.
 *
 * The reference puts a bell in its `AppShell` header that navigates to
 * `/inbox` and carries a red count polled every 15 seconds. This is that,
 * in Shraddha's own primitives and beside the portal's existing alert bell —
 * which is a different thing (socket-driven portal alerts) and is left alone.
 *
 * ---------------------------------------------------------------------------
 * It disappears for anyone it does not apply to
 * ---------------------------------------------------------------------------
 * The portal's top bar is shared by customers and employees (AD-14), so this
 * renders NOTHING unless the viewer holds `inbox:view:self` and Inbox is a
 * built module. 🔴 The reference's own nav entry requires no permission at all
 * (`requires: []`) even though every endpoint behind it does.
 *
 * The count is polled rather than pushed, exactly as the reference polls it —
 * its own comment says SSE was considered and rejected. Polling stops while the
 * tab is hidden, which the reference's `refetchIntervalInBackground: false`
 * also does.
 */
export function InboxBell() {
  const { can, usesModule } = useHrmsPermissions();
  const enabled = usesModule(M.INBOX) && can(M.INBOX, A.VIEW, S.SELF);

  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await inboxApi.unreadCount();
      setCount(res?.count ?? 0);
    } catch {
      // A failed poll is not worth a visible error in a top bar; the next one
      // will succeed or the Inbox page will show the real problem.
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    load();

    const tick = () => {
      if (document.visibilityState === "visible") load();
    };
    const id = setInterval(tick, INBOX_BADGE_POLL_MS);
    document.addEventListener("visibilitychange", tick);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, load]);

  if (!enabled) return null;

  const label = count > 0 ? `Inbox, ${count} unread` : "Inbox";

  return (
    <Link
      to={`${HRMS_ROUTE_PREFIX}/inbox`}
      title="Inbox"
      aria-label={label}
      className="p-2 rounded-lg text-slate-500 hover:text-primary-700 hover:bg-primary-50 transition-colors relative focus:outline-none"
    >
      <InboxIcon size={18} />
      {count > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 bg-primary-600 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white shadow-sm tabular-nums">
          {count > INBOX_BADGE_MAX ? `${INBOX_BADGE_MAX}+` : count}
        </span>
      )}
    </Link>
  );
}

export default InboxBell;
