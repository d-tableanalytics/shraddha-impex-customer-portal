import { twMerge } from "tailwind-merge";

import { PageHeader } from "../common/PageHeader";
import { Breadcrumb } from "./Breadcrumb";
import { TabNav } from "./TabNav";
import { ErrorState } from "./ErrorState";
import { LoadingSpinner } from "../ui/LoadingSpinner";

/**
 * The container every HRMS page sits in.
 *
 * ---------------------------------------------------------------------------
 * A page container, NOT a second application shell
 * ---------------------------------------------------------------------------
 * The chrome - sidebar, top bar, notifications - is the portal's existing
 * MainLayout, and HRMS renders inside it. Forking that would give the product
 * two shells with two sidebars and two ideas of who is signed in, which is
 * exactly what "HRMS must become a native part of the portal" rules out.
 *
 * What this adds is the per-page structure the reference gives its pages:
 * breadcrumb, title with a secondary description line, right-aligned actions,
 * an optional tab strip, then the content.
 *
 * Loading and error are handled here rather than in each page because every
 * page needs them and each would otherwise invent its own.
 */
export function HrmsPageLayout({
  title,
  subtitle,
  breadcrumbs = [],
  actions,
  tabs,
  activeTab,
  onTabChange,
  loading = false,
  error = null,
  onRetry,
  children,
  className,
}) {
  return (
    <div className={twMerge("flex flex-col", className)}>
      <Breadcrumb items={breadcrumbs} />

      <PageHeader title={title} subtitle={subtitle} actions={actions} />

      {tabs?.length > 0 && (
        <TabNav tabs={tabs} activeKey={activeTab} onChange={onTabChange} className="mt-4" />
      )}

      <div className="mt-6">
        {loading ? (
          <div className="flex items-center justify-center min-h-[40vh]">
            <LoadingSpinner size={32} />
          </div>
        ) : error ? (
          <ErrorState
            variant={
              error.isForbidden ? "forbidden" : error.isNotImplemented ? "unavailable" : "error"
            }
            description={error.message}
            onRetry={onRetry}
          />
        ) : (
          children
        )}
      </div>
    </div>
  );
}

export default HrmsPageLayout;
