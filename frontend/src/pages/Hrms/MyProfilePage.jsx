import { Navigate } from "react-router-dom";
import { UserX } from "lucide-react";

import { HrmsPageLayout } from "../../components/hrms/HrmsPageLayout";
import { EmptyState } from "../../components/ui/EmptyState";
import { useHrmsPermissions } from "../../hooks/useHrmsPermissions";
import { useHrmsStore } from "../../store/hrmsStore";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";

/**
 * /hrms/me — "My Profile".
 *
 * A thin redirect to the actor's own employee profile, matching the reference's
 * `MyProfilePage`, which is itself four lines: read `me.employee`, redirect to
 * `/employees/:id`, and render an empty state when there is no employee record.
 *
 * Keeping it a redirect rather than a second profile screen is the whole point.
 * A separate "my profile" page would be a duplicate of the employee profile
 * that has to be kept in step with it, and would need its own answer to what a
 * person may see about themselves — which the employee profile and its server
 * checks already decide, in one place.
 *
 * ---------------------------------------------------------------------------
 * No employee record is a normal state, not an error
 * ---------------------------------------------------------------------------
 * An HRMS role and an employee record are separate things (AD-3, AD-4). An IT
 * or payroll administrator can hold `hrms_super_admin` with nobody's `userId`
 * pointing at them, and the very first HRMS account necessarily has no employee
 * record, because it is the account that creates the first employee. Telling
 * that person plainly what is missing beats a 404 or an empty page.
 */
export function MyProfilePage() {
  const { actor, loading } = useHrmsPermissions();
  const error = useHrmsStore((s) => s.error);
  const reload = useHrmsStore((s) => s.load);

  // The redirect happens before anything renders, so the profile page owns the
  // loading, error and permission handling from here on.
  if (!loading && !error && actor?.employeeId) {
    return <Navigate to={`${HRMS_ROUTE_PREFIX}/employees/${actor.employeeId}`} replace />;
  }

  return (
    <HrmsPageLayout
      title="My Profile"
      breadcrumbs={[{ label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` }, { label: "My Profile" }]}
      loading={loading}
      error={error ? { message: error } : null}
      onRetry={() => reload({ force: true })}
    >
      <EmptyState
        icon={<UserX className="w-10 h-10 text-slate-400 stroke-[1.5]" />}
        title="No employee record linked to this account"
        description="Your sign-in has HRMS access, but it is not linked to an employee record yet, so there is no profile to show. Ask HR to add you to the employee directory, or link this login to your existing record."
      />
    </HrmsPageLayout>
  );
}

export default MyProfilePage;
