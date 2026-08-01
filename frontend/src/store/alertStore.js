import { create } from "zustand";
import { inventoryApi } from "../services/inventory";

/**
 * Alert state (IMS Module M8).
 *
 * Presentation only. Every count, band and severity shown on the screen arrives
 * from the server already decided — nothing here derives a stock figure, and
 * nothing here can raise an alert. The store's whole job is fetching, filtering
 * and reflecting the three lifecycle actions.
 */
const DEFAULT_COUNTS = { byStatus: {}, bySeverity: {}, byCategory: {} };

export const useAlertStore = create((set, get) => ({
  // ── List ────────────────────────────────────────────────────────────────
  alerts: [],
  counts: DEFAULT_COUNTS,
  total: 0,
  pages: 1,
  loading: true,
  error: null,
  // The default view is "what needs attention", not the full history.
  filters: { status: "", severity: "", category: "", alertType: "", brand: "", activeOnly: true, page: 1, limit: 25 },

  setFilters: (patch) => {
    // Any filter change but paging returns to page 1 — otherwise narrowing the
    // list while on page 4 shows an empty screen.
    const resetsPage = Object.keys(patch).some((k) => k !== "page");
    set((s) => ({ filters: { ...s.filters, ...patch, ...(resetsPage ? { page: 1 } : {}) } }));
    get().fetchAlerts();
  },

  fetchAlerts: async () => {
    set({ loading: true, error: null });
    try {
      const { items, total, pages, counts } = await inventoryApi.listAlerts(get().filters);
      set({ alerts: items, total, pages, counts, loading: false });
    } catch (err) {
      set({ loading: false, error: err.response?.data?.message || "Failed to load alerts" });
    }
  },

  // ── Detail ──────────────────────────────────────────────────────────────
  selected: null,
  detailLoading: false,

  openAlert: async (alertId) => {
    set({ detailLoading: true, selected: null });
    try {
      const data = await inventoryApi.getAlert(alertId);
      // Dropped if the drawer was dismissed while the request was in flight.
      if (!get().detailLoading) return;
      set({ selected: data, detailLoading: false });
    } catch (err) {
      set({ detailLoading: false, error: err.response?.data?.message || "Failed to load the alert" });
    }
  },

  closeDetail: () => set({ selected: null, detailLoading: false }),

  // ── Lifecycle ───────────────────────────────────────────────────────────
  acting: false,

  act: async (alertId, action, note = null) => {
    set({ acting: true, error: null });
    try {
      const fn = {
        acknowledge: () => inventoryApi.acknowledgeAlert(alertId),
        resolve: () => inventoryApi.resolveAlert(alertId, note),
        close: () => inventoryApi.closeAlert(alertId, note),
      }[action];
      if (!fn) throw new Error(`Unknown action "${action}".`);

      await fn();
      set({ acting: false });
      // Refetched rather than patched locally: acting on an alert usually
      // removes it from the default "needs attention" view, and the tab counts
      // move with it.
      await get().fetchAlerts();
      if (get().selected?.alertId === alertId) await get().openAlert(alertId);
      return { ok: true };
    } catch (err) {
      const message = err.response?.data?.message || `Failed to ${action} the alert`;
      set({ acting: false, error: message });
      return { ok: false, message };
    }
  },

  // ── Statistics (dashboard widget) ───────────────────────────────────────
  stats: null,
  statsLoading: false,

  fetchStats: async () => {
    set({ statsLoading: true });
    try {
      set({ stats: await inventoryApi.getAlertStatistics(), statsLoading: false });
    } catch {
      // A failed widget must not break the page it sits on.
      set({ statsLoading: false });
    }
  },

  // ── Rules ───────────────────────────────────────────────────────────────
  rules: [],
  rulesLoading: false,
  savingRule: null,

  fetchRules: async () => {
    set({ rulesLoading: true });
    try {
      const { rules } = await inventoryApi.listAlertRules();
      set({ rules, rulesLoading: false });
    } catch (err) {
      set({ rulesLoading: false, error: err.response?.data?.message || "Failed to load alert rules" });
    }
  },

  saveRule: async (alertType, patch) => {
    set({ savingRule: alertType, error: null });
    try {
      const saved = await inventoryApi.updateAlertRule(alertType, patch);
      set((s) => ({
        savingRule: null,
        rules: s.rules.map((r) => (r.alertType === alertType
          ? { ...r, ...saved, configured: true, severity: saved.severity || r.defaultSeverity }
          : r)),
      }));
      return { ok: true };
    } catch (err) {
      const message = err.response?.data?.message || "Failed to save the rule";
      set({ savingRule: null, error: message });
      return { ok: false, message };
    }
  },

  // ── Notification feed ───────────────────────────────────────────────────
  notifications: [],
  unread: 0,

  fetchNotifications: async () => {
    try {
      const { items, unread } = await inventoryApi.listAlertNotifications({ limit: 20 });
      set({ notifications: items, unread });
    } catch {
      // Silent: the bell is secondary to whatever the user is doing.
    }
  },

  markRead: async (ids = null) => {
    try {
      await inventoryApi.markAlertNotificationsRead(ids);
      set((s) => ({
        notifications: s.notifications.map((n) =>
          (!ids || ids.includes(n._id) ? { ...n, read: true } : n)),
        unread: ids ? Math.max(0, s.unread - ids.length) : 0,
      }));
    } catch {
      // Ignored — the next fetch corrects the count.
    }
  },

  clearError: () => set({ error: null }),
}));

export default useAlertStore;
