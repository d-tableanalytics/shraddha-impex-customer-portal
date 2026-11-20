/**
 * PO-WISE INDENT STOCK ASSIGNMENT — giving every indent on one PO its stock in
 * one click.
 *
 * The individual screen (indentAssignment.service.js) answers "which indent
 * gets these units?" one indent at a time. When a PO was raised for several
 * lines and the material has landed, the desk wants the other question: "this
 * PO's stock is in — settle the whole PO". That is all this file adds.
 *
 * NOTHING NEW HAPPENS HERE. Each indent is assigned through
 * `assignToIndent()`, exactly as clicking Assign on its row does: the same
 * free-stock and pending-quantity checks, the same guarded stock writes, the
 * same allocation onto the indent's own booking, the same MSIL Convert stamp,
 * the same customer announcement and the same per-indent audit entry. This
 * file only decides WHICH indents to call it for, in which order, and with how
 * much — and writes one extra audit entry for the PO-wise run itself.
 *
 * The indents on a PO are read from `assignmentQueue()`, the very thing the
 * screen is drawn from, so the server assigns what the user was looking at:
 * the same PO resolution (the indent's own PO, else its booking's), the same
 * oldest-first order, the same free-stock figures.
 *
 * A refusal on one indent does not abandon the rest of the PO. Each one is
 * tried, and the result lists what was assigned and what was not, with the
 * reason — a partly-served PO is reported as such rather than hidden behind a
 * single error.
 */

import AuditLog from '../../models/AuditLog.js';
import { assignmentQueue, assignToIndent } from './indentAssignment.service.js';

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status });

const audit = (actor, action, remarks, meta, req) => AuditLog.create({
  user: actor?._id || null,
  action,
  method: req?.method || 'SYSTEM',
  endpoint: req?.originalUrl || 'N/A',
  ipAddress: req?.ip || '127.0.0.1',
  userAgent: req?.headers?.['user-agent'] || 'ERP SYSTEM',
  remarks,
  meta,
}).catch((e) => console.error(`[PoIndentAssignment] audit "${action}" failed:`, e.message));

/** POs are compared as typed but not as cased: 'po-a-778' finds PO-A-778. */
const samePo = (a, b) => String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();

const labelOf = (indent) => indent.indentNumber || indent.reservationId;

/**
 * Every open indent that goes by this PO number, with the SKU card it came
 * from, oldest first across SKUs — the order the FIFO pass would have used, so
 * a PO-wise run hands its stock out the same way a per-SKU auto-assign would.
 */
export const indentsUnderPo = (skus, poNumber) => {
  const rows = [];
  for (const sku of skus || []) {
    for (const indent of sku.indents || []) {
      if (indent.poNumber && samePo(indent.poNumber, poNumber)) rows.push({ sku, indent });
    }
  }
  rows.sort((a, b) => new Date(a.indent.date || 0) - new Date(b.indent.date || 0)
    || String(a.indent.id).localeCompare(String(b.indent.id)));
  return rows;
};

/**
 * Assign the free stock of every indent listed under one PO.
 *
 * Each indent takes what it is still waiting for, or what is free of its SKU,
 * whichever is less — except an indent whose booking was cancelled, which can
 * only be taken whole (`wholeOnly`) and is skipped when that much is not free.
 * The free stock is counted down as the run goes, so two indents for the same
 * SKU under one PO are never promised the same units; the guarded writes
 * inside `assignToIndent` remain the real check against a race.
 *
 * @returns {Promise<{poNumber, indents, assigned[], skipped[], units}>}
 */
export const assignPoIndents = async ({ poNumber, actor, req }) => {
  const po = String(poNumber || '').trim();
  if (!po) throw fail(400, 'Say which PO number to assign.');

  const { skus } = await assignmentQueue();
  const targets = indentsUnderPo(skus, po);
  if (!targets.length) throw fail(404, `No indent is waiting for stock under PO ${po}. Refresh and check.`);

  // What is free per SKU as this run starts, counted down as it hands units out.
  const free = new Map();
  for (const { sku } of targets) if (!free.has(sku.skuCode)) free.set(sku.skuCode, Math.max(0, sku.available || 0));

  const assigned = [];
  const skipped = [];

  for (const { sku, indent } of targets) {
    const available = free.get(sku.skuCode) ?? 0;
    const want = indent.wholeOnly ? indent.pending : Math.min(indent.pending, available);
    const row = {
      indent: labelOf(indent), indentId: indent.id, skuCode: sku.skuCode,
      customer: indent.customer, pending: indent.pending,
    };

    if (want < 1 || want > available) {
      skipped.push({
        ...row,
        reason: available < 1
          ? `No ${sku.skuCode} stock is free.`
          : `${sku.skuCode}: only ${available} unit(s) free, and this indent's booking was cancelled, `
            + `so it can only be taken whole (${indent.pending}).`,
      });
      continue;
    }

    try {
      const done = await assignToIndent({ indentId: indent.id, quantity: want, actor, req });
      free.set(sku.skuCode, available - want);
      assigned.push({ ...row, quantity: want, orderId: done.orderId });
    } catch (error) {
      // One indent refused (a race, a cancelled indent, a quantity that moved)
      // does not abandon the others on the PO; it is reported instead.
      skipped.push({ ...row, reason: error.message });
    }
  }

  const units = assigned.reduce((n, a) => n + a.quantity, 0);
  await audit(
    actor,
    'Indent Stock Assigned (PO-wise)',
    `PO ${po}: ${units} unit(s) assigned to ${assigned.length} of ${targets.length} waiting indent(s)`
    + (skipped.length ? `; ${skipped.length} not assigned.` : '.'),
    { poNumber: po, indents: targets.length, units, assigned, skipped },
    req,
  );

  return { poNumber: po, indents: targets.length, assigned, skipped, units };
};

export default { assignPoIndents, indentsUnderPo };
