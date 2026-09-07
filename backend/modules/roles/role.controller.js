import Role from '../../models/Role.js';
import User from '../../models/User.js';
import {
  ACTIONS,
  registryForClient,
  grantsFromPermissions,
  validateGrants,
} from '../../config/moduleRegistry.js';
import { BASELINE_ROLE_PERMISSIONS, SYSTEM_ROLE_NAMES } from '../../config/permissions.js';
import {
  loadRoles,
  resolveRolePermissions,
  resolveUserPermissions,
  grantsForUser,
  menuFor,
} from '../../utils/roleResolver.js';
import { hasPermission } from '../../middlewares/rbac.js';

/**
 * Role administration - requirement 3, and the screen behind requirements 1-4.
 *
 * Every write here ends with loadRoles(). The resolver answers from an
 * in-memory mirror (see utils/roleResolver.js), so a save that does not refresh
 * it is a save that appears to work and changes nobody's access until the next
 * restart. Refreshing before responding means the client's next request already
 * sees the new rules.
 */

const slugify = (name) =>
  String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Only a wildcard holder may create or alter unrestricted roles. */
const isUnrestricted = (actor) => hasPermission(actor, '*');

/**
 * A role, as the admin screen needs it - including the permissions it
 * RESOLVES to.
 *
 * The resolved list is sent because the matrix alone does not tell the whole
 * truth: a system role also carries a compiled-in baseline it cannot fall
 * below, and a legacy role may carry flat permissions with no cell of their
 * own. Showing only the ticks would misrepresent what the role can actually do.
 */
const present = (role) => ({
  _id: role._id,
  name: role.name,
  slug: role.slug,
  description: role.description,
  grants: role.grants || [],
  permissions: role.permissions || [],
  isSuperAdmin: !!role.isSuperAdmin,
  isSystem: !!role.isSystem,
  portalOnly: !!role.portalOnly,
  order: role.order ?? 100,
  // What this role's holders actually end up with, baseline included.
  effectivePermissions: resolveRolePermissions(role.name),
  // The same answer as matrix cells, so the screen can show what the role
  // REALLY has rather than only what someone last ticked. The two differ
  // wherever a compiled-in floor or a legacy flat permission is in play.
  effectiveGrants: grantsFromPermissions(resolveRolePermissions(role.name)),
  // The floor this role cannot be taken below. Sent in both shapes: the flat
  // list for anything reasoning about keys, and the matrix form so the screen
  // can render exactly those cells as locked rather than as ordinary ticks
  // somebody will try, and fail, to clear.
  baselinePermissions: BASELINE_ROLE_PERMISSIONS[role.name] || [],
  baselineGrants: grantsFromPermissions(BASELINE_ROLE_PERMISSIONS[role.name] || []),
  updatedAt: role.updatedAt,
});

export const getRoles = async (req, res, next) => {
  try {
    const roles = await Role.find().sort({ order: 1, name: 1 }).lean();

    // Accounts per role, so the screen can warn before a delete and show who is
    // affected by a change. Counted by role NAME, which is how an account
    // references its role - custom roles included.
    const byName = await User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]);
    const nameCounts = new Map(byName.map((r) => [r._id, r.count]));

    res.status(200).json({
      success: true,
      data: roles.map((role) => ({
        ...present(role),
        userCount: nameCounts.get(role.name) || 0,
      })),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * The module catalogue the matrix is drawn from.
 *
 * Served rather than duplicated on the frontend: the admin screen must offer
 * exactly the cells the backend will honour, and the only way to guarantee that
 * is for both to read the same list. A new module appears on the screen the
 * moment it appears in the registry, with no frontend change at all -
 * requirement 8.
 */
export const getRegistry = async (req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      data: { actions: ACTIONS, modules: registryForClient() },
    });
  } catch (error) {
    next(error);
  }
};

export const createRole = async (req, res, next) => {
  try {
    const { name, description, grants, isSuperAdmin, portalOnly } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'A role name is required.' });
    }

    const trimmed = String(name).trim();

    const exists = await Role.findOne({ name: trimmed });
    if (exists) {
      return res.status(400).json({ success: false, message: 'A role with this name already exists.' });
    }

    // Creating an unrestricted role is creating a second Super Admin. Only
    // somebody who already holds the wildcard may do it.
    if (isSuperAdmin && !isUnrestricted(req.user)) {
      return res.status(403).json({
        success: false,
        message: 'Only a Super Admin can create a role with full system access.',
      });
    }

    const { grants: clean, error } = validateGrants(grants || []);
    if (error) return res.status(400).json({ success: false, message: error });

    const role = await Role.create({
      name: trimmed,
      slug: slugify(trimmed),
      description: description || '',
      grants: clean,
      permissions: [],
      isSuperAdmin: !!isSuperAdmin,
      isSystem: false,
      portalOnly: !!portalOnly,
      order: 100,
    });

    await loadRoles();
    res.status(201).json({ success: true, data: present(role.toObject()) });
  } catch (error) {
    next(error);
  }
};

/**
 * Update a role: its description, its matrix, and - for custom roles - its
 * name.
 *
 * A SYSTEM role cannot be renamed. Users carry their role as a string, and the
 * compiled-in baseline is keyed by that string, so renaming 'Sales' would
 * detach every salesperson from both their permissions and their identity in
 * one save. Re-permissioning a system role is fine and expected; renaming it is
 * not a permission change, it is a data migration.
 */
export const updateRole = async (req, res, next) => {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });

    const { name, description, grants, isSuperAdmin, portalOnly } = req.body;

    if (name !== undefined && String(name).trim() !== role.name) {
      if (role.isSystem) {
        return res.status(400).json({
          success: false,
          message: `"${role.name}" is a built-in role and cannot be renamed. Its permissions can be changed freely.`,
        });
      }
      const trimmed = String(name).trim();
      if (!trimmed) {
        return res.status(400).json({ success: false, message: 'A role name is required.' });
      }
      const clash = await Role.findOne({ name: trimmed, _id: { $ne: role._id } });
      if (clash) {
        return res.status(400).json({ success: false, message: 'A role with this name already exists.' });
      }
      role.name = trimmed;
      role.slug = slugify(trimmed);
    }

    if (description !== undefined) role.description = description;

    if (isSuperAdmin !== undefined && !!isSuperAdmin !== role.isSuperAdmin) {
      if (!isUnrestricted(req.user)) {
        return res.status(403).json({
          success: false,
          message: 'Only a Super Admin can change full-access status on a role.',
        });
      }
      // Demoting the built-in super-admin roles is how an ERP locks everyone
      // out of its own administration screen. The flag is fixed for them.
      if (role.isSystem && BASELINE_ROLE_PERMISSIONS[role.name]?.includes('*')) {
        return res.status(400).json({
          success: false,
          message: `"${role.name}" is the system's full-access role and cannot have that access removed.`,
        });
      }
      role.isSuperAdmin = !!isSuperAdmin;
    }

    if (portalOnly !== undefined) {
      // Lifting the fence off the Customer role would let a mis-tick in the
      // matrix hand every customer account an internal screen. Requirement 1 is
      // not a default somebody can turn off from a checkbox.
      if (role.name === 'Customer' && !portalOnly) {
        return res.status(400).json({
          success: false,
          message: 'Customers are restricted to the Customer Portal. This cannot be lifted.',
        });
      }
      role.portalOnly = !!portalOnly;
    }

    if (grants !== undefined) {
      const { grants: clean, error } = validateGrants(grants);
      if (error) return res.status(400).json({ success: false, message: error });
      role.grants = clean;
    }

    await role.save();
    await loadRoles();

    res.status(200).json({ success: true, data: present(role.toObject()) });
  } catch (error) {
    next(error);
  }
};

/**
 * LEGACY endpoint, kept working.
 *
 * The old permission matrix screen called PUT /roles/:id/permissions with a
 * flat list, and this still does exactly that. Kept because the deployment is
 * not atomic - a browser holding yesterday's bundle will call it - and because
 * the flat list remains a supported way to grant a key that has no matrix cell
 * yet. See the note on `permissions` in models/Role.js.
 */
export const updateRolePermissions = async (req, res, next) => {
  try {
    const { permissions } = req.body;
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ success: false, message: 'permissions must be an array.' });
    }

    // '*' is not grantable this way; isSuperAdmin is the visible, deliberate
    // route to unrestricted access.
    const clean = permissions.filter((p) => typeof p === 'string' && p && p !== '*');

    const role = await Role.findByIdAndUpdate(
      req.params.id,
      { permissions: clean },
      { new: true, runValidators: true },
    );

    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });

    await loadRoles();
    res.status(200).json({ success: true, data: present(role.toObject()) });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete a custom role.
 *
 * Refused for system roles, and refused while anybody still holds it. Deleting
 * a role out from under a live account leaves someone who can sign in and do
 * nothing, with no message explaining why - so the check is on the users, and
 * the error says how many.
 */
export const deleteRole = async (req, res, next) => {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });

    if (role.isSystem || SYSTEM_ROLE_NAMES.includes(role.name)) {
      return res.status(400).json({
        success: false,
        message: `"${role.name}" is a built-in role and cannot be deleted.`,
      });
    }

    const inUse = await User.countDocuments({ role: role.name });
    if (inUse > 0) {
      return res.status(400).json({
        success: false,
        message: `${inUse} account(s) still use "${role.name}". Move them to another role first.`,
      });
    }

    await Role.deleteOne({ _id: role._id });
    await loadRoles();

    res.status(200).json({ success: true, message: `Role "${role.name}" deleted.` });
  } catch (error) {
    next(error);
  }
};

/**
 * The signed-in user's own access.
 *
 * Not behind manage_roles - everybody may ask what THEY can do. It is the same
 * data /auth/me carries, exposed separately so a screen can refresh it after an
 * admin changes something without re-fetching the whole profile.
 */
export const getMyAccess = async (req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        role: req.user.role,
        permissions: resolveUserPermissions(req.user),
        grants: grantsForUser(req.user),
        menu: menuFor(req.user),
      },
    });
  } catch (error) {
    next(error);
  }
};

export default {
  getRoles,
  getRegistry,
  createRole,
  updateRole,
  updateRolePermissions,
  deleteRole,
  getMyAccess,
};
