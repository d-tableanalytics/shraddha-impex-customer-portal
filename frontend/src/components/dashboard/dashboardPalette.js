/**
 * One palette for the home dashboard ("/"), so a quantity wears the same colour
 * in every widget: "Booked" is indigo on the conversion chips AND the trend
 * chart, "Confirmed" emerald in both, and so on.
 *
 * SERIES are data colours (chart lines, bar segments, legend dots). They were
 * checked with the dataviz palette validator against the light card (#ffffff)
 * and the dark card (#232e42 — see `html.dark .bg-white` in index.css):
 *   - booked/confirmed pass every check in both themes.
 *   - confirmed/pending sit just under the colour-blind target (ΔE 7.9), which
 *     is allowed only with a second cue — and every part also carries a text
 *     label, a 2px gap, and (where it fits) its value.
 *   - reserved is deliberately the app's neutral slate: "in the selection list,
 *     not yet confirmed" is the not-yet-anything state, and reads as such.
 * Text never wears these colours; labels stay in the slate text tokens.
 */
export const SERIES = {
  booked: '#6366f1',    // indigo-500 — total demand
  confirmed: '#059669', // emerald-600 — fulfilled
  pending: '#d97706',   // amber-600 — indent, awaiting stock
  reserved: '#64748b',  // slate-500 — in selection list, awaiting confirm
};

/**
 * Accent hues for icon chips, tile rules and status markers: a step for the
 * light theme and a lighter step of the SAME hue for the dark theme (the -600s
 * go muddy on the navy cards). Applied through CSS variables — see `.dash-accent`
 * in index.css — so tints are derived with opacity and one piece of markup reads
 * correctly in both themes, instead of a dark-mode remap per hue.
 */
export const ACCENTS = {
  primary: ['#2563eb', '#60a5fa'],
  warning: ['#ea580c', '#fb923c'],
  error: ['#dc2626', '#f87171'],
  amber: ['#d97706', '#fbbf24'],
  indigo: ['#4f46e5', '#818cf8'],
  emerald: ['#059669', '#34d399'],
  teal: ['#0d9488', '#2dd4bf'],
  slate: ['#64748b', '#94a3b8'],
};

/** Inline style that sets an element's accent. Pair it with the `dash-accent` class. */
export const accentStyle = (name) => {
  const [light, dark] = ACCENTS[name] || ACCENTS.slate;
  return { '--dash-accent-l': light, '--dash-accent-d': dark };
};
