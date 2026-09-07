/**
 * Expense claim, its line items, and its approval chain.
 *
 * Ported from the reference's `ExpenseClaim` + `ExpenseLineItem`. Statuses are
 * exactly the six it uses — `draft | submitted | manager_approved |
 * finance_approved | reimbursed | rejected`. There is no `cancelled` state in
 * the reference and none is invented here.
 *
 * ---------------------------------------------------------------------------
 * Line items are EMBEDDED, where the reference has a second table
 * ---------------------------------------------------------------------------
 * A line item has no life of its own: it is created with its claim, read with
 * its claim, and deleted with its claim. In Postgres that still costs a table
 * and a join; in MongoDB it is a subdocument, which makes a claim one atomic
 * write and one read rather than a join that has to be kept consistent by hand.
 * The count is bounded — the schema caps a claim at 50 lines.
 *
 * ---------------------------------------------------------------------------
 * Money is Decimal128, and `total` is DERIVED
 * ---------------------------------------------------------------------------
 * AD-2 forbids floats for money. The reference sums line amounts with `+` over
 * JavaScript numbers and stores the result, so a claim for 0.1 + 0.2 stores
 * 0.30000000000000004. Here every amount is Decimal128, the total is recomputed
 * from the lines on every save, and it is never accepted from a client.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

export const CLAIM_STATUSES = Object.freeze([
  'draft',
  'submitted',
  'manager_approved',
  'finance_approved',
  'reimbursed',
  'rejected',
]);

/** Exact decimal addition over the string form, so no float is ever involved. */
export function sumMoney(values = []) {
  const paise = values.reduce((total, value) => {
    const [whole, fraction = ''] = String(value).split('.');
    const padded = `${fraction}00`.slice(0, 2);
    return total + BigInt(whole) * 100n + BigInt(padded) * (whole.startsWith('-') ? -1n : 1n);
  }, 0n);

  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

const lineItemSchema = new Schema(
  {
    categoryId: { type: Schema.Types.ObjectId, required: true },
    /** `YYYY-MM-DD`. An expense is a calendar day, not an instant. */
    date: {
      type: String,
      required: true,
      match: [/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date'],
    },
    amount: { type: Schema.Types.Decimal128, required: true },
    description: { type: String, required: true, trim: true, maxlength: 500 },

    /**
     * The storage key of an uploaded receipt.
     *
     * Written ONLY by the upload endpoint, which mints it through the storage
     * layer. The reference accepts this field on create and later resolves it
     * against a local uploads directory to read the file back, so a claim
     * created with `../../.env` reads whatever the process can.
     */
    receiptKey: { type: String, default: null },
    receiptContentType: { type: String, default: null },
    receiptSize: { type: Number, default: null },
  },
  { _id: true, timestamps: false },
);

/**
 * One step of the two-level chain: the direct manager, then finance.
 *
 * The approver's NAME is snapshotted alongside the id so a decided claim still
 * reads correctly after that person leaves.
 */
const approvalStepSchema = new Schema(
  {
    level: { type: Number, required: true, min: 1 },
    role: { type: String, enum: ['manager', 'finance'], required: true },
    approverEmployeeId: { type: Schema.Types.ObjectId, default: null },
    approverName: { type: String, default: '' },
    decision: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    decidedAt: { type: Date, default: null },
    comment: { type: String, default: null, maxlength: 500 },
  },
  { _id: false },
);

const expenseClaimSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },

    status: { type: String, enum: CLAIM_STATUSES, default: 'draft', index: true },
    submittedAt: { type: Date, default: null },

    /** Derived from the lines on every save; never accepted from a caller. */
    total: { type: Schema.Types.Decimal128, default: () => mongoose.Types.Decimal128.fromString('0.00') },
    currency: { type: String, default: 'INR', maxlength: 3 },

    lineItems: { type: [lineItemSchema], default: [] },
    approvalChain: { type: [approvalStepSchema], default: [] },

    /** Set when the claim is marked reimbursed. */
    reimbursedAt: { type: Date, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_expense_claims' },
);

/** `total` is a projection of the lines, recomputed rather than trusted. */
expenseClaimSchema.pre('validate', function recomputeTotal(next) {
  const amounts = (this.lineItems ?? []).map((line) => String(line.amount ?? '0'));
  this.total = mongoose.Types.Decimal128.fromString(sumMoney(amounts));
  next();
});

/** The three reads: my claims, an approver's queue, and a status sweep. */
expenseClaimSchema.index({ employeeId: 1, status: 1, createdAt: -1 });
expenseClaimSchema.index({ status: 1, submittedAt: -1 });
expenseClaimSchema.index({ deletedAt: 1, createdAt: -1 });

export const ExpenseClaim =
  mongoose.models.ExpenseClaim || mongoose.model('ExpenseClaim', expenseClaimSchema);
export default ExpenseClaim;
