import { useEffect, useState } from "react";
import toast from "react-hot-toast";

import { Drawer } from "../../../components/ui/Drawer";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { helpdeskApi, TICKET_PRIORITY_LABELS } from "../../../services/hrms";
import { createTicketSchema } from "@shared/schemas/helpdesk.js";

/**
 * Raise a ticket.
 *
 * The reference's drawer — category, subject, details, priority — with the
 * category list loaded from the server. Its own version hardcodes
 * `'hr-placeholder'`, `'it-placeholder'` and `'payroll-placeholder'` as the
 * option values, none of which is a uuid, so every submission is rejected by
 * its own validator. There is no endpoint there to populate the list from.
 */

export function RaiseTicketDrawer({ open, onClose, onCreated }) {
  const [form, setForm] = useState({
    categoryId: "",
    subject: "",
    body: "",
    priority: "normal",
  });
  const [categories, setCategories] = useState([]);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({ categoryId: "", subject: "", body: "", priority: "normal" });
    setErrors({});

    let cancelled = false;
    helpdeskApi
      .categories()
      .then((rows) => {
        if (!cancelled) setCategories(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load the ticket categories.");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const set = (patch) => setForm((c) => ({ ...c, ...patch }));
  const chosen = categories.find((c) => c.id === form.categoryId);

  const submit = async (event) => {
    event.preventDefault();

    const payload = {
      categoryId: form.categoryId,
      subject: form.subject.trim(),
      body: form.body.trim(),
      priority: form.priority,
    };

    // The SAME schema the server validates with, so the two cannot drift.
    const parsed = createTicketSchema.safeParse(payload);
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) next[issue.path.join(".")] = issue.message;
      setErrors(next);
      return;
    }

    setSaving(true);
    try {
      const created = await helpdeskApi.raise(parsed.data);
      toast.success(`Ticket ${created.ticketNumber} raised.`);
      onCreated?.(created);
      onClose?.();
    } catch (error) {
      toast.error(error?.message ?? "That ticket could not be raised.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen={open}
      onClose={saving ? () => {} : onClose}
      title="Raise a ticket"
      maxWidth="max-w-lg"
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label
            htmlFor="ticket-category"
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            Category
          </label>
          <select
            id="ticket-category"
            value={form.categoryId}
            onChange={(e) => set({ categoryId: e.target.value })}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">Select a category…</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">
            {chosen
              ? `Answered within ${chosen.slaHours} hours by the ${chosen.name} team.`
              : "The category decides which team answers, and how quickly."}
          </p>
          {errors.categoryId && (
            <p className="mt-1 text-xs text-error-600">{errors.categoryId}</p>
          )}
        </div>

        <div>
          <label
            htmlFor="ticket-subject"
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            Subject
          </label>
          <Input
            id="ticket-subject"
            value={form.subject}
            onChange={(e) => set({ subject: e.target.value })}
            placeholder="A short summary of the problem"
            maxLength={200}
          />
          {errors.subject && <p className="mt-1 text-xs text-error-600">{errors.subject}</p>}
        </div>

        <div>
          <label htmlFor="ticket-body" className="mb-1 block text-sm font-medium text-slate-700">
            Details
          </label>
          <textarea
            id="ticket-body"
            rows={6}
            maxLength={10_000}
            value={form.body}
            onChange={(e) => set({ body: e.target.value })}
            placeholder="What happened, what you expected, and anything you have already tried."
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
          {errors.body && <p className="mt-1 text-xs text-error-600">{errors.body}</p>}
        </div>

        <div>
          <label
            htmlFor="ticket-priority"
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            Priority
          </label>
          <select
            id="ticket-priority"
            value={form.priority}
            onChange={(e) => set({ priority: e.target.value })}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            {Object.entries(TICKET_PRIORITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Raising…" : "Raise ticket"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default RaiseTicketDrawer;
