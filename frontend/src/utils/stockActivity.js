import { ArrowDownRight, ArrowUpRight, Lock, Unlock, Minus } from "lucide-react";

/**
 * How a stock movement LOOKS, in one place.
 *
 * The words come from the server (activity.service.js `describeMovement`), so
 * the Stock Ledger and the SKU Activity Log say the same thing about the same
 * row. This file is only the paint: which colour, which arrow, which chip.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY DIRECTION IS NOT THE SIGN OF THE QUANTITY
 * ─────────────────────────────────────────────────────────────────────────
 * The old ledger coloured every positive number green and every negative one
 * red, which is what made it unreadable: confirming a booking writes RESERVE
 * +20, and a green +20 beside "RESERVE" reads as twenty units arriving. They
 * did not. Twenty units that were already in the building stopped being
 * available.
 *
 * So there are five directions, not two:
 *
 *   in        goods arrived            green, up arrow
 *   out       goods left               red, down arrow
 *   allocate  spoken for, still here   amber, padlock
 *   release   no longer spoken for     indigo, open padlock
 *   none      nothing moved at all     slate, dash  (an indent, a pending booking)
 */

export const DIRECTION_STYLES = {
  in: {
    icon: ArrowUpRight,
    text: "text-success-700",
    chip: "bg-success-50 text-success-700 border-success-200",
    dot: "bg-success-500",
    sign: "+",
  },
  out: {
    icon: ArrowDownRight,
    text: "text-error-600",
    chip: "bg-error-50 text-error-600 border-error-200",
    dot: "bg-error-500",
    sign: "−",
  },
  allocate: {
    icon: Lock,
    text: "text-warning-700",
    chip: "bg-warning-50 text-warning-700 border-warning-200",
    dot: "bg-warning-500",
    sign: "",
  },
  release: {
    icon: Unlock,
    text: "text-indigo-700",
    chip: "bg-indigo-50 text-indigo-700 border-indigo-200",
    dot: "bg-indigo-500",
    sign: "",
  },
  none: {
    icon: Minus,
    text: "text-slate-500",
    chip: "bg-slate-100 text-slate-600 border-slate-200",
    dot: "bg-slate-400",
    sign: "",
  },
};

export const directionStyle = (direction) => DIRECTION_STYLES[direction] || DIRECTION_STYLES.none;

/**
 * What the before/after pair actually counts.
 *
 * `onHand` is physical stock. `booked` is the allocation balance — the figure a
 * RESERVE/RELEASE movement carries (see models/StockMovement.js). Labelling it
 * "Stock" is the single most misleading thing the old screen did, so the label
 * is rendered from this rather than hard-coded in a table header.
 */
export const BALANCE_LABEL = {
  onHand: "Stock",
  booked: "Booked",
};

export const balanceLabel = (kind) => BALANCE_LABEL[kind] || "";

/**
 * The one-line explanation of a before/after pair, for a tooltip or caption.
 * Returns null where there is nothing to explain.
 */
export const balanceNote = (kind) => {
  if (kind === "booked") {
    return "These are booked units, not physical stock — nothing entered or left the warehouse.";
  }
  if (kind === "onHand") return "Physical stock on hand, before and after this transaction.";
  return null;
};

/** A signed quantity with its sign always shown, or an em dash for nothing. */
export const signedQty = (value) => {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (Number.isNaN(n)) return "—";
  return n > 0 ? `+${n.toLocaleString("en-IN")}` : n.toLocaleString("en-IN");
};

/**
 * Whether a quantity may carry a + or a − at all.
 *
 * ONLY PHYSICAL STOCK EARNS A SIGN. A booking confirmation is stored as
 * RESERVE +4, and the + is honest about what it measures — the BOOKED count
 * went up by four — but nobody reads it that way. On a row whose own caption
 * says "stock unchanged", a bold +4 is the largest thing on the line and says
 * the opposite: four units arrived. They did not; four units already in the
 * building stopped being available.
 *
 * So the sign is reserved for stock that physically entered or left. An
 * allocation shows a plain count, and the padlock, the colour and the caption
 * carry the meaning instead. This was the original bug wearing a new hat: it
 * moved out of the colour and into the number.
 */
export const isSigned = (balanceKind) => balanceKind === "onHand";

/** The quantity as it should be printed, signed only where a sign is honest. */
export const quantityText = (value, balanceKind) => (
  isSigned(balanceKind) ? signedQty(value) : fmtQty(Math.abs(Number(value) || 0))
);

export const fmtQty = (value) =>
  value === null || value === undefined ? "—" : Number(value).toLocaleString("en-IN");

export const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";

export const fmtDateTime = (d) =>
  d
    ? new Date(d).toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    })
    : "—";

export default {
  directionStyle, balanceLabel, balanceNote, signedQty, quantityText, isSigned,
  fmtQty, fmtDate, fmtDateTime,
};
