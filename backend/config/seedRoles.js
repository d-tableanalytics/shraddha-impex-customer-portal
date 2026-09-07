import Role from '../models/Role.js';
import { BASELINE_ROLE_PERMISSIONS, SYSTEM_ROLE_NAMES } from './permissions.js';
import { grantsFromPermissions } from './moduleRegistry.js';
import { loadRoles } from '../utils/roleResolver.js';

/**
 * Seed and migrate the roles collection.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPLACES
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The previous version seeded four rows - Administrator, Sales Manager,
 * Inventory Manager, Staff - and bailed out if the collection was non-empty.
 * Those rows were never consulted by anything: enforcement read a hardcoded map
 * keyed by User.role, whose values ('Admin', 'Sales', ...) do not even match
 * those names. Editing them in the permission matrix screen changed nothing.
 *
 * So there were two role systems: one that worked and was not editable, and one
 * that was editable and did not work. This joins them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THREE RULES THIS FOLLOWS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. NOTHING IS DELETED. The four legacy rows are kept and migrated, not
 *    dropped, even though nothing referenced them. They are somebody's
 *    configuration; requirement 7 says configuration survives. A role named
 *    'Staff' with no permissions is not evidence that nobody wanted it.
 *
 * 2. MIGRATION HAPPENS ONCE, PER ROLE. Grants are written only to a role that
 *    has none. Re-running this on every boot must not undo a Super Admin's
 *    edits - a seed that quietly restores yesterday's matrix every morning is
 *    worse than one that never ran.
 *
 * 3. GRANTS ARE DERIVED, NOT RETYPED. Each role's matrix is computed from the
 *    permission list that already defined it, through
 *    grantsFromPermissions(). Hand-writing the equivalent matrix for seven
 *    roles is where the mistakes would be, and the mistakes would be silent
 *    ones that hand somebody access they never had.
 */

/**
 * The legacy rows, and what they turn into.
 *
 * These names came from a seed written before the User.role enum existed, so no
 * account has ever carried one. They are converted to ordinary custom roles:
 * visible in the matrix, editable, deletable - just no longer pretending to be
 * the system's roles.
 *
 * 'Inventory Manager' is deliberately absent. The legacy seed used that exact
 * name, and so does the real enum, so the two collide on the unique index -
 * there is one document, and the loop below treats it as the SYSTEM role it
 * shares a name with, merging rather than duplicating. That is the right
 * outcome: an admin looking at "Inventory Manager" should see one role, holding
 * everything either definition gave it.
 */
const LEGACY_ROLE_DESCRIPTIONS = {
  Administrator: 'Legacy role, retained from the original seed. Superseded by Super Admin.',
  'Sales Manager': 'Legacy role, retained from the original seed. Superseded by Sales.',
  Staff: 'Legacy role, retained from the original seed. Holds no permissions.',
};

const slugify = (name) =>
  String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Display order: Super Admin first, Customer last, the rest in between. */
const ORDER = {
  'Super Admin': 0,
  Admin: 1,
  Sales: 2,
  'Inventory Manager': 3,
  'Warehouse User': 4,
  Management: 5,
  'Import Team': 6,
  Customer: 7,
};

const DESCRIPTIONS = {
  'Super Admin': 'Full, permanent access to the entire ERP. Cannot be restricted.',
  Admin: 'Full, permanent access to the entire ERP. The original name for Super Admin.',
  Sales: 'Works the sales desk: reviews bookings, amends them before the PO, raises the PO, onboards customers.',
  'Inventory Manager': 'Owns stock: master data, receipts, issues, counts, transfers and adjustments.',
  'Warehouse User': 'Floor operator: receives and counts stock at their own site.',
  Management: 'Oversight: reads everything and approves. Creates nothing.',
  'Import Team': 'Loads and corrects catalogue data in bulk. Holds no ordering or booking access.',
  Customer: 'The Customer Portal, and nothing else.',
};

export const seedDefaultRoles = async () => {
  try {
    let created = 0;
    let migrated = 0;

    // ── The system roles ────────────────────────────────────────────────
    for (const name of SYSTEM_ROLE_NAMES) {
      const baseline = BASELINE_ROLE_PERMISSIONS[name] || [];
      const isSuperAdmin = baseline.includes('*');

      // Derived from the very list that has been enforcing this role's access
      // all along, so the matrix opens showing what is already true.
      const grants = grantsFromPermissions(baseline);

      const existing = await Role.findOne({ name });

      if (!existing) {
        await Role.create({
          name,
          slug: slugify(name),
          description: DESCRIPTIONS[name] || '',
          permissions: [],
          grants,
          isSuperAdmin,
          isSystem: true,
          // Requirement 1, expressed as a property of the role rather than as a
          // special case in the resolver. See the note in models/Role.js.
          portalOnly: name === 'Customer',
          order: ORDER[name] ?? 100,
        });
        created += 1;
        continue;
      }

      // The role already exists - either from the legacy seed (the
      // 'Inventory Manager' collision) or from a previous boot. Fill in what is
      // missing; never overwrite grants somebody has edited.
      const patch = {};
      if (!existing.slug) patch.slug = slugify(name);
      if (!existing.isSystem) patch.isSystem = true;
      if (existing.isSuperAdmin !== isSuperAdmin) patch.isSuperAdmin = isSuperAdmin;
      if (name === 'Customer' && !existing.portalOnly) patch.portalOnly = true;
      if (existing.order == null || existing.order === 100) patch.order = ORDER[name] ?? 100;
      if (!existing.description) patch.description = DESCRIPTIONS[name] || '';

      // Rule 2: only a role with an empty matrix gets one written.
      if (!existing.grants?.length) {
        // Rule 1 in miniature. Where a legacy row shares this name, its old flat
        // permissions are folded in alongside the baseline's, so the migrated
        // matrix is the union of both definitions rather than one replacing the
        // other.
        patch.grants = grantsFromPermissions([...baseline, ...(existing.permissions || [])]);
        migrated += 1;
      }

      if (Object.keys(patch).length) {
        await Role.updateOne({ _id: existing._id }, { $set: patch });
      }
    }

    // ── The legacy rows ─────────────────────────────────────────────────
    for (const [name, description] of Object.entries(LEGACY_ROLE_DESCRIPTIONS)) {
      const existing = await Role.findOne({ name });
      if (!existing) continue; // never seeded here, or already removed by hand

      const patch = {};
      if (!existing.slug) patch.slug = slugify(name);
      if (!existing.description) patch.description = description;
      if (existing.isSystem === undefined) patch.isSystem = false;

      // Their flat permissions become matrix grants, so they are visible and
      // editable on the same screen as everything else. The flat list itself is
      // LEFT IN PLACE - the resolver still reads it, so nothing this row grants
      // can be lost in translation if the mapping turns out to be imperfect.
      if (!existing.grants?.length && existing.permissions?.length) {
        patch.grants = grantsFromPermissions(existing.permissions);
        migrated += 1;
      }

      if (Object.keys(patch).length) {
        await Role.updateOne({ _id: existing._id }, { $set: patch });
      }
    }

    if (created || migrated) {
      console.log(`[Seed] Roles: ${created} created, ${migrated} migrated into the permission matrix.`);
    }

    // Prime the in-memory mirror the resolver reads. Until this runs the server
    // answers from the compiled baseline alone, which is correct but ignores
    // anything the Super Admin has configured.
    const count = await loadRoles();
    if (count !== null) console.log(`[RBAC] Role cache primed with ${count} role(s).`);
  } catch (error) {
    console.error(`[Seed Error] Failed to seed roles: ${error.message}`);
  }
};

export default seedDefaultRoles;
