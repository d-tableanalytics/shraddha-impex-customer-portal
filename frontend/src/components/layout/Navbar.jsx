import { useState, useRef, useEffect } from "react";
import {
  Bell,
  Moon,
  Sun,
  LogOut,
  User as UserIcon,
  Search,
  Menu,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useUserStore } from "../../store/userStore";
import { useUIStore } from "../../store/uiStore";
import { useThemeStore } from "../../store/themeStore";
import { useNotificationStore } from "../../store/notificationStore";
import { Drawer } from "../ui/Drawer";
import toast from "react-hot-toast";

const timeAgo = (iso) => {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
};

export const Navbar = () => {
  const navigate = useNavigate();
  const { user, logout } = useUserStore();
  const {
    sidebarOpen,
    toggleSidebar,
    notificationsOpen,
    setNotificationsOpen,
    searchQuery,
    setSearchQuery,
  } = useUIStore();

  const { theme, setTheme } = useThemeStore();
  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  const { notifications, fetchNotifications, markAllRead, markOneRead } =
    useNotificationStore();
  const unreadCount = notifications.filter((n) => !n.read).length;

  // Load the notification history once the user is known; the socket keeps it
  // live from there on.
  useEffect(() => {
    if (user) fetchNotifications();
  }, [user, fetchNotifications]);

  const handleLogout = () => {
    logout();
    toast.success("Successfully logged out.");
  };

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setProfileDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <header className="h-16 bg-white/80 backdrop-blur-md border-b border-primary-100 px-6 flex items-center justify-between sticky top-0 z-20">
      <div className="flex items-center gap-4">
        {!sidebarOpen && (
          <button
            onClick={toggleSidebar}
            className="p-1 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors focus:outline-none"
          >
            <Menu size={20} />
          </button>
        )}

        <div 
          className="relative w-72 max-w-xs hidden md:block cursor-pointer group"
          onClick={useUIStore.getState().toggleCommandPalette}
        >
          <div className="w-full pl-9 pr-4 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between text-slate-400 group-hover:bg-white group-hover:border-primary-300 transition-all">
            <span>Jump to a page...</span>
            <kbd className="font-mono text-[9px] font-bold border border-slate-200 px-1 rounded bg-white">Ctrl+K</kbd>
          </div>

          <div className="absolute left-3 top-2 text-slate-400">
            <Search size={14} />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={() => setTheme(isDark ? "light" : "dark")}
          className="p-2 rounded-lg text-slate-500 hover:text-primary-700 hover:bg-primary-50 transition-colors focus:outline-none"
          title={isDark ? "Switch to light mode" : "Switch to dark mode"}
          aria-label="Toggle dark mode"
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        <button
          onClick={() => setNotificationsOpen(true)}
          className="p-2 rounded-lg text-slate-500 hover:text-primary-700 hover:bg-primary-50 transition-colors relative focus:outline-none"
          title="System Alerts"
        >
          <Bell size={18} />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-400 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white shadow-sm">
              {unreadCount}
            </span>
          )}
        </button>

        <div className="w-px h-6 bg-slate-200" />

        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setProfileDropdownOpen(!profileDropdownOpen)}
            className="flex items-center gap-2.5 p-1 rounded-lg hover:bg-slate-50 transition-colors focus:outline-none"
          >
            {user?.avatar ? (
              <img
                src={user.avatar}
                alt={user?.user || user?.name}
                className="w-8 h-8 rounded-full object-cover border border-slate-200 shadow-sm animate-fade-in"
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-linear-to-br from-primary-600 to-primary-800 text-white flex items-center justify-center font-bold text-xs shadow-sm shadow-primary-900/30">
                {(user?.user || user?.name || "US").slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="text-left hidden lg:block select-none">
              <p className="text-sm font-bold text-slate-900 leading-none mb-1">
                {user?.user || user?.name || "Loading partner..."}
              </p>
              <p className="text-[11px] text-slate-500 font-medium uppercase tracking-wider leading-none">
                {user?.company || "System Account"}
              </p>
            </div>
          </button>

          {profileDropdownOpen && (
            <div className="absolute right-0 mt-2.5 w-52 bg-white border border-slate-200 rounded-lg shadow-enterprise-lg py-1 z-30">
              <div className="px-4 py-2 border-b border-slate-100 lg:hidden">
                <p className="text-xs font-bold text-slate-800 leading-tight">
                  {user?.user || user?.name}
                </p>
                <p className="text-[10px] text-slate-400 font-semibold">
                  {user?.company}
                </p>
              </div>
              <button
                className="w-full flex items-center gap-2.5 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors text-left"
                onClick={() => {
                  setProfileDropdownOpen(false);
                  navigate("/settings");
                }}
              >
                <UserIcon size={14} className="text-slate-400" />
                My Profile
              </button>
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-2.5 px-4 py-2 text-xs font-semibold text-error-500 hover:bg-error-50/50 transition-colors text-left"
              >
                <LogOut size={14} className="text-error-500" />
                Logout
              </button>
            </div>
          )}
        </div>
      </div>

      <Drawer
        isOpen={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        title="Alerts & Messages"
      >
        <div className="flex flex-col gap-4">
          {notifications.length === 0 ? (
            <div className="py-12 text-center text-xs font-semibold text-slate-400">
              You're all caught up — no notifications yet.
            </div>
          ) : (
            notifications.map((n) => (
              <button
                key={n._id}
                onClick={() => markOneRead(n._id)}
                className={`w-full text-left p-3 rounded-lg border flex flex-col gap-1 transition-all ${
                  n.read
                    ? "bg-white border-slate-100 text-slate-500 animate-fade-in"
                    : "bg-primary-50/20 border-primary-100 text-slate-800 animate-fade-in"
                }`}
              >
                <div className="flex justify-between items-start gap-2">
                  <span
                    className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                      n.read ? "bg-slate-300" : "bg-primary-600"
                    }`}
                  />
                  <div className="flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-bold leading-relaxed">{n.title}</p>
                      {user?.role === "Admin" && typeof n.user === "object" && n.user && (
                        <span className="text-[9px] bg-primary-600 text-white px-1.5 py-0.5 rounded font-bold uppercase shrink-0 max-w-[120px] truncate">
                          {n.user.user || n.user.name || "System"}
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-medium leading-relaxed text-slate-500">
                      {n.message}
                    </p>
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 font-bold self-end mt-1">
                  {timeAgo(n.createdAt)}
                </span>
              </button>
            ))
          )}
          {notifications.some((n) => !n.read) && (
            <button
              onClick={() => markAllRead()}
              className="w-full py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-xs font-bold text-slate-600 transition-colors mt-2"
            >
              Mark All as Read
            </button>
          )}
        </div>
      </Drawer>
    </header>
  );
};
export default Navbar;
