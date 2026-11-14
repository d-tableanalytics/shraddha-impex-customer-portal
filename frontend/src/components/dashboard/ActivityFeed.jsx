import { useNavigate } from 'react-router-dom';
import { Card } from '../ui/Card';
import { SkeletonLoader } from '../ui/SkeletonLoader';
import { Package, CheckCircle, Clock, AlertTriangle, Truck, History, Inbox, ArrowRight } from 'lucide-react';
import { useDashboardStats } from '../../store/homeDashboardStore';
import { WidgetHeader } from './WidgetHeader';
import { accentStyle } from './dashboardPalette';

// Each status gets an icon AND its name on screen — the colour is never the
// only cue. Hues match the status colours used across the booking screens.
const STATUS_STYLE = {
  'PO Received':        { icon: Clock,         accent: 'warning' },
  'Ready for Dispatch': { icon: Package,       accent: 'indigo' },
  Dispatched:           { icon: Truck,         accent: 'teal' },
  Delivered:            { icon: CheckCircle,   accent: 'emerald' },
  // Legacy
  Booked:               { icon: Clock,         accent: 'warning' },
  Cancelled:            { icon: AlertTriangle, accent: 'error' },
};
const UNKNOWN_STATUS = { icon: Package, accent: 'slate' };

const timeAgo = (dateStr) => {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 1)    return 'just now';
  if (mins < 60)   return `${mins}m ago`;
  if (hours < 24)  return `${hours}h ago`;
  return `${days}d ago`;
};

export const ActivityFeed = () => {
  const navigate = useNavigate();
  // Shared with the other dashboard widgets: one request between them.
  const { stats, loading } = useDashboardStats();
  const activities = stats?.recentOrders || [];

  return (
    // From xl up the card is lifted out of the grid's sizing and fills the cell,
    // so the chart beside it sets the row height and this list scrolls inside.
    <Card className="flex h-full max-h-[460px] flex-col rounded-2xl border-slate-200/80 xl:absolute xl:inset-0 xl:max-h-none">
      <div className="shrink-0 border-b border-slate-100 px-5 pb-4 pt-5 sm:px-6 sm:pt-6">
        <WidgetHeader
          icon={History}
          accent="primary"
          title="Recent Bookings"
          subtitle="Latest booking activity"
          actions={
            <button
              type="button"
              onClick={() => navigate('/orders/history')}
              className="group inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-primary-600 transition-colors hover:bg-primary-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40"
            >
              View all
              <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </button>
          }
        />
      </div>

      {loading ? (
        <div className="flex flex-1 flex-col gap-5 px-5 py-5 sm:px-6" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex gap-3">
              <SkeletonLoader variant="circular" className="h-8 w-8 shrink-0" />
              <div className="flex flex-1 flex-col gap-2">
                <SkeletonLoader variant="text" className="h-3.5 w-1/2" />
                <SkeletonLoader variant="text" className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      ) : activities.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
            <Inbox size={22} aria-hidden="true" />
          </span>
          <p className="text-sm font-medium text-slate-400">No bookings yet</p>
        </div>
      ) : (
        <ul className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-2.5 py-2 sm:px-3.5">
          {activities.map((order, idx) => {
            const { icon: Icon, accent } = STATUS_STYLE[order.status] ?? UNKNOWN_STATUS;
            const trueDate = order.orderTimestamp || order.date || order.createdAt;
            return (
              <li
                key={order._id || idx}
                style={accentStyle(accent)}
                className="dash-accent relative flex gap-3 rounded-xl px-2.5 py-3 transition-colors hover:bg-slate-50"
              >
                {/* Timeline connector to the next entry. */}
                {idx !== activities.length - 1 && (
                  <span aria-hidden="true" className="absolute -bottom-2 left-[25.5px] top-12 w-px bg-slate-200" />
                )}
                <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--dash-accent)/10 text-(--dash-accent) ring-1 ring-inset ring-(--dash-accent)/20">
                  <Icon size={14} />
                </span>

                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate text-sm font-bold text-slate-800">
                      {order.orderId || order._id}
                    </span>
                    <span className="shrink-0 pt-0.5 text-[11px] font-medium text-slate-400">{timeAgo(trueDate)}</span>
                  </div>

                  <span className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-full bg-(--dash-accent)/10 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-(--dash-accent)" aria-hidden="true" />
                    {order.status}
                  </span>

                  <p className="mt-1.5 truncate text-xs text-slate-500">
                    SKU: <span className="font-semibold text-slate-700">{order.skuCode}</span>
                    {order.brand ? ` · ${order.brand}` : ''}
                    {order.requestedQty ? ` · Qty: ${order.requestedQty}` : ''}
                  </p>
                  {order.company && (
                    <p className="truncate text-xs text-slate-400">{order.company}</p>
                  )}
                  <span className="mt-0.5 text-[11px] font-medium text-slate-400">
                    {new Date(trueDate).toLocaleString('en-US', {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                    })}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
};
