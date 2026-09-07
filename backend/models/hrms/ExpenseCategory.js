/**
 * Expense category — the catalogue a line item is booked against.
 *
 * Ported from the reference's `ExpenseCategory`, minus `organizationId` (AD-1),
 * so `@@unique([organizationId, code])` becomes a unique index on `code`,
 * partial over live rows exactly as Department and Location are.
 *
 * `glCode` and `tallyLedger` are the accounting hooks the reference carries.
 * They are free text there and stay free text here — inventing a validated
 * chart of accounts would be a feature this product does not have.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

const expenseCategorySchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 30,
      match: [/^[A-Z0-9_-]+$/, 'Use uppercase letters, numbers, hyphen or underscore only.'],
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },

    glCode: { type: String, default: null, trim: true, maxlength: 30 },
    tallyLedger: { type: String, default: null, trim: true, maxlength: 160 },

    /**
     * Retired-but-kept, distinct from deleted.
     *
     * The reference has both an `active` flag and a DELETE endpoint. `active`
     * takes a category out of the picker while leaving historical claims
     * readable; `deletedAt` retires it entirely. Both are needed: a claim from
     * last year still has to render the name of the category it was booked to.
     */
    active: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_expense_categories' },
);

expenseCategorySchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
expenseCategorySchema.index({ deletedAt: 1, active: 1, name: 1 });

export const ExpenseCategory =
  mongoose.models.ExpenseCategory || mongoose.model('ExpenseCategory', expenseCategorySchema);
export default ExpenseCategory;
