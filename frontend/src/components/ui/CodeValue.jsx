/**
 * A SKU or MSIL code, shown in full.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 *
 * Some SKU numbers and MSIL codes are long enough that the cell they sat in cut
 * them off, and the customer could not re-check the code before confirming a
 * booking. A truncated identifier is worse than a narrow one: "9031A-KT-45…"
 * and "9031A-KT-4512" look identical on screen and are different parts.
 *
 * ---------------------------------------------------------------------------
 * WHY WRAPPING AND NOT `truncate`, A TOOLTIP, OR A SCROLLER
 * ---------------------------------------------------------------------------
 *
 * The value WRAPS. Every alternative was considered and each fails the actual
 * job, which is "read this code and compare it against a piece of paper":
 *
 *   `truncate` + title=      Hover is not available on the tablets the desk
 *                            uses, and a value you must hover to read cannot be
 *                            compared against a PO at a glance.
 *   horizontal scroll        Hides the end of the code behind a gesture, and a
 *                            scrollbar inside a table cell is a nuisance to hit.
 *   shrinking the font       Illegible exactly when the code is longest, which
 *                            is when it matters most.
 *
 * Wrapping costs a little row height on the few long codes and shows every
 * character of all of them. `break-all` rather than `break-word` because these
 * codes have no spaces — a word-boundary break would refuse to split them and
 * overflow anyway.
 *
 * `title` is still set, so a desktop hover gives the value as one unbroken
 * string for copying. It is an addition, never the only way to read it.
 *
 * `tabular-nums` keeps digits in fixed-width columns so two codes that differ
 * in one character line up when stacked, which is what makes a mismatch visible
 * rather than merely present.
 */
export function CodeValue({
  value,
  className = "",
  tone = "default",
  placeholder = "—",
}) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-slate-400">{placeholder}</span>;
  }

  const text = String(value);
  const tones = {
    default: "text-slate-800 font-bold",
    muted: "text-slate-500 font-semibold",
  };

  return (
    <span
      title={text}
      className={`block font-mono tabular-nums tracking-tight break-all leading-snug ${tones[tone] ?? tones.default} ${className}`}
    >
      {text}
    </span>
  );
}

export default CodeValue;
