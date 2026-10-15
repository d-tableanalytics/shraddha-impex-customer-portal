import { Card, CardContent } from '../ui/Card';
import { Package, CheckCircle, Clock, AlertTriangle, Truck, Loader2 } from 'lucide-react';
import { useDashboardStats } from '../../store/homeDashboardStore';

const STATUS_ICON = {
  'PO Received':        <Clock    size={14} className="text-warning-500" />,
  'Ready for Dispatch': <Package  size={14} className="text-indigo-500" />,
  Dispatched:           <Truck    size={14} className="text-teal-500" />,
  Delivered:            <CheckCircle size={14} className="text-emerald-500" />,
  // Legacy
  Booked:               <Clock    size={14} className="text-warning-500" />,
  Cancelled:            <AlertTriangle size={14} className="text-error-500" />,
};

const STATUS_DOT = {
  'PO Received':        'bg-warning-400',
  'Ready for Dispatch': 'bg-indigo-400',
  Dispatched:           'bg-teal-400',
  Delivered:            'bg-emerald-400',
  Booked:               'bg-warning-400',
  Cancelled:            'bg-error-400',
};

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
  // Shared with the other dashboard widgets: one request between them.
  const { stats, loading } = useDashboardStats();
  const activities = stats?.recentOrders || [];

  return (
    <Card className="h-full max-h-[440px] flex flex-col">
      <CardContent className="p-6 flex flex-col min-h-0 flex-1">
        <div className="flex items-center justify-between mb-5 border-b border-slate-100 pb-4 shrink-0">
          <div>
            <h3 className="font-bold text-slate-800">Recent Bookings</h3>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center flex-1 text-slate-300">
            <Loader2 className="animate-spin" size={24} />
          </div>
        ) : activities.length === 0 ? (
          <div className="flex items-center justify-center flex-1 text-slate-400 text-sm">
            No bookings yet
          </div>
        ) : (
          <div className="flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto pr-2 -mr-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-slate-200 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-slate-300 [scrollbar-width:thin] [scrollbar-color:#e2e8f0_transparent]">
            {activities.map((order, idx) => (
              <div key={order._id || idx} className="flex gap-3 relative">
                {idx !== activities.length - 1 && (
                  <div className="absolute left-[15px] top-9 w-px h-full bg-slate-100 -z-10" />
                )}
                <div className="w-8 h-8 rounded-full flex flex-shrink-0 items-center justify-center bg-slate-50 border border-slate-200 mt-0.5">
                  {STATUS_ICON[order.status] ?? <Package size={14} className="text-slate-400" />}
                </div>
                <div className="flex flex-col min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-800 truncate">
                      {order.orderId || order._id}
                    </span>
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[order.status] || 'bg-slate-300'}`} />
                    <span className="text-xs text-slate-400 flex-shrink-0">{order.status}</span>
                  </div>
                  <p className="text-xs text-slate-500 truncate">
                    SKU: <span className="font-semibold text-slate-700">{order.skuCode}</span>
                    {order.brand ? ` · ${order.brand}` : ''}
                    {order.requestedQty ? ` · Qty: ${order.requestedQty}` : ''}
                  </p>
                  {order.company && (
                    <p className="text-xs text-slate-400 truncate">{order.company}</p>
                  )}
                  <span className="text-[11px] text-slate-400 font-medium mt-0.5">
                    {(() => {
                      const trueDate = order.orderTimestamp || order.date || order.createdAt;
                      return (
                        <>
                          {new Date(trueDate).toLocaleString('en-US', {
                            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                          })} • {timeAgo(trueDate)}
                        </>
                      );
                    })()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
