/**
 * Expense policy — one optional row per category.
 *
 * Ported from the reference's `ExpensePolicy`.
 *
 * ---------------------------------------------------------------------------
 * These limits are GUIDANCE, not gates
 * ---------------------------------------------------------------------------
 * The reference stores every field here and reads none of them. Its claim
 * service mentions `autoApproveBelow` in a comment and never implements it, and
 * nothing anywhere consults `dailyLimit`, `monthlyLimit` or `requiresReceipt`.
 *
 * That behaviour is preserved: a claim is never silently refused for breaching
 * a limit, because refusing on a rule the reference does not enforce would
 * change what the product does. The values are surfaced so a claimant can see
 * the limit they are working to, and so the policy is ready if enforcement is
 * ever specified.
 *
 * Money is Decimal128 (AD-2). A limit compared against a float that has drifted
 * is worse than no limit.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

/** Null means "no limit", which is different from zero. */
const optionalMoney = { type: Schema.Types.Decimal128, default: null };

const expensePolicySchema = new Schema(
  {
    categoryId: { type: Schema.Types.ObjectId, required: true },

    dailyLimit: optionalMoney,
    monthlyLimit: optionalMoney,
    autoApproveBelow: optionalMoney,

    requiresReceipt: { type: Boolean, default: true },
    requiresApproval: { type: Boolean, default: true },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_expense_policies' },
);

/** One live policy per category — the reference's `@@unique([categoryId])`. */
expensePolicySchema.index(
  { categoryId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

export const ExpensePolicy =
  mongoose.models.ExpensePolicy || mongoose.model('ExpensePolicy', expensePolicySchema);
export default ExpensePolicy;
