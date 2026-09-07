import { hrmsClient } from "./client";

/**
 * Inbox API.
 *
 * A thin wrapper over `hrmsClient`, which already unwraps the
 * `{ success, data }` envelope and normalises errors into `HrmsApiError`.
 *
 * There is no `create`. Inbox items are produced by business events on the
 * server, and no endpoint accepts a recipient — see the routes file.
 */

export const inboxApi = {
  list: (params = {}) => hrmsClient.get("/inbox", params),
  /** The badge. Polled; deliberately the cheapest call in the app. */
  unreadCount: () => hrmsClient.get("/inbox/unread-count"),
  markRead: (id) => hrmsClient.post(`/inbox/${id}/read`, {}),
  /** No way back in the reference: once read, permanently read. */
  markUnread: (id) => hrmsClient.post(`/inbox/${id}/unread`, {}),
  markManyRead: (ids) => hrmsClient.post("/inbox/read", { ids }),
  markAllRead: () => hrmsClient.post("/inbox/read-all", {}),
  /** The reference has no delete and no archive at all. */
  archive: (ids) => hrmsClient.post("/inbox/archive", { ids }),
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Tone per CATEGORY, not per type.
 *
 * 🔴 The reference colours by raw type through a five-entry map, over
 * fourteen distinct values its producers actually emit — so nine of them render
 * grey, and the pill shows the machine string itself.
 */
export const INBOX_CATEGORY_TONES = Object.freeze({
  action: "warning",
  decision: "success",
  announcement: "primary",
  update: "neutral",
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "3 minutes ago", then a date once it stops being useful.
 *
 * The reference uses `dayjs().fromNow()` forever, so a notification from last
 * March reads "8 months ago" — which is not when it happened.
 */
export function formatInboxTime(iso) {
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";

  const seconds = Math.round((Date.now() - then.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (seconds < 7 * 86_400) {
    const d = Math.floor(seconds / 86_400);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  return `${String(then.getDate()).padStart(2, "0")} ${MONTHS[then.getMonth()]} ${then.getFullYear()}`;
}
