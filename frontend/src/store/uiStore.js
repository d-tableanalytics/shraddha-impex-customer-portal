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

/**
 * Whether the desktop rail is expanded or shown as icons only.
 *
 * Persisted for the same reason the collapsed groups are: it is a statement
 * about how somebody wants to work. Collapsing the rail to reclaim 176px and
 * finding it expanded again on the next page load overrules that choice once
 * per navigation.
 *
 * DESKTOP ONLY. The mobile drawer is `mobileNavOpen` below and is deliberately
 * NOT persisted — a drawer that reopens itself on every visit is a drawer
 * covering the screen.
 */
const SIDEBAR_KEY = "erp.sidebarOpen";

const readSidebarOpen = () => {
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY);
    // No stored preference means expanded, which is what the rail has always
    // opened as.
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
};

const writeSidebarOpen = (open) => {
  try {
    localStorage.setItem(SIDEBAR_KEY, String(open));
  } catch {
    // Private mode or cleared storage. The preference simply will not survive
    // this session, which is not worth failing the shell over.
  }
};

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
  sidebarOpen: readSidebarOpen(),

  /**
   * The MOBILE navigation drawer — a different question from `sidebarOpen`.
   *
   * Below the `lg` breakpoint the rail cannot sit beside the content: at 375px
   * a 256px sidebar leaves about 119px for the page. So it becomes an
   * off-canvas drawer, and "is it on screen" is a separate piece of state from
   * "is the desktop rail expanded".
   *
   * Two flags rather than one flag meaning different things at different widths:
   * that version works until somebody resizes the window, at which point the
   * rail is in whichever state the other breakpoint left it.
   *
   * Always starts closed, and is never persisted.
   */
  mobileNavOpen: false,

  collapsedNavGroups: readCollapsedGroups(),
  toggleNavGroup: (key) =>
    set((state) => {
      const next = state.collapsedNavGroups.includes(key)
        ? state.collapsedNavGroups.filter((k) => k !== key)
        : [...state.collapsedNavGroups, key];
      writeCollapsedGroups(next);
      return { collapsedNavGroups: next };
    }),
  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarOpen;
      writeSidebarOpen(next);
      return { sidebarOpen: next };
    }),
  setSidebarOpen: (open) => {
    writeSidebarOpen(open);
    return set({ sidebarOpen: open });
  },

  toggleMobileNav: () => set((state) => ({ mobileNavOpen: !state.mobileNavOpen })),
  setMobileNavOpen: (open) => set({ mobileNavOpen: open }),
  closeMobileNav: () => set({ mobileNavOpen: false }),
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
