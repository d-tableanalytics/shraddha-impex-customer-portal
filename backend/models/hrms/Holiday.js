/**
 * Holiday — the yearly calendar HR maintains at rollover.
 *
 * Ported from the reference's `Holiday`, minus `organizationId` (AD-1). Its
 * `@@unique([organizationId, date, name])` becomes a unique index on
 * `(date, name)`, partial over live rows: the same date can carry two
 * differently-named holidays, and the same name recurs in another year.
 *
 * `year` is denormalised from `date` for the by-year listing the reference's UI
 * is built around. It is derived on save rather than accepted, so the two can
 * never disagree.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

export const HOLIDAY_TYPES = Object.freeze([
  'public',
  'national',
  'state',
  'festival',
  'optional',
  'restricted',
]);

const holidaySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },

    /**
     * Stored as `YYYY-MM-DD`, not a Date.
     *
     * A holiday is a calendar day, not an instant. Storing it as a Date invites
     * the off-by-one where 26 January read back as the 25th for anyone west of
     * UTC - which for a holiday calendar means the wrong day is free.
     */
    date: {
      type: String,
      required: true,
      match: [/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date'],
    },

    /** Derived from `date` in a pre-validate hook; never accepted from a caller. */
    year: { type: Number, required: true, min: 2000, max: 2100, index: true },

    type: { type: String, enum: HOLIDAY_TYPES, default: 'public' },

    /** Free text in the reference. Null means it applies to everyone. */
    region: { type: String, default: null, trim: true, maxlength: 20 },
    description: { type: String, default: null, trim: true, maxlength: 500 },

    /** A "restricted" holiday: offered, not automatic. */
    isOptional: { type: Boolean, default: false },

    createdByUserId: { type: Schema.Types.ObjectId, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_holidays' },
);

holidaySchema.pre('validate', function deriveYear(next) {
  if (typeof this.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(this.date)) {
    this.year = Number(this.date.slice(0, 4));
  }
  next();
});

holidaySchema.index(
  { date: 1, name: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
holidaySchema.index({ deletedAt: 1, year: 1, date: 1 });

export const Holiday = mongoose.models.Holiday || mongoose.model('Holiday', holidaySchema);
export default Holiday;
