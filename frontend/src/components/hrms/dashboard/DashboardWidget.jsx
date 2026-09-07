import { twMerge } from "tailwind-merge";

import { Card } from "../../ui/Card";
import { LoadingSpinner } from "../../ui/LoadingSpinner";
import { EmptyState } from "../../ui/EmptyState";
import { ErrorState } from "../ErrorState";

/**
 * The card every dashboard widget renders inside.
 *
 * Handles the four states each widget would otherwise handle for itself —
 * loading, error, empty, content — so they are consistent across the dashboard
 * and a widget author only writes the content.
 *
 * The empty state is deliberate: a widget with no data must SAY so. A zero
 * where a number should be reads as a real figure, and on an HR dashboard that
 * is the difference between "nobody is on leave today" and "we have not built
 * this yet".
 */
export function DashboardWidget({
  title,
  description,
  action,
  loading = false,
  error = null,
  onRetry,
  isEmpty = false,
  emptyTitle,
  emptyDescription,
  className,
  bodyClassName,
  children,
}) {
  return (
    <Card className={twMerge("flex flex-col", className)}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-slate-100">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-900 truncate">{title}</h3>
            {description && (
              <p className="text-xs text-slate-500 mt-0.5 truncate">{description}</p>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}

      <div className={twMerge("flex-1 p-5", bodyClassName)}>
        {loading ? (
          <div className="flex items-center justify-center min-h-[120px]">
            <LoadingSpinner size={22} />
          </div>
        ) : error ? (
          <ErrorState
            variant={
              error.isForbidden ? "forbidden" : error.isNotImplemented ? "unavailable" : "error"
            }
            description={error.message}
            onRetry={onRetry}
            className="border-0 p-4"
          />
        ) : isEmpty ? (
          <EmptyState
            title={emptyTitle ?? "Nothing to show"}
            description={emptyDescription ?? "There is no activity to report right now."}
            className="border-0 p-4"
          />
        ) : (
          children
        )}
      </div>
    </Card>
  );
}

export default DashboardWidget;
