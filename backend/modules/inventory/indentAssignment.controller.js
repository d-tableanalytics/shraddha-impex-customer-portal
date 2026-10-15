import {
  assignmentQueue, autoAssign, assignToIndent, reassignAllocation,
} from './indentAssignment.service.js';

/**
 * Indent Stock Assignment endpoints. All behind `assign_indent_stock` (see
 * inventory.routes.js); the rules live in indentAssignment.service.js.
 */

const send = (res, status, data) => res.status(status).json({ success: true, data });

/** GET /inventory/indent-assignment?sku=A,B — SKUs, free stock, indents, movable allocations. */
export const getQueue = async (req, res, next) => {
  try {
    const skuCodes = String(req.query.sku || '').split(',').map((s) => s.trim()).filter(Boolean);
    send(res, 200, await assignmentQueue({ skuCodes: skuCodes.length ? skuCodes : null }));
  } catch (error) { next(error); }
};

/** POST /inventory/indent-assignment/auto — body { skuCodes: [] }. FIFO, now. */
export const postAuto = async (req, res, next) => {
  try {
    send(res, 200, await autoAssign({ skuCodes: req.body?.skuCodes, actor: req.user, req }));
  } catch (error) { next(error); }
};

/** POST /inventory/indent-assignment/assign — body { indentId, quantity }. */
export const postAssign = async (req, res, next) => {
  try {
    send(res, 200, await assignToIndent({
      indentId: req.body?.indentId, quantity: req.body?.quantity, actor: req.user, req,
    }));
  } catch (error) { next(error); }
};

/** POST /inventory/indent-assignment/reassign — body { orderId, lineId, seq, toIndentId, quantity? }. */
export const postReassign = async (req, res, next) => {
  try {
    const { orderId, lineId, seq, toIndentId, quantity } = req.body || {};
    send(res, 200, await reassignAllocation({
      orderId, lineId, seq: Number(seq), toIndentId, quantity, actor: req.user, req,
    }));
  } catch (error) { next(error); }
};

export default { getQueue, postAuto, postAssign, postReassign };
