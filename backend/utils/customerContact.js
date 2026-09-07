import User from '../models/User.js';

/**
 * Attach the customer's User Management record to bookings.
 *
 * TWO JOBS, AND THEY ARE NOT THE SAME JOB.
 *
 * 1. `customerProfile` — the customer's CURRENT master details, straight from
 *    the user record: name, company, phone, location, shop, vendor and GST
 *    numbers. Always attached, never derived from the booking. This is what the
 *    screens show when they want to say who the customer IS, and because it is
 *    read live, filling in a customer's master details in User Management shows
 *    up on every one of their past bookings immediately.
 *
 * 2. `phoneNumber` / `location` on the booking itself — filled in ONLY when the
 *    row has none. These are the booking's own snapshot: stamped when it was
 *    created, and re-stamped by the desk when the PO is raised, because a PO may
 *    legitimately quote a different delivery address from the customer's
 *    registered one. Overwriting them with the profile would rewrite what a
 *    raised purchase order says, which is the one thing that must not move.
 *
 * So: the SNAPSHOT is what this booking was made with, the PROFILE is who the
 * customer is today. Keeping them apart is the whole point — a screen that
 * wants either can have it, and neither can quietly become the other.
 *
 * The master details are immutable on the user record by design (see the note
 * in models/User.js), so in practice the profile is stable and reading it live
 * costs nothing in consistency. What it buys is that a detail added AFTER a
 * booking was placed still appears on it.
 *
 * ONE BATCHED QUERY PER CALL, never one per row. Mutates in place and returns
 * the same array, so it composes into an existing response pipeline.
 *
 * Works on anything carrying `user` — raw Order rows and shaped bookings alike.
 */

/** What the screens are allowed to see about a customer. Never the password. */
const PROFILE_FIELDS = 'user company email customerName phone location shopNumber vendorNumber gstNumber customerCategory';

/** The shape every screen reads. Present even when the user record is gone. */
const profileOf = (u) => ({
  // The Customer Master name — the legal entity we trade with. Distinct from
  // `company` and from `user`, which is the contact person.
  customerName: u?.customerName || null,
  company: u?.company || null,
  contactName: u?.user || null,
  email: u?.email || null,
  phone: u?.phone || null,
  location: u?.location || null,
  shopNumber: u?.shopNumber || null,
  vendorNumber: u?.vendorNumber || null,
  gstNumber: u?.gstNumber || null,
  customerCategory: u?.customerCategory || null,
});

export const attachCustomerDetails = async (items) => {
  const list = Array.isArray(items) ? items : [];
  const ids = [...new Set(list.map((i) => String(i?.user || '')).filter(Boolean))];
  if (!ids.length) return items;

  const users = await User.find({ _id: { $in: ids } }, PROFILE_FIELDS).lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  for (const item of list) {
    const u = byId.get(String(item?.user || ''));
    // A booking whose customer account has been deleted still renders; it
    // simply has no profile, and the screens fall back to the snapshot.
    if (!u) continue;

    // A Mongoose document needs the assignment to go through `set` for a field
    // its schema does not declare; a lean object or a shaped booking is plain.
    if (typeof item.set === 'function' && typeof item.toObject === 'function') {
      item.set('customerProfile', profileOf(u), { strict: false });
    } else {
      item.customerProfile = profileOf(u);
    }

    // The snapshot, only where the booking has none of its own.
    if (!item.phoneNumber) item.phoneNumber = u.phone || null;
    if (!item.location) item.location = u.location || null;
  }

  return items;
};

/**
 * The previous name for this, kept so nothing that still calls it breaks.
 *
 * It never only filled the contact pair — it now also attaches the profile —
 * so the name is wrong and callers should move to attachCustomerDetails.
 */
export const fillCustomerContact = attachCustomerDetails;

export default { attachCustomerDetails, fillCustomerContact };
