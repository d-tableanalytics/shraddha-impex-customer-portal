import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  PlusCircle,
  UploadCloud,
  History,
  PackageX,
  Boxes,
  Users,
  Settings,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  FileCheck2,
  LogOut,
  Warehouse,
  ScrollText,
  Activity,
  GaugeCircle,
  Upload,
  Images,
  Store,
  ShieldCheck,
  LayoutGrid,
  Key,
  BarChart3,
  Circle,
  X,
  ListChecks,
  Truck,
  Ban,
  CalendarClock,
} from "lucide-react";
import toast from "react-hot-toast";
import { useUIStore } from "../../store/uiStore";
import { useCartStore } from "../../store/cartStore";
import { useUserStore } from "../../store/userStore";
import { homePathFor } from "../../utils/permissions";
import { buildNavigation } from "../../utils/navigation";
import { useUserStore as useFmsUserStore } from "../../fms/store/userStore";
import { fmsNavGroup, withFmsGroup } from "../../fms/navigation";

/**
 * Icon names travel from the backend registry as strings; this is where they
 * become components.
 *
 * A map rather than a dynamic lookup into the whole of lucide-react, so the
 * bundle carries the two dozen icons the ERP actually uses instead of all
 * thousand-odd. An unknown name falls back to a plain dot - a new module should
 * appear in the menu the day it is registered, even if nobody has chosen its
 * icon yet.
 */
const ICONS = {
  LayoutDashboard, PlusCircle, UploadCloud, History, PackageX, Boxes, Users,
  Settings, HelpCircle, FileCheck2, Warehouse, ScrollText, Activity,
  GaugeCircle, Upload, Images, Store, ShieldCheck, LayoutGrid, Key, BarChart3,
  // FMS (src/fms/navigation.js).
  ListChecks, Truck, Ban,
  // Upcoming Stock demo (utils/navigation.js).
  CalendarClock,
};

// The registry sends icons as NAMES, and this is where they become components.
// An unknown name falls back to a plain dot, so a module registered before
// somebody picks its icon still appears in the menu.
const iconFor = (name) => ICONS[name] || Circle;

/**
 * The width at which the rail can sit BESIDE the content instead of over it.
 *
 * 1024px, matching Tailwind's `lg`, and the two must agree: the classes below
 * switch the rail between drawer and rail at `lg`, and this decides whether the
 * labels render. Reading the same number twice is what stops a 1000px window
 * showing a 256px drawer with no labels in it.
 */
const DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * Is there room for the rail beside the page?
 *
 * In JS rather than CSS alone because two things depend on the answer and only
 * one of them is styling: the WIDTH is a class, but whether a row renders its
 * LABEL is a render decision, and a media query cannot make that one.
 *
 * Guarded for the server and for jsdom, where `matchMedia` is a stub that
 * answers `false` — which resolves to the drawer, and the drawer always shows
 * its labels, so a test still sees every link by name.
 */
const useIsDesktop = () => {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(DESKTOP_QUERY).matches === true,
  );

  useEffect(() => {
    const mql = window.matchMedia?.(DESKTOP_QUERY);
    if (!mql) return undefined;

    const onChange = (event) => setIsDesktop(event.matches);
    // Re-read on mount: the initialiser ran during the first render, and a
    // window can be resized between that and the effect.
    setIsDesktop(mql.matches);

    // `addListener` is the Safari < 14 spelling. Both are stubbed in tests, and
    // a stub that implements neither simply gets no subscription rather than a
    // TypeError — the initial value is still correct.
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else if (mql.addListener) mql.addListener(onChange);

    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onChange);
      else if (mql.removeListener) mql.removeListener(onChange);
    };
  }, []);

  return isDesktop;
};

export const Sidebar = () => {
  const {
    sidebarOpen, toggleSidebar, collapsedNavGroups, toggleNavGroup,
    mobileNavOpen, closeMobileNav,
  } = useUIStore();
  const cartItems = useCartStore((state) => state.items);

  const { user, logout } = useUserStore();
  // The user as the Employee API resolves them — the only answer that can
  // include FMS. Null until it loads, and for anyone FMS is not offered to.
  const fmsUser = useFmsUserStore((s) => s.user);
  const location = useLocation();
  const isDesktop = useIsDesktop();

  /**
   * Whether rows show their labels.
   *
   * On desktop this is the user's collapse preference. On mobile it is always
   * true: the drawer is 256px wide whatever the preference says, and an
   * icon-only rail inside a full-width drawer is a 256px panel showing nine
   * ambiguous glyphs. The persisted preference is about the DESKTOP rail, so it
   * must not follow the user onto a phone.
   */
  const expanded = isDesktop ? sidebarOpen : true;

  /**
   * A tap on a link has to close the drawer.
   *
   * Without this the page changes underneath a drawer that is still covering
   * it, and the user has to dismiss it by hand every single time — which reads
   * as the menu being stuck. Desktop is unaffected: the rail is not an overlay
   * there, so there is nothing to close.
   */
  useEffect(() => {
    if (!isDesktop) closeMobileNav();
  }, [location.pathname, location.search, isDesktop, closeMobileNav]);

  /** Escape closes it, as it does for every other overlay in the app. */
  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") closeMobileNav();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileNavOpen, closeMobileNav]);

  const handleLogout = () => {
    logout();
    toast.success("Successfully logged out.");
  };

  // Admin is worth surfacing, but a separate chip crowds the card - fold it
  // into the second line alongside the company.
  const subtitle =
    [user?.role && user.role !== "Customer" ? user.role : null, user?.company || user?.email]
      .filter(Boolean)
      .join(" · ") || "System Account";

  /**
   * THE MENU IS NOW DATA, NOT CODE.
   *
   * This component used to assemble the menu itself from a dozen inline
   * permission checks - `...(canUseInventoryMaster(user) ? [...] : [])` and so
   * on. That could only ever describe roles the bundle already knew about, so a
   * role invented by a Super Admin would get whatever the checks happened to
   * decide, and a new module meant editing this file.
   *
   * buildNavigation() takes what the SERVER says this user may see and turns it
   * into groups. The presentation decisions that genuinely belong to the
   * sidebar - the cart badge, which group is open - stay here.
   */
  const erpGroups = withFmsGroup(buildNavigation(user), fmsNavGroup(fmsUser));

  /**
   * Administration sits at the BOTTOM of the rail, under everything it
   * administers.
   *
   * It has to be done here rather than with the registry's `order`, because the
   * two halves of this menu are ordered by different things. The ERP groups
   * arrive from the server already sorted by `order`, and Administration is
   * moved by KEY rather than by renumbering the registry — so it stays last
   * whatever order values the registry is later given.
   *
   * Moving the one group by key is therefore the honest fix: it says what it
   * means, it survives a renumbering, and it does nothing at all for an account
   * that cannot see Administration in the first place.
   */
  const isAdministration = (group) => group.key === "administration";

  const groups = [
    ...erpGroups.filter((g) => !isAdministration(g)),
    ...erpGroups.filter(isAdministration),
  ];

  // Import Team's home is the inventory dashboard, so "/" only ever redirects
  // for them. Every flat path below is the one the user is actually taken to.
  const homePath = homePathFor(user);

  /**
   * Exactly ONE item is highlighted, and it is the most specific match.
   *
   * Each item deciding for itself with `pathname.startsWith(basePath)` lights up
   * two rows at once wherever one nav path is a prefix of another - "/inventory"
   * and "/inventory/master". Choosing a single winner by longest matching path
   * is what makes that impossible rather than merely unlikely.
   *
   * The match is on a SEGMENT boundary, so "/inventory" claims
   * "/inventory/master" but never "/inventory-config".
   */
  const matches = (item) => {
    const [basePath, searchStr] = item.path.split("?");
    if (item.path === "/") return location.pathname === "/";
    if (searchStr) return location.pathname === basePath && location.search.includes(searchStr);
    // Booking History and Indent History share a path and differ by query
    // string, so the bare path must not claim a filtered view.
    if (item.path === "/orders/history") return location.pathname === basePath && !location.search;
    return location.pathname === basePath || location.pathname.startsWith(`${basePath}/`);
  };

  const allItems = groups.flatMap((g) => g.items);
  const activeItem = allItems.reduce((best, item) => {
    if (!matches(item)) return best;
    const len = item.path.split("?")[0].length;
    return !best || len > best.len ? { id: item.id, len } : best;
  }, null);
  const activeItemId = activeItem?.id ?? null;

  // The group holding the current screen is always open, whatever the user last
  // collapsed - a collapsed group hiding the page you are on reads as the menu
  // having lost your place.
  const activeGroupKey = groups.find((g) => g.items.some((i) => i.id === activeItemId))?.key;

  /**
   * WHERE YOU ARE, stated in solid white.
   *
   * The previous active state was `bg-white/10` — a 10% overlay on a dark
   * gradient, which sits about as far from the hover state (`white/[0.07]`) as
   * a rounding error. On the deep end of the gradient it was effectively
   * invisible, so the rail could not answer "which page am I on" at a glance.
   *
   * A SOLID white pill with dark text inverts the row instead of tinting it.
   * That is unmistakable at any point of the gradient, and it is the one
   * treatment nothing else in the sidebar uses, so it cannot be confused with
   * hover or focus. The Employee Portal's rail already made this change and
   * carries a test for it; this brings the two back into line.
   *
   * The left accent bar that used to ride inside the active row goes with it: a
   * 3px primary sliver on a white pill is both redundant and clipped by the
   * row's own rounded corner. It survives where it still earns its place — on a
   * COLLAPSED group header, which is the one case where the active row is
   * hidden and the rail must still say where you are.
   *
   * `min-h-9` (36px) keeps every row a comfortable target without changing the
   * density the rail already had.
   */
  const linkClass = (isActive) =>
    `group relative flex items-center gap-3 rounded-lg px-3 py-2 min-h-9 text-sm transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
      isActive
        ? "nav-active bg-white text-primary-900 font-semibold shadow-sm"
        : "text-primary-100/90 font-medium hover:bg-white/[0.07] hover:text-white"
    }`;

  /**
   * A PARENT NODE.
   *
   * Deliberately the same SHAPE as a child row — same height, same padding,
   * same 18px icon — because in a tree a parent and a child are the same kind
   * of thing at different depths. What separates them is weight, the chevron,
   * and the fact that children are indented underneath.
   *
   * This replaces the small uppercase caption the header used to be. A caption
   * is the right treatment for a FLAT list, where the heading is the only thing
   * carrying group membership and has to look unlike the rows it labels. Once
   * the children are visibly nested under a rail, the caption stops being a
   * heading and starts being a node that looks nothing like its siblings.
   *
   * `bg-white/[0.06]` when the branch holds the current page: enough to find at
   * a glance while scrolling, and nowhere near the solid white pill an active
   * ROW gets, so the two can never be confused.
   */
  const branchHeaderClass = (holdsActive) =>
    `relative w-full flex items-center gap-3 rounded-lg px-3 py-2 min-h-9 text-sm font-semibold transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
      holdsActive
        ? "bg-white/[0.06] text-white"
        : "text-primary-100 hover:bg-white/[0.07] hover:text-white"
    }`;

  /**
   * THE BRANCH — the indented well a parent's children sit in.
   *
   * `ml-[21px]` is not arbitrary. The parent row is `px-3` (12px) and its icon
   * is 18px, so the icon's centre line falls at 12 + 9 = 21px. Running the rail
   * down from exactly there makes it read as descending FROM the parent rather
   * than as a stripe that happens to be nearby — which is the difference
   * between a tree and a list with a decoration on it.
   *
   * The rail brightens when the branch contains the current page, so "which
   * section am I in" survives scrolling past the parent it belongs to.
   */
  const branchClass = (holdsActive) =>
    `relative ml-[21px] pl-2 border-l space-y-0.5 transition-colors duration-150 ${
      holdsActive ? "border-primary-400/40" : "border-white/10"
    }`;

  const renderItem = (item) => {
    const Icon = iconFor(item.icon);
    const isActive = item.id === activeItemId;
    const badge =
      item.badge === "cart" && cartItems.length > 0 ? cartItems.length : undefined;

    return (
      <NavLink
        key={item.id}
        to={item.path}
        title={expanded ? undefined : item.label}
        className={() => linkClass(isActive)}
      >
        {() => (
          <>
            <Icon size={18} className="shrink-0" />
            {expanded && <span className="flex-1 truncate">{item.label}</span>}
            {expanded && badge !== undefined && (
              <span
                className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                  isActive ? "bg-primary-600 text-white" : "bg-white text-primary-800"
                }`}
              >
                {badge}
              </span>
            )}
            {/* The badge still has to be countable on the icon rail, where
                there is no room for the pill above. A dot says "there is
                something here" without pretending to be a number. */}
            {!expanded && badge !== undefined && (
              <span
                aria-hidden="true"
                className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary-300 ring-2 ring-primary-900"
              />
            )}
          </>
        )}
      </NavLink>
    );
  };

  return (
    <>
      {/*
        THE BACKDROP, mobile only.

        Dismisses the drawer on a tap outside it, which is the gesture people
        try first. `aria-hidden` because the drawer itself is the thing to
        interact with; Escape covers the keyboard.
      */}
      <div
        onClick={closeMobileNav}
        aria-hidden="true"
        className={`fixed inset-0 z-30 bg-slate-900/50 backdrop-blur-[1px] transition-opacity duration-300 lg:hidden ${
          mobileNavOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      <aside
        className={`bg-linear-to-bl from-slate-800 via-primary-900 to-slate-900 h-screen flex flex-col transition-all duration-300 select-none shadow-xl shadow-primary-950/20
          fixed inset-y-0 left-0 z-40 w-64
          lg:relative lg:z-30 lg:translate-x-0 lg:visible
          ${mobileNavOpen ? "translate-x-0 visible" : "-translate-x-full invisible"}
          ${sidebarOpen ? "lg:w-64" : "lg:w-20"}`}
      >
        {/*
          The desktop collapse handle. Hidden below `lg`: it rides on the rail's
          right edge, which on a drawer would float over the page content, and
          collapsing a drawer to an icon strip is not a state the drawer has.
        */}
        <button
          onClick={toggleSidebar}
          aria-label={sidebarOpen ? "Collapse navigation" : "Expand navigation"}
          className="hidden lg:flex absolute -right-3 top-6 bg-white text-primary-700 hover:text-primary-900 w-6 h-6 rounded-full items-center justify-center shadow-enterprise-md hover:scale-110 transition-all focus:outline-none ring-1 ring-primary-100"
        >
          {sidebarOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>

        {/* Logo, then a rule. The same mark and the same link as before — only
            the block around it is tighter, so the rail starts with navigation
            rather than with a large empty band. */}
        <div
          className={`py-4 flex items-center overflow-hidden border-b border-white/10 ${
            expanded ? "px-4 justify-between gap-2" : "px-2 justify-center"
          }`}
        >
          <NavLink
            to={homePath}
            className={`bg-white rounded-xl flex items-center justify-center transition-all duration-300 ${
              expanded ? "w-44 h-14 p-2" : "w-11 h-11 p-1"
            }`}
          >
            <img
              src="/logo.avif"
              alt="Shraddha Impex"
              className="object-contain w-full h-full"
            />
          </NavLink>

          {/* The drawer's own dismiss. Mobile only — on desktop the handle on
              the rail's edge does this job. */}
          <button
            onClick={closeMobileNav}
            aria-label="Close navigation menu"
            className="lg:hidden inline-flex items-center justify-center min-h-10 min-w-10 rounded-lg text-primary-100 hover:text-white hover:bg-white/10 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1 overscroll-contain [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-white/10 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-white/30 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.1)_transparent]">
          {groups.map((group) => {
            // A module with a single destination is rendered as a plain link.
            // A disclosure triangle that opens to reveal one row is a control
            // that costs a click and tells the user nothing.
            if (group.items.length === 1 && !group.alwaysGrouped) {
              return renderItem({ ...group.items[0], label: group.label, icon: group.icon });
            }

            const GroupIcon = iconFor(group.icon);
            const holdsActive = group.key === activeGroupKey;

            /**
             * An explicit collapse is honoured, even for the group you are in.
             *
             * This used to read `!holdsActive && collapsedNavGroups.includes(...)`,
             * so the group containing the current screen could never be shut. The
             * intent was that a collapsed group must not hide your place — but the
             * effect was a chevron that rendered, accepted the click, wrote it to
             * the store, and then did nothing, which is the one thing a control
             * must never do.
             *
             * The intent is kept a better way: a collapsed group that holds the
             * current page carries the same accent an active row does (below), so
             * you can still see where you are without the menu overriding you.
             */
            const collapsed = collapsedNavGroups.includes(group.key);

            // Icon rail: the group header has nowhere to put a label and its
            // children have no room to indent, so the items are shown flat.
            if (!expanded) {
              return (
                <div key={group.key} className="space-y-1">
                  <div className="h-px bg-white/10 my-2" />
                  {group.items.map((item) => renderItem(item))}
                </div>
              );
            }

            return (
              /*
                `pt-3 first:pt-0` is the whole spacing change: one group now
                reads as separate from the next. Previously every group and
                every row sat on the same 2px rhythm, so the rail was one
                undifferentiated column of twenty links and the headings did no
                grouping work at all.
              */
              <div key={group.key} className="space-y-0.5 pt-3 first:pt-0">
                <button
                  type="button"
                  onClick={() => toggleNavGroup(group.key)}
                  aria-expanded={!collapsed}
                  className={branchHeaderClass(holdsActive)}
                >
                  {/* Shut, but this is where you are. The accent says so, so
                      collapsing the group never costs you your place. */}
                  {holdsActive && collapsed && (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-primary-300"
                    />
                  )}
                  <GroupIcon size={18} className="shrink-0" />
                  <span className="flex-1 truncate text-left">{group.label}</span>
                  {/*
                    The disclosure, pointing DOWN when open and right when shut —
                    the direction every tree view uses, and the one thing on the
                    row that says it has children at all.
                  */}
                  <ChevronDown
                    size={14}
                    className={`shrink-0 opacity-70 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
                  />
                </button>

                {/* `group.sections` — the sub-headed variant — existed only for
                    HRMS, which had four sections inside one dropdown. Every group
                    the module registry produces is a flat list, so the branch that
                    rendered sections went with HRMS rather than staying as a
                    permanently-false condition. */}
                {!collapsed && (
                  <div className={branchClass(holdsActive)}>
                    {group.items.map((item) => renderItem(item))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Signed-in user. Collapses to avatar + sign-out when the rail is narrow.
            The card is a plain div, not a link, so the sign-out button isn't
            nested inside an anchor. */}
        <div className="p-3 border-t border-white/10">
          <div
            className={`flex items-center rounded-lg border border-white/10 bg-white/5 ${
              expanded ? "gap-2 p-2.5" : "flex-col gap-2 p-2"
            }`}
          >
            <NavLink
              to="/settings"
              title={expanded ? "View your profile" : user?.user || user?.name || "Profile"}
              className="flex items-center gap-3 min-w-0 flex-1 rounded-md hover:opacity-80 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              {user?.avatar ? (
                <img
                  src={user.avatar}
                  alt=""
                  className="w-9 h-9 rounded-full object-cover border border-white/20 shrink-0"
                />
              ) : (
                <div className="w-9 h-9 rounded-full bg-white/15 text-white flex items-center justify-center text-xs font-bold shrink-0">
                  {(user?.user || user?.name || "US").slice(0, 2).toUpperCase()}
                </div>
              )}

              {expanded && (
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-white truncate leading-tight">
                    {user?.user || user?.name || "Loading..."}
                  </p>
                  <p className="text-[11px] text-primary-200/80 font-medium truncate">
                    {subtitle}
                  </p>
                </div>
              )}
            </NavLink>

            <button
              onClick={handleLogout}
              title="Sign out"
              aria-label="Sign out"
              className="p-1.5 rounded-md text-primary-200 hover:text-white hover:bg-red-500/80 transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
};
export default Sidebar;
