import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Package, Clock, AlertTriangle, Users, PackageX, Layers, ArrowUpRight } from 'lucide-react';
import { useDashboardStats } from '../../store/homeDashboardStore';
import { useUserStore } from '../../store/userStore';
import { canUseOrdering } from '../../utils/permissions';
import { canCell } from '../../utils/cellKeys';
import { SkeletonLoader } from '../ui/SkeletonLoader';
import { accentStyle } from './dashboardPalette';

/**
 * Columns per tile count. The count depends on the role (1 stock tile, up to 6
 * for an admin who works orders), so each count gets a layout that keeps tiles
 * a readable width: a lone tile never stretches across the page, and six sit
 * three-by-two until the screen is wide enough for one row.
 */
const GRID_BY_COUNT = {
  1: 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-3',
  4: 'grid-cols-2 xl:grid-cols-4',
  5: 'grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5',
  6: 'grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6',
  7: 'grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7',
};

const TILE_SHELL =
  'relative flex h-full w-full flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-4 shadow-enterprise sm:p-5';

export const KPIStats = () => {
  const navigate = useNavigate();
  const { user } = useUserStore();
  // Shared with the other dashboard widgets: one request between them.
  const { stats, loading } = useDashboardStats();
  // Booking and indent tiles link into the ordering screens, which a role with
  // no ordering permission cannot open. Showing them would offer a tile that
  // bounces straight back here.
  const worksOrders = canUseOrdering(user);

  const tiles = [
    {
      id: 1, title: 'Total Products',
      value: stats?.totalProducts?.toLocaleString() ?? '—',
      sub: 'Across all brands',
      icon: Package, color: 'primary',
      path: '/inventory',
    },
    ...(worksOrders ? [{
      id: 2, title: 'In Process',
      value: stats?.bookedOrders?.toLocaleString() ?? '—',
      sub: `${stats?.totalOrders ?? 0} total bookings`,
      icon: Clock, color: 'warning',
      path: '/orders/history',
    }] : []),
    // Tiles follow the matrix cell of the screen they summarise, not the
    // Super Admin role name.
    ...(canCell(user, 'inventory', 'dashboard', 'view') ? [{
      id: 5, title: 'Low Stock SKUs',
      value: stats?.lowStockAlerts?.toLocaleString() ?? '—',
      sub: 'Available for sale ≤ 0',
      icon: AlertTriangle, color: 'error',
      path: '/inventory',
    }] : []),
    /**
     * Indents get two tiles, not one line of small print.
     *
     * "How much is waiting" and "how many indents are waiting" are different
     * questions and are acted on by different people — one drives what to
     * order, the other how many customers are waiting on something. Folding the
     * quantity into the subtitle of a count tile made the number nobody could
     * read at a glance the one everybody wanted.
     *
     * The COUNT is grouped indents, matching what Indent History shows. It used
     * to be the raw line count, which made a five-SKU indent read as five.
     */
    ...(worksOrders ? [
      {
        id: 7, title: 'Total Indent Count',
        value: stats?.totalIndentCount?.toLocaleString() ?? '—',
        sub: `${(stats?.totalIndentLines ?? 0).toLocaleString()} line(s) awaiting stock`,
        icon: PackageX, color: 'amber',
        path: '/orders/indent-history',
      },
      {
        id: 8, title: 'Total Indent Quantity',
        value: stats?.totalIndentQty?.toLocaleString() ?? '—',
        sub: 'Units awaiting fresh stock',
        icon: Layers, color: 'indigo',
        path: '/orders/indent-history',
      },
    ] : []),
    ...(canCell(user, 'administration', 'users', 'view') ? [{
      id: 6, title: 'Active Users',
      value: stats?.activeUsers?.toLocaleString() ?? '—',
      sub: 'Registered customers',
      icon: Users, color: 'emerald',
      path: '/admin/users',
    }] : []),
  ];

  const gridCols = GRID_BY_COUNT[tiles.length] || GRID_BY_COUNT[6];

  // Placeholders in the exact shape and number of the tiles to come, so the
  // page does not jump when the figures land.
  if (loading) {
    return (
      <div className={`grid ${gridCols} gap-4`} aria-busy="true">
        {tiles.map((stat) => (
          <div key={stat.id} className={TILE_SHELL}>
            <SkeletonLoader variant="text" className="h-10 w-10 rounded-xl" />
            <SkeletonLoader variant="text" className="mt-4 h-3.5 w-2/3" />
            <SkeletonLoader variant="text" className="mt-2.5 h-7 w-1/2" />
            <SkeletonLoader variant="text" className="mt-2 h-3 w-3/4" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={`grid ${gridCols} gap-4`}>
      {tiles.map((stat, idx) => {
        const Icon = stat.icon;

        return (
          <motion.div
            key={stat.id}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.06, type: "spring", stiffness: 300, damping: 26 }}
            className="h-full"
          >
            <button
              type="button"
              onClick={() => navigate(stat.path)}
              style={accentStyle(stat.color)}
              className={`dash-accent group text-left transition-all duration-300 hover:-translate-y-0.5 hover:border-(--dash-accent)/40 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-(--dash-accent)/50 ${TILE_SHELL}`}
            >
              {/* Accent rule along the top edge, and a soft glow on hover. */}
              <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] bg-(--dash-accent) opacity-70 transition-opacity duration-300 group-hover:opacity-100" />
              <span aria-hidden="true" className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-(--dash-accent)/10 opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100" />

              <div className="relative flex items-start justify-between gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-(--dash-accent)/10 text-(--dash-accent) ring-1 ring-inset ring-(--dash-accent)/20 transition-transform duration-300 group-hover:scale-105">
                  <Icon size={20} strokeWidth={2.25} />
                </span>
                <ArrowUpRight
                  size={16}
                  aria-hidden="true"
                  className="text-slate-300 transition-all duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-(--dash-accent)"
                />
              </div>

              <p className="relative mt-4 text-[13px] font-semibold leading-snug text-slate-500">{stat.title}</p>
              <h3 className="relative mt-0.5 text-[26px] font-bold leading-tight tracking-tight text-slate-900 sm:text-3xl">{stat.value}</h3>
              <p className="kpi-tile-sub relative mt-1 line-clamp-2 text-xs sm:line-clamp-1 font-medium text-slate-400 transition-colors group-hover:text-slate-500">{stat.sub}</p>
            </button>
          </motion.div>
        );
      })}
    </div>
  );
};
