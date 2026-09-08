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
import { useHrmsPermissions } from "../../hooks/useHrmsPermissions";
import { visibleHrmsNavItems, hrmsSidebarGroup } from "../hrms/navItems";

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

// The ERP registry sends icons as NAMES; the HRMS nav items hold the imported
// component directly. Accepting both keeps one renderer for the whole rail
// rather than forking it, and keeps every HRMS icon out of the map above.
const iconFor = (name) =>
  (typeof name === "function" || typeof name === "object") && name ? name : ICONS[name] || Circle;

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
  /**
   * HRMS navigation - ONE dropdown.
   *
   * Appended to the SAME group list the ERP menu produces, not rendered as a
   * second rail: HRMS items then take part in the same active-item contest,
   * the same collapse behaviour and the same renderer, so exactly one row is
   * ever lit and the two halves cannot drift apart visually.
   *
   * This used to append one top-level group PER HRMS group - HRMS, My Work,
   * People & Org and HRMS Admin, four headings deep in a rail that already has
   * the ERP's own modules in it. They are now a single "HRMS" group, so the
   * whole system is one thing the user opens rather than four they have to
   * recognise as related. The item ORDER is unchanged: hrmsSidebarGroup walks
   * the same four groups in the same order and only drops the headings.
   *
   * Visibility comes from the HRMS evaluator, never from a portal permission -
   * the portal's Roles & Permissions matrix decides which HRMS ROLES an account
   * holds (see backend/utils/hrmsAccessBridge.js), and the evaluator then
   * decides what those roles can see, exactly as it did before. An account with
   * no HRMS access - a customer, or an admin on a role without the HRMS module
   * - gets null back and sees no trace of HRMS, not even a heading (AD-4).
   */
  const { can, implementedModules, hasAccess: hasHrmsAccess } = useHrmsPermissions();
  const hrmsGroup = hasHrmsAccess
    ? hrmsSidebarGroup(visibleHrmsNavItems(can, implementedModules))
    : null;

  const erpGroups = buildNavigation(user);

  const hrmsGroups = hrmsGroup
    ? [{
        key: hrmsGroup.key,
        label: hrmsGroup.label,
        icon: "Users",
        // Always a heading, even at one item: an HRMS entry loose among the
        // ERP modules would read as an ERP module.
        alwaysGrouped: true,
        items: hrmsGroup.items.map((item) => ({
          id: `hrms:${item.key}`,
          key: item.key,
          label: item.label,
          path: item.path,
          icon: item.icon,
        })),
      }]
    : [];

  /**
   * Administration sits at the BOTTOM of the rail, under everything it
   * administers.
   *
   * It has to be done here rather than with the registry's `order`, because the
   * two halves of this menu are ordered by different things. The ERP groups
   * arrive from the server already sorted by `order`; the HRMS group is built
   * on the client from the HRMS actor and knows nothing about that scale, so it
   * can only ever be concatenated - which put it after Administration however
   * the registry was numbered.
   *
   * Moving the one group by key is therefore the honest fix: it says what it
   * means, it survives a renumbering, and it does nothing at all for an account
   * that cannot see Administration in the first place.
   */
  const isAdministration = (group) => group.key === "administration";

  const groups = [
    ...erpGroups.filter((g) => !isAdministration(g)),
    ...hrmsGroups,
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

  const linkClass = (isActive, indented) =>
    `group relative flex items-center gap-3.5 rounded-lg text-sm font-semibold transition-all duration-200 ${
      indented && sidebarOpen ? "pl-9 pr-3 py-2" : "px-3 py-2.5"
    } ${
      isActive
        ? "nav-active bg-white text-primary-800 shadow-md shadow-primary-950/30 border border-transparent"
        : "text-primary-100 border border-transparent hover:bg-primary-400/20 hover:text-white hover:border-primary-400/30 hover:translate-x-1 hover:shadow-[0_0_15px_rgba(96,165,250,0.3)]"
    }`;

  const renderItem = (item, indented) => {
    const Icon = iconFor(item.icon);
    const isActive = item.id === activeItemId;
    const badge =
      item.badge === "cart" && cartItems.length > 0 ? cartItems.length : undefined;

    return (
      <NavLink
        key={item.id}
        to={item.path}
        title={sidebarOpen ? undefined : item.label}
        className={() => linkClass(isActive, indented)}
      >
        {() => (
          <>
            {isActive && (
              <span className="absolute -left-3 top-1/2 -translate-y-1/2 h-6 w-1 rounded-full bg-white" />
            )}
            <Icon size={indented && sidebarOpen ? 16 : 20} className="shrink-0" />
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

      <div className={`py-6 flex flex-col items-center overflow-hidden ${sidebarOpen ? "px-4" : "justify-center"}`}>
        <NavLink
          to={homePath}
          className={`bg-white rounded-xl flex items-center justify-center transition-all duration-300 ${
            sidebarOpen ? "w-48 h-16 p-2" : "w-11 h-11 p-1"
          }`}
        >
          <img
            src="/logo.avif"
            alt="Shraddha Impex"
            className="object-contain w-full h-full"
          />
        </NavLink>
      </div>

      <nav className="flex-1 overflow-y-auto py-6 px-3 space-y-1 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-white/10 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-white/30 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.1)_transparent]">
        {groups.map((group) => {
          // A module with a single destination is rendered as a plain link.
          // A disclosure triangle that opens to reveal one row is a control
          // that costs a click and tells the user nothing.
          if (group.items.length === 1 && !group.alwaysGrouped) {
            return renderItem({ ...group.items[0], label: group.label, icon: group.icon }, false);
          }

          const GroupIcon = iconFor(group.icon);
          const holdsActive = group.key === activeGroupKey;
          const collapsed = !holdsActive && collapsedNavGroups.includes(group.key);

          // Collapsed rail: the group header has nowhere to put a label and its
          // children have no room to indent, so the items are shown flat.
          if (!sidebarOpen) {
            return (
              <div key={group.key} className="space-y-1">
                <div className="h-px bg-white/10 my-2" />
                {group.items.map((item) => renderItem(item, false))}
              </div>
            );
          }

          return (
            <div key={group.key} className="space-y-1">
              <button
                type="button"
                onClick={() => toggleNavGroup(group.key)}
                aria-expanded={!collapsed}
                className={`w-full flex items-center gap-3.5 px-3 py-2.5 rounded-lg text-sm font-bold transition-all duration-200 focus:outline-none ${
                  holdsActive
                    ? "text-white bg-white/10"
                    : "text-primary-100 hover:bg-primary-400/20 hover:text-white"
                }`}
              >
                <GroupIcon size={20} className="shrink-0" />
                <span className="flex-1 truncate text-left">{group.label}</span>
                <ChevronDown
                  size={14}
                  className={`shrink-0 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
                />
              </button>

              {!collapsed && (
                <div className="space-y-1">
                  {group.items.map((item) => renderItem(item, true))}
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
