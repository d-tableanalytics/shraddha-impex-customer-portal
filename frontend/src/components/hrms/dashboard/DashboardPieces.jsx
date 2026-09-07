import { Link } from "react-router-dom";
import { twMerge } from "tailwind-merge";
import * as Icons from "lucide-react";

import { EmptyState } from "../../ui/EmptyState";

/**
 * The dashboard's building blocks.
 *
 * The reference builds its dashboard out of AntD `Card`, `Statistic`, `List`
 * and `Avatar` with inline `style` objects — 1181 lines across three files, much
 * of it repeated per widget. These are the same shapes in Shraddha's own
 * primitives and Tailwind, factored once so the page stays a layout.
 *
 * No Ant Design, and no CSS copied from the reference: the visual hierarchy is
 * reproduced (hero, then quick access, then operational cards, then metrics),
 * the implementation is this design system's.
 */

// ---------------------------------------------------------------------------
// Section heading
// ---------------------------------------------------------------------------

export function SectionTitle({ title, subtitle, action }) {
  return (
    <div className="flex items-end justify-between gap-3 mb-3">
      <div className="min-w-0">
        <h2 className="text-sm font-bold text-slate-900">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * A widget card with a title, an optional "View all", and its own states.
 *
 * 🔴 Each card renders its OWN empty state. The reference has no per-widget
 * error handling at all — one failed query blanks the whole dashboard — and the
 * server here settles each widget independently so a card can be empty while
 * its neighbours are fine.
 */
export function WidgetCard({ title, icon: Icon, viewAllTo, viewAllLabel = "View all", children, isEmpty, emptyTitle, emptyDescription, className }) {
  return (
    <section
      className={twMerge(
        "flex flex-col bg-white border border-slate-200 rounded-xl shadow-enterprise overflow-hidden",
        className,
      )}
    >
      <header className="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-100">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon size={14} className="shrink-0 text-slate-400" />}
          <h3 className="text-[13px] font-bold text-slate-900 truncate">{title}</h3>
        </div>
        {viewAllTo && (
          <Link
            to={viewAllTo}
            className="shrink-0 text-[11px] font-bold text-primary-700 hover:underline"
          >
            {viewAllLabel}
          </Link>
        )}
      </header>

      <div className="flex-1 p-4">
        {isEmpty ? (
          <EmptyState title={emptyTitle} description={emptyDescription} className="border-0 py-4" />
        ) : (
          children
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Metric tile
// ---------------------------------------------------------------------------

const TONE_BAR = {
  neutral: "bg-slate-300",
  positive: "bg-success-600",
  warning: "bg-warning-500",
  danger: "bg-error-500",
};

/**
 * One workforce number.
 *
 * The reference uses a gradient tile per KPI, cycling seven CSS gradients by
 * index — so the colour carries no meaning. Here the accent follows the TONE
 * the server already sends (`positive`, `warning`, `neutral`), which is the
 * thing a reader is actually trying to see.
 */
export function StatTile({ label, value, tone = "neutral", to }) {
  const body = (
    <>
      <span className={twMerge("absolute inset-x-0 top-0 h-1", TONE_BAR[tone] ?? TONE_BAR.neutral)} />
      <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</span>
      <span className="text-2xl font-bold text-slate-900 tabular-nums mt-1">
        {typeof value === "number" ? value.toLocaleString("en-IN") : value}
      </span>
    </>
  );

  const shell =
    "relative flex flex-col justify-center px-4 py-4 bg-white border border-slate-200 rounded-xl shadow-enterprise overflow-hidden";

  return to ? (
    <Link to={to} className={twMerge(shell, "transition-colors hover:border-primary-300")}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const AVATAR_TONES = [
  "bg-primary-100 text-primary-700",
  "bg-success-50 text-success-600",
  "bg-warning-50 text-warning-600",
  "bg-slate-100 text-slate-600",
];

/**
 * Initials, not a photo.
 *
 * The reference joins `user.avatarUrl` onto every widget row. No HRMS DTO here
 * exposes an avatar, and adding an image join to six widgets is scope this does
 * not need — the reference falls back to exactly this when the URL is null.
 * The tint is derived from the name so a given person looks the same wherever
 * they appear.
 */
export function Initial({ name, size = 32 }) {
  const text = String(name ?? "?").trim();
  const initial = text.charAt(0).toUpperCase() || "?";
  const tone = AVATAR_TONES[text.length % AVATAR_TONES.length];

  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      className={twMerge(
        "shrink-0 inline-flex items-center justify-center rounded-full font-bold",
        tone,
      )}
    >
      {initial}
    </span>
  );
}

/** A person row: initial, name, and one line of context. */
export function PersonRow({ name, meta, trailing, to }) {
  const inner = (
    <>
      <Initial name={name} />
      <span className="flex flex-col min-w-0">
        <span className="text-[13px] font-semibold text-slate-900 truncate">{name}</span>
        {meta && <span className="text-[11px] text-slate-500 truncate">{meta}</span>}
      </span>
      {trailing && <span className="ml-auto shrink-0">{trailing}</span>}
    </>
  );

  const shell = "flex items-center gap-2.5 py-2 min-w-0";

  return to ? (
    <Link to={to} className={twMerge(shell, "-mx-2 px-2 rounded-lg hover:bg-slate-50")}>
      {inner}
    </Link>
  ) : (
    <div className={shell}>{inner}</div>
  );
}

// ---------------------------------------------------------------------------
// Quick access
// ---------------------------------------------------------------------------

const QA_TONE = {
  primary: "bg-primary-50 text-primary-700 group-hover:bg-primary-100",
  success: "bg-success-50 text-success-600 group-hover:bg-success-100",
  warning: "bg-warning-50 text-warning-600 group-hover:bg-warning-100",
  danger: "bg-error-50 text-error-500 group-hover:bg-error-100",
  neutral: "bg-slate-100 text-slate-600 group-hover:bg-slate-200",
};

/**
 * One Quick Access tile.
 *
 * The SERVER decides which of these exist — it filters the shared catalogue
 * with the same evaluator the routes use — so this renders what it is given and
 * never re-decides. A tile the API would refuse is never sent.
 *
 * `icon` arrives as a lucide name; an unknown one falls back rather than
 * crashing the dashboard, which is what `Icons[name]` returning undefined would
 * otherwise do.
 */
export function QuickAccessTile({ item, prefix }) {
  const Icon = Icons[item.icon] ?? Icons.Circle;

  return (
    <Link
      to={`${prefix}${item.path}`}
      className="group flex flex-col items-center gap-2 px-2 py-4 bg-white border border-slate-200 rounded-xl shadow-enterprise transition-colors hover:border-primary-300"
    >
      <span
        className={twMerge(
          "inline-flex items-center justify-center w-10 h-10 rounded-xl transition-colors",
          QA_TONE[item.tone] ?? QA_TONE.neutral,
        )}
      >
        <Icon size={18} />
      </span>
      <span className="text-[11.5px] font-semibold text-slate-700 text-center leading-tight">
        {item.label}
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** A card-shaped skeleton, so the layout does not jump when data lands. */
export function WidgetSkeleton({ className }) {
  return (
    <div
      className={twMerge(
        "bg-white border border-slate-200 rounded-xl shadow-enterprise p-4 animate-pulse",
        className,
      )}
    >
      <div className="h-3 w-1/3 bg-slate-200 rounded mb-4" />
      <div className="flex flex-col gap-2.5">
        <div className="h-2.5 bg-slate-100 rounded w-full" />
        <div className="h-2.5 bg-slate-100 rounded w-4/5" />
        <div className="h-2.5 bg-slate-100 rounded w-2/3" />
      </div>
    </div>
  );
}
