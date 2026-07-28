import { useIndentHistoryStore } from "../../store/indentHistoryStore";
import { Card, CardContent } from "../ui/Card";
import { PackageX, Boxes } from "lucide-react";

// Mirrors MetricsCard on Booking History. Only the two headline figures are
// shown; the store still computes the rest if they are ever wanted back.
export const IndentMetricsCard = () => {
  const { metrics } = useIndentHistoryStore();

  const items = [
    {
      label: "Total Indents",
      value: metrics.total,
      icon: <PackageX size={20} className="text-amber-600" />,
      bg: "bg-amber-50",
    },
    {
      label: "Total Qty",
      value: metrics.totalQty,
      icon: <Boxes size={20} className="text-indigo-600" />,
      bg: "bg-indigo-50",
    },
  ];

  return (
    // Two tiles only — capped width so they keep the same proportions as the
    // six-across row on Booking History instead of stretching over the page.
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg">
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
