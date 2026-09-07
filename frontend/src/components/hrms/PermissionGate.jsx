import { useHrmsPermissions } from "../../hooks/useHrmsPermissions";

/**
 * Render children only when the actor holds the permission.
 *
 * The reference does `{canCreate && <Button/>}` inline in every page, which
 * spreads the same check across dozens of files and makes it easy for one of
 * them to test the wrong scope. This keeps the question declarative and
 * evaluated by the canonical helper.
 *
 * A convenience, never a control: every HRMS endpoint re-checks server-side.
 *
 *   <PermissionGate module="employees" action="create" scope="org">
 *     <Button>Add employee</Button>
 *   </PermissionGate>
 *
 * `anyOf` mirrors the guard's ANY-OF semantics, for the cases where several
 * different grants should reveal the same control.
 */
export const PermissionGate = ({
  module,
  action,
  scope,
  resource,
  anyOf,
  fallback = null,
  children,
}) => {
  const { can } = useHrmsPermissions();

  const specs = anyOf ?? (module ? [{ module, action, scope }] : []);
  if (specs.length === 0) {
    throw new Error("PermissionGate needs either module/action/scope or anyOf");
  }

  const allowed = specs.some((s) => can(s.module, s.action, s.scope, s.resource ?? resource));
  return allowed ? <>{children}</> : fallback;
};

export default PermissionGate;
