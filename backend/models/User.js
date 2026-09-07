import mongoose from 'mongoose';
import { isAssignableRoleName } from '../utils/roleResolver.js';

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
  //   Import Team      — loads and corrects catalogue data in bulk; holds no
  //                      ordering or booking permission at all
  //   Super Admin      - full access to the entire ERP, forever. Added
  //                      alongside 'Admin' rather than replacing it: 'Admin'
  //                      has meant exactly this since the system was built, and
  //                      renaming every existing account is not a prerequisite
  //                      for the new role model. Both resolve to the wildcard.
  /**
   * VALIDATED, NOT ENUMERATED.
   *
   * This was a fixed enum of seven names. It cannot stay one: the Super Admin
   * can now create roles, and a role nobody can be assigned to is not a role.
   *
   * The validator accepts the built-in names unconditionally - so an account
   * can always be given a real role even with a cold cache or an unreachable
   * roles collection - plus any role that actually exists. It is still a closed
   * set, just one that grows when the Super Admin grows it: an arbitrary string
   * is refused exactly as it was before.
   */
  role: {
    type: String,
    default: 'Customer',
    validate: {
      validator: (value) => isAssignableRoleName(value),
      message: (props) => `"${props.value}" is not a role that exists.`,
    },
  },

  /**
   * Per-user extra access, in the same shape as a role's grants -
   * requirement 4.
   *
   * For the one person who needs one more thing than their role gives them.
   * Without this the only way to say "Priya, and only Priya, may approve
   * counts" is to invent a role for Priya, and a roles list that grows a row
   * per person stops being a roles list.
   *
   * Additive by design. Access is granted here, never
   * revoked - taking something away is done by changing the role, where it is
   * visible to whoever reviews the matrix next.
   */
  extraGrants: {
    type: [{
      module: { type: String, required: true },
      submodule: { type: String, required: true },
      actions: [{ type: String, enum: ['view', 'create', 'edit', 'delete', 'approve'] }],
      _id: false,
    }],
    default: [],
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

export default mongoose.model('User', userSchema);
