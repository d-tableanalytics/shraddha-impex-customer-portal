import { useEffect, useMemo, useState } from 'react';
import {
  Save, Loader2, ShieldCheck, Lock, Plus, Trash2, Users, Store, AlertCircle, X,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { useAdminStore } from '../../../store/adminStore';
import { useUserStore } from '../../../store/userStore';
import { Card, CardContent } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { canManageRoles } from '../../../utils/permissions';
import {
  ACTION_LABELS, grantsToMap, mapToGrants, sameGrants, toggleCell,
} from '../../../utils/grants';

/**
 * The Super Admin's control panel for access - requirement 3.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPLACES, AND WHY THE OLD ONE COULD NOT BE PATCHED
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The previous screen listed seven hardcoded permission names down the side and
 * every role across the top, and saving it wrote to a `Role` collection that
 * NOTHING consulted. Enforcement read a compiled-in map keyed by User.role,
 * whose values ('Admin', 'Sales') did not even match the role names this screen
 * displayed ('Administrator', 'Sales Manager'). Every tick here was a no-op,
 * and the screen gave no sign of it.
 *
 * So this is not a redesign of that screen; it is the first version of it that
 * is connected to anything.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE ROLE AT A TIME
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The old layout put roles on the X axis. That works for seven permissions and
 * collapses at forty-odd sub-modules times five actions times a growing number
 * of roles - it becomes a horizontally scrolling grid where the row label is
 * off-screen by the time you reach the column you wanted.
 *
 * Picking a role and showing its whole matrix keeps every cell next to the
 * thing it describes, and matches how the job is actually done: you sit down to
 * configure a role, not to compare a permission across roles.
 */

export const PermissionMatrix = () => {
  const { roles, registry, loading, fetchRoleMatrix, updateRole, createRole, deleteRole } =
    useAdminStore();
  const { user, fetchUser } = useUserStore();

  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(new Map());
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');

  useEffect(() => {
    fetchRoleMatrix();
  }, [fetchRoleMatrix]);

  const selected = useMemo(
    () => roles.find((r) => r._id === selectedId) || roles[0] || null,
    [roles, selectedId],
  );

  // Reset the draft whenever the selected role changes or the server sends a
  // newer copy of it. Keyed on id and updatedAt rather than on the role object,
  // which is a fresh reference on every store update and would throw away an
  // in-progress edit on each render.
  const selectedId_ = selected?._id;
  const selectedUpdatedAt = selected?.updatedAt;
  const selectedGrants = selected?.grants;
  useEffect(() => {
    if (!selectedId_) return;
    setDraft(grantsToMap(selectedGrants));
    // selectedGrants is intentionally read, not depended on: a save returns a
    // new array every time, and depending on it would reset the draft mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId_, selectedUpdatedAt]);

  /**
   * Cells this role holds no matter what the matrix says.
   *
   * Its compiled-in floor - see BASELINE in backend/config/permissions.js. They
   * are rendered ticked and disabled, because the alternative is a checkbox
   * that clears itself on save, which teaches the admin that the screen is
   * unreliable rather than that the permission is guaranteed.
   */
  const baseline = useMemo(() => grantsToMap(selected?.baselineGrants || []), [selected]);

  const isLocked = (moduleKey, subKey, action) => {
    if (selected?.isSuperAdmin) return true;
    return baseline.get(`${moduleKey}.${subKey}`)?.has(action) || false;
  };

  const isChecked = (moduleKey, subKey, action) => {
    if (selected?.isSuperAdmin) return true;
    if (isLocked(moduleKey, subKey, action)) return true;
    return draft.get(`${moduleKey}.${subKey}`)?.has(action) || false;
  };

  const toggle = (moduleKey, subKey, action) => {
    if (isLocked(moduleKey, subKey, action)) return;
    setDraft((prev) => toggleCell(prev, moduleKey, subKey, action));
  };

  /** Tick or clear every available action on one sub-module. */
  const toggleRow = (moduleKey, sub) => {
    const id = `${moduleKey}.${sub.key}`;
    const current = draft.get(id) || new Set();
    const unlocked = sub.actions.filter((a) => !isLocked(moduleKey, sub.key, a));
    const allOn = unlocked.every((a) => current.has(a));
    setDraft((prev) => {
      const next = new Map(prev);
      next.set(id, allOn ? new Set() : new Set([...current, ...unlocked]));
      return next;
    });
  };

  const dirty = selected ? !sameGrants(mapToGrants(draft), selected.grants || []) : false;

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    const res = await updateRole(selected._id, { grants: mapToGrants(draft) });
    setSaving(false);

    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(`Saved permissions for ${selected.name}.`);

    // The signed-in admin may have just changed their OWN role. Re-reading the
    // profile refreshes their sidebar and their own permission set, rather than
    // leaving them on a menu that no longer matches what the server will allow.
    if (user?.role === selected.name) fetchUser();
  };

  const handleCreate = async () => {
    const name = newRoleName.trim();
    if (!name) return;
    const res = await createRole({ name, description: '', grants: [] });
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(`Role "${name}" created. It starts with no access.`);
    setNewRoleName('');
    setCreating(false);
    setSelectedId(res.role._id);
  };

  const handleDelete = async () => {
    if (!selected) return;
    const res = await deleteRole(selected._id);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(`Role "${selected.name}" deleted.`);
    setSelectedId(null);
  };

  if (!canManageRoles(user)) {
    return (
      <Card>
        <CardContent className="p-10 text-center">
          <ShieldCheck className="mx-auto mb-3 text-slate-300" size={32} />
          <p className="text-sm font-semibold text-slate-700">
            You do not have permission to manage roles.
          </p>
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap justify-between items-start gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-800">Roles &amp; Permissions</h2>
          <p className="text-sm text-slate-500">
            Choose a role, then grant it access module by module. Changes apply the moment
            they are saved.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!creating && (
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
              <Plus size={16} className="mr-2" /> New Role
            </Button>
          )}
          <Button size="sm" variant="primary" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save size={16} className="mr-2" />}
            {saving ? 'Saving...' : dirty ? 'Save Changes' : 'Saved'}
          </Button>
        </div>
      </div>

      {creating && (
        <Card>
          <CardContent className="p-4 flex flex-wrap items-center gap-3">
            <input
              autoFocus
              value={newRoleName}
              onChange={(e) => setNewRoleName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="Role name, e.g. Dispatch Supervisor"
              className="flex-1 min-w-56 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <Button size="sm" variant="primary" onClick={handleCreate} disabled={!newRoleName.trim()}>
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setNewRoleName(''); }}>
              <X size={16} />
            </Button>
            <p className="w-full text-xs text-slate-400">
              A new role starts with no access at all. Grant it what it needs below.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6 items-start">
        {/* Roles */}
        <Card>
          <CardContent className="p-2">
            <div className="flex flex-col gap-1">
              {roles.map((role) => {
                const active = selected?._id === role._id;
                return (
                  <button
                    key={role._id}
                    type="button"
                    onClick={() => setSelectedId(role._id)}
                    className={`text-left px-3 py-2.5 rounded-lg transition-colors ${
                      active ? 'bg-primary-50 border border-primary-200' : 'hover:bg-slate-50 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-bold truncate ${active ? 'text-primary-800' : 'text-slate-700'}`}>
                        {role.name}
                      </span>
                      {role.isSuperAdmin && <ShieldCheck size={14} className="text-amber-500 shrink-0" />}
                      {role.portalOnly && <Store size={14} className="text-sky-500 shrink-0" />}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[11px] text-slate-400 font-semibold flex items-center gap-1">
                        <Users size={11} /> {role.userCount ?? 0}
                      </span>
                      {role.isSystem && (
                        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                          Built-in
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Matrix */}
        {!selected ? (
          <Card>
            <CardContent className="p-8 text-center text-slate-500">No roles found.</CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-4">
            <Card>
              <CardContent className="p-4 flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-base font-bold text-slate-800">{selected.name}</h3>
                    {selected.isSuperAdmin && (
                      <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                        Full access
                      </span>
                    )}
                    {selected.portalOnly && (
                      <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200">
                        Customer Portal only
                      </span>
                    )}
                  </div>
                  {selected.description && (
                    <p className="text-xs text-slate-500 mt-1 max-w-2xl">{selected.description}</p>
                  )}
                </div>
                {!selected.isSystem && (
                  <Button size="sm" variant="ghost" onClick={handleDelete}>
                    <Trash2 size={15} className="mr-1.5 text-error-600" />
                    <span className="text-error-600">Delete</span>
                  </Button>
                )}
              </CardContent>
            </Card>

            {selected.isSuperAdmin && (
              <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800">
                <ShieldCheck size={16} className="mt-0.5 shrink-0" />
                <p className="text-xs font-semibold">
                  This role has full access to the entire ERP, including modules added in the
                  future. That cannot be narrowed here - build a role with the specific access
                  you want instead.
                </p>
              </div>
            )}

            {selected.portalOnly && (
              <div className="flex items-start gap-2.5 p-3 rounded-lg bg-sky-50 border border-sky-200 text-sky-800">
                <Store size={16} className="mt-0.5 shrink-0" />
                <p className="text-xs font-semibold">
                  This role is confined to the Customer Portal. Anything granted outside it is
                  ignored by the server, so those cells are shown but never take effect.
                </p>
              </div>
            )}

            {(registry?.modules || []).map((mod) => {
              const portalFenced = selected.portalOnly && mod.key !== 'customer_portal';

              return (
                <Card key={mod.key} className={portalFenced ? 'opacity-50' : undefined}>
                  <CardContent className="p-0">
                    <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50 rounded-t-lg">
                      <h4 className="text-sm font-bold text-slate-800">{mod.label}</h4>
                      {mod.description && (
                        <p className="text-[11px] text-slate-500 font-medium">{mod.description}</p>
                      )}
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-slate-100">
                            <th className="px-5 py-2.5 text-xs font-bold text-slate-500 uppercase tracking-wide">
                              Sub-module
                            </th>
                            {(registry?.actions || []).map((action) => (
                              <th
                                key={action}
                                className="px-3 py-2.5 text-xs font-bold text-slate-500 uppercase tracking-wide text-center w-20"
                              >
                                {ACTION_LABELS[action] || action}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {mod.submodules.map((sub) => (
                            <tr key={sub.key} className="hover:bg-slate-50/70 transition-colors">
                              <td className="px-5 py-2.5">
                                <button
                                  type="button"
                                  onClick={() => !portalFenced && toggleRow(mod.key, sub)}
                                  disabled={portalFenced || selected.isSuperAdmin}
                                  className="text-left font-semibold text-slate-700 hover:text-primary-700 disabled:hover:text-slate-700 disabled:cursor-default"
                                >
                                  {sub.label}
                                </button>
                                {!sub.path && (
                                  // Says plainly why there is no menu entry for
                                  // this row, so its absence from the sidebar
                                  // does not read as a bug.
                                  <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-slate-300">
                                    Capability
                                  </span>
                                )}
                              </td>

                              {(registry?.actions || []).map((action) => {
                                const available = sub.actions.includes(action);
                                if (!available) {
                                  return (
                                    <td key={action} className="px-3 py-2.5 text-center text-slate-200 select-none">
                                      &mdash;
                                    </td>
                                  );
                                }

                                const locked = isLocked(mod.key, sub.key, action);
                                return (
                                  <td key={action} className="px-3 py-2.5 text-center">
                                    <span className="relative inline-flex items-center justify-center">
                                      <input
                                        type="checkbox"
                                        checked={isChecked(mod.key, sub.key, action)}
                                        onChange={() => toggle(mod.key, sub.key, action)}
                                        disabled={locked || portalFenced}
                                        title={
                                          locked
                                            ? `${selected.name} always has this. It is part of the role's built-in access and cannot be removed here.`
                                            : undefined
                                        }
                                        className="w-4 h-4 text-primary-600 rounded border-slate-300 focus:ring-primary-500 disabled:opacity-60 disabled:cursor-not-allowed"
                                      />
                                      {locked && !selected.isSuperAdmin && (
                                        <Lock
                                          size={9}
                                          className="absolute -right-3 text-slate-400 pointer-events-none"
                                        />
                                      )}
                                    </span>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              );
            })}

            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-slate-50 border border-slate-200 text-slate-600">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-slate-400" />
              <p className="text-xs font-medium">
                <Lock size={11} className="inline mb-0.5" /> marks access this role has had
                since before permissions were configurable. It is kept so nobody loses access
                they were relying on, and can only be changed in the code.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PermissionMatrix;
