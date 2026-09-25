/**
 * What each stage asks for when it is completed (§FMS stage-wise fields).
 *
 * ---------------------------------------------------------------------------
 * ONE SPEC, READ BY BOTH SIDES
 * ---------------------------------------------------------------------------
 *
 * The form that collects these and the validation that enforces them are the
 * same list, read from here. The alternative — a form built in React and a
 * matching set of `if (!evidence.piNumber)` checks on the server — is two
 * copies of one rule, and the day they disagree the screen asks for something
 * the server ignores, or refuses something the screen never offered.
 *
 * ---------------------------------------------------------------------------
 * THIS DOES NOT CHANGE THE WORKFLOW
 * ---------------------------------------------------------------------------
 *
 * No stage order, no SLA, no permission and no column moves because of this
 * file. The values land in `O2dOrderStage.evidence`, which is already a Mixed
 * field built for exactly this, so nothing in the schema changes either.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------------------------------------------------------
 *
 *   STAGE 1   is the intake form, not a completion form. Its fields — PO
 *             number, PO date, customer, sales person, promise date, stock
 *             status — are collected when the ORDER is created and already
 *             live on `O2dOrder`. It has no SLA and nothing to complete.
 *   STAGE 4   has its own endpoint. "Advance order?" decides whether stage 5
 *             runs or is skipped, which is a branch rather than a note, so it
 *             cannot be a free-form evidence field. Its two inputs are the
 *             ones the spec lists — the decision and a remark.
 *
 * ⚠ ACTUAL COMPLETION TIME IS NEVER A FIELD HERE. The engine stamps it. §33
 * allows a back-fill through a separate, audited path; a box on this form
 * would let anyone set their own SLA result.
 */

/**
 * Field types the renderer and the validator both understand.
 *
 * `document` is not a value in `evidence` — it is a file that must already be
 * uploaded against this stage. See `requiredDocTypeFor`.
 */
export const STAGE_FIELD_TYPES = Object.freeze({
  TEXT: 'text',
  NUMBER: 'number',
  DATE: 'date',
  BOOLEAN: 'boolean',
  DOCUMENT: 'document',
});

const { TEXT, NUMBER, DATE, BOOLEAN, DOCUMENT } = STAGE_FIELD_TYPES;

/**
 * Stage number -> the fields its completion form shows, in order.
 *
 * `key` is the property written into `evidence`. The names are the
 * specification's own, not tidied — "SOR Reference" and "UTR / Instrument
 * Reference" are what the desk says out loud, and renaming them here would mean
 * the screen and the process document describe different things.
 */
export const STAGE_COMPLETION_FIELDS = Object.freeze({
  // ── 02 — Submit PO to Billing ────────────────────────────────────────────
  2: [
    {
      key: 'poCopy',
      label: 'PO Copy / PO Scan',
      type: DOCUMENT,
      docType: 'PO',
      required: true,
      help: 'Upload the signed purchase order received from the customer.',
    },
  ],

  // ── 03 — Send SOR + PI to Client ─────────────────────────────────────────
  3: [
    { key: 'piNumber', label: 'PI Number', type: TEXT, required: true },
    {
      key: 'sorReference',
      label: 'SOR Reference',
      type: TEXT,
      required: true,
      // §11 sends the dispatch details back on THIS thread, so the reference
      // recorded here is what stage 11 replies to.
      help: 'The outbound mail reference. Stage 11 replies on this thread.',
    },
  ],

  // ── 05 — Realise Advance Payment ─────────────────────────────────────────
  5: [
    { key: 'amountReceived', label: 'Amount Received', type: NUMBER, required: true, min: 0 },
    { key: 'utrReference', label: 'UTR / Instrument Reference', type: TEXT, required: true },
    { key: 'paymentDate', label: 'Payment Date', type: DATE, required: true },
    {
      key: 'partPayment',
      label: 'Part Payment',
      type: BOOLEAN,
      required: true,
      // The existing "Proceed Anyway" authorisation is unchanged — this field
      // records WHICH case it was, it does not grant the permission.
      help: 'A part payment still needs the existing Proceed Anyway authorisation.',
    },
  ],

  // ── 06 — Fill Order List / Notify Imports + Accounts ──────────────────────
  6: [
    { key: 'orderListReference', label: 'Order List Reference', type: TEXT, required: true },
    {
      key: 'notifiedTo',
      label: 'Notified To',
      type: TEXT,
      required: true,
      help: 'Departments or people notified.',
    },
  ],

  // ── 07 — Inform Warehouse / Take Out Material ────────────────────────────
  7: [
    { key: 'pickListId', label: 'Pick List ID', type: TEXT, required: true },
    {
      key: 'warehouseAcknowledgedBy',
      label: 'Warehouse Acknowledged By',
      type: TEXT,
      required: true,
      // §10: the acknowledgement IS the actual completion. The timestamp is
      // still the engine's; this records who gave it.
      help: 'The acknowledgement is what stops this stage’s clock.',
    },
  ],

  // ── 08 — Scan Material, Bill & Create Invoice ────────────────────────────
  8: [
    { key: 'invoiceNumber', label: 'Invoice Number', type: TEXT, required: true },
    { key: 'invoiceDate', label: 'Invoice Date', type: DATE, required: true },
    { key: 'invoiceValue', label: 'Invoice Value', type: NUMBER, required: true, min: 0 },
  ],

  // ── 09 — Pack & Dispatch ─────────────────────────────────────────────────
  9: [
    { key: 'transporter', label: 'Transporter', type: TEXT, required: true },
    { key: 'awbNumber', label: 'AWB Number', type: TEXT, required: true },
    { key: 'boxCount', label: 'Box Count', type: NUMBER, required: true, min: 1 },
    { key: 'weightKg', label: 'Weight (kg)', type: NUMBER, required: true, min: 0 },
  ],

  // ── 10 — Mark "Sent" on Zoho Books ───────────────────────────────────────
  10: [
    {
      key: 'zohoStatus',
      label: 'Zoho Status',
      type: TEXT,
      required: true,
      help: 'Completed automatically when the Zoho webhook is live.',
    },
  ],

  // ── 11 — Send Dispatch Details to Client ─────────────────────────────────
  11: [
    {
      key: 'mailReference',
      label: 'Mail Reference',
      type: TEXT,
      required: true,
      help: 'Invoice copy, AWB number and transporter, on the stage 3 thread.',
    },
    { key: 'whatsappSent', label: 'WhatsApp Sent', type: BOOLEAN, required: true },
  ],

  // ── 12 — Collect AWB Copies & File Them ──────────────────────────────────
  12: [
    { key: 'awbCopy', label: 'AWB / LR Copy', type: DOCUMENT, docType: 'AWB', required: true },
    { key: 'deliveryDays', label: 'Delivery Days', type: NUMBER, required: true, min: 0 },
    { key: 'closingRemark', label: 'Closing Remark', type: TEXT, required: true },
  ],
});

/** The fields for a stage, or an empty list for one that asks nothing. */
export const fieldsForStage = (stageNumber) =>
  STAGE_COMPLETION_FIELDS[Number(stageNumber)] ?? [];

/**
 * The document type this stage will not complete without, if any.
 *
 * Separate from the value fields because a file is not something the caller can
 * put in `evidence` — it has to have been uploaded against the stage first, and
 * the check is "does such a document exist", not "is this string non-empty".
 */
export const requiredDocTypeFor = (stageNumber) =>
  fieldsForStage(stageNumber)
    .find((f) => f.type === STAGE_FIELD_TYPES.DOCUMENT && f.required)?.docType ?? null;

/**
 * Which stages Zoho can fill in for the user, when the integration is live.
 *
 * Stage 8 takes the invoice number, date and value straight from the document
 * Zoho issued; stage 10 is the webhook telling us the invoice was marked sent.
 * Listed here rather than checked inline so the screens can say "this will fill
 * itself" instead of silently offering a form nobody should be typing into.
 */
export const ZOHO_FILLED_STAGES = Object.freeze({
  8: { fills: ['invoiceNumber', 'invoiceDate', 'invoiceValue'] },
  10: { fills: ['zohoStatus'], autoCompletes: true },
});

export default {
  STAGE_FIELD_TYPES,
  STAGE_COMPLETION_FIELDS,
  fieldsForStage,
  requiredDocTypeFor,
  ZOHO_FILLED_STAGES,
};
