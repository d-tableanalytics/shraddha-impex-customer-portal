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

/**
 * A breadcrumb is shown only once it says something the page does not.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A THRESHOLD AT ALL
 * ---------------------------------------------------------------------------
 * No other module in the portal has a breadcrumb. On a TOP-LEVEL HRMS page the
 * trail reads "HRMS > Assets" directly above a title that reads "Assets",
 * beside a sidebar already highlighting Assets - three statements of the same
 * fact, and the one visible thing that made HRMS pages not look like Sales,
 * Inventory or Reports pages.
 *
 * On a nested page it is doing real work: "HRMS > Employees > Priya Sharma >
 * Edit" is the only way back up, and the portal has no equivalent screen to be
 * inconsistent with.
 *
 * So the trail earns its place by DEPTH rather than being all-or-nothing. That
 * keeps the reasoning recorded on Breadcrumb.jsx - HRMS is a section inside a
 * larger portal, so a user needs to see where they are - exactly where that
 * reasoning still applies, and drops it where it had become decoration.
 *
 * Two crumbs is the redundant case: every one of them is
 * `[{ HRMS }, { <this module> }]`. Pages pass their trail unconditionally and
 * need no edit; deepening a page's trail turns its breadcrumb on by itself.
 */
const MIN_MEANINGFUL_CRUMBS = 3;
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
      {breadcrumbs.length >= MIN_MEANINGFUL_CRUMBS && <Breadcrumb items={breadcrumbs} />}

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
