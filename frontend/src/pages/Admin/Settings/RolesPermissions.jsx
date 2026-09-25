import { useEffect, useMemo, useRef, useState } from "react";
import {
  Save, Loader2, ShieldCheck, Plus, Trash2, Users, Store, X,
  Search, ChevronRight, ChevronDown, Folder, Copy, Pencil, Mail, MoreVertical, Lock,
} from "lucide-react";
import toast from "react-hot-toast";

import { useAdminStore } from "../../../store/adminStore";
import { useUserStore } from "../../../store/userStore";
import { Card, CardContent } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import { Input } from "../../../components/ui/Input";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { canAction, canManageRoles } from "../../../utils/permissions";
import { ACTION_LABELS } from "../../../utils/grants";
import {
  isFullAccessRole, initialDraft, servedIdsOf, draftToGrants, isDirty, cellState, toggle, setCell, fullDraft,
} from "../../../utils/roleMatrix";

/**
 * Roles & Permissions — the Customer Portal's modules only.
 *
 * Laid out exactly like the Employee Portal's screen (pages/Admin/Settings/
 * PermissionMatrix.jsx there): a role list on the left, and on the right the
 * selected role's header, a Permissions / Users tab pair, "Copy from role",
 * and ONE matrix table whose module rows expand to their sub-modules and carry
 * a bulk control per action. So an administrator who uses both portals meets
 * one screen, not two.
 *
 * What differs is underneath, and is deliberate:
 *
 *   • No "HRMS Roles" view — this portal serves no HRMS.
 *   • Only this portal's modules are shown, and only their cells are sent. The
 *     server keeps every Employee Portal cell (FMS, Work Queue, HRMS) as stored,
 *     whatever arrives (backend/utils/portalGrants.js).
 *   • The draft is the role's STORED grants, not baseline ∪ grants. The row is
 *     the whole answer on the server, so a box ticked here is exactly what the
 *     role can do — and an unticked box stays unticked.
 *   • Some boxes are LOCKED, with the reason on hover: a full-access role, a
 *     portal-only role outside the Customer Portal module, and the "derived"
 *     cells the server does not let this portal change. The Employee screen
 *     shows those as live boxes whose ticks the server then ignores; here the
 *     screen never offers a tick that would go nowhere.
 *
 * The per-box rules live in utils/roleMatrix.js.
 */

// ---------------------------------------------------------------------------
// Small pieces — the Employee Portal's, unchanged
// ---------------------------------------------------------------------------

const AVATAR_TONES = [
  "bg-rose-100 text-rose-700",
  "bg-primary-100 text-primary-700",
  "bg-emerald-100 text-emerald-700",
  "bg-amber-100 text-amber-700",
  "bg-violet-100 text-violet-700",
  "bg-sky-100 text-sky-700",
];

/** Two initials and a tint, both derived from the name. */
function RoleAvatar({ name = "", size = 36 }) {
  const text = String(name).trim();
  const words = text.split(/\s+/).filter(Boolean);
  const initials =
    (words.length > 1 ? words.slice(0, 2).map((w) => w[0]).join("") : (words[0] || "").slice(0, 2)).toUpperCase() || "?";
  const seed = [...text].reduce((n, c) => n + c.charCodeAt(0), 0);

  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      className={`shrink-0 inline-flex items-center justify-center rounded-xl font-bold ${AVATAR_TONES[seed % AVATAR_TONES.length]}`}
    >
      {initials}
    </span>
  );
}

/** What KIND of role this is — built-in, unrestricted, portal-only or custom. */
function RoleBadge({ role, className = "" }) {
  const [label, tone] = isFullAccessRole(role)
    ? ["Full access", "bg-amber-50 text-amber-700 border-amber-200"]
    : role.portalOnly
      ? ["Portal only", "bg-sky-50 text-sky-700 border-sky-200"]
      : role.isSystem
        ? ["Built-in", "bg-slate-100 text-slate-600 border-slate-200"]
        : ["Custom", "bg-success-50 text-success-600 border-success-200"];

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wide ${tone} ${className}`}>
      {label}
    </span>
  );
}

/** A checkbox with a third, "some", state — written through a ref. */
function TriCheckbox({ state, onChange, title, className = "", disabled = false }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === "all"}
      onChange={onChange}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`w-4 h-4 text-primary-600 rounded border-slate-300 focus:ring-primary-500 cursor-pointer disabled:cursor-default ${className}`}
    />
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export const RolesPermissions = () => {
  const { roles, registry, users, loading, error, fetchRoleMatrix, fetchUsers, updateRole, createRole, deleteRole } = useAdminStore();
  const user = useUserStore((s) => s.user);
  const fetchUser = useUserStore((s) => s.fetchUser);

  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(new Map());
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);

  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("permissions");
  const [expanded, setExpanded] = useState(() => new Set());
  const [editing, setEditing] = useState(false);
  const [menuFor, setMenuFor] = useState(null);

  const allowed = canManageRoles(user);
  const mayCreateRole = canAction(user, "administration", "roles", "create");
  const mayEditRole = canAction(user, "administration", "roles", "edit");
  const mayDeleteRole = canAction(user, "administration", "roles", "delete");

  useEffect(() => {
    if (allowed) fetchRoleMatrix();
  }, [allowed, fetchRoleMatrix]);

  const selected = useMemo(() => roles.find((r) => r._id === selectedId) || roles[0] || null, [roles, selectedId]);
  const rules = registry?.rules ?? {};
  const served = useMemo(() => servedIdsOf(registry), [registry]);

  // Re-seed when a different role is opened or the server sends a newer copy.
  const selectedId_ = selected?._id;
  const selectedUpdatedAt = selected?.updatedAt;
  useEffect(() => {
    if (!selectedId_) return;
    setDraft(initialDraft(selected, rules));
    setTab("permissions");
    // Open the modules this role was specifically set up for.
    const granted = new Set((selected.grants || []).filter((g) => served.has(`${g.module}.${g.submodule}`)).map((g) => g.module));
    setExpanded(granted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId_, selectedUpdatedAt, registry]);

  /** The Users tab reads the account list, which this screen does not load. */
  useEffect(() => {
    if (tab === "users" && users.length === 0) fetchUsers();
  }, [tab, users.length, fetchUsers]);

  const shownRoles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return roles;
    return roles.filter((r) => r.name.toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q));
  }, [roles, search]);

  const roleUsers = useMemo(() => (selected ? users.filter((u) => u.role === selected.name) : []), [users, selected]);

  if (!allowed) {
    return (
      <Card>
        <CardContent className="p-10 text-center">
          <ShieldCheck className="mx-auto mb-3 text-slate-300" size={32} />
          <p className="text-sm font-semibold text-slate-700">You do not have permission to manage roles.</p>
        </CardContent>
      </Card>
    );
  }

  if (loading && !registry) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="animate-spin text-slate-400" size={32} />
      </div>
    );
  }

  if (error && !registry) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <p className="text-sm font-semibold text-error-600">{error}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={fetchRoleMatrix}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const actions = registry?.actions || [];
  const fullAccess = isFullAccessRole(selected);
  const readOnly = !mayEditRole || fullAccess;
  const dirty = selected && !fullAccess ? isDirty(draft, selected, rules, served) : false;

  // ---- per-box state -------------------------------------------------------
  const stateOf = (moduleKey, subKey, action) => cellState({ role: selected, draft, rules, moduleKey, subKey, action });

  const toggleOne = (moduleKey, subKey, action) => setDraft((prev) => toggle(prev, rules, moduleKey, subKey, action));

  /** Tick or clear every changeable action on one sub-module. */
  const toggleRow = (moduleKey, sub) => {
    const open = sub.actions.filter((a) => !stateOf(moduleKey, sub.key, a).locked);
    if (open.length === 0) return;
    const allOn = open.every((a) => stateOf(moduleKey, sub.key, a).checked);
    setDraft((prev) => open.reduce((d, a) => setCell(d, rules, moduleKey, sub.key, a, !allOn), prev));
  };

  /** The sub-modules of `mod` that offer `action`, and whose box can change. */
  const openCells = (mod, action) =>
    mod.submodules.filter((s) => s.actions.includes(action) && !stateOf(mod.key, s.key, action).locked);

  /** 'none' when the action applies nowhere in the module; module rows show the truth, locked boxes included. */
  const moduleState = (mod, action) => {
    const cells = mod.submodules.filter((s) => s.actions.includes(action));
    if (cells.length === 0) return "none";
    const on = cells.filter((s) => stateOf(mod.key, s.key, action).checked).length;
    return on === 0 ? "off" : on === cells.length ? "all" : "some";
  };

  const toggleModuleAction = (mod, action) => {
    const cells = openCells(mod, action);
    if (cells.length === 0) return;
    const allOn = cells.every((s) => stateOf(mod.key, s.key, action).checked);
    setDraft((prev) => cells.reduce((d, s) => setCell(d, rules, mod.key, s.key, action, !allOn), prev));
  };

  const toggleExpanded = (key) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // ---- writes ----------------------------------------------------------------
  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    const res = await updateRole(selected._id, { grants: draftToGrants(draft, rules, served) });
    setSaving(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(`Saved permissions for ${selected.name}.`);
    // Editing your own role changes what this very session may do.
    if (user?.role === selected.name) fetchUser();
  };

  const handleCreate = async () => {
    const name = newRoleName.trim();
    if (!name) return;
    const res = await createRole({ name, description: "", grants: [] });
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(`Role "${name}" created. It starts with no access.`);
    setNewRoleName("");
    setCreating(false);
    setSelectedId(res.role._id);
  };

  const handleDelete = async () => {
    const role = confirmDelete;
    setConfirmDelete(null);
    if (!role) return;
    const res = await deleteRole(role._id);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(`Role "${role.name}" deleted.`);
    setSelectedId(null);
  };

  /**
   * Start from another role's permissions — into the DRAFT only, so Cancel
   * undoes it. A full-access source copies every box this screen offers.
   */
  const copyFrom = (sourceId) => {
    const source = roles.find((r) => r._id === sourceId);
    if (!source) return;
    setDraft(isFullAccessRole(source) ? fullDraft(registry) : initialDraft(source, rules));
    toast.success(`Copied ${source.name}'s permissions. Nothing is saved until you press Save.`);
  };

  return (
    <div className="flex flex-col gap-5">
      {/* ---- Heading ----------------------------------------------------- */}
      <div>
        <nav aria-label="Breadcrumb" className="text-[11px] font-semibold text-slate-400 mb-1.5">
          Administration <span className="mx-1 text-slate-300">/</span>
          <span className="text-slate-600">Roles &amp; Permissions</span>
        </nav>
        <h2 className="text-xl font-bold text-slate-900">Roles &amp; Permissions</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Create and manage roles, and set access to Customer Portal modules and sub-modules. FMS, Work Queue and
          HRMS access is managed in the Employee Portal and is never changed from here.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5 items-start">
        {/* ---- Roles ----------------------------------------------------- */}
        <Card>
          <CardContent className="p-0">
            <header className="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-100">
              <h3 className="text-sm font-bold text-slate-900">Roles</h3>
              {mayCreateRole && (
                <Button size="xs" variant="primary" onClick={() => setCreating(true)}>
                  <Plus size={13} className="mr-1" /> New Role
                </Button>
              )}
            </header>

            <div className="p-3 border-b border-slate-100">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 z-10 text-slate-400 pointer-events-none" />
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search roles..."
                  aria-label="Search roles"
                  className="pl-8 py-1.5 text-xs"
                />
              </div>
            </div>

            {creating && (
              <div className="p-3 border-b border-slate-100 bg-slate-50/60 flex flex-col gap-2">
                <Input
                  autoFocus
                  value={newRoleName}
                  onChange={(e) => setNewRoleName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  placeholder="Role name, e.g. Dispatch Supervisor"
                  aria-label="New role name"
                  className="text-xs"
                />
                <div className="flex items-center gap-2">
                  <Button size="xs" variant="primary" onClick={handleCreate} disabled={!newRoleName.trim()}>
                    Create
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => { setCreating(false); setNewRoleName(""); }} aria-label="Cancel new role">
                    <X size={13} />
                  </Button>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  A new role starts with no access at all. Grant it what it needs on the right.
                </p>
              </div>
            )}

            <div className="p-2 flex flex-col gap-1 max-h-[32rem] overflow-y-auto">
              {shownRoles.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-slate-400">No role matches “{search}”.</p>
              ) : (
                shownRoles.map((role) => {
                  const active = selected?._id === role._id;
                  return (
                    <div key={role._id} className="relative">
                      <button
                        type="button"
                        onClick={() => setSelectedId(role._id)}
                        aria-current={active ? "true" : undefined}
                        className={`w-full text-left flex items-center gap-2.5 pl-3 pr-8 py-2.5 rounded-lg border transition-colors ${
                          active ? "bg-primary-50 border-primary-200" : "border-transparent hover:bg-slate-50"
                        }`}
                      >
                        <RoleAvatar name={role.name} size={34} />
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className={`text-[13px] font-bold truncate ${active ? "text-primary-800" : "text-slate-800"}`}>
                              {role.name}
                            </span>
                            {isFullAccessRole(role) && <ShieldCheck size={12} className="shrink-0 text-amber-500" aria-label="Full access" />}
                            {role.portalOnly && <Store size={12} className="shrink-0 text-sky-500" aria-label="Portal only" />}
                          </span>
                          <span className="flex items-center gap-1 mt-0.5 text-[11px] text-slate-400 font-semibold">
                            <Users size={10} />
                            {role.userCount ?? 0} {role.userCount === 1 ? "user" : "users"}
                          </span>
                        </span>
                      </button>

                      {!role.isSystem && (mayEditRole || mayDeleteRole) && (
                        <button
                          type="button"
                          onClick={() => setMenuFor(menuFor === role._id ? null : role._id)}
                          aria-label={`Actions for ${role.name}`}
                          className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-md text-slate-300 hover:text-slate-600 hover:bg-slate-100"
                        >
                          <MoreVertical size={14} />
                        </button>
                      )}

                      {menuFor === role._id && (mayEditRole || mayDeleteRole) && (
                        <div className="absolute right-1 top-full z-20 mt-1 w-40 rounded-lg border border-slate-200 bg-white shadow-enterprise-lg py-1">
                          {mayEditRole && (
                            <button
                              type="button"
                              onClick={() => { setSelectedId(role._id); setEditing(true); setMenuFor(null); }}
                              className="w-full text-left px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                            >
                              Edit role
                            </button>
                          )}
                          {mayDeleteRole && (
                            <button
                              type="button"
                              onClick={() => { setMenuFor(null); setConfirmDelete(role); }}
                              className="w-full text-left px-3 py-1.5 text-xs font-semibold text-error-600 hover:bg-error-50"
                            >
                              Delete role
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>

        {/* ---- The role --------------------------------------------------- */}
        {!selected ? (
          <Card>
            <CardContent className="p-8 text-center text-slate-500">No roles found.</CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0 flex flex-col" aria-label={`${selected.name} permissions`} role="region">
              <header className="flex flex-wrap items-start gap-3 px-5 py-4 border-b border-slate-100">
                <RoleAvatar name={selected.name} size={44} />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-bold text-slate-900">{selected.name}</h3>
                    <RoleBadge role={selected} />
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">{selected.description || "No description yet."}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {mayEditRole && (
                    <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                      <Pencil size={13} className="mr-1.5" />
                      Edit Role
                    </Button>
                  )}
                  {!selected.isSystem && mayDeleteRole && (
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(selected)} aria-label={`Delete ${selected.name}`}>
                      <Trash2 size={15} className="text-error-600" />
                    </Button>
                  )}
                </div>
              </header>

              {/* Tabs + copy */}
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 border-b border-slate-100">
                <div role="tablist" className="flex items-center gap-1 -mb-px">
                  {[
                    { key: "permissions", label: "Permissions" },
                    { key: "users", label: `Users (${selected.userCount ?? 0})` },
                  ].map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      aria-selected={tab === t.key}
                      onClick={() => setTab(t.key)}
                      className={`px-3 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
                        tab === t.key ? "text-primary-700 border-primary-600" : "text-slate-500 border-transparent hover:text-slate-800"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {tab === "permissions" && roles.length > 1 && !readOnly && (
                  <label className="flex items-center gap-1.5 py-2 text-[11px] font-bold text-primary-700">
                    <Copy size={12} />
                    <span className="sr-only sm:not-sr-only">Copy from role</span>
                    <select
                      value=""
                      onChange={(e) => { copyFrom(e.target.value); e.target.value = ""; }}
                      aria-label="Copy permissions from another role"
                      className="text-[11px] font-semibold text-slate-600 bg-transparent border border-slate-200 rounded-md px-1.5 py-1 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary-500"
                    >
                      <option value="">Choose…</option>
                      {roles.filter((r) => r._id !== selected._id).map((r) => (
                        <option key={r._id} value={r._id}>{r.name}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              {tab === "users" ? (
                <UsersTab role={selected} rows={roleUsers} loading={loading} />
              ) : (
                <>
                  <div className="flex flex-col gap-2 px-5 pt-4 empty:hidden">
                    {fullAccess && (
                      <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800">
                        <ShieldCheck size={16} className="mt-0.5 shrink-0" />
                        <p className="text-xs font-semibold">
                          This role has full access to the entire ERP, including modules added in the future. That cannot
                          be narrowed here - build a role with the specific access you want instead.
                        </p>
                      </div>
                    )}
                    {selected.portalOnly && (
                      <div className="flex items-start gap-2.5 p-3 rounded-lg bg-sky-50 border border-sky-200 text-sky-800">
                        <Store size={16} className="mt-0.5 shrink-0" />
                        <p className="text-xs font-semibold">
                          This role is confined to the Customer Portal module. Everything outside it is locked, because
                          the server would ignore it.
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200">
                        <tr>
                          <th className="px-5 py-2.5 text-[11px] font-bold text-slate-500 uppercase tracking-wide">Module / Sub-module</th>
                          {actions.map((action) => (
                            <th key={action} className="px-3 py-2.5 w-20 text-center text-[11px] font-bold text-slate-500 uppercase tracking-wide">
                              {ACTION_LABELS[action] || action}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {(registry?.modules || []).map((mod) => (
                          <ModuleRows
                            key={mod.key}
                            mod={mod}
                            actions={actions}
                            open={expanded.has(mod.key)}
                            onToggleOpen={() => toggleExpanded(mod.key)}
                            portalFenced={selected.portalOnly && mod.key !== "customer_portal"}
                            moduleState={moduleState}
                            moduleHasOpenCells={(action) => openCells(mod, action).length > 0}
                            toggleModuleAction={toggleModuleAction}
                            stateOf={stateOf}
                            toggle={toggleOne}
                            toggleRow={toggleRow}
                            readOnly={readOnly}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <footer className="flex flex-wrap items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-200 bg-slate-50/60">
                    {dirty && <span className="mr-auto text-[11px] font-semibold text-warning-600">Unsaved changes</span>}
                    <Button size="sm" variant="outline" onClick={() => setDraft(initialDraft(selected, rules))} disabled={!dirty || saving}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="primary" onClick={handleSave} disabled={saving || !dirty || readOnly}>
                      {saving ? <Loader2 className="animate-spin mr-2" size={15} /> : <Save size={15} className="mr-2" />}
                      {saving ? "Saving..." : "Save Changes"}
                    </Button>
                  </footer>
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {editing && selected && (
        <EditRoleModal
          role={selected}
          onClose={() => setEditing(false)}
          onSave={async (updates) => {
            const res = await updateRole(selected._id, updates);
            if (!res.success) {
              toast.error(res.error);
              return false;
            }
            toast.success("Role updated.");
            setEditing(false);
            return true;
          }}
        />
      )}

      <ConfirmationDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title="Delete role"
        description={`Delete "${confirmDelete?.name}"? This cannot be undone. A role still assigned to any account cannot be deleted.`}
        confirmText="Delete"
        variant="danger"
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// One module and its sub-modules
// ---------------------------------------------------------------------------

function ModuleRows({
  mod, actions, open, onToggleOpen, portalFenced,
  moduleState, moduleHasOpenCells, toggleModuleAction, stateOf, toggle, toggleRow, readOnly = false,
}) {
  const muted = portalFenced ? "opacity-50" : "";

  return (
    <>
      <tr className={`bg-slate-50/40 hover:bg-slate-50 transition-colors ${muted}`}>
        <td className="px-5 py-2.5">
          <button type="button" onClick={onToggleOpen} aria-expanded={open} className="flex items-center gap-2 text-left">
            <span className="text-slate-400">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
            <Folder size={14} className="shrink-0 text-slate-400" />
            <span className="text-[13px] font-bold text-slate-800">{mod.label}</span>
            <span className="text-[11px] text-slate-400">({mod.submodules.length})</span>
          </button>
          {mod.description && <p className="ml-[52px] text-[11px] text-slate-400">{mod.description}</p>}
        </td>

        {actions.map((action) => {
          const state = moduleState(mod, action);
          if (state === "none") {
            return <td key={action} className="px-3 py-2.5 text-center text-slate-200 select-none">&mdash;</td>;
          }
          return (
            <td key={action} className="px-3 py-2.5 text-center">
              <TriCheckbox
                state={state}
                onChange={() => toggleModuleAction(mod, action)}
                disabled={readOnly || !moduleHasOpenCells(action)}
                title={`${ACTION_LABELS[action] || action} across all of ${mod.label}`}
              />
            </td>
          );
        })}
      </tr>

      {open &&
        mod.submodules.map((sub) => (
          <tr key={sub.key} className={`hover:bg-slate-50/70 transition-colors ${muted}`}>
            <td className="px-5 py-2">
              {readOnly ? (
                <span className="ml-[30px] text-[13px] font-semibold text-slate-600">{sub.label}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => toggleRow(mod.key, sub)}
                  className="ml-[30px] text-left text-[13px] font-semibold text-slate-600 hover:text-primary-700"
                >
                  {sub.label}
                </button>
              )}
              {!sub.path && (
                <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-slate-300">Capability</span>
              )}
            </td>

            {actions.map((action) => {
              if (!sub.actions.includes(action)) {
                return <td key={action} className="px-3 py-2 text-center text-slate-200 select-none">&mdash;</td>;
              }
              const state = stateOf(mod.key, sub.key, action);
              return (
                <td key={action} className="px-3 py-2 text-center">
                  <span className="relative inline-flex items-center justify-center" title={state.reason ?? undefined}>
                    <input
                      type="checkbox"
                      checked={state.checked}
                      onChange={() => toggle(mod.key, sub.key, action)}
                      disabled={readOnly || state.locked}
                      aria-label={`${ACTION_LABELS[action] || action} — ${mod.label} / ${sub.label}`}
                      className="w-4 h-4 text-primary-600 rounded border-slate-300 focus:ring-primary-500 cursor-pointer disabled:cursor-default"
                    />
                    {state.locked && !readOnly && (
                      <Lock size={9} className="absolute -right-3 text-slate-300" aria-hidden="true" />
                    )}
                  </span>
                </td>
              );
            })}
          </tr>
        ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Users tab
// ---------------------------------------------------------------------------

/** Who holds this role. Read-only — accounts are managed in User Management. */
function UsersTab({ role, rows, loading }) {
  if (loading && rows.length === 0) {
    return (
      <div className="flex justify-center p-10">
        <Loader2 className="animate-spin text-slate-400" size={26} />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="p-10 text-center">
        <Users className="mx-auto mb-3 text-slate-300" size={28} />
        <p className="text-sm font-semibold text-slate-600">No account holds the {role.name} role.</p>
        <p className="text-xs text-slate-400 mt-1">Assign it to somebody from User Management.</p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-slate-100 max-h-[32rem] overflow-y-auto">
      {rows.map((u) => (
        <li key={u._id} className="flex items-center gap-3 px-5 py-3">
          <RoleAvatar name={u.user || u.email || "?"} size={32} />
          <span className="flex-1 min-w-0">
            <span className="block text-[13px] font-semibold text-slate-900 truncate">{u.user || u.email}</span>
            <span className="flex items-center gap-1 text-[11px] text-slate-400 truncate">
              <Mail size={10} />
              {u.email}
            </span>
          </span>
          <span
            className={`shrink-0 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wide ${
              (u.status || "Active") === "Active" ? "bg-success-50 text-success-600 border-success-200" : "bg-slate-100 text-slate-500 border-slate-200"
            }`}
          >
            {u.status || "Active"}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Edit role
// ---------------------------------------------------------------------------

/** Rename a role and describe it. A built-in role's name is fixed; the server refuses it anyway. */
function EditRoleModal({ role, onClose, onSave }) {
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description || "");
  const [saving, setSaving] = useState(false);

  const changed = name.trim() !== role.name || description !== (role.description || "");

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    const updates = { description };
    if (!role.isSystem && name.trim() !== role.name) updates.name = name.trim();
    await onSave(updates);
    setSaving(false);
  };

  return (
    <Modal isOpen onClose={onClose} title={`Edit ${role.name}`} size="md">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Role name"
          aria-label="Role name"
          value={name}
          maxLength={60}
          disabled={role.isSystem}
          onChange={(e) => setName(e.target.value)}
          helperText={role.isSystem ? "Built-in roles cannot be renamed. Their permissions can be changed freely." : undefined}
        />
        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="role-description" className="text-xs font-semibold text-slate-700 select-none">Description</label>
          <textarea
            id="role-description"
            rows={3}
            maxLength={280}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this role is for, e.g. Can manage sales and view reports."
            className="w-full px-3 py-2 text-sm bg-white border rounded-lg shadow-sm outline-none transition-all border-slate-300 placeholder-slate-400 text-slate-900 focus:border-primary-500 focus:ring-1 focus:ring-primary-500 resize-y leading-relaxed"
          />
          <span className="text-xs text-slate-500">Shown beside the role wherever it appears.</span>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" variant="primary" loading={saving} disabled={!changed}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

export default RolesPermissions;
