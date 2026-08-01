import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAdminStore } from '../../../store/adminStore';
import { useUserStore } from '../../../store/userStore';
import { Card, CardContent } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { ConfirmationDialog } from '../../../components/ui/ConfirmationDialog';
import { Pagination } from '../../../components/ui/Pagination';
import { usePagination } from '../../../hooks/usePagination';
import { UserPlus, Shield, Mail, Search, X, Pencil, KeyRound } from 'lucide-react';
import { TableSkeleton } from '../../../components/ui/TableSkeleton';
import toast from 'react-hot-toast';

const PAGE_SIZE = 10;

const CATEGORY_STYLES = {
  MSIL: 'bg-primary-50 text-primary-700 border-primary-200',
  'Non-MSIL': 'bg-amber-50 text-amber-700 border-amber-200',
};

const STATUS_STYLES = {
  Active: 'bg-success-50 text-success-700',
  Inactive: 'bg-slate-100 text-slate-600',
  Suspended: 'bg-red-50 text-red-700',
};

const emptyForm = {
  user: '',
  company: '',
  email: '',
  password: '',
  role: 'Customer',
  customerCategory: 'Non-MSIL',
  status: 'Active',
  brandAccess: {
    koken: true,
    bix: true,
    imada: true,
  },
};

// A single "access level" maps onto the underlying role + customerCategory fields.
// 'Sales User' is a role in its own right, not a customer category — it must be
// listed here, or editing a Sales user would silently demote them to Customer.
const ACCESS_LEVELS = ['Non-MSIL', 'MSIL', 'Sales User', 'Admin'];

const accessLevelOf = (u) => {
  if (u.role === 'Admin') return 'Admin';
  if (u.role === 'Sales') return 'Sales User';
  return u.customerCategory === 'MSIL' ? 'MSIL' : 'Non-MSIL';
};

const accessLevelToFields = (level) => {
  if (level === 'Admin') return { role: 'Admin' };
  if (level === 'Sales User') return { role: 'Sales' };
  return { role: 'Customer', customerCategory: level };
};

export const UserManagement = () => {
  const { users, fetchUsers, loading, createUser, updateUser, resetUserPassword } = useAdminStore();
  const { user } = useUserStore();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [editUser, setEditUser] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const [pwUser, setPwUser] = useState(null);
  const [newPw, setNewPw] = useState('');
  const [savingPw, setSavingPw] = useState(false);

  const isAdmin = user?.role === 'Admin';

  const q = search.trim().toLowerCase();
  const filteredUsers = q
    ? users.filter((u) =>
        [u.user, u.company, u.email]
          .some((v) => String(v || '').toLowerCase().includes(q)),
      )
    : users;

  const { page, setPage, pageItems: visibleUsers, total } = usePagination(filteredUsers, PAGE_SIZE);

  useEffect(() => {
    if (isAdmin) fetchUsers();
  }, [fetchUsers, isAdmin]);

  // A new search gives a different result set — start it from the first page.
  useEffect(() => {
    setPage(1);
  }, [q, setPage]);

  // User management (incl. customer category) is admin only.
  if (user && !isAdmin) {
    return <Navigate to="/" replace />;
  }

  const setField = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const setEditField = (field) => (e) => setEditForm((f) => ({ ...f, [field]: e.target.value }));

  const openEdit = (u) => {
    setEditUser(u);
    setEditForm({
      user: u.user || '',
      company: u.company || '',
      email: u.email || '',
      status: u.status || 'Active',
      accessLevel: accessLevelOf(u),
      brandAccess: u.brandAccess || { koken: true, bix: true, imada: true },
    });
  };

  const closeEdit = () => {
    setEditUser(null);
    setEditForm(null);
    setConfirmSuspend(false);
  };

  const handleEditSave = async (e) => {
    e.preventDefault();
    if (!editForm.email) {
      toast.error('Email is required');
      return;
    }
    // Suspending deletes the account from the users collection — confirm first.
    if (editForm.status === 'Suspended' && editUser.status !== 'Suspended') {
      setConfirmSuspend(true);
      return;
    }
    await saveEdit();
  };

  const saveEdit = async () => {
    setSavingEdit(true);
    const { accessLevel, ...details } = editForm;
    const res = await updateUser(editUser._id, {
      ...details,
      ...accessLevelToFields(accessLevel),
    });
    setSavingEdit(false);
    setConfirmSuspend(false);
    if (res.success) {
      const restored = editUser.archived && editForm.status !== 'Suspended';
      toast.success(
        editForm.status === 'Suspended'
          ? 'Account suspended and removed from the database'
          : restored
            ? 'Account restored to the database'
            : 'User updated',
      );
      closeEdit();
    } else {
      toast.error(res.error || 'Failed to update user');
    }
  };

  const openResetPw = (u) => {
    setPwUser(u);
    setNewPw('');
  };

  const handleResetPw = async (e) => {
    e.preventDefault();
    if (newPw.length < 5) {
      toast.error('Password must be at least 5 characters');
      return;
    }
    setSavingPw(true);
    const res = await resetUserPassword(pwUser._id, newPw);
    setSavingPw(false);
    if (res.success) {
      toast.success(`Password reset for ${pwUser.email}`);
      setPwUser(null);
      setNewPw('');
    } else {
      toast.error(res.error || 'Failed to reset password');
    }
  };

  const handleCategoryChange = async (userId, customerCategory) => {
    const res = await updateUser(userId, { customerCategory });
    if (res.success) {
      toast.success(`Category updated to ${customerCategory}`);
    } else {
      toast.error(res.error || 'Failed to update category');
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.email || !form.password) {
      toast.error('Email and password are required');
      return;
    }
    setSaving(true);
    const res = await createUser(form);
    setSaving(false);
    if (res.success) {
      toast.success('Customer created');
      setForm(emptyForm);
      setShowAdd(false);
    } else {
      toast.error(res.error || 'Failed to create customer');
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-800">User Management</h2>
          <p className="text-sm text-slate-500">Manage customers, categories, roles, and access.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative w-full sm:w-72">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, company or email..."
              className="w-full pl-9 pr-8 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 text-slate-800"
            />
            {search && (
              <X
                size={14}
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 cursor-pointer hover:text-slate-600"
              />
            )}
          </div>
          <Button size="sm" variant="primary" onClick={() => setShowAdd(true)} className="shrink-0">
            <UserPlus size={16} className="mr-2" />
            Add Customer
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-4 font-bold text-slate-600">User</th>
                  <th className="px-6 py-4 font-bold text-slate-600">Role</th>
                  <th className="px-6 py-4 font-bold text-slate-600">Customer Category</th>
                  <th className="px-6 py-4 font-bold text-slate-600">Brand Access</th>
                  <th className="px-6 py-4 font-bold text-slate-600">Status</th>
                  <th className="px-6 py-4 font-bold text-slate-600 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <TableSkeleton rows={PAGE_SIZE} columns={6} />
                ) : filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-slate-400">
                      {q ? `No users match "${search}".` : 'No users found.'}
                    </td>
                  </tr>
                ) : (
                  visibleUsers.map((u) => {
                    const displayName = u.user || u.company || u.email;
                    const isCustomer = u.role !== 'Admin';
                    return (
                      <tr key={u._id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center text-slate-600 font-bold uppercase">
                              {displayName?.charAt(0) || 'U'}
                            </div>
                            <div className="flex flex-col">
                              <span className="font-bold text-slate-800">{displayName}</span>
                              <span className="text-xs text-slate-500 flex items-center gap-1"><Mail size={12} />{u.email}</span>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className="px-2 py-1 bg-primary-50 text-primary-700 text-xs font-semibold rounded flex items-center gap-1 w-fit">
                            <Shield size={12} /> {u.role || 'Customer'}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          {isCustomer ? (
                            <select
                              value={u.customerCategory || 'Non-MSIL'}
                              onChange={(e) => handleCategoryChange(u._id, e.target.value)}
                              disabled={u.archived}
                              title={u.archived ? 'Restore the account to Active to edit it' : undefined}
                              className={`text-xs font-bold rounded-md border px-2.5 py-1.5 outline-none cursor-pointer focus:ring-2 focus:ring-primary-500/20 disabled:opacity-50 disabled:cursor-not-allowed ${CATEGORY_STYLES[u.customerCategory || 'Non-MSIL']}`}
                            >
                              <option value="MSIL">MSIL</option>
                              <option value="Non-MSIL">Non-MSIL</option>
                            </select>
                          ) : (
                            <span className="text-xs text-slate-400 italic">N/A (Admin)</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex gap-1.5 flex-wrap max-w-[150px]">
                            {u.brandAccess?.koken && (
                              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200 rounded">Koken</span>
                            )}
                            {u.brandAccess?.bix && (
                              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200 rounded">BIX</span>
                            )}
                            {u.brandAccess?.imada && (
                              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200 rounded text-nowrap">IMADA</span>
                            )}
                            {(!u.brandAccess || (!u.brandAccess.koken && !u.brandAccess.bix && !u.brandAccess.imada)) && (
                              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-red-50 text-red-700 border border-red-200 rounded">None</span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-col items-start gap-1">
                            <span className={`px-2 py-1 text-xs font-bold rounded-full ${STATUS_STYLES[u.status] || STATUS_STYLES.Inactive}`}>
                              {u.status || 'Active'}
                            </span>
                            {u.archived && (
                              <span className="text-[10px] font-semibold text-slate-400" title="Removed from the users collection; restored when set back to Active">
                                Archived — not in database
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button size="sm" variant="outline" onClick={() => openEdit(u)}>
                              <Pencil size={14} className="mr-1.5" />
                              Edit
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => openResetPw(u)} title="Reset password">
                              <KeyRound size={14} className="mr-1.5" />
                              Password
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {!loading && total > 0 && (
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50/60 rounded-b-xl">
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                totalItems={total}
                onPageChange={setPage}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Customer modal */}
      <Modal isOpen={showAdd} onClose={() => setShowAdd(false)} title="Add Customer">
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Name">
              <input value={form.user} onChange={setField('user')} className={inputCls} placeholder="Contact name" />
            </Field>
            <Field label="Company">
              <input value={form.company} onChange={setField('company')} className={inputCls} placeholder="Company name" />
            </Field>
          </div>
          <Field label="Email *">
            <input type="email" value={form.email} onChange={setField('email')} className={inputCls} placeholder="customer@example.com" required />
          </Field>
          <Field label="Password *">
            <input type="text" value={form.password} onChange={setField('password')} className={inputCls} placeholder="Initial password" required />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field label="Role">
              <select value={form.role} onChange={setField('role')} className={inputCls}>
                <option value="Customer">Customer</option>
                <option value="Sales">Sales User</option>
                {/* Inventory roles work the business's own stock rather than
                    their own orders, so they see every brand and none of the
                    ordering screens. */}
                <option value="Inventory Manager">Inventory Manager</option>
                <option value="Warehouse User">Warehouse User</option>
                <option value="Management">Management</option>
                <option value="Admin">Admin</option>
              </select>
            </Field>
            <Field label="Customer Category">
              <select
                value={form.customerCategory}
                onChange={setField('customerCategory')}
                className={inputCls}
                disabled={form.role === 'Admin' || form.role === 'Sales'}
              >
                <option value="Non-MSIL">Non-MSIL</option>
                <option value="MSIL">MSIL</option>
              </select>
            </Field>
             <Field label="Status">
               <select value={form.status} onChange={setField('status')} className={inputCls}>
                 <option value="Active">Active</option>
                 <option value="Inactive">Inactive</option>
                 <option value="Suspended">Suspended</option>
               </select>
             </Field>
           </div>
 
           <div className="flex flex-col gap-2 mt-1">
             <span className="text-xs font-bold text-slate-600">Brand Access</span>
             <div className="flex gap-4">
               <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                 <input
                   type="checkbox"
                   checked={form.brandAccess?.koken}
                   onChange={(e) => setForm(f => ({ ...f, brandAccess: { ...f.brandAccess, koken: e.target.checked } }))}
                   className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                 />
                 Koken
               </label>
               <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                 <input
                   type="checkbox"
                   checked={form.brandAccess?.bix}
                   onChange={(e) => setForm(f => ({ ...f, brandAccess: { ...f.brandAccess, bix: e.target.checked } }))}
                   className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                 />
                 BIX
               </label>
               <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                 <input
                   type="checkbox"
                   checked={form.brandAccess?.imada}
                   onChange={(e) => setForm(f => ({ ...f, brandAccess: { ...f.brandAccess, imada: e.target.checked } }))}
                   className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                 />
                 IMADA
               </label>
             </div>
           </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 mt-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button type="submit" variant="primary" size="sm" disabled={saving}>
              {saving ? 'Creating...' : 'Create Customer'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Edit User modal */}
      <Modal isOpen={!!editUser} onClose={closeEdit} title="Edit User">
        {editForm && (
          <form onSubmit={handleEditSave} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Name">
                <input value={editForm.user} onChange={setEditField('user')} className={inputCls} placeholder="Contact name" />
              </Field>
              <Field label="Company">
                <input value={editForm.company} onChange={setEditField('company')} className={inputCls} placeholder="Company name" />
              </Field>
            </div>
            <Field label="Email *">
              <input type="email" value={editForm.email} onChange={setEditField('email')} className={inputCls} placeholder="customer@example.com" required />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Role">
                <select value={editForm.accessLevel} onChange={setEditField('accessLevel')} className={inputCls}>
                  {ACCESS_LEVELS.map((lvl) => (
                    <option key={lvl} value={lvl}>{lvl}</option>
                  ))}
                </select>
              </Field>
               <Field label="Status">
                 <select value={editForm.status} onChange={setEditField('status')} className={inputCls}>
                   <option value="Active">Active</option>
                   <option value="Inactive">Inactive</option>
                   <option value="Suspended">Suspended</option>
                 </select>
               </Field>
             </div>

            {/* What each status actually does, stated where the choice is made. */}
            {editForm.status === 'Suspended' && (
              <p className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                Suspending deletes this account from the users database. Its bookings and indents
                are kept, and setting the status back to Active recreates the account exactly as it
                was.
              </p>
            )}
            {editForm.status === 'Inactive' && (
              <p className="text-xs font-semibold text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                An inactive account stays in the database but cannot sign in.
              </p>
            )}
            {editUser?.archived && editForm.status !== 'Suspended' && (
              <p className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                Saving restores this account to the database with its original ID, so its history
                reattaches.
              </p>
            )}
 
             <div className="flex flex-col gap-2 mt-1">
               <span className="text-xs font-bold text-slate-600">Brand Access</span>
               <div className="flex gap-4">
                 <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                   <input
                     type="checkbox"
                     checked={editForm.brandAccess?.koken}
                     onChange={(e) => setEditForm(f => ({ ...f, brandAccess: { ...f.brandAccess, koken: e.target.checked } }))}
                     className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                   />
                   Koken
                 </label>
                 <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                   <input
                     type="checkbox"
                     checked={editForm.brandAccess?.bix}
                     onChange={(e) => setEditForm(f => ({ ...f, brandAccess: { ...f.brandAccess, bix: e.target.checked } }))}
                     className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                   />
                   BIX
                 </label>
                 <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                   <input
                     type="checkbox"
                     checked={editForm.brandAccess?.imada}
                     onChange={(e) => setEditForm(f => ({ ...f, brandAccess: { ...f.brandAccess, imada: e.target.checked } }))}
                     className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                   />
                   IMADA
                 </label>
               </div>
             </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 mt-2">
              <Button type="button" variant="outline" size="sm" onClick={closeEdit}>Cancel</Button>
              <Button type="submit" variant="primary" size="sm" disabled={savingEdit}>
                {savingEdit ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <ConfirmationDialog
        isOpen={confirmSuspend}
        onClose={() => setConfirmSuspend(false)}
        onConfirm={saveEdit}
        loading={savingEdit}
        title="Suspend this account?"
        confirmText="Suspend & remove"
        variant="danger"
        description={`${editUser?.user || editUser?.company || editUser?.email} will be deleted from the users database and will not be able to sign in. Their bookings and indents are kept, and setting the account back to Active recreates it exactly as it was.`}
      />

      {/* Reset Password modal */}
      <Modal isOpen={!!pwUser} onClose={() => setPwUser(null)} title="Reset Password" size="sm">
        {pwUser && (
          <form onSubmit={handleResetPw} className="flex flex-col gap-4">
            <p className="text-sm text-slate-600">
              Set a new password for{' '}
              <span className="font-bold text-slate-800">{pwUser.user || pwUser.company || pwUser.email}</span>.
              The user can sign in with it immediately.
            </p>
            <Field label="New Password *">
              <input
                type="text"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                className={inputCls}
                placeholder="At least 5 characters"
                autoFocus
                required
              />
            </Field>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 mt-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setPwUser(null)}>Cancel</Button>
              <Button type="submit" variant="primary" size="sm" disabled={savingPw}>
                {savingPw ? 'Resetting...' : 'Reset Password'}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
};

const inputCls =
  'w-full px-3 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 text-slate-800';

const Field = ({ label, children }) => (
  <div className="flex flex-col gap-1.5">
    <label className="text-xs font-bold text-slate-600">{label}</label>
    {children}
  </div>
);

export default UserManagement;
