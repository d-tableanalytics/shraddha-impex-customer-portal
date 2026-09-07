import { useEffect, useMemo, useState } from "react";

import { Drawer } from "../../../components/ui/Drawer";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { attendanceCorrectionsApi } from "../../../services/hrms";
import { attendanceCorrectionSchema } from "@shared/schemas/attendance.js";
import { ATTENDANCE_TIME_ZONE } from "@shared/constants/attendance.js";
import { todayIsoDay, formatTime } from "./attendanceFormat";

/**
 * Ask for a day's punches to be corrected.
 *
 * ---------------------------------------------------------------------------
 * Validated with the SERVER's schema
 * ---------------------------------------------------------------------------
 * `attendanceCorrectionSchema` is imported from `@shared`, so the rules the
 * form enforces are literally the rules the API enforces — the ten-character
 * reason, at least one time, in-order times, no future date. The reference
 * hand-writes Ant Design form rules that partly overlap its server schema, and
 * the two have already drifted: its browser blocks a future date, its API
 * accepts one.
 *
 * ---------------------------------------------------------------------------
 * Local time in, UTC out
 * ---------------------------------------------------------------------------
 * A `<input type="time">` gives `HH:mm` with no zone. Combining it with the
 * date using `new Date("YYYY-MM-DDTHH:mm")` would interpret it in the
 * BROWSER's zone, so a manager in another country would file a correction
 * hours off the day it belongs to. `toUtcIso` resolves it in the business zone
 * instead — the same zone the server files the day under.
 */

/**
 * The offset of a zone from UTC at a given instant, in minutes.
 *
 * Derived from `Intl` rather than hardcoded, so it stays correct across DST in
 * any configured zone. `en-CA` gives `YYYY-MM-DD, HH:mm:ss`, which parses back
 * cleanly.
 */
function zoneOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return (asUtc - date.getTime()) / 60000;
}

/** `2026-09-02` + `09:15` in the business zone -> an absolute ISO instant. */
export function toUtcIso(day, time, timeZone = ATTENDANCE_TIME_ZONE) {
  if (!day || !time) return null;
  const [hours, minutes] = time.split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;

  // First guess: treat the wall time as UTC, then correct by the offset that
  // applies at that instant. One iteration is enough for every real zone.
  const guess = new Date(`${day}T00:00:00.000Z`);
  guess.setUTCHours(hours, minutes, 0, 0);
  const offset = zoneOffsetMinutes(guess, timeZone);
  return new Date(guess.getTime() - offset * 60000).toISOString();
}

/** `09:15` in the business zone, for prefilling a time input from a record. */
const toTimeInput = (iso) => (iso ? formatTime(iso) : "");

export function CorrectionDrawer({ open, onClose, initialDate, existingRecord, onSubmitted }) {
  const today = useMemo(() => todayIsoDay(), []);
  const [values, setValues] = useState({ date: today, clockIn: "", clockOut: "", reason: "" });
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState(null);

  /**
   * Prime the form each time the drawer opens.
   *
   * Keyed on `open` so reopening from a different row starts clean rather than
   * carrying the previous row's reason — which is the kind of stale state that
   * gets a wrong correction filed.
   */
  useEffect(() => {
    if (!open) return;
    setValues({
      date: initialDate ?? today,
      clockIn: toTimeInput(existingRecord?.clockIn),
      clockOut: toTimeInput(existingRecord?.clockOut),
      reason: "",
    });
    setErrors({});
    setFailure(null);
  }, [open, initialDate, existingRecord, today]);

  const set = (key) => (event) => {
    const { value } = event.target;
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const dto = {
      date: values.date,
      requestedClockIn: toUtcIso(values.date, values.clockIn),
      requestedClockOut: toUtcIso(values.date, values.clockOut),
      reason: values.reason,
    };

    const parsed = attendanceCorrectionSchema.safeParse(dto);
    if (!parsed.success) {
      // Mapped onto the field each issue names, so the message appears beside
      // the input that caused it rather than in a summary at the top.
      const next = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path?.[0];
        const field =
          path === "requestedClockIn" ? "clockIn" : path === "requestedClockOut" ? "clockOut" : path;
        if (field && !next[field]) next[field] = issue.message;
      }
      setErrors(next);
      return;
    }

    setSubmitting(true);
    try {
      const created = await attendanceCorrectionsApi.submit(parsed.data);
      onSubmitted?.(created);
      onClose();
    } catch (err) {
      setFailure(err?.message ?? "The correction could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    /* 420px and the reference's exact title (`CorrectionDrawer.tsx:96-99`). */
    <Drawer
      isOpen={open}
      onClose={onClose}
      title="Request attendance correction"
      maxWidth="max-w-[420px]"
    >
      <form onSubmit={submit} className="flex flex-col gap-4 p-6">
        {/*
          `aria-label` alongside the visible `label`, because the shared Input
          renders its label as a sibling with no `htmlFor` — so the two are not
          programmatically associated and a screen reader would announce an
          unlabelled field. Fixed here rather than in the shared component:
          changing that would touch every form in the portal, which is more
          than this module should reach for.
        */}
        <Input
          type="date"
          label="Date"
          aria-label="Date"
          max={today}
          value={values.date}
          onChange={set("date")}
          error={errors.date}
          required
        />

        {/*
          Labels and helper text taken from the reference's own Form.Items
          (`CorrectionDrawer.tsx:113-146`): "Requested clock-in time", with
          "Current: HH:mm · edit if wrong" underneath when the day already has
          a punch, and "No clock-in recorded for this date" when it does not.
        */}
        <Input
          type="time"
          label="Requested clock-in time"
          aria-label="Requested clock-in time"
          value={values.clockIn}
          onChange={set("clockIn")}
          error={errors.clockIn}
          helperText={
            existingRecord?.clockIn
              ? `Current: ${formatTime(existingRecord.clockIn)} · edit if wrong`
              : "No clock-in recorded for this date"
          }
        />

        <Input
          type="time"
          label="Requested clock-out time"
          aria-label="Requested clock-out time"
          value={values.clockOut}
          onChange={set("clockOut")}
          error={errors.clockOut}
          helperText={
            existingRecord?.clockOut
              ? `Current: ${formatTime(existingRecord.clockOut)} · edit if wrong`
              : "No clock-out recorded for this date"
          }
        />

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="correction-reason" className="text-xs font-semibold text-slate-700">
            Reason
          </label>
          <textarea
            id="correction-reason"
            rows={4}
            value={values.reason}
            onChange={set("reason")}
            placeholder="Why does this need correcting?"
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none transition-all placeholder-slate-400 text-slate-900 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          {errors.reason && (
            <span className="text-xs text-error-500 font-medium">{errors.reason}</span>
          )}
        </div>

        {failure && (
          <p role="alert" className="text-xs text-error-500 font-medium">
            {failure}
          </p>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            Submit request
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default CorrectionDrawer;
