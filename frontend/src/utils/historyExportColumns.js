import { isMsilCustomer } from "./moq";

/**
 * The customer and transaction columns that Booking History and Indent History
 * exports share.
 *
 * ONE DEFINITION FOR BOTH HISTORIES, and for all three outputs — Excel, PDF and
 * Print all read the same column list through utils/exportUtils.js. The two
 * screens are separate components with separate stores, so the only thing that
 * can keep their exports in the same shape is a list neither of them owns.
 *
 * WHAT A ROW MUST CARRY: the four keys `customerExportRow()` produces. Each
 * screen builds its own rows — a booking and an indent are different objects —
 * but both hand them to this helper first, so "Customer Name" means the same
 * thing on both sheets rather than the master name on one and the login email
 * on the other.
 */

/** What an empty cell says. Matches the default in exportUtils.cellValue(). */
export const NA = "N/A";

const text = (value) => {
  const s = String(value ?? "").trim();
  return s === "" ? null : s;
};

/** Anything falsy or blank prints as N/A rather than as an empty cell. */
export const orNa = (value) => text(value) ?? NA;

/**
 * A PO number, or N/A.
 *
 * '-' is how a booking with no PO is stored (see the poRaised() check in
 * picklistDocument.js), so it has to be read as "not raised" rather than
 * printed as if it were a number. Requirement: show the PO wherever one has
 * been raised, N/A where one has not.
 */
export const poNumberValue = (value) => {
  const s = text(value);
  return s === null || s === "-" ? NA : s;
};

/** A date as the rest of the app prints one. */
export const exportDate = (value) => {
  if (!value) return NA;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? NA : d.toLocaleDateString();
};

/**
 * MSIL or Customer — the same two words User Management calls access levels.
 *
 * The stored category also holds 'Regular Customer' and 'Non-MSIL' from older
 * data entry, and all three mean the same thing. Normalising here stops one
 * sheet reading 'Non-MSIL' and the next 'Customer' for two accounts that are
 * not actually different. Tolerant of case and spacing via isMsilCustomer().
 */
export const customerTypeOf = (profile) => (isMsilCustomer(profile) ? "MSIL" : "Customer");

/**
 * The four customer fields of an export row.
 *
 * `name` is the caller's already-resolved display name where it has one;
 * otherwise the master name leads, then the company, then the contact person —
 * the same order services/orders.js resolves a booking's customer in.
 *
 * `shopNumber` / `location` prefer the value the caller passes, because a
 * booking carries its OWN snapshot of both and a raised PO may legitimately
 * quote a different address from the customer's registered one. The profile is
 * the fallback for rows that have no snapshot.
 */
export const customerExportRow = ({
  name = null, profile = null, shopNumber = null, location = null,
} = {}) => ({
  customerName:
    text(name)
    || text(profile?.customerName)
    || text(profile?.company)
    || text(profile?.contactName)
    || null,
  shopNumber: text(shopNumber) || text(profile?.shopNumber) || null,
  location: text(location) || text(profile?.location) || null,
  customerType: customerTypeOf(profile),
});

/** The columns those four keys fill, in the order they are asked for. */
export const CUSTOMER_EXPORT_COLS = [
  { key: "customerName", label: "Customer Name", format: orNa },
  { key: "shopNumber", label: "Shop No.", format: orNa },
  { key: "location", label: "Location", format: orNa },
  { key: "customerType", label: "Customer Type", format: orNa },
];

export default {
  NA,
  orNa,
  poNumberValue,
  exportDate,
  customerTypeOf,
  customerExportRow,
  CUSTOMER_EXPORT_COLS,
};
