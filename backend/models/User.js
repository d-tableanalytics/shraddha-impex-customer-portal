import mongoose from 'mongoose';
import { isAssignableRoleKey } from '../shared/permissions/assignment.js';
import { isAssignableRoleName } from '../utils/roleResolver.js';
import { assertHrmsRolesAssignable } from '../utils/hrmsRoleGuard.js';

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

  /**
   * ── Where goods are sent, and where the invoice goes ─────────────────────
   *
   * NEW. Before this there was no address on a customer record at all — the six
   * master fields above were the whole of it — and the picklist printed
   * `location` alone under a single "Place of supply" heading. `Order` has
   * carried `shippingAddress` and `billingAddress` since the sales desk was
   * built, but nothing ever populated them: their only writer is `raisePo`,
   * reading a request body that the PO modal seeds from fields that are null.
   *
   * So the picklist could not show a shipping and a billing address separately,
   * because the system did not know them.
   *
   * These are the SOURCE OF TRUTH, held once per customer and maintained in
   * Admin → User Management beside the GST and shop number. Each booking then
   * SNAPSHOTS them onto its Order rows at creation, so a customer who later
   * moves does not silently rewrite the address on a picklist that has already
   * been picked, packed or invoiced. That is the same choice `unitPrice` makes a
   * few fields up in Order.js, and for the same reason.
   *
   * Both optional. Every account that exists today has neither, and a picklist
   * for an old booking falls back to the customer's current profile rather than
   * printing nothing — see `picklistDocument.js`.
   */
  shippingAddress: { type: String, default: null },
  billingAddress: { type: String, default: null },
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
  lastLogin: { type: Date },

  // ── Refresh-token rotation ──────────────────────────────────────────────
  //
  // LEGACY, AND STILL READ. SHA-256 of a single refresh token — the whole
  // session model until `refreshSessions` below replaced it.
  //
  // It is no longer WRITTEN on any successful path. It is still read once, in
  // refresh(), so that a user holding a cookie issued before this change is
  // adopted into the new model instead of being signed out by the deploy. Once
  // adopted the field is cleared. Every revoke-everything path still nulls it
  // alongside emptying refreshSessions, so a stale value can never resurrect a
  // session that was meant to be dead.
  //
  // `select: false` keeps it out of every existing query and every API response
  // that returns a user document — no controller needs to know it exists.
  refreshTokenHash: { type: String, default: null, select: false },

  /**
   * ── One entry per signed-in device ──────────────────────────────────────
   *
   * WHY THIS REPLACED A SINGLE HASH
   *
   * The old model stored ONE hash for the whole account, and refresh() treated
   * any mismatch as a replayed token by nulling it — revoking every session the
   * account had. That is the correct response to a genuine theft and the wrong
   * response to almost everything else, because two ordinary situations produce
   * exactly the same mismatch:
   *
   *   - Two browser TABS. They share one cookie jar and one localStorage access
   *     token, so they expire together and both post /auth/refresh at the same
   *     instant. One rotates the hash; the other is now holding the previous
   *     token and is read as an attacker.
   *   - Two DEVICES. Signing in on a phone overwrote the desktop's hash, so the
   *     desktop's next refresh was read as an attacker — and killed both.
   *
   * The production audit trail showed this happening constantly: 27 revocations
   * against 69 successful refreshes (28% of all refresh attempts), and one admin
   * account force-signed-out 13 times in five hours.
   *
   * Keying the hash per SESSION rather than per ACCOUNT is what separates the
   * two cases. A mismatch is now scoped to the one session that presented it, so
   * reuse detection still fires — it just cannot take the other devices with it.
   *
   * WHAT EACH FIELD IS FOR
   *
   *   hash        SHA-256 of the CURRENT refresh token for this session. A
   *               database leak still yields no usable sessions.
   *   prevHash    the token this session held immediately before its last
   *               rotation, plus `rotatedAt`, together forming a short GRACE
   *               WINDOW. Two tabs racing on the SAME session both present the
   *               same token; the first rotates, the second arrives moments
   *               later holding what is now `prevHash`. Inside the window that
   *               is a race, not a replay: it is served a fresh access token
   *               without rotating again. Outside it, it is a replay.
   *   jti         the refresh token's own id claim. Lets a session be found and
   *               revoked without knowing the token itself.
   *   userAgent   so a person can recognise their own devices in a session list.
   *
   * `select: false` for the same reason as the legacy field: no existing query
   * or API response should start carrying session material.
   */
  refreshSessions: {
    type: [{
      hash: { type: String, required: true },
      prevHash: { type: String, default: null },
      rotatedAt: { type: Date, default: null },
      jti: { type: String, default: null },
      createdAt: { type: Date, default: Date.now },
      lastUsedAt: { type: Date, default: Date.now },
      userAgent: { type: String, default: null },
      _id: false,
    }],
    default: [],
    select: false,
  },
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
    // The widened rule: any PORTAL-ONLY role, not just the literal 'Customer'.
    // A Super Admin can mark a role they invent as portal-only, and an account
    // on one is as fenced as a Customer is.
    assertHrmsRolesAssignable(this.role, this.roles);
    next();
  } catch (err) {
    next(err);
  }
});

export default mongoose.model('User', userSchema);
