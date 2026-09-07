import { useCallback, useEffect, useRef, useState } from "react";
import { LogIn, LogOut, MapPin, AlertTriangle, Clock } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { SelfieCaptureModal } from "./SelfieCaptureModal";
import { SelfieChip } from "./SelfieThumb";
import { attendanceApi, uploadSelfie } from "../../../services/hrms";
import { readPosition, captureMessage } from "./deviceCapture";
import {
  formatClockTime,
  formatClockTimeLabel,
  formatDayLabel,
  formatElapsed,
  formatHoursDecimal,
  formatLocation,
} from "./attendanceFormat";
import { CONSENT_PURPOSES } from "@shared/constants/hrms.js";

/**
 * The clock in / clock out card.
 *
 * ---------------------------------------------------------------------------
 * Laid out to match the reference's ClockInCard
 * ---------------------------------------------------------------------------
 * Same structure, same order, same type scale (`ClockInCard.tsx:640-810`):
 *
 *   radius 16, padding 22, min-height 220, gradient by state
 *   row 1   status pill (11px/700/uppercase) ......... date (12px, 'ddd, DD MMM')
 *   row 2   idle: 44px clock + 20px meridiem
 *           on the clock: 38px elapsed counter, "Since 9:15 AM"
 *           done: IN / OUT / HOURS, 10px labels over 22px values
 *   row 3   selfie chips, when a punch stored one
 *   row 4   full-width 48px white CTA
 *   row 5   In:/Out: location lines (11.5px)
 *   row 6   idle hint (11px)
 *
 * The gradients are the reference's own: blue idle, emerald on the clock, slate
 * once the day is closed.
 *
 * ---------------------------------------------------------------------------
 * The punch is the thing that must succeed
 * ---------------------------------------------------------------------------
 * The reference gates its punch behind a hard permission check - camera AND
 * location must both be granted, with an explicit "there's no bypass" comment -
 * so an employee with a broken camera cannot record that they came to work.
 * AD-15 rejects that: consent has to be free, so every capture step here can
 * fail or be declined and the punch still goes through.
 *
 *   1. Consent decides whether we ask at all. Not consented -> not asked.
 *   2. A consented photo is offered; declining or a camera failure continues.
 *   3. A consented location is read; a denial or timeout continues.
 *   4. The punch is sent, with whatever was actually captured.
 *
 * Only step 4 can fail the operation, and only for a real reason.
 */
export function ClockCard({ record, consent, onPunched, onError }) {
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [selfieOpen, setSelfieOpen] = useState(false);
  const [notice, setNotice] = useState(null);

  /** The action waiting on the selfie modal, and its resolver. */
  const pendingAction = useRef(null);
  const selfieResolve = useRef(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const state = !record?.clockIn ? "idle" : !record.clockOut ? "in" : "done";

  const selfieAllowed = Boolean(consent?.[CONSENT_PURPOSES.ATTENDANCE_SELFIE]?.granted);
  const locationAllowed = Boolean(consent?.[CONSENT_PURPOSES.ATTENDANCE_LOCATION]?.granted);

  const askForSelfie = useCallback(
    () =>
      new Promise((resolve) => {
        selfieResolve.current = resolve;
        setSelfieOpen(true);
      }),
    [],
  );

  const settleSelfie = (blob) => {
    setSelfieOpen(false);
    selfieResolve.current?.(blob);
    selfieResolve.current = null;
  };

  const cancelPunch = () => {
    setSelfieOpen(false);
    // `undefined`, distinct from the `null` that means "skipped": one aborts
    // the punch, the other completes it without a photo.
    selfieResolve.current?.(undefined);
    selfieResolve.current = null;
    pendingAction.current = null;
    setBusy(false);
  };

  const punch = async (action) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    pendingAction.current = action;

    const dto = { source: /Mobi|Android/i.test(navigator.userAgent) ? "mobile" : "web" };
    const softFailures = [];

    try {
      if (selfieAllowed) {
        const blob = await askForSelfie();
        if (blob === undefined) return; // cancelled outright
        if (blob) {
          try {
            const key = await uploadSelfie(blob);
            if (key) dto.selfieKey = key;
          } catch {
            // The photo was optional to begin with. Losing the upload must not
            // cost someone their punch - it is noted and the punch proceeds.
            softFailures.push("The photo could not be uploaded, so your punch was recorded without it.");
          }
        }
      }

      if (locationAllowed) {
        const position = await readPosition();
        if (position.ok) dto.geo = position.geo;
        else softFailures.push(`Location was not recorded. ${captureMessage(position.reason)}`);
      }

      const result =
        action === "in" ? await attendanceApi.clockIn(dto) : await attendanceApi.clockOut(dto);

      onPunched?.(result);
      if (softFailures.length > 0) setNotice(softFailures.join(" "));
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
      pendingAction.current = null;
    }
  };

  const clock = formatClockTime(now);
  const inLocation = formatLocation(record?.clockInCapture);
  const outLocation = formatLocation(record?.clockOutCapture);

  const gradient =
    state === "in"
      ? "from-emerald-800 to-emerald-500"
      : state === "done"
        ? "from-slate-700 to-slate-500"
        : "from-primary-800 via-primary-600 to-primary-400";

  const dot =
    state === "in" ? "bg-emerald-300" : state === "done" ? "bg-slate-300" : "bg-amber-300";

  return (
    <>
      <SelfieCaptureModal
        open={selfieOpen}
        onCapture={(blob) => settleSelfie(blob)}
        onSkip={() => settleSelfie(null)}
        onCancel={cancelPunch}
      />

      <section
        data-testid="clock-card"
        aria-label="Clock in and out"
        className={`relative overflow-hidden rounded-2xl p-[22px] min-h-[220px] flex flex-col gap-3.5 text-white bg-gradient-to-br ${gradient} shadow-enterprise-lg`}
      >
        {/* Row 1 — status pill and today's date */}
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.16] text-[11px] font-bold uppercase tracking-[0.4px]">
            <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
            {state === "in" ? "On the clock" : state === "done" ? "Day complete" : "Ready to clock in"}
          </span>
          <span className="text-xs opacity-85">{formatDayLabel(now)}</span>
        </div>

        {/* Row 2 — the state's headline figure */}
        {state === "idle" && (
          <div>
            <p className="text-[44px] font-bold leading-none tracking-[-1.5px]">
              {clock.time}
              <span className="text-xl font-semibold ml-1.5 opacity-80">{clock.meridiem}</span>
            </p>
            <p className="text-[12.5px] opacity-[0.86] mt-1.5">Tap below to start your workday</p>
          </div>
        )}

        {state === "in" && (
          <div>
            <p className="text-[38px] font-bold leading-none tracking-[-1px] tabular-nums">
              {formatElapsed(record.clockIn, now)}
            </p>
            <p className="text-[12.5px] opacity-[0.86] mt-1.5">
              Since {formatClockTimeLabel(record.clockIn)}
            </p>
          </div>
        )}

        {state === "done" && (
          <div className="flex gap-[22px] items-baseline">
            {[
              ["IN", formatClockTimeLabel(record.clockIn)],
              ["OUT", formatClockTimeLabel(record.clockOut)],
              ["HOURS", formatHoursDecimal(record.hoursWorked)],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="text-[10px] tracking-[0.5px] opacity-75">{label}</p>
                <p className="text-[22px] font-bold">{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Row 3 — the photos this day's punches stored */}
        {(record?.clockInCapture?.hasSelfie || record?.clockOutCapture?.hasSelfie) && (
          <div className="flex gap-2">
            {record.clockInCapture.hasSelfie && (
              <SelfieChip recordId={record.id} punch="in" label="In" tone="#4ADE80" />
            )}
            {record.clockOutCapture.hasSelfie && (
              <SelfieChip recordId={record.id} punch="out" label="Out" tone="#FBBF24" />
            )}
          </div>
        )}

        {/* Row 4 — the CTA. Absent once the day is closed, as in the reference. */}
        {state !== "done" && (
          <Button
            variant="secondary"
            loading={busy}
            onClick={() => punch(state === "in" ? "out" : "in")}
            className="mt-1 w-full h-12 rounded-xl bg-white text-slate-900 hover:bg-slate-100 border-0 font-semibold text-sm shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
          >
            {state === "in" ? (
              <>
                <LogOut size={16} className="mr-2" /> Clock out
              </>
            ) : (
              <>
                <LogIn size={16} className="mr-2" /> Clock in
              </>
            )}
          </Button>
        )}

        {/*
          Row 5 — where the punches happened.

          The employee sees this on their OWN record. The reference hides it
          from them and shows it only to managers and HR, which is backwards:
          it is their location. AD-15 §2 puts `view:self` on the same gate as
          `view:team` and `view:org`, and that is followed.
        */}
        {(inLocation || outLocation) && (
          <div className="space-y-0.5 text-[11.5px] opacity-90 leading-[1.5]">
            {inLocation && (
              <p className="flex items-start gap-1.5">
                <MapPin size={12} className="mt-0.5 shrink-0" />
                <span>
                  <span className="opacity-75 mr-1">In:</span>
                  {inLocation}
                </span>
              </p>
            )}
            {outLocation && (
              <p className="flex items-start gap-1.5">
                <MapPin size={12} className="mt-0.5 shrink-0" />
                <span>
                  <span className="opacity-75 mr-1">Out:</span>
                  {outLocation}
                </span>
              </p>
            )}
          </div>
        )}

        {/*
          A capture that failed is stated plainly, and separately from the punch
          having worked. Silently recording a punch with no photo would leave
          someone believing a verification happened that did not.
        */}
        {notice && (
          <p
            role="status"
            className="flex items-start gap-2 text-[11px] leading-relaxed bg-white/[0.15] rounded-lg p-2.5"
          >
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            {notice}
          </p>
        )}

        {/*
          Row 6 — the idle hint. The reference's line is "Camera and location
          access are required to clock in"; ours says what is actually true
          here, because neither is required and promising otherwise would be
          the coercive framing AD-15 removes.
        */}
        {state === "idle" && (
          <p className="flex items-center gap-1.5 text-[11px] opacity-75 mt-auto">
            <Clock size={12} className="shrink-0" />
            {selfieAllowed || locationAllowed
              ? "A photo and location are captured with your punch. Both are optional."
              : "Photo and location capture are off. Your punch is recorded without them."}
          </p>
        )}
      </section>
    </>
  );
}

export default ClockCard;
