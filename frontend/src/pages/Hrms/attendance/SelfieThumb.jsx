import { useState } from "react";
import { Camera, Loader2 } from "lucide-react";

import { Modal } from "../../../components/ui/Modal";
import { attendanceApi } from "../../../services/hrms";

/**
 * A punch photo, fetched only when someone actually asks to see it.
 *
 * ---------------------------------------------------------------------------
 * Why this is a button and not an <img src>
 * ---------------------------------------------------------------------------
 * There is no URL to put in a `src`. A selfie lives in private storage and is
 * reachable only through a 60-second presigned link that the server issues
 * after checking the caller's scope against the person in the photograph - and
 * it writes an audit entry each time it does. That entry is the record of a
 * photograph being VIEWED, so minting one for every row of a table would file
 * dozens of views nobody performed and hand out dozens of bearer-capable URLs
 * to go with them.
 *
 * The reference renders `<Image src={r.clockInSelfieUrl} width={36} height={36}>`
 * inline, which is only possible because its endpoint is public - the single
 * worst defect AD-15 names. So the SHAPE is reproduced exactly (36x36, 4px
 * radius, 2px border, green for the in-punch and red for the out-punch, side by
 * side under the location line) and only the loading moment differs: the image
 * arrives on click rather than on render.
 */

/** The reference's border colours, kept verbatim. */
const TONES = { in: "#1e8e5a", out: "#c0342c" };

function useSelfie(recordId, punch) {
  const [state, setState] = useState("idle");
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);

  const open = async () => {
    if (state === "loading") return;
    setState("loading");
    setError(null);
    try {
      const result = await attendanceApi.selfieUrl(recordId, punch);
      setUrl(result?.url ?? null);
      setState("open");
    } catch (err) {
      setError(err?.message ?? "Could not load the photo.");
      setState("open");
    }
  };

  const close = () => {
    setState("idle");
    // Dropped rather than kept: the link expires in a minute, so a cached one
    // would render a broken image the second time it was opened.
    setUrl(null);
  };

  return { state, url, error, open, close };
}

function SelfieModal({ open, onClose, label, url, error }) {
  return (
    <Modal isOpen={open} onClose={onClose} title={`Punch photo — ${label}`} size="md">
      {error ? (
        <p role="alert" className="text-xs text-error-500 font-medium">
          {error}
        </p>
      ) : url ? (
        <div className="flex flex-col gap-2">
          <img
            src={url}
            alt={`${label} punch photo`}
            className="w-full max-h-[70vh] object-contain rounded-lg border border-slate-200 bg-slate-50"
          />
          <p className="text-[11px] text-slate-400">
            This link expires in about a minute. Reopen the photo to view it again.
          </p>
        </div>
      ) : (
        <p className="text-xs text-slate-500">No photo was stored for this punch.</p>
      )}
    </Modal>
  );
}

/**
 * The 36x36 table thumbnail.
 *
 * Sized and bordered like the reference's, so a row with two photos has the
 * same visual rhythm.
 */
export function SelfieThumb({ recordId, punch, label }) {
  const { state, url, error, open, close } = useSelfie(recordId, punch);

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-label={`View the ${label} photo`}
        title={`${label} selfie`}
        className="w-9 h-9 shrink-0 inline-flex items-center justify-center rounded bg-slate-50 hover:bg-slate-100 transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-1"
        style={{ border: `2px solid ${TONES[punch] ?? TONES.in}` }}
      >
        {state === "loading" ? (
          <Loader2 size={14} className="animate-spin text-slate-500" />
        ) : (
          <Camera size={14} className="text-slate-600" />
        )}
      </button>

      <SelfieModal open={state === "open"} onClose={close} label={label} url={url} error={error} />
    </>
  );
}

/**
 * The pill chip used inside the clock card.
 *
 * The reference's `SelfieChip` - a 26px round thumbnail with a tinted ring, on
 * a translucent white pill, sitting on the gradient.
 */
export function SelfieChip({ recordId, punch, label, tone }) {
  const { state, url, error, open, close } = useSelfie(recordId, punch);

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-label={`View the ${label.toLowerCase()} photo`}
        className="inline-flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full bg-white/[0.14] border border-white/[0.24] backdrop-blur-[6px] hover:bg-white/25 transition-colors focus:outline-none focus:ring-2 focus:ring-white/70"
      >
        <span
          className="w-[26px] h-[26px] rounded-full inline-flex items-center justify-center bg-white/20"
          style={{ border: `1.5px solid ${tone}` }}
        >
          {state === "loading" ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Camera size={12} />
          )}
        </span>
        <span className="text-[11px] font-semibold tracking-[0.3px]">{label}</span>
      </button>

      <SelfieModal open={state === "open"} onClose={close} label={label} url={url} error={error} />
    </>
  );
}

export default SelfieThumb;
