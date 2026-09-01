import { useMemo } from "react";

import {
  hasHrmsPermission,
  canAccessHrmsModule,
  hasAnyHrmsAccess,
  ANONYMOUS_HRMS_ACTOR,
} from "@shared/permissions/has-permission.js";
import { useHrmsStore } from "../store/hrmsStore";

/**
 * HRMS authorization for the UI.
 *
 * Uses the SAME evaluator the server guard uses - imported from @shared, not
 * reimplemented here. That is the point of the shared module: the backend and
 * the frontend cannot disagree about what a permission means, which is exactly
 * what the old hand-mirrored permissions files could not guarantee.
 *
 * This governs what the UI OFFERS. Every HRMS endpoint re-checks server-side,
 * so hiding a button is a convenience, never a control.
 *
 *   const { can, seesModule, hasAccess } = useHrmsPermissions();
 *   if (can('leave', 'approve', 'team')) { ... }
 */
export function useHrmsPermissions() {
  const actor = useHrmsStore((s) => s.actor);
  const loading = useHrmsStore((s) => s.loading);

  // The anonymous actor holds nothing, so every check is false while loading
  // or for an account with no HRMS role. Failing closed is the right default
  // for a shell that customers and employees share (AD-14).
  const resolved = useMemo(() => actor ?? ANONYMOUS_HRMS_ACTOR, [actor]);

  return useMemo(
    () => ({
      actor: resolved,
      loading,
      hasAccess: hasAnyHrmsAccess(resolved),
      can: (module, action, scope, resource) =>
        hasHrmsPermission(resolved, module, action, scope, resource),
      seesModule: (module) => canAccessHrmsModule(resolved, module),
      roleKeys: resolved.roleKeys ?? [],
    }),
    [resolved, loading],
  );
}

export default useHrmsPermissions;
