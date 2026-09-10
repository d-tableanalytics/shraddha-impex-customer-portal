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
import { UserPlus, Shield, Mail, Search, X, Pencil, KeyRound, SlidersHorizontal } from 'lucide-react';
import { TableSkeleton } from '../../../components/ui/TableSkeleton';
import { UserAccessModal } from '../../../components/admin/UserAccessModal';
import toast from 'react-hot-toast';
import {
  canOpenUserManagement, canManageAllUsers, canManageAccount, assignableRolesFor, canManageRoles,
} from '../../../utils/permissions';

/**
 * Customer master details.
 *
 * Mirrors CUSTOMER_MASTER_FIELDS in backend/modules/users/user.controller.js.
 */
const CUSTOMER_MASTER_FIELDS = [
  { key: 'customerName', label: 'Customer Name', placeholder: 'Legal / trading name' },
  { key: 'phone', label: 'Phone Number', placeholder: '+91 98765 43210' },
  { key: 'location', label: 'Location', placeholder: 'City / area' },
  { key: 'shopNumber', label: 'Shop Number', placeholder: 'Shop / unit no.' },
  { key: 'vendorNumber', label: 'Vendor Number', placeholder: 'Vendor code' },
  { key: 'gstNumber', label: 'GST Number', placeholder: '22AAAAA0000A1Z5' },
];

/**
 * Delivery and invoice addresses.
 *
 * Mirrors CUSTOMER_ADDRESS_FIELDS in backend/modules/users/user.controller.js.
 *
 * SEPARATE from the master set above, and optional, for two reasons: an address
 * legitimately changes when a customer moves (the master fields identify the
 * legal entity and are meant not to), and every account that already exists has
 * neither, so requiring them would block editing any of them.
 *
 * Textareas, not inputs — an address is several lines, and the picklist prints
 * the newlines the admin types here.
 */
const CUSTOMER_ADDRESS_FIELDS = [
  {
    key: 'shippingAddress',
    label: 'Shipping Address',
    placeholder: 'Where goods are delivered',
  },
  {
    key: 'billingAddress',
    label: 'Billing Address',
    placeholder: 'Where the invoice goes — leave blank if same as shipping',
  },
];

/** A GST number is 15 characters. Checked loosely — format varies in practice. */
const gstLooksValid = (v) => String(v || '').trim().length === 15;
const phoneLooksValid = (v) => String(v || '').replace(/[^0-9]/g, '').length >= 7;

const PAGE_SIZE = 10;

const CATEGORY_STYLES = {
  MSIL: 'bg-primary-50 text-primary-700 border-primary-200',
  // 'Customer' is the current name for the non-MSIL category. The two older
  // spellings are still in the database on accounts written before the rename,
  // so they keep their badge colour rather than falling through to no style.
  Customer: 'bg-amber-50 text-amber-700 border-amber-200',
  'Regular Customer': 'bg-amber-50 text-amber-700 border-amber-200',
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
  customerName: '',
  phone: '',
  location: '',
  shopNumber: '',
  vendorNumber: '',
  gstNumber: '',
  shippingAddress: '',
  billingAddress: '',
  // The new account's access level, in the same vocabulary the edit modal and
  // the table use: 'Customer' and 'MSIL' are levels here, not a role plus a
  // category. It is turned back into { role, customerCategory } on submit.
  accessLevel: 'Customer', // overridden per audience when the Add modal opens
  status: 'Active',
  brandAccess: {
    koken: true,
    bix: true,
    imada: true,
  },
};

/**
 * An "access level" is just a ROLE, with one exception: the Customer role is
 * split by its customer CATEGORY, because 'Customer' and 'MSIL' are one role
 * and two categories, and the person choosing in this dropdown thinks of them
 * as two options.
 *
 * EVERY LEVEL ROUND-TRIPS. This list used to be four hard-coded entries —
 * Customer, MSIL, Sales User, Admin — while the system had seven roles. The
 * consequence was not a missing option but silent data loss: accessLevelOf()
 * fell through to 'Customer' for every role it did not know, so opening an
 * Inventory Manager, Warehouse User, Management or Import Team account in the
 * edit modal showed "Customer", and saving ANY unrelated change — a phone
 * number, a status, a brand tick — wrote that back and demoted the account.
 * The comment above the old list warned about exactly this for Sales, and then
 * the same trap was left open for every role added afterwards.
 *
 * So the list is DERIVED from the roles the actor may assign rather than
 * written out. A role added to permissions.js appears here automatically, and
 * cannot fall behind again.
 */
const SALES_LEVEL = 'Sales User';

/**
 * The levels that ARE a customer. Both sit on the Customer role and differ only
 * by category, and both trade with us — so both need the master details, and
 * neither may be created without them.
 */
const CUSTOMER_LEVELS = ['Customer', 'MSIL'];
const isCustomerLevel = (level) => CUSTOMER_LEVELS.includes(level);

/** The level an existing account currently sits at. Never guesses. */
const accessLevelOf = (u) => {
  const role = u?.role || 'Customer';
  if (role === 'Customer') return u?.customerCategory === 'MSIL' ? 'MSIL' : 'Customer';
  if (role === 'Sales') return SALES_LEVEL;
  return role;
};

/** What a chosen level means in the fields the server stores. */
const accessLevelToFields = (level) => {
  if (level === 'MSIL') return { role: 'Customer', customerCategory: 'MSIL' };
  if (level === 'Customer') return { role: 'Customer', customerCategory: 'Customer' };
  if (level === SALES_LEVEL) return { role: 'Sales' };
  // Every other level IS the role. The category is deliberately left alone:
  // it does not apply to a staff account, and clearing it would lose the
  // category of an account moved to staff and back.
  return { role: level };
};

/**
 * Every level this actor may set, in the order the roles are listed.
 *
 * `customRoles` carries the roles a Super Admin has created since this bundle
 * was built. They are passed in rather than read from a constant, because a
 * role invented last week cannot appear in a list written last year - and a
 * role nobody can be assigned to is not much of a role.
 */
const accessLevelsFor = (actor, customRoles = []) =>
  assignableRolesFor(actor, customRoles).flatMap((role) => {
    if (role === 'Customer') return ['Customer', 'MSIL'];
    if (role === 'Sales') return [SALES_LEVEL];
    return [role];
  });

/**
 * ── ONE COMPONENT, TWO AUDIENCES ─────────────────────────────────────────
 *
 * `audience` decides which POPULATION this screen manages:
 *
 *   'customers'  the businesses we sell to. Sales owns this, holding
 *                MANAGE_CUSTOMER_USERS, and the server already refuses them any
 *                account whose role is not Customer.
 *   'internal'   staff — Sales, Inventory Manager, Admin. Needs MANAGE_USERS,
 *                the permission that can grant privilege.
 *
 * Parameterised rather than forked into two 900-line files: the two screens are
 * the same table, the same modals and the same API, pointed at different rows.
 * Copying it would guarantee that a fix to one silently misses the other — and
 * the thing that must NOT be shared is the population and the permission, which
 * is exactly what this prop separates.
 *
 * The routes mount it twice, and the module registry decides which route each
 * DOMAIN offers: Customer Management is customer-portal-only, Internal User
 * Management is served by both because the staff it creates work in both.
 */
export const UserManagement = ({ audience = 'internal' }) => {
  const isCustomerAudience = audience === 'customers';
  const {
    users, fetchUsers, loading, createUser, updateUser, resetUserPassword,
    roles, fetchAssignableRoles,
  } = useAdminStore();
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
  // The account whose extra access is being edited, if any.
  const [accessUser, setAccessUser] = useState(null);
  const [newPw, setNewPw] = useState('');
  const [savingPw, setSavingPw] = useState(false);

  // Admin manages every account; Sales manages CUSTOMER accounts only. The
  // server enforces both — this decides what the screen offers.
  const mayOpen = canOpenUserManagement(user);
  const isAdmin = canManageAllUsers(user);

  /**
   * Who may hand one account access beyond its role.
   *
   * BOTH permissions, not just manage_users. The server only demands the first,
   * but the screen also has to SHOW what the account's role already grants -
   * and that comes from the roles API, which is behind manage_roles. Without it
   * the grid would render every inherited cell as empty and invite an admin to
   * "grant" forty permissions the account already had.
   *
   * Super Admin holds both through the wildcard, so this only ever excludes a
   * custom role built with user management and nothing else.
   */
  const mayGrantExtraAccess = isAdmin && canManageRoles(user);

  // The roles a Super Admin has created. Only an actor who may manage every
  // account can assign one, so nobody else pays for the fetch.
  const customRoles = roles.filter((r) => !r.isSystem).map((r) => r.name);
  // The levels this actor may create an account at. Same list the edit modal
  // offers, so an account is created at the level it would later be edited to
  // rather than through a different pair of dropdowns.
  const forAudience = (levels) => levels.filter((l) =>
    isCustomerAudience ? (l === 'Customer' || l === 'MSIL') : (l !== 'Customer' && l !== 'MSIL'),
  );
  const addLevels = forAudience(accessLevelsFor(user, customRoles));

  /**
   * The levels the edit modal offers.
   *
   * A non-Admin cannot change the level at all, so they are shown the one the
   * account already holds rather than a list they cannot use.
   *
   * The account's CURRENT level is always included, even for an Admin. Without
   * it a role this build does not offer — a legacy value, or one removed from
   * the list — would render as a blank select and be written away by the next
   * save, which is the same silent demotion this mapping was fixed to stop.
   */
  const editLevels = editForm
    ? [...new Set([
      ...(isAdmin ? forAudience(accessLevelsFor(user, customRoles)) : []),
      // The account's CURRENT level is always kept, even when the audience
      // filter would exclude it — otherwise a legacy value renders as a blank
      // select and is written away by the next save.
      editForm.accessLevel,
    ])].filter(Boolean)
    : [];

  /*
   * The population, before any search.
   *
   * A Customer account and a staff account are different objects with different
   * required fields, and mixing them in one list is what made "add a user" mean
   * two things. `role === 'Customer'` is the whole distinction — MSIL is a
   * customerCategory ON a Customer, not a separate role.
   */
  const audienceUsers = users.filter((u) =>
    isCustomerAudience ? u.role === 'Customer' : u.role !== 'Customer',
  );

  const q = search.trim().toLowerCase();
  const filteredUsers = q
    ? audienceUsers.filter((u) =>
        [u.user, u.company, u.email]
          .some((v) => String(v || '').toLowerCase().includes(q)),
      )
    : audienceUsers;

  const { page, setPage, pageItems: visibleUsers, total } = usePagination(filteredUsers, PAGE_SIZE);

  useEffect(() => {
    if (mayOpen) fetchUsers();
  }, [fetchUsers, mayOpen]);

  // The custom roles, for the access-level dropdown. Only an actor who may
  // manage every account can assign one, so a Sales user does not pay for a
  // request whose answer they could not use.
  useEffect(() => {
    if (isAdmin) fetchAssignableRoles();
  }, [isAdmin, fetchAssignableRoles]);

  // A new search gives a different result set — start it from the first page.
  useEffect(() => {
    setPage(1);
  }, [q, setPage]);

  /*
   * The gate differs by audience, and the difference is the point.
   *
   * Customer Management admits anyone who may manage customers — that includes
   * Sales, which is the role that onboards them.
   * Internal User Management demands MANAGE_USERS, so Sales cannot reach it.
   * Without that split a salesperson could open the screen that creates an
   * Admin, which is the privilege-escalation path the two permissions exist to
   * keep apart. The server enforces both again on every call.
   */
  const mayOpenThisScreen = isCustomerAudience ? mayOpen : isAdmin;
  if (user && !mayOpenThisScreen) {
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
      customerName: u.customerName || '',
      phone: u.phone || '',
      location: u.location || '',
      shopNumber: u.shopNumber || '',
      vendorNumber: u.vendorNumber || '',
      gstNumber: u.gstNumber || '',
      shippingAddress: u.shippingAddress || '',
      billingAddress: u.billingAddress || '',
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

    // The six master details are mandatory for a customer — MSIL included,
    // since MSIL is a customer category and not a staff role — and the server
    // refuses the create without them. Checked here so the answer names the
    // missing fields while the form is still open, rather than after a 400.
    if (isCustomerLevel(form.accessLevel)) {
      const missing = CUSTOMER_MASTER_FIELDS.filter((f) => !String(form[f.key] || '').trim());
      if (missing.length) {
        toast.error(`Required: ${missing.map((f) => f.label).join(', ')}`);
        return;
      }
      if (!phoneLooksValid(form.phone)) {
        toast.error('Enter a valid phone number.');
        return;
      }
      if (!gstLooksValid(form.gstNumber)) {
        toast.error('A GST number is 15 characters.');
        return;
      }
    }

    setSaving(true);
    // The server stores a role and a category, not a level.
    const { accessLevel, ...details } = form;
    const res = await createUser({ ...details, ...accessLevelToFields(accessLevel) });
    setSaving(false);
    if (res.success) {
      toast.success('User created');
      setForm(emptyForm);
      setShowAdd(false);
    } else {
      toast.error(res.error || 'Failed to create user');
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-800">
            {isCustomerAudience ? 'Customer Management' : 'Internal User Management'}
          </h2>
          <p className="text-sm text-slate-500">
            {isCustomerAudience
              ? 'Onboard and maintain the businesses we sell to — categories, brand access and contact details.'
              : 'Create and maintain staff accounts. These people work across both portals.'}
          </p>
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
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              // Open at a level this audience can actually create, so the first
              // thing an admin sees is not a role they must immediately change.
              setForm((f) => ({ ...f, accessLevel: addLevels[0] ?? f.accessLevel }));
              setShowAdd(true);
            }}
            className="shrink-0"
          >
            <UserPlus size={16} className="mr-2" />
            Add User
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
                  {/*
                    CUSTOMER-ONLY COLUMNS.
                    `customerCategory` is MSIL vs non-MSIL, and `brandAccess`
                    scopes which brands a CUSTOMER may order — see the note on
                    INVENTORY_ROLES in backend/config/permissions.js, which says
                    the flags exist to scope customers and that staff roles see
                    every brand regardless.

                    On the internal list they were worse than merely redundant:
                    the Category cell fell back to printing the account's role,
                    duplicating the column beside it, and Brand Access rendered a
                    red "None" against inventory staff who in fact see all three
                    brands. A column that states the opposite of the truth is
                    worse than no column.
                  */}
                  {isCustomerAudience && (
                    <>
                      <th className="px-6 py-4 font-bold text-slate-600">Customer Category</th>
                      <th className="px-6 py-4 font-bold text-slate-600">Brand Access</th>
                    </>
                  )}
                  <th className="px-6 py-4 font-bold text-slate-600">Status</th>
                  <th className="px-6 py-4 font-bold text-slate-600 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <TableSkeleton rows={PAGE_SIZE} columns={6} />
                ) : filteredUsers.length === 0 ? (
                  <tr>
                    {/* Must track the header count, which is two shorter on the
                        internal list — a fixed 6 would leave the empty-state row
                        spanning past the last column. */}
                    <td colSpan={isCustomerAudience ? 6 : 4} className="px-6 py-12 text-center text-slate-400">
                      {q ? `No users match "${search}".` : 'No users found.'}
                    </td>
                  </tr>
                ) : (
                  visibleUsers.map((u) => {
                    const displayName = u.user || u.company || u.email;
                    // A customer category belongs to CUSTOMERS. Testing against
                    // Admin alone meant every staff role — Sales, Inventory
                    // Manager, Warehouse, Management — was offered an
                    // MSIL/Customer dropdown that means nothing for them, and
                    // could be set to a value that never applies. Staff work
                    // across both categories by definition.
                    const isCustomer = (u.role || 'Customer') === 'Customer';
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
                        {isCustomerAudience && (
                          <>
                        <td className="px-6 py-4">
                          {isCustomer ? (
                            <select
                              value={u.customerCategory === 'MSIL' ? 'MSIL' : 'Customer'}
                              onChange={(e) => handleCategoryChange(u._id, e.target.value)}
                              disabled={u.archived}
                              title={u.archived ? 'Restore the account to Active to edit it' : undefined}
                              className={`text-xs font-bold rounded-md border px-2.5 py-1.5 outline-none cursor-pointer focus:ring-2 focus:ring-primary-500/20 disabled:opacity-50 disabled:cursor-not-allowed ${CATEGORY_STYLES[u.customerCategory] || CATEGORY_STYLES.Customer}`}
                            >
                              <option value="Customer">Customer</option>
                              <option value="MSIL">MSIL</option>
                            </select>
                          ) : (
                            /* Was hardcoded "N/A (Admin)", which labelled a Sales
                               user as an Admin. Staff work across both MSIL and
                               Customer, so the honest value is the role held. */
                            <span
                              title={`Customer category does not apply to a ${u.role} account — they work across both MSIL and Customer.`}
                              className="px-2 py-1 bg-slate-100 text-slate-600 text-xs font-bold rounded-md border border-slate-200 w-fit inline-block"
                            >
                              {u.role}
                            </span>
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
                          </>
                        )}
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
                            {/* Only accounts this actor may manage. A
                                salesperson sees staff rows (never, in fact —
                                the API scopes them out) but could not act on
                                one, so no button is offered for it. */}
                            {canManageAccount(user, u) && (
                              <>
                                <Button size="sm" variant="outline" onClick={() => openEdit(u)}>
                                  <Pencil size={14} className="mr-1.5" />
                                  Edit
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => openResetPw(u)} title="Reset password">
                                  <KeyRound size={14} className="mr-1.5" />
                                  Password
                                </Button>
                                {/* Extra access is admin-only, and meaningless
                                    for an archived row - that account is not in
                                    the users collection, so there is nothing to
                                    write to until it is restored. */}
                                {mayGrantExtraAccess && !u.archived && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setAccessUser(u)}
                                    title="Grant this account access beyond its role"
                                  >
                                    <SlidersHorizontal size={14} className="mr-1.5" />
                                    Access
                                  </Button>
                                )}
                              </>
                            )}
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

      {/* Add User modal */}
      <Modal isOpen={showAdd} onClose={() => setShowAdd(false)} title="Add User">
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

          {/* The role comes BEFORE the master details, because it decides
              whether they are asked for at all. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Role">
              {/* One list, the same one the edit modal offers. Customer and
                  MSIL are LEVELS here rather than a role plus a separate
                  category dropdown: they are the two kinds of customer the
                  business has, and asking for them in two places offered an
                  MSIL category on an Inventory Manager, where nothing reads it.

                  Only what this actor may assign is listed. A salesperson gets
                  Customer and MSIL and nothing else — the server refuses
                  anything wider, so offering it would only produce a 403.
                  Inventory roles work the business's own stock rather than
                  their own orders, so they see every brand and none of the
                  ordering screens. */}
              <select
                value={form.accessLevel}
                onChange={setField('accessLevel')}
                className={inputCls}
                disabled={addLevels.length === 1}
              >
                {addLevels.map((lvl) => (
                  <option key={lvl} value={lvl}>{lvl}</option>
                ))}
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

          {/* Customer master details — shown for a Customer or an MSIL account,
              and for nothing else. Directly under the role so it appears the
              moment one of those two is chosen; a staff account has no GST or
              shop number and is never asked for one.

              All six are mandatory at creation — the server refuses a customer
              without them — and they are what Booking History shows as the
              customer's name, location and phone. They can be corrected later
              in the edit modal. */}
          {isCustomerLevel(form.accessLevel) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 flex flex-col gap-3">
              <div>
                <h4 className="text-xs font-bold text-amber-800 uppercase tracking-wide">
                  Customer master details
                </h4>
                <p className="text-[11px] text-amber-700 mt-0.5 leading-relaxed">
                  Required for {form.accessLevel === 'MSIL' ? 'an MSIL' : 'a Customer'} account —
                  these identify the entity we trade with, and appear with the account's bookings.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {CUSTOMER_MASTER_FIELDS.map((f) => (
                  <Field key={f.key} label={`${f.label} *`}>
                    <input
                      value={form[f.key]}
                      onChange={setField(f.key)}
                      className={inputCls}
                      placeholder={f.placeholder}
                      required
                    />
                  </Field>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                {CUSTOMER_ADDRESS_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label}>
                    <textarea
                      value={form[f.key]}
                      onChange={setField(f.key)}
                      className={`${inputCls} min-h-[64px] resize-y`}
                      placeholder={f.placeholder}
                      rows={3}
                    />
                  </Field>
                ))}
              </div>
            </div>
          )}

           {/* Customer-only: brand access scopes which brands a CUSTOMER may
               order. Staff roles see every brand regardless. */}
           {isCustomerAudience && (
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
           )}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 mt-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button type="submit" variant="primary" size="sm" disabled={saving}>
              {saving ? 'Creating...' : 'Create User'}
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
                {/* EVERY role can be changed here, in either direction — an
                    account is not stuck with the role it was created under.
                    Which roles are offered is Admin's alone: the server refuses
                    a role change from anyone else, so a salesperson sees the
                    level their customer holds but cannot move it. */}
                <select
                  value={editForm.accessLevel}
                  onChange={setEditField('accessLevel')}
                  className={inputCls}
                  disabled={!isAdmin}
                  title={isAdmin ? undefined : 'Only an administrator can change an account role.'}
                >
                  {editLevels.map((lvl) => (
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

            {/* Customer master details — follows the level CHOSEN above, not
                the one the account was opened at, so moving a staff account to
                Customer or MSIL asks for them straight away instead of after a
                save and a reopen. */}
            {isCustomerLevel(editForm.accessLevel) && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <Shield size={13} className="text-slate-400" />
                  <h4 className="text-xs font-bold text-slate-600 uppercase tracking-wide">
                    Customer master details
                  </h4>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1">
                  {CUSTOMER_MASTER_FIELDS.map((f) => (
                    <Field key={f.key} label={f.label}>
                      <input
                        value={editForm[f.key]}
                        onChange={setEditField(f.key)}
                        className={inputCls}
                        placeholder={f.placeholder}
                      />
                    </Field>
                  ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                  {CUSTOMER_ADDRESS_FIELDS.map((f) => (
                    <Field key={f.key} label={f.label}>
                      <textarea
                        value={editForm[f.key]}
                        onChange={setEditField(f.key)}
                        className={`${inputCls} min-h-[64px] resize-y`}
                        placeholder={f.placeholder}
                        rows={3}
                      />
                    </Field>
                  ))}
                </div>
              </div>
            )}

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
 
             {/* Customer-only — see the note in the Add modal. */}
             {isCustomerAudience && (
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
             )}

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
      <UserAccessModal user={accessUser} onClose={() => setAccessUser(null)} />

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
