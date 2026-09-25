import { useState, useMemo, useEffect } from "react";
import { Loader2, Upload, Check, AlertTriangle } from "lucide-react";

import { Button } from "../../components/ui/Button";
import { o2dApi, formatDateTime } from "../../services/o2d/orders";
import {
  STAGE_FIELD_TYPES,
  fieldsForStage,
  ZOHO_FILLED_STAGES,
} from "@shared/constants/o2dStageFields.js";
import { STAGES } from "@shared/constants/o2d.js";

/**
 * The stage-specific completion form.
 *
 * ---------------------------------------------------------------------------
 * THE FIELDS COME FROM THE SPEC, NOT FROM HERE
 * ---------------------------------------------------------------------------
 *
 * `fieldsForStage` is the same list the server validates against, so this form
 * cannot ask for something the server ignores, or omit something it will refuse
 * the completion over. Adding a field to a stage is one edit in
 * `shared/constants/o2dStageFields.js` and both sides follow.
 *
 * It also means the rule "never show fields belonging to another stage" is
 * structural rather than a thing to remember: there is no list of all fields
 * anywhere in this component to accidentally render.
 *
 * ---------------------------------------------------------------------------
 * THE ACTUAL COMPLETION TIME IS NOT ON THIS FORM
 * ---------------------------------------------------------------------------
 *
 * Deliberately, and it is worth saying out loud because it looks like an
 * omission. The engine stamps it. A box here would let whoever is closing the
 * stage choose their own SLA result, and §33's back-fill path exists separately
 * and is audited.
 *
 * ---------------------------------------------------------------------------
 * VALIDATION IS THE SERVER'S, MIRRORED HERE FOR SPEED
 * ---------------------------------------------------------------------------
 *
 * The required check below is a courtesy so the user is not waiting on a round
 * trip to be told a box is empty. It is NOT the guard — the engine refuses a
 * completion missing its fields whatever this component does — and when the
 * server does refuse, its message and `field` are shown against the input
 * rather than replacing them with a local guess.
 */

/** A file has to be UPLOADED, not merely chosen. */
const isSatisfied = (field, values, uploaded) =>
  field.type === STAGE_FIELD_TYPES.DOCUMENT
    ? Boolean(uploaded[field.key])
    : !(values[field.key] === undefined
      || values[field.key] === null
      || String(values[field.key]).trim() === "");

/** What a stage stored last time, as form values — so a rework opens filled in. */
function valuesFrom(fields, evidence) {
  const out = {};
  for (const field of fields) {
    const raw = evidence?.[field.key];
    if (field.type === STAGE_FIELD_TYPES.DOCUMENT || raw === undefined || raw === null) continue;
    if (field.type === STAGE_FIELD_TYPES.DATE) out[field.key] = String(raw).slice(0, 10);
    else if (field.type === STAGE_FIELD_TYPES.BOOLEAN) out[field.key] = raw ? "true" : "false";
    else out[field.key] = String(raw);
  }
  return out;
}

export function CompleteStageModal({ order, stage, onClose, onCompleted }) {
  const fields = useMemo(() => fieldsForStage(stage?.stageNumber), [stage?.stageNumber]);
  const zoho = ZOHO_FILLED_STAGES[stage?.stageNumber] ?? null;
  // Stage 4 is a decision that also settles whether stage 5 runs, so it goes
  // through the advance-decision endpoint — the one Order Tracker uses.
  const isAdvanceDecision = stage?.stageNumber === STAGES.ADVANCE_DECISION;

  const [values, setValues] = useState(() => valuesFrom(fields, stage?.evidence));
  const [uploaded, setUploaded] = useState({});
  const [advance, setAdvance] = useState(() =>
    typeof stage?.evidence?.advanceRequired === "boolean" ? String(stage.evidence.advanceRequired) : "",
  );
  const [remarks, setRemarks] = useState(stage?.remarks ?? "");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(null);
  const [error, setError] = useState(null);

  /*
   * A required file already on the order counts — a PO copy attached at intake
   * satisfies stage 2 on the server, so the form must not ask for it again.
   */
  const docFields = fields.filter((f) => f.type === STAGE_FIELD_TYPES.DOCUMENT);
  useEffect(() => {
    if (!order?._id || docFields.length === 0) return;
    let live = true;
    o2dApi.documents(order._id)
      .then((docs) => {
        if (!live) return;
        const onFile = {};
        for (const field of docFields) {
          const doc = (docs ?? []).find((d) => d.docType === field.docType && !d.deletedAt);
          if (doc) onFile[field.key] = doc.originalName || `${field.docType} on file`;
        }
        setUploaded((s) => ({ ...onFile, ...s }));
      })
      .catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?._id, stage?.stageNumber]);

  if (!stage) return null;

  const set = (key) => (e) => {
    const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setValues((s) => ({ ...s, [key]: v }));
    if (error?.field === key) setError(null);
  };

  /**
   * Upload immediately on choosing the file.
   *
   * The server checks that a DOCUMENT EXISTS, not that the payload claims one,
   * so the file has to be on the server before the completion is attempted.
   * Uploading on submit would mean a half-done action if the upload succeeded
   * and the completion then failed validation.
   */
  const upload = (field) => async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(field.key);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("docType", field.docType);
      form.append("stageNumber", String(stage.stageNumber));
      await o2dApi.uploadDocument(order._id, form);
      setUploaded((s) => ({ ...s, [field.key]: file.name }));
    } catch (err) {
      setError({ message: err?.message ?? "That file could not be uploaded.", field: field.key });
    } finally {
      setUploading(null);
    }
  };

  const missing = [
    ...(isAdvanceDecision && advance === ""
      ? [{ key: "advanceRequired", label: "Advance payment decision" }]
      : []),
    ...fields.filter((f) => f.required && !isSatisfied(f, values, uploaded)),
  ];

  const submit = async () => {
    if (missing.length > 0) {
      const first = missing[0];
      setError({ message: `${first.label} is required.`, field: first.key });
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (isAdvanceDecision) {
        await o2dApi.advanceDecision(order._id, {
          advanceRequired: advance === "true",
          remarks: remarks.trim() || null,
        });
        onCompleted?.();
        onClose();
        return;
      }

      // Documents are already on the server; only the value fields travel.
      const evidence = Object.fromEntries(
        fields
          .filter((f) => f.type !== STAGE_FIELD_TYPES.DOCUMENT)
          .filter((f) => values[f.key] !== undefined && values[f.key] !== "")
          .map((f) => [f.key, values[f.key]]),
      );

      await o2dApi.completeStage(order._id, stage.stageNumber, {
        evidence,
        remarks: remarks.trim() || null,
      });
      onCompleted?.();
      onClose();
    } catch (err) {
      // The server names the offending field; put its message where the fix is.
      setError({ message: err?.message ?? "That stage could not be completed.", field: err?.data?.field ?? null });
    } finally {
      setBusy(false);
    }
  };

  const input =
    "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none " +
    "focus:border-primary-500 focus:ring-1 focus:ring-primary-500";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-enterprise-lg">
        <div className="border-b border-slate-100 px-5 py-4">
          <h3 className="text-sm font-bold text-slate-900">
            Complete stage {stage.stageNumber} — {stage.stageName}
          </h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {order?.poNumber}
            {order?.customerName ? ` · ${order.customerName}` : ""}
            {/* Said plainly, because its absence from the form looks like an
                oversight otherwise. */}
            {" · "}The completion time is recorded automatically.
          </p>
          {(stage.ownerRole || stage.plannedCompletion || stage.assignedToName) && (
            <p className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-slate-500">
              {stage.ownerRole && <span>Owner: <span className="font-semibold text-slate-700">{stage.ownerRole}</span></span>}
              {stage.plannedCompletion && <span>Due: <span className="font-semibold text-slate-700">{formatDateTime(stage.plannedCompletion)}</span></span>}
              {stage.assignedToName && <span>Assigned to: <span className="font-semibold text-slate-700">{stage.assignedToName}</span></span>}
            </p>
          )}
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {zoho && (
            <div className="mb-3 flex gap-2 rounded-lg border border-sky-200 bg-sky-50 p-3">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-sky-600" />
              <p className="text-[11px] leading-relaxed text-sky-900">
                {zoho.autoCompletes
                  ? "When the Zoho Books webhook is live this stage completes itself, and this form is not needed."
                  : "When Zoho Books is connected these values arrive from the invoice rather than being typed."}
              </p>
            </div>
          )}

          {isAdvanceDecision ? (
            <fieldset>
              <legend className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500">
                Does this order need an advance payment?<span className="ml-0.5 text-error-600">*</span>
              </legend>
              <div className="flex flex-col gap-1.5 text-sm text-slate-700">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="advanceRequired"
                    value="true"
                    checked={advance === "true"}
                    onChange={() => { setAdvance("true"); setError(null); }}
                  />
                  Yes — advance required (stage 5 goes to Accounts)
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="advanceRequired"
                    value="false"
                    checked={advance === "false"}
                    onChange={() => { setAdvance("false"); setError(null); }}
                  />
                  No — skip stage 5
                </label>
              </div>
              {error?.field === "advanceRequired" && (
                <p className="mt-1 text-[11px] font-semibold text-error-600">{error.message}</p>
              )}
            </fieldset>
          ) : fields.length === 0 ? (
            <p className="text-sm text-slate-600">
              This stage needs no extra information. Completing it records the time and moves the
              order on.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {fields.map((field) => {
                const invalid = error?.field === field.key;
                return (
                  <div key={field.key}>
                    <label
                      htmlFor={`sf-${field.key}`}
                      className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500"
                    >
                      {field.label}
                      {field.required && <span className="ml-0.5 text-error-600">*</span>}
                    </label>

                    {field.type === STAGE_FIELD_TYPES.DOCUMENT ? (
                      <div>
                        <label
                          htmlFor={`sf-${field.key}`}
                          className={`flex cursor-pointer items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm ${
                            uploaded[field.key]
                              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                              : invalid
                                ? "border-error-400 text-slate-600"
                                : "border-slate-300 text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          {uploading === field.key ? (
                            <Loader2 size={15} className="animate-spin" />
                          ) : uploaded[field.key] ? (
                            <Check size={15} />
                          ) : (
                            <Upload size={15} />
                          )}
                          <span className="truncate">
                            {uploaded[field.key] ?? "Choose a file to upload"}
                          </span>
                        </label>
                        <input
                          id={`sf-${field.key}`}
                          type="file"
                          className="hidden"
                          onChange={upload(field)}
                        />
                      </div>
                    ) : field.type === STAGE_FIELD_TYPES.BOOLEAN ? (
                      <select
                        id={`sf-${field.key}`}
                        className={`${input} ${invalid ? "border-error-500" : ""}`}
                        value={values[field.key] ?? ""}
                        onChange={set(field.key)}
                      >
                        <option value="">Select…</option>
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </select>
                    ) : (
                      <input
                        id={`sf-${field.key}`}
                        type={
                          field.type === STAGE_FIELD_TYPES.NUMBER
                            ? "number"
                            : field.type === STAGE_FIELD_TYPES.DATE
                              ? "date"
                              : "text"
                        }
                        min={field.min}
                        className={`${input} ${invalid ? "border-error-500" : ""}`}
                        value={values[field.key] ?? ""}
                        onChange={set(field.key)}
                      />
                    )}

                    {invalid ? (
                      <p className="mt-1 text-[11px] font-semibold text-error-600">{error.message}</p>
                    ) : field.help ? (
                      <p className="mt-1 text-[11px] text-slate-400">{field.help}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-4">
            <label
              htmlFor="sf-remarks"
              className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500"
            >
              Remarks <span className="font-semibold normal-case text-slate-400">(optional)</span>
            </label>
            <textarea
              id="sf-remarks"
              rows={2}
              className={input}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
            />
          </div>

          {/* A refusal with no field to attach to still has to be seen. */}
          {error && !error.field && (
            <p className="mt-3 rounded-lg border border-error-200 bg-error-50 px-3 py-2 text-[11px] font-semibold text-error-700">
              {error.message}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-3">
          <p className="text-[11px] text-slate-500">
            {missing.length > 0
              ? `${missing.length} required field${missing.length === 1 ? "" : "s"} left`
              : "Ready to complete"}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={busy || uploading !== null}>
              {busy && <Loader2 size={14} className="mr-1 animate-spin" />}
              Complete stage
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CompleteStageModal;
