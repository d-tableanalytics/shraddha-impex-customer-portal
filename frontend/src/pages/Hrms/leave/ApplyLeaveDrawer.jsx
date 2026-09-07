import { useEffect, useMemo, useState } from "react";
import { useForm, FormProvider, useFormContext, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";

import { Drawer } from "../../../components/ui/Drawer";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { leaveApi, formatDay, formatDays } from "../../../services/hrms";
import { createLeaveRequestSchema } from "@shared/schemas/leave.js";
import { eachDay, computeLeaveDays } from "@shared/leave/dates.js";

/**
 * Apply for leave.
 *
 * A drawer, as the reference uses. The form mirrors its four duration modes —
 * full day, half day, hourly and mixed — and the same per-day pickers those
 * modes need once a request spans more than one day.
 *
 * ---------------------------------------------------------------------------
 * The day count shown here is an ESTIMATE
 * ---------------------------------------------------------------------------
 * It runs the same `computeLeaveDays` the server runs, over the same holiday
 * list, so it will normally agree. It is still only a preview: the server
 * recomputes from its own holiday table and its number is the one that is
 * stored. Showing a figure the browser calculated and then storing a different
 * one would be worse than showing none, which is why the two share the function
 * rather than each having their own.
 */

const UNITS = [
  { value: "full_day", label: "Full day" },
  { value: "half_day", label: "Half day" },
  { value: "hour", label: "By the hour" },
  { value: "mixed", label: "Mixed (per day)" },
];

const HALF_PERIODS = [
  { value: "first", label: "First half" },
  { value: "second", label: "Second half" },
];

const MIXED_KINDS = [
  { value: "full", label: "Full day" },
  { value: "half_first", label: "First half" },
  { value: "half_second", label: "Second half" },
];

const today = () => new Date().toISOString().slice(0, 10);

const emptyRequest = () => ({
  leaveTypeId: "",
  startDate: today(),
  endDate: today(),
  durationUnit: "full_day",
  reason: "",
});

function Field({ label, required, hint, error, children }) {
  return (
    <div>
      <label className="mb-1.5 block select-none text-xs font-semibold text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-error-500">*</span>}
      </label>
      {children}
      {error && <span className="mt-1 block text-xs font-medium text-error-500">{error}</span>}
      {!error && hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </div>
  );
}

/** Per-day First/Second half, once a half-day request covers more than a day. */
function PerDayPicker({ name, options }) {
  const { control, setValue } = useFormContext();
  const [startDate, endDate, current] = useWatch({
    control,
    name: ["startDate", "endDate", name],
  });

  const dates = useMemo(() => {
    try {
      return eachDay(startDate, endDate);
    } catch {
      return [];
    }
  }, [startDate, endDate]);

  // Prime an entry for every date, so the request is always complete.
  useEffect(() => {
    if (dates.length < 2) return;
    const byDate = new Map((current ?? []).map((entry) => [entry.date, entry]));
    const next = dates.map(
      (date) => byDate.get(date) ?? { date, ...options.primeWith },
    );
    const changed =
      next.length !== (current ?? []).length ||
      next.some((entry, i) => entry.date !== current?.[i]?.date);
    if (changed) setValue(name, next, { shouldValidate: true });
  }, [dates.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  if (dates.length < 2) return null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      {dates.map((date, index) => (
        <div key={date} className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-slate-600">{formatDay(date)}</span>
          <select
            aria-label={`${options.label} for ${formatDay(date)}`}
            value={current?.[index]?.[options.key] ?? options.primeWith[options.key]}
            onChange={(e) => {
              const next = [...(current ?? [])];
              next[index] = { date, [options.key]: e.target.value };
              setValue(name, next, { shouldValidate: true, shouldDirty: true });
            }}
            className="w-40 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          >
            {options.choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}

export function ApplyLeaveDrawer({ open, onClose, onCreated, types = [], holidays = [] }) {
  const [saving, setSaving] = useState(false);

  const methods = useForm({
    resolver: zodResolver(createLeaveRequestSchema),
    defaultValues: emptyRequest(),
    mode: "onBlur",
  });

  const {
    register,
    control,
    setValue,
    formState: { errors },
  } = methods;

  // `halfDaySlots` is not watched: it never changes the estimate (a half day
  // costs 0.5 whichever half is taken) and the submit handler reads it from the
  // form values directly.
  const [leaveTypeId, startDate, endDate, unit, hoursPerDay, dayBreakdown] = useWatch({
    control,
    name: ["leaveTypeId", "startDate", "endDate", "durationUnit", "hoursPerDay", "dayBreakdown"],
  });

  useEffect(() => {
    if (open) methods.reset(emptyRequest());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedType = types.find((t) => t.id === leaveTypeId);
  const multiDay = (() => {
    try {
      return eachDay(startDate, endDate).length > 1;
    } catch {
      return false;
    }
  })();

  // Mixed only means anything across more than one day, and a type that forbids
  // half days only offers whole ones.
  useEffect(() => {
    if (unit === "mixed" && !multiDay) setValue("durationUnit", "full_day");
    if (selectedType && !selectedType.allowsHalfDay && unit !== "full_day") {
      setValue("durationUnit", "full_day");
    }
  }, [unit, multiDay, selectedType?.allowsHalfDay]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The same calculation the server performs, over the same holidays. */
  const estimate = useMemo(() => {
    try {
      return computeLeaveDays(
        { startDate, endDate, durationUnit: unit, hoursPerDay, dayBreakdown },
        new Set(holidays.filter((h) => !h.isOptional).map((h) => h.date)),
        8,
      );
    } catch {
      return null;
    }
  // `halfDaySlots` is deliberately absent: a half day costs 0.5 whichever
  // half is taken, so the per-day period never changes the total.
  }, [startDate, endDate, unit, hoursPerDay, dayBreakdown, holidays]);

  // Before a type is chosen there is no rule to apply yet, so every mode is
  // offered. Narrowing to whole days on `undefined?.allowsHalfDay` would show a
  // restriction that no type has actually imposed.
  const allowsHalfDay = selectedType ? selectedType.allowsHalfDay : true;
  const unitOptions = allowsHalfDay
    ? UNITS.filter((u) => u.value !== "mixed" || multiDay)
    : UNITS.filter((u) => u.value === "full_day");

  const submit = methods.handleSubmit(async (values) => {
    setSaving(true);
    try {
      // Only what the chosen mode actually needs — the schema is `.strict()`,
      // so a stale field from a mode the user switched away from is a 400.
      const payload = {
        leaveTypeId: values.leaveTypeId,
        startDate: values.startDate,
        endDate: values.endDate,
        durationUnit: values.durationUnit,
        reason: values.reason,
      };
      if (values.durationUnit === "half_day") {
        if (multiDay) payload.halfDaySlots = values.halfDaySlots;
        else payload.halfDayPeriod = values.halfDayPeriod ?? "first";
      }
      if (values.durationUnit === "mixed") payload.dayBreakdown = values.dayBreakdown;
      if (values.durationUnit === "hour") {
        payload.hourFrom = values.hourFrom;
        payload.hourTo = values.hourTo;
        payload.hoursPerDay = values.hoursPerDay;
      }

      const created = await leaveApi.create(payload);
      toast.success(
        created.status === "approved"
          ? "Leave approved — you have no reporting manager, so it was granted straight away."
          : "Leave requested. Your manager has been asked to approve it.",
      );
      onCreated?.(created);
    } catch (err) {
      // The drawer stays open so nothing typed is lost.
      toast.error(err.message ?? "Could not submit the request.");
    } finally {
      setSaving(false);
    }
  });

  return (
    <Drawer
      isOpen={open}
      onClose={saving ? () => {} : onClose}
      title="Apply for leave"
      maxWidth="max-w-lg"
    >
      <FormProvider {...methods}>
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
          <Field label="Leave type" required error={errors.leaveTypeId?.message}>
            <SearchableSelect
              value={leaveTypeId || null}
              onChange={(v) => setValue("leaveTypeId", v ?? "", { shouldValidate: true })}
              options={types.map((t) => ({ value: t.id, label: `${t.code} · ${t.name}` }))}
              placeholder="Choose a leave type"
              emptyText="No leave types are available to you"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="From" required error={errors.startDate?.message}>
              <Input type="date" aria-label="From" {...register("startDate")} />
            </Field>
            <Field label="To" required error={errors.endDate?.message}>
              <Input type="date" aria-label="To" {...register("endDate")} />
            </Field>
          </div>

          <Field
            label="Duration"
            required
            hint={
              selectedType && !selectedType.allowsHalfDay
                ? `${selectedType.name} must be taken as whole days.`
                : undefined
            }
          >
            <select
              {...register("durationUnit")}
              aria-label="Duration"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            >
              {unitOptions.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          </Field>

          {unit === "half_day" && !multiDay && (
            <Field label="Which half" required error={errors.halfDayPeriod?.message}>
              <select
                {...register("halfDayPeriod")}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
              >
                {HALF_PERIODS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {unit === "half_day" && multiDay && (
            <Field label="Which half, per day" required error={errors.halfDaySlots?.message}>
              <PerDayPicker
                name="halfDaySlots"
                options={{
                  key: "period",
                  label: "Half",
                  choices: HALF_PERIODS,
                  primeWith: { period: "first" },
                }}
              />
            </Field>
          )}

          {unit === "mixed" && (
            <Field label="Each day" required error={errors.dayBreakdown?.message}>
              <PerDayPicker
                name="dayBreakdown"
                options={{
                  key: "kind",
                  label: "Day",
                  choices: MIXED_KINDS,
                  primeWith: { kind: "full" },
                }}
              />
            </Field>
          )}

          {unit === "hour" && (
            <div className="grid grid-cols-3 gap-4">
              <Field label="From" required error={errors.hourFrom?.message}>
                <Input type="time" {...register("hourFrom")} />
              </Field>
              <Field label="To" required error={errors.hourTo?.message}>
                <Input type="time" {...register("hourTo")} />
              </Field>
              <Field label="Hours" required error={errors.hoursPerDay?.message}>
                <Input
                  type="number"
                  step="0.5"
                  min="0.5"
                  max="24"
                  {...register("hoursPerDay", { valueAsNumber: true })}
                />
              </Field>
            </div>
          )}

          <Field label="Reason" required error={errors.reason?.message}>
            <textarea
              {...register("reason")}
              rows={3}
              placeholder="Why you need the time off"
              className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none placeholder-slate-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            />
          </Field>

          {estimate !== null && (
            <p
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600"
              data-testid="leave-estimate"
            >
              {estimate > 0 ? (
                <>
                  This will use <span className="font-semibold">{formatDays(estimate)}</span>.
                  Weekends and holidays are only counted when they fall between two full days of
                  leave. The final figure is confirmed by the server.
                </>
              ) : (
                <>That range has no working days in it — it falls on weekends or holidays.</>
              )}
            </p>
          )}

          <div className="flex justify-end gap-3 border-t border-slate-100 pt-4">
            <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={estimate === 0}>
              Submit request
            </Button>
          </div>
        </form>
      </FormProvider>
    </Drawer>
  );
}

export default ApplyLeaveDrawer;
