/**
 * Who the documents come from.
 *
 * Printed at the top of the picklist / PO preview, which is a commercial
 * document a customer keeps — so these values are here, in one place, rather
 * than typed into a template. Anything left null is simply not printed: an
 * incomplete letterhead is better than a wrong one.
 *
 * ADDRESS IS DELIBERATELY BLANK. The rest of the portal never stored a postal
 * address for the business, and inventing one for a document that goes to
 * customers is not a detail worth guessing at. Fill it in here and it appears
 * on every preview and PDF at once.
 */
export const COMPANY = {
  name: "SHRADDHA IMPEX",
  addressLines: [],
  phone: null,
  email: "support@shraddhaimpex.net",
  website: "www.shraddhaimpex.net",
  gstin: null,
};

export default COMPANY;
