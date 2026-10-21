import { useEffect, useState } from "react";
import { CalendarClock, Loader2, Check, X as XIcon } from "lucide-react";
import toast from "react-hot-toast";

import { salesApi } from "../../services/sales";
import { Modal } from "../ui/Modal";

/**
 * MSIL Supply Date and the desk's decision on held indents.
 *
 * The rule lives on the server (backend/utils/msilSupply.js): an MSIL
 * customer's indent converts into the booking by itself only when its stock
 * arrives on or before the Supply Date AND within 7 days of the booking.
 * Otherwise it is held as "Awaiting decision", and these controls let the desk
 * Convert it anyway or Cancel it. Nothing here decides anything.
 */

/*
 * The Supply Date is a day in INDIA (the server stores the instant that IST
 * day starts). Read and shown in Asia/Kolkata, so it is the same day for a
 * user whatever zone their own machine is set to.
 */
const IST = "Asia/Kolkata";

/** 'YYYY-MM-DD' of the IST day containing `value` — what the date input shows. */
export const toInput = (value) => (value
  ? new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(value))
  : "");

/** '25 Oct 2026', in IST. */
export const fmt = (value) => (value
  ? new Date(value).toLocaleDateString("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric" })
  : null);

export const isMsilBooking = (booking) => booking?.customerProfile?.customerCategory === "MSIL";

/**
 * The Supply Date row in the booking drawer. MSIL bookings only.
 */
export const MsilSupplyDateBar = ({ booking, canEdit, onSaved }) => {
  const saved = toInput(booking.msilSupplyDate);
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValue(saved); }, [saved, booking.orderId]);

  const save = async (next) => {
    setSaving(true);
    try {
      const data = await salesApi.setSupplyDate(booking.orderId, next || null);
      // This booking's lines only — the server re-checks every indent on those
      // SKUs, but what the desk asked about is this booking.
      const converted = data?.convertedLines ?? 0;
      const held = data?.awaitingLines ?? 0;
      toast.success(
        (data?.msilSupplyDate ? `Supply Date set to ${fmt(data.msilSupplyDate)}.` : "Supply Date cleared.")
        + (converted ? ` ${converted} waiting line(s) converted.` : "")
        + (held ? ` ${held} line(s) still need a decision.` : ""),
        { duration: 5000 },
      );
      await onSaved?.();
    } catch (err) {
      toast.error(err.response?.data?.message || "The Supply Date could not be saved.");
      setValue(saved);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="px-6 py-3 bg-white border-b border-slate-200 flex flex-wrap items-center gap-3 shrink-0">
      <CalendarClock size={16} className="text-primary-600 shrink-0" />
      <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">MSIL Supply Date</span>
      {canEdit ? (
        <>
          <input
            type="date"
            aria-label="MSIL Supply Date"
            className="px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            value={value}
            disabled={saving}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            type="button"
            onClick={() => save(value)}
            disabled={saving || value === saved || !value}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg bg-primary-600 text-white disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            Save
          </button>
          {saved && (
            <button
              type="button"
              onClick={() => save(null)}
              disabled={saving}
              className="px-3 py-1.5 text-xs font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              Clear
            </button>
          )}
        </>
      ) : (
        <span className="text-sm font-semibold text-slate-700">{fmt(booking.msilSupplyDate) || "Not set"}</span>
      )}
      <span className="basis-full text-[11px] text-slate-400 leading-relaxed">
        Indent stock converts into this booking automatically only if it arrives on or before this
        date and within {booking.poDeadlineDays ?? 7} days of the booking. Later arrivals wait for
        you to Convert or Cancel. No date: indents convert as usual.
      </span>
    </div>
  );
};

const BADGE = {
  "Awaiting decision": "bg-amber-50 text-amber-800 border-amber-200",
  "Auto-converted": "bg-emerald-50 text-emerald-700 border-emerald-200",
  "Converted manually": "bg-primary-50 text-primary-700 border-primary-200",
  Cancelled: "bg-slate-100 text-slate-500 border-slate-200",
};

/**
 * The supply-check verdict on one indent line, with Convert / Cancel when the
 * line is waiting for the desk.
 */
export const HeldIndentStatus = ({ line, canDecide, onDone }) => {
  const check = line.supplyCheck;
  const [busy, setBusy] = useState(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!check) return null;

  const awaiting = check.status === "Awaiting decision";

  const convert = async () => {
    setBusy("convert");
    try {
      const res = await salesApi.convertHeldIndent(line.reservationId);
      toast.success(res.message || "Converted.");
      await onDone?.();
    } catch (err) {
      toast.error(err.response?.data?.message || "The indent could not be converted.");
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy("cancel");
    try {
      await salesApi.cancelHeldIndent(line.reservationId, reason.trim() || null);
      toast.success(`Indent line ${line.skuCode} cancelled.`);
      setCancelOpen(false);
      setReason("");
      await onDone?.();
    } catch (err) {
      toast.error(err.response?.data?.message || "The indent could not be cancelled.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      <span className={`self-start px-1.5 py-0.5 rounded border text-[10px] font-bold ${BADGE[check.status] || BADGE.Cancelled}`}>
        {check.status}
      </span>
      {awaiting && check.reason && (
        <p className="text-[11px] text-amber-800 leading-snug max-w-xs">{check.reason}</p>
      )}
      {awaiting && canDecide && (
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={convert}
            disabled={Boolean(busy)}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold rounded-md bg-primary-600 text-white disabled:opacity-50"
          >
            {busy === "convert" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            Convert
          </button>
          <button
            type="button"
            onClick={() => setCancelOpen(true)}
            disabled={Boolean(busy)}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold rounded-md border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            <XIcon size={12} />
            Cancel
          </button>
        </div>
      )}

      <Modal isOpen={cancelOpen} onClose={busy ? () => {} : () => setCancelOpen(false)} title={`Cancel indent line ${line.skuCode}`}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-600">
            {line.quantity} pc(s) of {line.skuCode} will no longer be waited for. The customer is notified.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">Reason (optional)</span>
            <input
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Customer no longer needs it"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCancelOpen(false)}
              disabled={Boolean(busy)}
              className="px-3 py-2 text-xs font-bold rounded-lg border border-slate-200 text-slate-600"
            >
              Keep it
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={Boolean(busy)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-lg bg-red-600 text-white disabled:opacity-50"
            >
              {busy === "cancel" && <Loader2 size={13} className="animate-spin" />}
              Cancel indent line
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default { MsilSupplyDateBar, HeldIndentStatus, isMsilBooking };
