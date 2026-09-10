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
} from "lucide-react";
import toast from "react-hot-toast";
import { useUIStore } from "../../store/uiStore";
import { useCartStore } from "../../store/cartStore";
import { useUserStore } from "../../store/userStore";
import { homePathFor } from "../../utils/permissions";
import { buildNavigation } from "../../utils/navigation";

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
};

// The registry sends icons as NAMES, and this is where they become components.
// An unknown name falls back to a plain dot, so a module registered before
// somebody picks its icon still appears in the menu.
const iconFor = (name) => ICONS[name] || Circle;

export const Sidebar = () => {
  const { sidebarOpen, toggleSidebar, collapsedNavGroups, toggleNavGroup } = useUIStore();
  const cartItems = useCartStore((state) => state.items);

  const { user, logout } = useUserStore();
  const location = useLocation();

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
  const erpGroups = buildNavigation(user);

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
   * One row of the rail.
   *
   * Flat, not nested: every item sits at the same left edge, so the rail reads
   * as one navigation system. Group membership is carried by the heading above,
   * which is what a heading is for — it does not need to be restated as
   * indentation on every child.
   *
   * `py-2` on `text-sm` gives a ~36px row; `px-3` is the 12px gutter the rest of
   * the shell uses; `rounded-lg` is 8px.
   */
  const linkClass = (isActive) =>
    `group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-150 ${
      isActive
        ? "nav-active bg-white/10 text-white font-semibold"
        : "text-primary-100/90 font-medium hover:bg-white/[0.07] hover:text-white"
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
        title={sidebarOpen ? undefined : item.label}
        className={() => linkClass(isActive)}
      >
        {() => (
          <>
            {/* The accent sits INSIDE the row's left edge, so it reads as a
                border on the item rather than a marker floating in the gutter.
                Rounded on the right only, like a tab stop. */}
            {isActive && (
              <span
                aria-hidden="true"
                className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-primary-300"
              />
            )}
            <Icon size={18} className="shrink-0" />
            {sidebarOpen && <span className="flex-1 truncate">{item.label}</span>}
            {sidebarOpen && badge !== undefined && (
              <span
                className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                  isActive ? "bg-primary-600 text-white" : "bg-white text-primary-800"
                }`}
              >
                {badge}
              </span>
            )}
          </>
        )}
      </NavLink>
    );
  };

  return (
    <aside
      className={`bg-linear-to-bl from-slate-800 via-primary-900 to-slate-900 h-screen flex flex-col transition-all duration-300 relative z-30 select-none shadow-xl shadow-primary-950/20 ${
        sidebarOpen ? "w-64" : "w-20"
      }`}
    >
      <button
        onClick={toggleSidebar}
        className="absolute -right-3 top-6 bg-white text-primary-700 hover:text-primary-900 w-6 h-6 rounded-full flex items-center justify-center shadow-enterprise-md hover:scale-110 transition-all focus:outline-none ring-1 ring-primary-100"
      >
        {sidebarOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
      </button>

      {/* Logo, then a rule. The same mark and the same link as before — only
          the block around it is tighter, so the rail starts with navigation
          rather than with a large empty band. */}
      <div
        className={`py-4 flex flex-col items-center overflow-hidden border-b border-white/10 ${
          sidebarOpen ? "px-4" : "justify-center"
        }`}
      >
        <NavLink
          to={homePath}
          className={`bg-white rounded-xl flex items-center justify-center transition-all duration-300 ${
            sidebarOpen ? "w-44 h-14 p-2" : "w-11 h-11 p-1"
          }`}
        >
          <img
            src="/logo.avif"
            alt="Shraddha Impex"
            className="object-contain w-full h-full"
          />
        </NavLink>
      </div>

      <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-white/10 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-white/30 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.1)_transparent]">
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

          // Collapsed rail: the group header has nowhere to put a label and its
          // children have no room to indent, so the items are shown flat.
          if (!sidebarOpen) {
            return (
              <div key={group.key} className="space-y-1">
                <div className="h-px bg-white/10 my-2" />
                {group.items.map((item) => renderItem(item))}
              </div>
            );
          }

          return (
            <div key={group.key} className="space-y-0.5">
              <button
                type="button"
                onClick={() => toggleNavGroup(group.key)}
                aria-expanded={!collapsed}
                className={`relative w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-bold transition-colors duration-150 focus:outline-none ${
                  holdsActive
                    ? "text-white"
                    : "text-primary-100 hover:bg-white/[0.07] hover:text-white"
                }`}
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
                <div className="space-y-0.5">
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
            sidebarOpen ? "gap-2 p-2.5" : "flex-col gap-2 p-2"
          }`}
        >
          <NavLink
            to="/settings"
            title={sidebarOpen ? "View your profile" : user?.user || user?.name || "Profile"}
            className="flex items-center gap-3 min-w-0 flex-1 rounded-md hover:opacity-80 transition-opacity"
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

            {sidebarOpen && (
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
            className="p-1.5 rounded-md text-primary-200 hover:text-white hover:bg-red-500/80 transition-colors shrink-0 focus:outline-none"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
};
export default Sidebar;
