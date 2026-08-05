import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DayPicker } from "react-day-picker";
import { Calendar as CalendarIcon, X } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

import { toYmd, fromYmd, formatDisplayDate } from "../../utils/dateValue";

/**
 * The portal's one date control.
 *
 * Replaces `<input type="date">`, whose calendar is drawn by the browser and so
 * looked different in Chrome, Firefox and Edge — and on Firefox for a long time
 * was not drawn at all. This renders the same calendar everywhere.
 *
 * The value contract is deliberately unchanged: a "YYYY-MM-DD" string in, a
 * "YYYY-MM-DD" string out, empty string for no date. Every filter, store and API
 * in the portal already speaks that format, so nothing downstream had to change.
 * `onChange` receives the string directly rather than an event — there is no
 * input element to carry one.
 *
 * Dates are converted in LOCAL time throughout — see utils/dateValue.js for why
 * that matters and what goes wrong otherwise.
 */

// Calendar theme. Supplied in full so the library's own stylesheet is never
// imported — one less set of styles to override and keep in step with the
// portal's palette.
const calendarClassNames = {
  root: "p-3",
  months: "relative",
  month: "w-full",
  month_caption: "flex items-center justify-center h-8 mb-1",
  caption_label: "text-sm font-black text-slate-800",
  dropdowns: "flex items-center gap-1.5",
  dropdown_root: "relative inline-flex items-center",
  dropdown:
    "appearance-none bg-white border border-slate-200 rounded-md pl-2 pr-6 py-1 " +
    "text-xs font-bold text-slate-700 outline-none cursor-pointer " +
    "hover:border-slate-300 focus:ring-1 focus:ring-primary-500",
  nav: "absolute inset-x-0 top-0 flex items-center justify-between h-8 pointer-events-none",
  button_previous:
    "pointer-events-auto inline-flex items-center justify-center w-7 h-7 rounded-md " +
    "text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors " +
    "disabled:opacity-30 disabled:pointer-events-none",
  button_next:
    "pointer-events-auto inline-flex items-center justify-center w-7 h-7 rounded-md " +
    "text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors " +
    "disabled:opacity-30 disabled:pointer-events-none",
  chevron: "w-4 h-4 fill-current",
  month_grid: "w-full border-collapse",
  weekdays: "flex",
  weekday:
    "w-9 h-8 flex items-center justify-center text-[10px] font-bold " +
    "text-slate-400 uppercase tracking-wider",
  weeks: "",
  week: "flex mt-0.5",
  day: "w-9 h-9 p-0",
  day_button:
    "w-9 h-9 inline-flex items-center justify-center rounded-lg text-[13px] font-semibold " +
    "text-slate-700 hover:bg-primary-50 hover:text-primary-700 transition-colors " +
    "focus:outline-none focus:ring-1 focus:ring-primary-500",
  today: "[&>button]:text-primary-600 [&>button]:font-black [&>button]:ring-1 [&>button]:ring-primary-200",
  selected:
    "[&>button]:bg-primary-600 [&>button]:text-white [&>button]:font-black " +
    "[&>button]:hover:bg-primary-700 [&>button]:hover:text-white [&>button]:ring-0",
  outside: "[&>button]:text-slate-300 [&>button]:font-normal",
  disabled: "[&>button]:text-slate-300 [&>button]:line-through [&>button]:pointer-events-none",
  hidden: "invisible",
};

export const DateField = ({
  value,
  onChange,
  min,
  max,
  placeholder = "Select date",
  className,
  disabled = false,
  clearable = true,
  id,
  align = "left",
  ...rest
}) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const popRef = useRef(null);

  const selected = fromYmd(value);
  const minDate = fromYmd(min);
  const maxDate = fromYmd(max);

  // Fixed positioning against the trigger's viewport rect. The calendar is
  // portalled to <body> because these fields sit inside a drawer with
  // overflow-hidden and inside horizontally scrolling tables — rendered in
  // place, the popup would be clipped by its own container.
  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = 288;
    const height = 340;
    // Flip above when there is not room below, and keep it on screen sideways.
    const below = window.innerHeight - r.bottom;
    const top = below < height && r.top > height ? r.top - height - 6 : r.bottom + 6;
    let left = align === "right" ? r.right - width : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    setPos({ top, left, width });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    // `true` captures scrolls on ancestor containers, not just the window —
    // these fields live inside scrollable drawers and toolbars.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (date) => {
    // Clicking the selected day again clears it, which is how DayPicker reports
    // a deselection. Honoured rather than ignored: several of these fields are
    // filters, where clearing is the normal way back to "any date".
    onChange(date ? toYmd(date) : "");
    setOpen(false);
  };

  const clear = (e) => {
    e.stopPropagation();
    onChange("");
  };

  // Year bounds for the dropdown navigation. Without them the caption offers a
  // single year, which makes filtering last year's ledger a lot of clicking.
  const today = new Date();
  const startMonth = minDate ?? new Date(today.getFullYear() - 6, 0, 1);
  const endMonth = maxDate ?? new Date(today.getFullYear() + 6, 11, 31);

  const restrictions = [];
  if (minDate) restrictions.push({ before: minDate });
  if (maxDate) restrictions.push({ after: maxDate });

  return (
    <>
      <button
        type="button"
        id={id}
        ref={triggerRef}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={twMerge(
          clsx(
            "w-full flex items-center gap-2 px-3 py-2 text-sm bg-white border rounded-lg",
            "outline-none transition-colors text-left",
            open ? "border-primary-500 ring-1 ring-primary-500" : "border-slate-300 hover:border-slate-400",
            disabled && "opacity-50 cursor-not-allowed hover:border-slate-300",
            selected ? "text-slate-700 font-semibold" : "text-slate-400 font-medium",
          ),
          className,
        )}
        {...rest}
      >
        <CalendarIcon size={15} className="shrink-0 text-slate-400" />
        <span className="flex-1 truncate">{selected ? formatDisplayDate(selected) : placeholder}</span>
        {clearable && selected && !disabled && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="Clear date"
            onClick={clear}
            className="shrink-0 p-0.5 -mr-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
          >
            <X size={13} />
          </span>
        )}
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          role="dialog"
          aria-label="Choose a date"
          style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width }}
          className="z-100 bg-white border border-slate-200 rounded-xl shadow-2xl"
        >
          <DayPicker
            mode="single"
            selected={selected}
            onSelect={pick}
            defaultMonth={selected ?? undefined}
            startMonth={startMonth}
            endMonth={endMonth}
            disabled={restrictions.length ? restrictions : undefined}
            captionLayout="dropdown"
            weekStartsOn={1}
            showOutsideDays
            autoFocus
            classNames={calendarClassNames}
          />
          <div className="flex items-center justify-between px-3 py-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => pick(new Date())}
              className="text-xs font-bold text-primary-600 hover:text-primary-700"
            >
              Today
            </button>
            {clearable && (
              <button
                type="button"
                onClick={() => pick(null)}
                className="text-xs font-bold text-slate-400 hover:text-red-600"
              >
                Clear
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

export default DateField;
