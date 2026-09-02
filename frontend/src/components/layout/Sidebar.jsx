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
  FileCheck2,
  LogOut,
  Warehouse,
  ScrollText,
  Activity,
  GaugeCircle,
  Upload,
  Images,
} from "lucide-react";
import toast from "react-hot-toast";
import { useUIStore } from "../../store/uiStore";
import { useCartStore } from "../../store/cartStore";
import { useUserStore } from "../../store/userStore";
import {
  canUseSalesDesk,
  canUseInventoryMaster,
  canUseOrdering,
  homePathFor,
  hasPermission,
  PERMISSIONS,
  canOpenUserManagement,
} from "../../utils/permissions";

export const Sidebar = () => {
  const { sidebarOpen, toggleSidebar } = useUIStore();
  const cartItems = useCartStore((state) => state.items);

  const { user, logout } = useUserStore();
  const location = useLocation();

  const handleLogout = () => {
    logout();
    toast.success("Successfully logged out.");
  };

  // Admin is worth surfacing, but a separate chip crowds the card — fold it
  // into the second line alongside the company.
  const subtitle =
    [user?.role && user.role !== "Customer" ? user.role : null, user?.company || user?.email]
      .filter(Boolean)
      .join(" · ") || "System Account";

  // The internal stock roles work stock, not orders — they hold no ordering
  // permission, so offering them the ordering flow would only lead to screens
  // they cannot use. Admin, Sales and customers are unaffected.
  //
  // Asked as a PERMISSION question rather than "is this role in a list": the
  // router guards the same screens with the same helper, so the menu and the
  // URL bar cannot end up disagreeing about who works orders — which they would
  // the first time a role was added to one list and not the other.
  const worksOrders = canUseOrdering(user);

  /**
   * The first menu item is HOME, wherever home is for this role.
   *
   * For Import Team that is the inventory dashboard, so the item points there
   * and the separate "Inventory Dashboard" entry below is suppressed — two rows
   * leading to the same screen, one of them highlighted and one not, reads as a
   * bug. Everyone else is unaffected: home is "/" and both items stay.
   */
  const homePath = homePathFor(user);
  const homeIsInventoryDashboard = homePath === "/inventory/dashboard";

  const menuItems = [
    {
      name: homeIsInventoryDashboard ? "Inventory Dashboard" : "Dashboard",
      path: homePath,
      icon: homeIsInventoryDashboard ? GaugeCircle : LayoutDashboard,
    },
    ...(worksOrders ? [
      {
        name: "Create Booking",
        path: "/orders/new",
        icon: PlusCircle,
        badge: cartItems.length > 0 ? cartItems.length : undefined,
      },
      { name: "Bulk Upload", path: "/orders/bulk-upload", icon: UploadCloud },
      { name: "Booking History", path: "/orders/history", icon: History },
      { name: "Indent History", path: "/orders/indent-history", icon: PackageX },
    ] : []),
    // The catalogue, for EVERYONE. It sat inside the ordering block above, so
    // the internal stock roles — who spend their day in it — were the only
    // people the menu never offered it to. It is not an ordering screen: it is
    // the product list, and it is where the product detail panel lives.
    { name: "Inventory", path: "/inventory", icon: Boxes },
    // IMS master — internal stock roles and Admin. The inventory dashboard is
    // omitted when it is already this role's home item above.
    ...(canUseInventoryMaster(user) ? [
      ...(homeIsInventoryDashboard
        ? []
        : [{ name: "Inventory Dashboard", path: "/inventory/dashboard", icon: GaugeCircle }]),
      { name: "Inventory Master", path: "/inventory/master", icon: Warehouse },
    ] : []),
    // Stock health — anyone who may see inventory.
    ...(hasPermission(user, PERMISSIONS.VIEW_INVENTORY) && canUseInventoryMaster(user) ? [
      { name: "Inventory Health", path: "/inventory/health", icon: Activity },
    ] : []),
    // Stock ledger — anyone who may read movement history.
    ...(hasPermission(user, PERMISSIONS.VIEW_STOCK_LEDGER) ? [
      { name: "Stock Ledger", path: "/inventory/ledger", icon: ScrollText },
    ] : []),
    // Import — the history is readable by anyone who sees inventory; the
    // upload controls inside are gated per import type.
    ...(canUseInventoryMaster(user) ? [
      { name: "Inventory Import", path: "/inventory/import", icon: Upload },
    ] : []),
    // Product content - descriptions, photographs and videos. Sits
    // with the inventory group because that is where it is consumed, and is
    // gated on MANAGE_INVENTORY_MASTER because that is the permission the
    // endpoints behind it require.
    ...(hasPermission(user, PERMISSIONS.MANAGE_INVENTORY_MASTER) ? [
      { name: "Product Details", path: "/admin/product-details", icon: Images },
    ] : []),
    // Sales desk: Sales users and Admins (via the '*' wildcard).
    ...(canUseSalesDesk(user) ? [
      { name: "Sales Desk", path: "/sales", icon: FileCheck2 },
    ] : []),
    // User Management is no longer Admin-only: Sales onboards its own
    // customers. What each of them can see and do inside is decided per
    // account, on the screen and again on the server.
    ...(canOpenUserManagement(user) ? [
      { name: "User Management", path: "/admin/users", icon: Users },
      // Reports hidden from the menu for now.
      // { name: "Reports", path: "/reports", icon: BarChart3 },
    ] : []),
    { name: "Settings", path: "/settings", icon: Settings },
    { name: "Help", path: "/help", icon: HelpCircle },
  ];

  /**
   * Exactly ONE item is highlighted, and it is the most specific match.
   *
   * Previously each item decided for itself with `pathname.startsWith(basePath)`.
   * Where one nav path is a prefix of another — "/inventory" and
   * "/inventory/master" — that is true for both, so opening a sub-page lit up
   * two rows at once. Choosing a single winner by longest matching path is what
   * makes that impossible rather than merely unlikely.
   *
   * The match is on a SEGMENT boundary, so "/inventory" claims "/inventory/master"
   * but never "/inventory-config".
   */
  const matches = (item) => {
    const [basePath, searchStr] = item.path.split('?');
    if (item.path === '/') return location.pathname === '/';
    if (searchStr) return location.pathname === basePath && location.search.includes(searchStr);
    // Booking History and Indent History share a path and differ by query
    // string, so the bare path must not claim a filtered view.
    if (item.path === '/orders/history') return location.pathname === basePath && !location.search;
    return location.pathname === basePath || location.pathname.startsWith(`${basePath}/`);
  };

  const activeItemName = menuItems.reduce((best, item) => {
    if (!matches(item)) return best;
    const len = item.path.split('?')[0].length;
    return !best || len > best.len ? { name: item.name, len } : best;
  }, null)?.name ?? null;

  return (
    <aside
      className={`bg-linear-to-bl from-slate-800 via-primary-900 to-slate-900 h-screen flex flex-col transition-all duration-300 relative z-30 select-none shadow-xl shadow-primary-950/20 ${sidebarOpen ? "w-64" : "w-20"
        }`}
    >
      <button
        onClick={toggleSidebar}
        className="absolute -right-3 top-6 bg-white text-primary-700 hover:text-primary-900 w-6 h-6 rounded-full flex items-center justify-center shadow-enterprise-md hover:scale-110 transition-all focus:outline-none ring-1 ring-primary-100"
      >
        {sidebarOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
      </button>

      <div className={`py-6 flex flex-col items-center overflow-hidden ${sidebarOpen ? "px-4" : "justify-center"}`}>
        <div className={`bg-white rounded-xl flex items-center justify-center transition-all duration-300 ${sidebarOpen ? "w-48 h-16 p-2" : "w-11 h-11 p-1"}`}>
          <img
            src="/logo.avif"
            alt="Shraddha Impex"
            className="object-contain w-full h-full"
          />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-6 px-3 space-y-1 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-white/10 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-white/30 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.1)_transparent]">
        {menuItems.map((item) => {
          const isActuallyActive = item.name === activeItemName;

          return (
          <NavLink
            key={item.name}
            to={item.path}
            className={() =>
              `group relative flex items-center gap-3.5 px-3 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 ${isActuallyActive
                ? "nav-active bg-white text-primary-800 shadow-md shadow-primary-950/30 border border-transparent"
                : "text-primary-100 border border-transparent hover:bg-primary-400/20 hover:text-white hover:border-primary-400/30 hover:translate-x-1 hover:shadow-[0_0_15px_rgba(96,165,250,0.3)]"
              }`
            }
          >
            {() => (
              <>
                {isActuallyActive && (
                  <span className="absolute -left-3 top-1/2 -translate-y-1/2 h-6 w-1 rounded-full bg-white" />
                )}
                <item.icon size={20} className="shrink-0" />
                {sidebarOpen && (
                  <span className="flex-1 truncate">{item.name}</span>
                )}
                {sidebarOpen && item.badge !== undefined && (
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${isActuallyActive ? "bg-primary-600 text-white" : "bg-white text-primary-800"}`}>
                    {item.badge}
                  </span>
                )}
              </>
            )}
          </NavLink>
        )})}
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
