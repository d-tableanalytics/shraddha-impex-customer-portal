import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Card, CardContent } from '../ui/Card';
import { Package, Clock, AlertTriangle, Users, PackageX, Layers, Loader2 } from 'lucide-react';
import { api } from '../../services/api';
import { useUserStore } from '../../store/userStore';
import { canUseOrdering } from '../../utils/permissions';

export const KPIStats = () => {
  const navigate = useNavigate();
  const { user } = useUserStore();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  // Booking and indent tiles link into the ordering screens, which a role with
  // no ordering permission cannot open. Showing them would offer a tile that
  // bounces straight back here.
  const worksOrders = canUseOrdering(user);

  useEffect(() => {
    api.get('/dashboard/stats')
      .then(r => setStats(r.data.data))
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    const skeletonCount = user?.role === 'Admin' ? 5 : 3;
    const gridCols = user?.role === 'Admin' ? 'xl:grid-cols-5' : 'xl:grid-cols-3';
    return (
      <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 ${gridCols} gap-4`}>
        {Array.from({ length: skeletonCount }).map((_, i) => (
          <Card key={i} className="animate-pulse">
            <CardContent className="p-4 h-24 flex items-center justify-center">
              <Loader2 className="animate-spin text-slate-300" size={24} />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

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
    ...(user?.role === 'Admin' ? [{
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
    ...(user?.role === 'Admin' ? [{
      id: 6, title: 'Active Users',
      value: stats?.activeUsers?.toLocaleString() ?? '—',
      sub: 'Registered customers',
      icon: Users, color: 'emerald',
      path: '/admin/users',
    }] : []),
  ];

  const colorMap = {
    primary: { bg: 'bg-primary-50', text: 'text-primary-600', border: 'border-primary-200', glow: 'hover:shadow-primary-500/20', hoverBorder: 'hover:border-primary-300' },
    warning:  { bg: 'bg-warning-50', text: 'text-warning-600', border: 'border-warning-200', glow: 'hover:shadow-warning-500/20', hoverBorder: 'hover:border-warning-300' },
    indigo:   { bg: 'bg-indigo-50', text: 'text-indigo-600', border: 'border-indigo-200', glow: 'hover:shadow-indigo-500/20', hoverBorder: 'hover:border-indigo-300' },
    success:  { bg: 'bg-success-50', text: 'text-success-600', border: 'border-success-200', glow: 'hover:shadow-success-500/20', hoverBorder: 'hover:border-success-300' },
    error:    { bg: 'bg-error-50', text: 'text-error-600', border: 'border-error-200', glow: 'hover:shadow-error-500/20', hoverBorder: 'hover:border-error-300' },
    emerald:  { bg: 'bg-emerald-50', text: 'text-emerald-600', border: 'border-emerald-200', glow: 'hover:shadow-emerald-500/20', hoverBorder: 'hover:border-emerald-300' },
    amber:    { bg: 'bg-amber-50', text: 'text-amber-600', border: 'border-amber-200', glow: 'hover:shadow-amber-500/20', hoverBorder: 'hover:border-amber-300' },
  };

  const colClassByCount = {
    // 1 and 2 exist for the roles that see only the stock tiles; without them a
    // single tile stretched the full width of the page.
    1: 'xl:grid-cols-1', 2: 'xl:grid-cols-2',
    3: 'xl:grid-cols-3', 4: 'xl:grid-cols-4', 5: 'xl:grid-cols-5', 6: 'xl:grid-cols-6', 7: 'xl:grid-cols-7'
  };
  const gridCols = colClassByCount[tiles.length] || 'xl:grid-cols-6';

  return (
    <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 ${gridCols} gap-5`}>
      {tiles.map((stat, idx) => {
        const Icon = stat.icon;
        const colors = colorMap[stat.color];
        
        return (
          <motion.div
            key={stat.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.07, type: "spring", stiffness: 300, damping: 24 }}
            className="h-full"
          >
            <button
              type="button"
              onClick={() => navigate(stat.path)}
              className={`relative h-full w-full text-left group hover:shadow-xl ${colors.glow} hover:-translate-y-1 transition-all duration-300 border border-slate-200 ${colors.hoverBorder} bg-white rounded-2xl`}
            >
              {/* Background Glow */}
              <div className={`absolute top-0 right-0 w-32 h-32 bg-linear-to-bl from-white to-transparent opacity-50 rounded-bl-full z-0`} />
              
              {/* Watermark Icon */}
              <div className={`absolute -right-4 -bottom-4 opacity-[0.03] group-hover:opacity-10 transition-all duration-500 transform group-hover:scale-110 group-hover:-rotate-12 ${colors.text} z-0 pointer-events-none`}>
                <Icon size={120} strokeWidth={1.5} />
              </div>

              <CardContent className="p-5 relative z-10 flex flex-col h-full gap-4 justify-between">
                <div className="flex justify-between items-start">
                  <div className={`p-2.5 rounded-xl border shadow-sm ${colors.bg} ${colors.text} ${colors.border} group-hover:scale-110 transition-transform duration-300`}>
                    <Icon size={20} strokeWidth={2.5} />
                  </div>
                </div>
                <div>
                  <h3 className="text-3xl font-bold text-slate-800 tracking-tight group-hover:text-slate-900 transition-colors">{stat.value}</h3>
                  <p className="text-[10px] font-bold text-slate-500 uppercase mt-1 tracking-widest">{stat.title}</p>
                  <p className="kpi-tile-sub text-[11px] font-medium text-slate-400 mt-1 line-clamp-1 group-hover:text-slate-500 transition-colors">{stat.sub}</p>
                </div>
              </CardContent>
            </button>
          </motion.div>
        );
      })}
    </div>
  );
};
