import mongoose from 'mongoose';
import { isAssignableRoleKey, assertRolesAssignable } from '../shared/permissions/assignment.js';

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  // Plaintext password used to match the auth sheet requirements.
  // TODO: replace with bcrypt.hash / bcrypt.compare once ready.
  password: { type: String, required: true },
  company: { type: String, default: null },
  user: { type: String, default: null }, // Maps to 'USER' column
  avatar: { type: String, default: null }, // Data URL or image link for the profile photo
  preferences: {
    emailNotifications: { type: Boolean, default: true },
    pushNotifications: { type: Boolean, default: false },
  },
  // 'Sales' reviews confirmed bookings, may edit them until the PO is raised,
  // and raises the PO itself.
  //
  // The three inventory roles were added for the IMS (Module M1). Without them
  // the inventory permissions in rbac.js could be declared but never assigned to
  // anyone, so 'Inventory Manager' and the rest would have been unusable:
  //   Inventory Manager — owns stock: master data, receipts, counts, adjustments
  //   Warehouse User    — floor operator: receives and counts at their own site
  //   Management        — oversight: reads everything, approves, creates nothing
  //
  // Permissions live in middlewares/rbac.js — never inline in a controller.
  role: {
    type: String,
    enum: ['Admin', 'Sales', 'Inventory Manager', 'Warehouse User', 'Management', 'Customer'],
    default: 'Customer',
  },

  // ── HRMS roles (AD-3) ───────────────────────────────────────────────────
  // Additive. `role` above is untouched and remains the portal's authority, so
  // every existing check (`req.user.role === 'Admin'`, INVENTORY_ROLES, the
  // legacy permission map) keeps working exactly as before.
  //
  // This array holds HRMS role keys — always `hrms_`-prefixed, so they can
  // never collide with a portal role name. A user may hold both: a salesperson
  // who is also an employee carries role='Sales' and roles=['hrms_employee'].
  //
  // AD-4: a Customer must never hold an HRMS role. Enforced in three places —
  // here at the schema, in assertRolesAssignable() at every write path, and
  // structurally in buildHrmsActor(), which only ever derives grants from
  // `hrms_*` keys. An empty array therefore means no HRMS access at all, which
  // is the correct default for every existing account.
  roles: {
    type: [String],
    default: [],
    validate: {
      validator: (values) => (values ?? []).every((v) => isAssignableRoleKey(v)),
      message: (props) => `roles contains an unknown role key: ${props.value}`,
    },
  },
  // Customer categorisation — drives which bulk-import template applies.
  // 'Customer' is the current name for the non-MSIL category. 'Regular
  // Customer' and 'Non-MSIL' are the two spellings it has had before, kept in
  // the enum so accounts written under them still validate on save — every
  // rule that reads this field asks whether it is 'MSIL', never which of the
  // other three it is (see utils/moq.js).
  customerCategory: { type: String, enum: ['MSIL', 'Customer', 'Regular Customer', 'Non-MSIL'], default: 'Customer' },

  // ── Customer master details ─────────────────────────────────────────────
  // Captured once, when the account is created, and NEVER editable afterwards.
  // They identify the legal entity we trade with — a GST number or a shop
  // number changing on a live account means it is a different customer, and
  // silently rewriting them would leave every past booking attributed to an
  // entity that no longer matches its own record.
  //
  // Enforced in the API by CUSTOMER_MASTER_FIELDS in the user controller, which
  // refuses an update rather than dropping it, so a caller bypassing the UI is
  // told no instead of being ignored.
  //
  // All optional at the schema level: accounts created before these existed
  // must keep loading and saving. "Required" applies to NEW customer creation
  // and is enforced there, not here.
  customerName: { type: String, default: null },
  phone: { type: String, default: null },
  location: { type: String, default: null },
  shopNumber: { type: String, default: null },
  vendorNumber: { type: String, default: null },
  gstNumber: { type: String, default: null },
  brandAccess: {
    koken: { type: Boolean, default: false },
    bix: { type: Boolean, default: false },
    imada: { type: Boolean, default: false }
  },
  moq: { type: String, default: null }, // String type to support 'SKIP'
  showMsilCode: { type: Boolean, default: false }, // Maps to 'Show MSIL Code'
  bookingCcEmails: { type: [String], default: [] }, // Maps to 'Booking CC Emails'
  status: { type: String, enum: ['Active', 'Inactive', 'Suspended'], default: 'Active' },
  lastLogin: { type: Date }
}, { timestamps: true });

/**
 * AD-4, at the document level: a Customer may hold no HRMS role.
 *
 * The path validator on `roles` above catches unknown keys, but the
 * Customer rule is a cross-field check and needs both `role` and `roles`, so it
 * lives here.
 *
 * Note this hook does NOT run for `findOneAndUpdate` / `findByIdAndUpdate`,
 * even with `runValidators: true` — Mongoose runs update validators against the
 * query, not a document. Every write path must therefore call
 * `assertRolesAssignable()` itself; this hook is the backstop for `.save()`,
 * not the only guard.
 */
userSchema.pre('validate', function assertRoleCombinationIsValid(next) {
  try {
    assertRolesAssignable(this.role, this.roles);
    next();
  } catch (err) {
    next(err);
  }
});

export default mongoose.model('User', userSchema);
