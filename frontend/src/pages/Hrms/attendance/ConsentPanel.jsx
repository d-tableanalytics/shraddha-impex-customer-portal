import { useState } from "react";
import { Camera, MapPin, ChevronDown } from "lucide-react";

import { CONSENT_PURPOSES } from "@shared/constants/hrms.js";

/**
 * Consent for photo and location capture (AD-15).
 *
 * ---------------------------------------------------------------------------
 * Why this is small
 * ---------------------------------------------------------------------------
 * The reference has NO consent UI. Its ClockInCard simply demands camera and
 * location and refuses to punch without them, so there is nothing here to match
 * pixel for pixel - the nearest thing it has is an 11px footnote on the card.
 *
 * The security behaviour must stay (declining still records the punch, and
 * withdrawal is always available), but the SURFACE had no business being two
 * large stacked cards below the fold: that gave a control the reference does
 * not have more visual weight than the clock itself.
 *
 * So it is a compact strip under the card, at the reference's own footnote
 * density: one row per purpose, the state on the right, and the full notice
 * folded away behind a disclosure. Nothing is hidden - the wording is one click
 * away and the row states plainly that both are optional.
 *
 * ---------------------------------------------------------------------------
 * What must not change
 * ---------------------------------------------------------------------------
 *   - the notice text comes from the SERVER, so the page can never display one
 *     wording while the ledger records agreement to another
 *   - withdrawing is one click, in the same place as granting, with no
 *     confirmation step in front of it (a DPDP requirement, and the line
 *     between a consent control and a dark pattern)
 *   - nothing here is pre-ticked, and nothing blocks the punch
 */
const PURPOSE_META = {
  [CONSENT_PURPOSES.ATTENDANCE_SELFIE]: { icon: Camera, label: "Photo at punch" },
  [CONSENT_PURPOSES.ATTENDANCE_LOCATION]: { icon: MapPin, label: "Location at punch" },
};

function ConsentRow({ entry, onChange, busy }) {
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const meta = PURPOSE_META[entry.purpose] ?? { icon: Camera, label: entry.purpose };
  const Icon = meta.icon;

  const act = async (granted) => {
    setPending(true);
    try {
      await onChange(entry.purpose, granted);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Icon size={14} className="text-slate-400 shrink-0" />

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex items-center gap-1 min-w-0 flex-1 text-left focus:outline-none focus:ring-2 focus:ring-primary-500 rounded"
        >
          <span className="text-xs font-semibold text-slate-700 truncate">{meta.label}</span>
          <ChevronDown
            size={12}
            className={`text-slate-400 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>

        <span
          className={`text-[11px] font-semibold shrink-0 ${
            entry.granted ? "text-success-600" : "text-slate-400"
          }`}
        >
          {entry.granted ? "Allowed" : entry.decided ? "Off" : "Not set"}
        </span>

        {/*
          One control, both directions, same place. `disabled` rather than a
          spinner swap so the button does not change width mid-click.
        */}
        <button
          type="button"
          onClick={() => act(!entry.granted)}
          disabled={pending || busy}
          className="shrink-0 px-2 py-1 rounded-md border border-slate-200 bg-white text-[11px] font-semibold text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          {entry.granted ? "Withdraw" : "Allow"}
        </button>
      </div>

      {expanded && (
        <div className="px-3 pb-2.5 pl-[34px] space-y-1.5">
          <p className="text-[11px] text-slate-600 leading-relaxed">{entry.notice.body}</p>
          <p className="text-[11px] text-slate-500 leading-relaxed font-medium">
            {entry.notice.optional}
          </p>
        </div>
      )}

      {/*
        A reworded notice invalidates the previous answer, and saying so is the
        point of versioning it - otherwise a re-prompt looks like the system
        forgetting what it was told. Always visible, never behind the fold.
      */}
      {entry.supersededByNewVersion && (
        <p className="px-3 pb-2 pl-[34px] text-[11px] text-warning-600 font-medium">
          These terms changed since you last answered. Please answer again.
        </p>
      )}
    </div>
  );
}

export function ConsentPanel({ consent, onChange, busy = false }) {
  if (!consent) return null;

  return (
    <section
      aria-label="Photo and location consent"
      className="bg-white border border-slate-200 rounded-lg overflow-hidden"
    >
      <p className="px-3 pt-2.5 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
        Capture — both optional
      </p>
      {Object.values(consent).map((entry) => (
        <ConsentRow key={entry.purpose} entry={entry} onChange={onChange} busy={busy} />
      ))}
    </section>
  );
}

export default ConsentPanel;
