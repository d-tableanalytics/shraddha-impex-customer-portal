import { useEffect, useMemo, useState } from 'react';
import { Loader2, Lock, ShieldCheck, Store, Save, Eraser } from 'lucide-react';
import toast from 'react-hot-toast';

import { useAdminStore } from '../../store/adminStore';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import {
  ACTION_LABELS, grantsToMap, mapToGrants, sameGrants, mapHas, toggleCell,
} from '../../utils/grants';

/**
 * Extra access for ONE account, on top of what its role already gives it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT JUST THE ROLE MATRIX POINTED AT A USER
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Because the question is different, and showing the same grid would answer the
 * wrong one. A role's matrix asks "what should this ROLE be able to do". This
 * asks "what does this PERSON need that their role does not give them" - and
 * the honest way to show that is to render what they already have as settled
 * and let the admin add to it.
 *
 * So the role's own cells are ticked and locked, labelled with where they came
 * from. Only the difference is editable, and only the difference is saved. An
 * admin who unticks nothing and ticks two boxes has granted two things, not
 * re-stated forty.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ADDITIVE, AND SAID SO
 * ─────────────────────────────────────────────────────────────────────────
 *
 * There is no way to take something away here, and that is deliberate rather
 * than unfinished - see the note on updateUserAccess in the user controller.
 * A per-user subtraction is invisible: nobody reviewing the role matrix would
 * ever learn that one account had been quietly cut back. Removing access is
 * done on the role, where it is visible. The banner says this out loud so an
 * admin does not go looking for a control that was left out on purpose.
 */
export const UserAccessModal = ({ user, onClose }) => {
  const { registry, roles, fetchRegistry, updateUserAccess } = useAdminStore();

  const [draft, setDraft] = useState(new Map());
  const [saving, setSaving] = useState(false);
  const [loadingRegistry, setLoadingRegistry] = useState(false);

  const open = !!user;

  useEffect(() => {
    if (!open || registry) return;
    setLoadingRegistry(true);
    fetchRegistry().finally(() => setLoadingRegistry(false));
  }, [open, registry, fetchRegistry]);

  // Reset the draft each time a different account is opened. Keyed on the id
  // rather than the object, which is a new reference on every store update.
  const userId = user?._id;
  const userExtraGrants = user?.extraGrants;
  useEffect(() => {
    if (!userId) return;
    setDraft(grantsToMap(userExtraGrants));
    // userExtraGrants is read, not depended on: a save returns a fresh array
    // and depending on it would reset the grid mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  /**
   * The account's role, as the roles API describes it.
   *
   * `effectiveGrants` is what the role RESOLVES to - its matrix plus the
   * compiled-in floor it cannot fall below - which is the right thing to show
   * as already-held. Showing only the stored matrix would present a permission
   * as grantable when the account already has it, and then appear to do nothing
   * when it was ticked.
   */
  const role = useMemo(
    () => roles.find((r) => r.name === user?.role) || null,
    [roles, user?.role],
  );

  const inherited = useMemo(() => grantsToMap(role?.effectiveGrants || []), [role]);

  const roleIsUnrestricted = !!role?.isSuperAdmin;
  const rolePortalOnly = !!role?.portalOnly;

  const isInherited = (m, s, a) => roleIsUnrestricted || mapHas(inherited, m, s, a);
  const isChecked = (m, s, a) => isInherited(m, s, a) || mapHas(draft, m, s, a);

  const toggle = (m, s, a) => {
    if (isInherited(m, s, a)) return;
    setDraft((prev) => toggleCell(prev, m, s, a));
  };

  const dirty = !sameGrants(mapToGrants(draft), user?.extraGrants || []);
  const extraCount = mapToGrants(draft).reduce((n, g) => n + g.actions.length, 0);

  const handleSave = async () => {
    setSaving(true);
    const res = await updateUserAccess(user._id, mapToGrants(draft));
    setSaving(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(
      extraCount
        ? `${user.user || user.email} now has ${extraCount} extra permission${extraCount === 1 ? '' : 's'}.`
        : `Extra access cleared for ${user.user || user.email}.`,
    );
    onClose();
  };

  const label = user?.user || user?.customerName || user?.email || 'this account';

  return (
    <Modal isOpen={open} onClose={onClose} title={`Extra Access — ${label}`} size="xl">
      {loadingRegistry || !registry ? (
        <div className="flex justify-center p-10">
          <Loader2 className="animate-spin text-slate-400" size={28} />
        </div>
      ) : (
        /*
         * ONE scroll region, not two.
         *
         * This used to be a plain column containing a box hard-capped at
         * `max-h-[52vh]`. Inside the Modal — whose body is already
         * `overflow-y-auto flex-1` — that made TWO nested scrollers, and on a
         * laptop viewport they fought: 52vh of modules did not fit in the space
         * the intro, the notice and the button row left over, so the OUTER
         * scroller engaged as well. Scrolling then moved whichever container the
         * pointer happened to be over, and the outer one carried the Save button
         * off the bottom of the modal.
         *
         * `h-full min-h-0` makes this column exactly as tall as the Modal body,
         * so the module list below is the only thing that scrolls and the footer
         * stays put. `min-h-0` is the load-bearing half: without it a flex child
         * refuses to shrink below its content height and the overflow escapes
         * the container instead of scrolling inside it.
         */
        <div className="flex flex-col gap-4 h-full min-h-0">
          <div className="flex flex-wrap items-center justify-between gap-3 shrink-0">
            <p className="text-xs text-slate-500 font-medium max-w-2xl">
              This account signs in as <span className="font-bold text-slate-700">{user?.role}</span>.
              Everything that role grants is ticked and locked below. Anything you add here
              applies to <span className="font-bold text-slate-700">this account only</span>.
            </p>
            <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400 shrink-0">
              {extraCount} extra
            </span>
          </div>

          {!role && (
            // The roles list did not load, so what the account already holds is
            // unknown. Saying so beats drawing an empty grid that would read as
            // "this account has nothing" and invite re-granting all of it.
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800">
              <ShieldCheck size={16} className="mt-0.5 shrink-0" />
              <p className="text-xs font-semibold">
                The {user?.role} role could not be loaded, so what this account already
                has cannot be shown. Anything ticked here would be saved as extra access
                on top of it - reload the page before changing anything.
              </p>
            </div>
          )}

          {roleIsUnrestricted ? (
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800">
              <ShieldCheck size={16} className="mt-0.5 shrink-0" />
              <p className="text-xs font-semibold">
                {user?.role} already has full access to the entire ERP. There is nothing extra
                to give this account.
              </p>
            </div>
          ) : (
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-slate-50 border border-slate-200 text-slate-600">
              <Lock size={16} className="mt-0.5 shrink-0 text-slate-400" />
              <p className="text-xs font-medium">
                Extra access only ever <span className="font-bold">adds</span>. To take something
                away, change the {user?.role} role — that way the change is visible to whoever
                reviews permissions next, instead of hidden on one account.
              </p>
            </div>
          )}

          {rolePortalOnly && (
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-sky-50 border border-sky-200 text-sky-800">
              <Store size={16} className="mt-0.5 shrink-0" />
              <p className="text-xs font-semibold">
                This account is a {user?.role}, which is confined to the Customer Portal. The
                server ignores anything granted outside it, so those cells are disabled here —
                move the account to another role first if it needs internal access.
              </p>
            </div>
          )}

          {/*
            `flex-1` rather than `max-h-[52vh]`: the list takes whatever height
            is actually left after the header and footer, on any viewport, instead
            of a fraction of the SCREEN that has no idea what else is in the modal.

            `min-h-[160px]` does double duty and is not just a floor. A flex item
            defaults to `min-height: auto`, i.e. its own content height, which
            stops it shrinking and lets the overflow escape instead of scrolling.
            Any explicit min-height overrides that — so this both permits the
            shrink AND keeps the list usable on a very short window. (`min-h-0`
            would do the first half, but the two together are contradictory CSS
            and which one wins depends on Tailwind's emit order.)

            The scrollbar is styled visible on purpose. Windows renders overlay
            scrollbars that vanish when idle, so a clipped list looked like a
            bug: there was no way to tell there was more below.
          */}
          <div
            className="flex flex-col gap-4 flex-1 min-h-[160px] overflow-y-auto pr-2
                       [&::-webkit-scrollbar]:w-1.5
                       [&::-webkit-scrollbar-track]:bg-slate-50 [&::-webkit-scrollbar-track]:rounded-full
                       [&::-webkit-scrollbar-thumb]:bg-slate-300 [&::-webkit-scrollbar-thumb]:rounded-full
                       hover:[&::-webkit-scrollbar-thumb]:bg-slate-400
                       [scrollbar-width:thin] [scrollbar-color:rgb(203_213_225)_rgb(248_250_252)]"
          >
            {registry.modules.map((mod) => {
              const fenced = rolePortalOnly && mod.key !== 'customer_portal';

              return (
                <div
                  key={mod.key}
                  className={`border border-slate-200 rounded-lg overflow-hidden ${fenced ? 'opacity-50' : ''}`}
                >
                  <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wide">
                      {mod.label}
                    </h4>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-slate-100">
                          <th className="px-4 py-2 text-[11px] font-bold text-slate-500 uppercase tracking-wide">
                            Sub-module
                          </th>
                          {registry.actions.map((action) => (
                            <th
                              key={action}
                              className="px-2 py-2 text-[11px] font-bold text-slate-500 uppercase tracking-wide text-center w-16"
                            >
                              {ACTION_LABELS[action] || action}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {mod.submodules.map((sub) => (
                          <tr key={sub.key} className="hover:bg-slate-50/70 transition-colors">
                            <td className="px-4 py-2 font-semibold text-slate-700">
                              {sub.label}
                              {!sub.path && (
                                <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-slate-300">
                                  Capability
                                </span>
                              )}
                            </td>

                            {registry.actions.map((action) => {
                              if (!sub.actions.includes(action)) {
                                return (
                                  <td key={action} className="px-2 py-2 text-center text-slate-200 select-none">
                                    &mdash;
                                  </td>
                                );
                              }

                              const fromRole = isInherited(mod.key, sub.key, action);
                              return (
                                <td key={action} className="px-2 py-2 text-center">
                                  <span className="relative inline-flex items-center justify-center">
                                    <input
                                      type="checkbox"
                                      checked={isChecked(mod.key, sub.key, action)}
                                      onChange={() => toggle(mod.key, sub.key, action)}
                                      disabled={fromRole || fenced}
                                      title={
                                        fromRole
                                          ? `Already granted by the ${user?.role} role.`
                                          : fenced
                                            ? 'Outside the Customer Portal, so the server would ignore it.'
                                            : undefined
                                      }
                                      className="w-4 h-4 text-primary-600 rounded border-slate-300 focus:ring-primary-500 disabled:opacity-60 disabled:cursor-not-allowed"
                                    />
                                    {fromRole && !fenced && (
                                      <Lock size={9} className="absolute -right-3 text-slate-400 pointer-events-none" />
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
                </div>
              );
            })}
          </div>

          {/* shrink-0 + a rule: the actions stay visible however long the list
              is, and read as a footer rather than as the end of the content. */}
          <div className="flex items-center justify-between gap-2 pt-3 shrink-0 border-t border-slate-100">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDraft(new Map())}
              disabled={extraCount === 0}
              title="Remove every extra permission from this account"
            >
              <Eraser size={15} className="mr-1.5" />
              Clear extras
            </Button>

            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
              <Button size="sm" variant="primary" onClick={handleSave} disabled={saving || !dirty}>
                {saving ? <Loader2 className="animate-spin mr-2" size={15} /> : <Save size={15} className="mr-2" />}
                {saving ? 'Saving...' : 'Save Access'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
};

export default UserAccessModal;
