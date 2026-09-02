/**
 * What a NEW SKU must state before an import is allowed to create it.
 *
 * A SKU that arrives on a bulk sheet carries a code and a quantity and nothing
 * else. Every planning figure it needs — the minimum that may be ordered, how
 * long an order takes to arrive, how much cover to hold, and which box the
 * warehouse picks it from — lands on the schema default of 0 / null, which
 * reads as a deliberate answer and is not one. A SKU in that state has a Max
 * Level of zero, so it is permanently "over-stocked", never reorders, and is
 * picked from nowhere.
 *
 * So the four are asked for BEFORE the import runs, not after: the sheet is
 * staged, the new SKUs are listed, and the import cannot be confirmed until
 * every one of them has been answered.
 *
 * ZERO IS REJECTED ON PURPOSE for the three numeric fields. Zero is exactly the
 * value this prompt exists to stop being left behind, so accepting it would
 * defeat the point — and Max Level is DAC x LeadTime x SafetyFactor, which any
 * zero collapses to nothing.
 *
 * Pure, and the single definition of these rules server-side: the endpoint that
 * accepts the answers, the confirm gate that refuses an unanswered import and
 * the processor that writes the values all read them from here. The import
 * modal mirrors them in the browser for immediate feedback, and is checked
 * against this on the way in — a second copy that disagreed would let a value
 * through the screen that the server then refused.
 */

/** A count, a duration or a multiplier — all of which must be above zero. */
const asPositive = (raw, { integer = false } = {}) => {
  const text = String(raw ?? '').trim();
  if (text === '') return { problem: 'is required' };
  // Sheets and pasted values carry thousands separators.
  const n = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(n)) return { problem: `"${text}" is not a number` };
  if (integer && !Number.isInteger(n)) return { problem: 'must be a whole number' };
  if (n <= 0) return { problem: integer ? 'must be 1 or more' : 'must be greater than 0' };
  return { value: n };
};

const asRequiredText = (raw) => {
  const text = String(raw ?? '').trim();
  if (text === '') return { problem: 'is required' };
  return { value: text };
};

/**
 * The mandatory four, in the order the modal shows them.
 *
 * `label` is what the user is shown and what every message names, so the screen
 * and the server error cannot describe the same field differently.
 */
export const NEW_SKU_FIELDS = [
  {
    field: 'moq',
    label: 'MOQ',
    hint: 'Minimum order quantity, in units.',
    parse: (raw) => asPositive(raw, { integer: true }),
  },
  {
    field: 'leadTime',
    label: 'Lead Time',
    hint: 'Days from raising the order to receiving the stock.',
    parse: (raw) => asPositive(raw),
  },
  {
    field: 'safetyFactor',
    label: 'Safety Factor',
    hint: 'Cover multiplier used to work out the Max Level.',
    parse: (raw) => asPositive(raw),
  },
  {
    field: 'boxNo',
    label: 'Box Number',
    hint: 'The box the warehouse picks this SKU from.',
    parse: asRequiredText,
  },
];

export const NEW_SKU_FIELD_NAMES = NEW_SKU_FIELDS.map((f) => f.field);

/**
 * Read one answer for one new SKU.
 *
 * EVERY field is checked, not just the first that fails — a user fixing one
 * cell at a time on a ten-SKU list is the round trip this whole prompt exists
 * to avoid.
 *
 * @returns {{ values: object, problems: object, ok: boolean }}
 *          `values` holds the coerced value of each field that passed;
 *          `problems` maps a field name to a sentence naming it.
 */
export const parseNewSkuDetails = (raw) => {
  const values = {};
  const problems = {};

  for (const spec of NEW_SKU_FIELDS) {
    const result = spec.parse(raw?.[spec.field]);
    if (result.problem) problems[spec.field] = `${spec.label} ${result.problem}`;
    else values[spec.field] = result.value;
  }

  return { values, problems, ok: Object.keys(problems).length === 0 };
};

/**
 * Has this queued SKU been fully answered?
 *
 * Runs the same parsers over the STORED values, so "complete" means exactly
 * "would be accepted again" — a field that was never set is null, and null is
 * `required`.
 */
export const isNewSkuComplete = (entry) =>
  NEW_SKU_FIELDS.every((spec) => spec.parse(entry?.[spec.field]).problem === undefined);

/** The new SKUs on a job that still have an unanswered field. */
export const incompleteNewSkus = (newSkus = []) => newSkus.filter((s) => !isNewSkuComplete(s));

export default {
  NEW_SKU_FIELDS, NEW_SKU_FIELD_NAMES, parseNewSkuDetails, isNewSkuComplete, incompleteNewSkus,
};
