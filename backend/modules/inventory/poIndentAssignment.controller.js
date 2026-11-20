import { assignPoIndents } from './poIndentAssignment.service.js';

/**
 * PO-wise Indent Stock Assignment endpoint. Behind `assign_indent_stock`, the
 * same permission as the individual assignment (see inventory.routes.js); the
 * rules live in poIndentAssignment.service.js.
 */

/**
 * POST /inventory/indent-assignment/po/assign — body { poNumber }.
 * Assigns every waiting indent listed under that PO, as far as free stock goes.
 */
export const postAssignPo = async (req, res, next) => {
  try {
    const data = await assignPoIndents({ poNumber: req.body?.poNumber, actor: req.user, req });
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

export default { postAssignPo };
