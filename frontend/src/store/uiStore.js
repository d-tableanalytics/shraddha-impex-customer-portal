import { create } from "zustand";

/**
 * Which sidebar groups the user has collapsed.
 *
 * Persisted, because a collapsed group is a statement about how somebody wants
 * to work - an Inventory Manager who folds away the Customer Portal has said
 * they do not use it, and re-expanding it on every page load overrules them
 * once per navigation.
 *
 * Stored as the COLLAPSED set rather than the expanded one, so a module added
 * later starts open. The alternative silently hides new modules from everyone
 * who has ever touched the sidebar.
 */
const NAV_GROUPS_KEY = "erp.collapsedNavGroups";

const readCollapsedGroups = () => {
  try {
    const raw = localStorage.getItem(NAV_GROUPS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
  } catch {
    // Private mode, cleared storage, or a value some other version wrote.
    // An unreadable preference is not worth failing the app shell over.
    return [];
  }
};

const writeCollapsedGroups = (groups) => {
  try {
    localStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(groups));
  } catch {
    // Nothing to do: the preference simply will not survive this session.
  }
};

export const useUIStore = create((set) => ({
  sidebarOpen: true,
  collapsedNavGroups: readCollapsedGroups(),
  toggleNavGroup: (key) =>
    set((state) => {
      const next = state.collapsedNavGroups.includes(key)
        ? state.collapsedNavGroups.filter((k) => k !== key)
        : [...state.collapsedNavGroups, key];
      writeCollapsedGroups(next);
      return { collapsedNavGroups: next };
    }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  notificationsOpen: false,
  toggleNotifications: () =>
    set((state) => ({ notificationsOpen: !state.notificationsOpen })),
  setNotificationsOpen: (open) => set({ notificationsOpen: open }),
  searchQuery: "",
  setSearchQuery: (query) => set({ searchQuery: query }),
  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  toggleCommandPalette: () => set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen })),
}));
