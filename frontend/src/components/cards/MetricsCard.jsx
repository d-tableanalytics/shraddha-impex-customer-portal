import { useOrderHistoryStore } from "../../store/orderHistoryStore";
import { stageLabel } from "../../constants/bookingLifecycle";
import { Card, CardContent } from "../ui/Card";
import {
  FileText,
  Inbox,
  CheckCircle,
  Package,
  Truck,
  Ban,
} from "lucide-react";

export const MetricsCard = () => {
  const { metrics } = useOrderHistoryStore();

  const items = [
    {
      label: "Total Bookings",
      value: metrics.total,
      icon: <FileText size={20} className="text-primary-600" />,
      bg: "bg-primary-50",
    },
    {
      // The lifecycle's first stage, named the way the customer sees it.
      label: stageLabel("PO Received"),
      value: metrics.poReceived,
      icon: <Inbox size={20} className="text-warning-600" />,
      bg: "bg-warning-50",
    },
    {
      label: "Ready for Dispatch",
      value: metrics.ready,
      icon: <Package size={20} className="text-indigo-600" />,
      bg: "bg-indigo-50",
    },
    {
      label: "Dispatched",
      value: metrics.dispatched,
      icon: <Truck size={20} className="text-teal-600" />,
      bg: "bg-teal-50",
    },
    {
      label: "Delivered",
      value: metrics.completed,
      icon: <CheckCircle size={20} className="text-success-600" />,
      bg: "bg-success-50",
    },
    {
      label: "Cancelled",
      value: metrics.cancelled,
      icon: <Ban size={20} className="text-slate-500" />,
      bg: "bg-slate-100",
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
      {items.map((item, idx) => (
        <Card key={idx} className="border-slate-200 shadow-sm overflow-hidden">
          <CardContent className="p-3 flex items-center gap-3">
            <div
              className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${item.bg}`}
            >
              {item.icon}
            </div>
            <div className="min-w-0">
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider truncate">
                {item.label}
              </p>
              <h3 className="text-xl font-bold text-slate-800">
                {item.value.toLocaleString()}
              </h3>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};
