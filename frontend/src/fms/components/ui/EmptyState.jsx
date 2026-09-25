import React from "react";
import { Inbox } from "lucide-react";
import { twMerge } from "tailwind-merge";

export const EmptyState = ({
  title = "No Data Found",
  description = "There are no records matching your request or selection.",
  icon = <Inbox className="w-10 h-10 text-slate-400 stroke-[1.5]" />,
  className,
}) => {
  return (
    <div
      className={twMerge(
        "flex flex-col items-center justify-center p-10 text-center bg-white border border-dashed border-slate-200 rounded-xl",
        className,
      )}
    >
      <div className="flex items-center justify-center w-16 h-16 mb-4 bg-slate-50 rounded-full border border-slate-100 shadow-sm">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-slate-900 mb-1">{title}</h3>
      <p className="text-xs text-slate-500 max-w-xs leading-relaxed">
        {description}
      </p>
    </div>
  );
};
