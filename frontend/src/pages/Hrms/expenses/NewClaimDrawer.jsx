import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Plus, Trash2 } from "lucide-react";

import { Drawer } from "../../../components/ui/Drawer";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { expensesApi, todayIso } from "../../../services/hrms";
import { createClaimSchema } from "@shared/schemas/expense.js";
import { Money } from "./expensesShared";

/**
 * File a new claim.
 *
 * The reference's `CreateClaimDrawer`: a title, then a repeating card per line
 * item, saved as a draft. Same shape, with two corrections.
 *
 * ---------------------------------------------------------------------------
 * The amount is a STRING all the way down
 * ---------------------------------------------------------------------------
 * The reference binds each amount to an `InputNumber` and posts a JSON number,
 * so the value is an IEEE double before it leaves the browser. Here the input
 * is text, the value is never parsed, and the string is what is posted — so
 * what the person typed is exactly what is stored.
 *
 * ---------------------------------------------------------------------------
 * The running total is computed in PAISE
 * ---------------------------------------------------------------------------
 * Summing the lines with `+` would show 0.30000000000000004 for two lines of
 * 0.10 and 0.20 — and the server, which sums exactly, would then disagree with
 * the figure the person just saw. Integer paise keeps the two in step.
 */

const emptyLine = () => ({ categoryId: "", date: todayIso(), amount: "", description: "" });

/** Exact addition over the typed strings; anything unparseable counts as zero. */
function sumLines(lines) {
  const paise = lines.reduce((total, line) => {
    const text = String(line.amount ?? "").trim();
    if (!/^\d+(\.\d{1,2})?$/.test(text)) return total;
    const [whole, fraction = ""] = text.split(".");
    return total + BigInt(whole) * 100n + BigInt(`${fraction}00`.slice(0, 2));
  }, 0n);
  return `${paise / 100n}.${String(paise % 100n).padStart(2, "0")}`;
}

export function NewClaimDrawer({ open, onClose, onCreated }) {
  const [title, setTitle] = useState("");
  const [lines, setLines] = useState([emptyLine()]);
  const [categories, setCategories] = useState([]);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setLines([emptyLine()]);
    setErrors({});

    let cancelled = false;
    expensesApi
      .categories()
      .then((rows) => {
        if (!cancelled) setCategories(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load expense categories.");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const total = useMemo(() => sumLines(lines), [lines]);

  const setLine = (index, patch) =>
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  const submit = async (event) => {
    event.preventDefault();

    const payload = {
      title: title.trim(),
      lineItems: lines.map((line) => ({
        categoryId: line.categoryId,
        date: line.date,
        amount: String(line.amount ?? "").trim(),
        description: line.description.trim(),
      })),
    };

    // The SAME schema the server validates with, so the two cannot drift.
    const parsed = createClaimSchema.safeParse(payload);
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) next[issue.path.join(".")] = issue.message;
      setErrors(next);
      return;
    }

    setSaving(true);
    try {
      const created = await expensesApi.create(parsed.data);
      toast.success("Draft claim created.");
      onCreated?.(created);
      onClose?.();
    } catch (error) {
      toast.error(error?.message ?? "Could not create that claim.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen={open}
      onClose={saving ? () => {} : onClose}
      title="New expense claim"
      maxWidth="max-w-3xl"
    >
      <form onSubmit={submit} className="flex h-full flex-col">
        <div className="flex-1 space-y-5 overflow-y-auto px-1">
          <div>
            <label htmlFor="claim-title" className="mb-1 block text-sm font-medium text-slate-700">
              Title
            </label>
            <Input
              id="claim-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. April client meetings"
              maxLength={200}
            />
            {errors.title && <p className="mt-1 text-xs text-error-600">{errors.title}</p>}
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">Line items</h3>

            {lines.map((line, index) => (
              <div
                key={index}
                className="mb-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3"
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                  <div className="sm:col-span-5">
                    <label
                      htmlFor={`line-${index}-category`}
                      className="mb-1 block text-xs font-medium text-slate-600"
                    >
                      Category
                    </label>
                    <select
                      id={`line-${index}-category`}
                      value={line.categoryId}
                      onChange={(e) => setLine(index, { categoryId: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
                    >
                      <option value="">Select a category…</option>
                      {categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.code} · {category.name}
                        </option>
                      ))}
                    </select>
                    {errors[`lineItems.${index}.categoryId`] && (
                      <p className="mt-1 text-xs text-error-600">
                        {errors[`lineItems.${index}.categoryId`]}
                      </p>
                    )}
                  </div>

                  <div className="sm:col-span-4">
                    <label
                      htmlFor={`line-${index}-date`}
                      className="mb-1 block text-xs font-medium text-slate-600"
                    >
                      Date
                    </label>
                    <Input
                      id={`line-${index}-date`}
                      type="date"
                      value={line.date}
                      max={todayIso()}
                      onChange={(e) => setLine(index, { date: e.target.value })}
                    />
                    {errors[`lineItems.${index}.date`] && (
                      <p className="mt-1 text-xs text-error-600">
                        {errors[`lineItems.${index}.date`]}
                      </p>
                    )}
                  </div>

                  <div className="sm:col-span-3">
                    <label
                      htmlFor={`line-${index}-amount`}
                      className="mb-1 block text-xs font-medium text-slate-600"
                    >
                      Amount (₹)
                    </label>
                    {/*
                      `type="text"` with a numeric keypad, NOT `type="number"`:
                      a number input hands back a float and silently rounds what
                      it cannot represent.
                    */}
                    <Input
                      id={`line-${index}-amount`}
                      type="text"
                      inputMode="decimal"
                      value={line.amount}
                      onChange={(e) => setLine(index, { amount: e.target.value })}
                      placeholder="0.00"
                    />
                    {errors[`lineItems.${index}.amount`] && (
                      <p className="mt-1 text-xs text-error-600">
                        {errors[`lineItems.${index}.amount`]}
                      </p>
                    )}
                  </div>

                  <div className="sm:col-span-12">
                    <label
                      htmlFor={`line-${index}-description`}
                      className="mb-1 block text-xs font-medium text-slate-600"
                    >
                      Description
                    </label>
                    <Input
                      id={`line-${index}-description`}
                      value={line.description}
                      onChange={(e) => setLine(index, { description: e.target.value })}
                      placeholder="What was this for?"
                      maxLength={500}
                    />
                    {errors[`lineItems.${index}.description`] && (
                      <p className="mt-1 text-xs text-error-600">
                        {errors[`lineItems.${index}.description`]}
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-2 flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={lines.length === 1}
                    onClick={() => setLines((c) => c.filter((_, i) => i !== index))}
                    aria-label={`Remove line item ${index + 1}`}
                  >
                    <Trash2 className="h-4 w-4 text-error-600" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ))}

            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={() => setLines((c) => [...c, emptyLine()])}
            >
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
              Add line item
            </Button>
            {errors.lineItems && <p className="mt-1 text-xs text-error-600">{errors.lineItems}</p>}
          </div>
        </div>

        <div className="mt-4 border-t border-slate-200 pt-4">
          <div className="mb-3 flex items-center justify-between text-sm">
            <span className="font-medium text-slate-600">Claim total</span>
            <span className="text-base font-semibold text-slate-900">
              <Money value={total} />
            </span>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save draft"}
            </Button>
          </div>
        </div>
      </form>
    </Drawer>
  );
}

export default NewClaimDrawer;
