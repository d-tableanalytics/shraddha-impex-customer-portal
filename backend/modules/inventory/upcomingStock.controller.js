import {
  listUpcoming, validateImport, commitImport, updateShipment, cancelShipment, deleteShipment,
  deleteSkuEntries,
} from './upcomingStock.service.js';

/**
 * Upcoming Stock endpoints. Permissions are applied in inventory.routes.js; the
 * rules live in upcomingStock.service.js.
 */

const send = (res, status, data) => res.status(status).json({ success: true, data });

/**
 * Tell open Upcoming Stock screens to re-read. Never throws: the change is
 * saved either way, and the worst case is a screen that updates on its next
 * fetch.
 */
const announce = (req) => {
  try {
    req.app?.get?.('io')?.emit('inventory:upcoming-updated', { at: Date.now() });
  } catch {
    // see above
  }
};

const handle = (work, status = 200, { changes = true } = {}) => async (req, res, next) => {
  try {
    const data = await work(req);
    if (changes) announce(req);
    send(res, status, data);
  } catch (error) { next(error); }
};

/** GET /inventory/upcoming — every SKU with stock on its way, with indents and reservations. */
export const getUpcoming = handle((req) => listUpcoming({ user: req.user }), 200, { changes: false });

/** POST /inventory/upcoming/import/preview — body { rows }. Writes nothing. */
export const postImportPreview = handle(
  (req) => validateImport({ rows: req.body?.rows, user: req.user }),
  200,
  { changes: false },
);

/** POST /inventory/upcoming/import — body { importId, fileName, rows }. */
export const postImport = handle((req) => commitImport({
  importId: req.body?.importId, fileName: req.body?.fileName, rows: req.body?.rows, user: req.user, req,
}), 201);

/** PATCH /inventory/upcoming/shipments/:id — body: any of { orderedQty, eta, ref, supplier, product }. */
export const patchShipment = handle((req) => updateShipment({ id: req.params.id, changes: req.body, user: req.user, req }));

/** POST /inventory/upcoming/shipments/:id/cancel — body { note? }. */
export const postCancelShipment = handle((req) => cancelShipment({
  id: req.params.id, note: req.body?.note, user: req.user, req,
}));

/** DELETE /inventory/upcoming/shipments/:id — body { note? }. Inventory is not touched. */
export const deleteUpcomingShipment = handle((req) => deleteShipment({
  id: req.params.id, note: req.body?.note, user: req.user, req,
}));

/** POST /inventory/upcoming/items/delete — body { brand, skuCode, note? }. Every entry of the SKU; inventory untouched. */
export const postDeleteSku = handle((req) => deleteSkuEntries({ body: req.body, user: req.user, req }));

// There are no reservation endpoints: what is reserved against each indent is
// a FIFO calculation made by GET /inventory/upcoming (allocateFifo).

export default {
  getUpcoming, postImportPreview, postImport, patchShipment, postCancelShipment,
  deleteUpcomingShipment, postDeleteSku,
};
