/**
 * HRMS UI primitives.
 *
 * Only what the portal did not already provide. Modal, Drawer, Card, Button,
 * Input, Badge, DateField, EmptyState, LoadingSpinner, SkeletonLoader,
 * TableSkeleton, ConfirmationDialog and Pagination are reused from
 * `components/ui` unchanged - duplicating them would give HRMS a second visual
 * language inside the same application.
 */

export { HrmsPageLayout } from "./HrmsPageLayout";
export { Breadcrumb } from "./Breadcrumb";
export { TabNav } from "./TabNav";
export { HrmsDataTable } from "./HrmsDataTable";
export { FilterBar } from "./FilterBar";
export { SearchableSelect } from "./SearchableSelect";
export { ErrorState } from "./ErrorState";
export { PermissionGate } from "./PermissionGate";
export { HrmsStatusBadge } from "./HrmsStatusBadge";
export {
  HRMS_NAV_ITEMS,
  HRMS_NAV_GROUPS,
  HRMS_NAV_GROUP_LABELS,
  HRMS_NAV_GROUP_ORDER,
  visibleHrmsNavItems,
  groupHrmsNavItems,
  hrmsSidebarGroup,
  HRMS_SIDEBAR_GROUP_KEY,
  HRMS_SIDEBAR_GROUP_LABEL,
  plannedHrmsNavItems,
} from "./navItems";
