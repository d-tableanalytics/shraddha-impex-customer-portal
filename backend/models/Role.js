import mongoose from 'mongoose';

/**
 * A single cell-group in the permission matrix: one sub-module, and the actions
 * granted on it.
 *
 * Stored as a LIST of grants rather than a nested object keyed by module, so a
 * module that is later renamed or removed leaves a row that is obviously stale
 * instead of a key buried in a document nobody can query. It also means a role
 * document is readable: `{ module: 'inventory', submodule: 'counts',
 * actions: ['view','create'] }` says what it means without the registry in hand.
 */
const grantSchema = new mongoose.Schema(
  {
    module: { type: String, required: true },
    submodule: { type: String, required: true },
    actions: [{ type: String, enum: ['view', 'create', 'edit', 'delete', 'approve'] }],
  },
  { _id: false },
);

const roleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    description: { type: String },

    /**
     * Stable machine key. `name` is what the Super Admin sees and may rename;
     * `slug` is what code and links refer to, so renaming "Sales" to "Sales
     * Desk" does not orphan anything.
     */
    slug: { type: String, unique: true, sparse: true, index: true },

    /**
     * LEGACY, AND STILL LOAD-BEARING.
     *
     * The flat permission keys this role grants directly, outside the matrix.
     * It predates `grants` and is deliberately kept for two reasons:
     *
     *  - The four roles seeded before this system existed (Administrator, Sales
     *    Manager, Inventory Manager, Staff) are defined by it. Requirement 7
     *    says existing configuration is preserved, so it is read, not dropped.
     *  - It is the escape hatch for a capability that has no matrix cell yet.
     *    A key can be granted here the day it is added and given a proper cell
     *    later, without blocking on a registry change.
     *
     * The resolver unions this with the compiled grants; neither can revoke
     * what the other allows.
     */
    permissions: [{ type: String }],

    /** The module x sub-module x action matrix. See config/moduleRegistry.js. */
    grants: { type: [grantSchema], default: [] },

    /**
     * Full access to the entire ERP - requirement 2.
     *
     * A FLAG rather than "a role that happens to hold every permission",
     * because those are different promises. A role holding every permission
     * known today stops being complete the moment a new module ships; a role
     * marked super-admin is complete by definition, forever. The resolver
     * answers '*' for it, which is the wildcard authorize() has always
     * understood, so nothing downstream needed teaching.
     */
    isSuperAdmin: { type: Boolean, default: false },

    /**
     * Built into the product. System roles are the seven the code itself
     * references by name - the User.role enum values, the roles the seeded
     * baseline is written against. They may be RE-PERMISSIONED freely (that is
     * the whole point of the matrix) but they cannot be deleted or renamed,
     * because a user document pointing at a role name that no longer exists is
     * an account that cannot sign in.
     */
    isSystem: { type: Boolean, default: false },

    /**
     * Restricts this role to the customer portal - requirement 5.
     *
     * Set on the Customer role. It is enforced as a CEILING in the resolver:
     * whatever the matrix says, a portal-only role can never come away holding
     * a permission outside the customer_portal module. So a Super Admin who
     * ticks "Inventory Master: view" for Customers by accident does not open
     * the warehouse to every customer account - the tick is simply not honoured.
     *
     * Deliberately not "the Customer role is special-cased in the resolver".
     * Special-casing one name means a second customer-shaped role (a read-only
     * guest login, say) silently loses the protection. A flag travels with the
     * role.
     */
    portalOnly: { type: Boolean, default: false },

    /** Display order in the role list. Lower sorts first. */
    order: { type: Number, default: 100 },
  },
  { timestamps: true },
);

export default mongoose.model('Role', roleSchema);
