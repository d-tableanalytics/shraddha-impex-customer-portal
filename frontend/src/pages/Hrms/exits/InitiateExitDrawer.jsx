import { useEffect, useState } from "react";
import toast from "react-hot-toast";

import { Drawer } from "../../../components/ui/Drawer";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { exitsApi, EXIT_REASON_LABELS } from "../../../services/hrms";
import { createExitRequestSchema } from "@shared/schemas/exit.js";

/**
 * File an exit.
 *
 * The reference's `InitiateDrawer`: category, requested last working day,
 * reason. Same three fields, same order.
 *
 * `termination` is offered only when HR is filing on someone else's behalf.
 * The reference hides it from the picker too — but its schema accepts it from
 * anyone, so an employee could still post a self-termination. Here the server
 * refuses that, and this is the matching half of the same rule.
 */

/** Today, as `YYYY-MM-DD`, in the viewer's own calendar — the earliest last day. */
const todayIso = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function InitiateExitDrawer({ open, onClose, onCreated, onBehalfOf = null }) {
  const forSomeoneElse = Boolean(onBehalfOf);
  const [form, setForm] = useState({
    reasonCategory: "resignation",
    requestedLastDay: "",
    reason: "",
  });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({ reasonCategory: "resignation", requestedLastDay: "", reason: "" });
    setErrors({});
  }, [open]);

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  const categories = forSomeoneElse
    ? ["resignation", "termination", "retirement", "other"]
    : ["resignation", "retirement", "other"];

  const submit = async (event) => {
    event.preventDefault();

    const payload = {
      ...(forSomeoneElse ? { employeeId: onBehalfOf.id } : {}),
      reasonCategory: form.reasonCategory,
      requestedLastDay: form.requestedLastDay,
      reason: form.reason.trim(),
    };

    // The SAME schema the server validates with, so the two cannot drift.
    const parsed = createExitRequestSchema.safeParse(payload);
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) next[issue.path.join(".")] = issue.message;
      setErrors(next);
      return;
    }

    setSaving(true);
    try {
      const created = await exitsApi.initiate(parsed.data);
      toast.success(forSomeoneElse ? "Exit recorded." : "Exit request submitted.");
      onCreated?.(created);
      onClose?.();
    } catch (error) {
      toast.error(error?.message ?? "That exit could not be filed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen={open}
      onClose={saving ? () => {} : onClose}
      title={forSomeoneElse ? `Record an exit — ${onBehalfOf.name}` : "Initiate resignation"}
      maxWidth="max-w-lg"
    >
      <form onSubmit={submit} className="space-y-4">
        {!forSomeoneElse && (
          <p className="rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-600">
            Your reporting manager and HR will be notified. You can withdraw this request until
            your clearances are complete.
          </p>
        )}

        <div>
          <label
            htmlFor="exit-category"
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            Category
          </label>
          <select
            id="exit-category"
            value={form.reasonCategory}
            onChange={(e) => set({ reasonCategory: e.target.value })}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
          >
            {categories.map((value) => (
              <option key={value} value={value}>
                {EXIT_REASON_LABELS[value]}
              </option>
            ))}
          </select>
          {errors.reasonCategory && (
            <p className="mt-1 text-xs text-error-600">{errors.reasonCategory}</p>
          )}
        </div>

        <div>
          <label
            htmlFor="exit-last-day"
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            Requested last working day
          </label>
          <Input
            id="exit-last-day"
            type="date"
            value={form.requestedLastDay}
            min={todayIso()}
            onChange={(e) => set({ requestedLastDay: e.target.value })}
          />
          <p className="mt-1 text-xs text-slate-500">
            HR confirms the actual last day once your notice period is agreed.
          </p>
          {errors.requestedLastDay && (
            <p className="mt-1 text-xs text-error-600">{errors.requestedLastDay}</p>
          )}
        </div>

        <div>
          <label htmlFor="exit-reason" className="mb-1 block text-sm font-medium text-slate-700">
            Reason
          </label>
          <textarea
            id="exit-reason"
            rows={4}
            value={form.reason}
            maxLength={2000}
            onChange={(e) => set({ reason: e.target.value })}
            placeholder={
              forSomeoneElse ? "Why is this exit being recorded?" : "Share your reason for leaving"
            }
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
          />
          {errors.reason && <p className="mt-1 text-xs text-error-600">{errors.reason}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Submitting…" : "Submit"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default InitiateExitDrawer;
