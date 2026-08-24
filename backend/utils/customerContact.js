import User from '../models/User.js';

/**
 * Fill missing phoneNumber/location from the customer's profile.
 *
 * Order rows are stamped with the pair at creation, but rows created before
 * that stamp existed carry null — and the pick list needs a contact for
 * exactly the bookings still being worked, which are as likely as not the old
 * ones. Works on anything carrying { user, phoneNumber, location }: raw Order
 * rows and shaped bookings alike.
 *
 * One batched query per call, never one per row. Mutates in place and returns
 * the same array for chaining. Values already present are never overwritten —
 * the row's snapshot is what the booking was actually created with.
 */
export const fillCustomerContact = async (items) => {
  const missing = items.filter((i) => !i.phoneNumber || !i.location);
  const ids = [...new Set(missing.map((i) => String(i.user || '')).filter(Boolean))];
  if (!ids.length) return items;
  const users = await User.find({ _id: { $in: ids } }, 'phone location').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  for (const i of missing) {
    const u = byId.get(String(i.user));
    if (!u) continue;
    if (!i.phoneNumber) i.phoneNumber = u.phone || null;
    if (!i.location) i.location = u.location || null;
  }
  return items;
};

export default { fillCustomerContact };
