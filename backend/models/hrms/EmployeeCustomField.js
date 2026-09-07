/**
 * Admin-defined extra employee fields.
 *
 * Ported from the reference's `CustomFieldDefinition`. Values live on
 * `Employee.customFieldValues`, keyed by `name`, so reading an employee is one
 * query rather than a join per field.
 *
 * ---------------------------------------------------------------------------
 * Custom fields cannot be a way round AD-10
 * ---------------------------------------------------------------------------
 * The reference's field builder accepts any name, and its own payroll code then
 * reads bank details straight out of that blob. So the obvious hole here is an
 * admin creating a field called "PAN" and collecting exactly what AD-10 moved
 * into encrypted storage.
 *
 * Two things close it. A definition whose name collides with a reserved
 * sensitive key is REFUSED at creation, and the sanitiser strips reserved keys
 * out of every incoming blob regardless — so even a definition that somehow
 * existed could not carry a value.
 */

import mongoose from 'mongoose';

import { isReservedCustomFieldKey } from '../../shared/security/sensitive-fields.js';

export const CUSTOM_FIELD_TYPES = Object.freeze([
  'text',
  'textarea',
  'number',
  'date',
  'boolean',
  'select',
  'multiselect',
]);

const employeeCustomFieldSchema = new mongoose.Schema(
  {
    /**
     * The key under which values are stored. Immutable once created: renaming
     * it would orphan the value on every existing employee, silently.
     */
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      immutable: true,
      match: [/^[a-z][a-z0-9_]*$/, 'name must be lowercase snake_case'],
      maxlength: 64,
      validate: {
        validator: (v) => !isReservedCustomFieldKey(v),
        message: (props) =>
          `"${props.value}" is a reserved sensitive field. Values like PAN, Aadhaar and ` +
          'bank details are stored encrypted on the employee record, not as custom fields.',
      },
    },

    label: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: CUSTOM_FIELD_TYPES, required: true },
    /** Choices for select / multiselect. Ignored for other types. */
    options: { type: [String], default: [] },
    required: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

employeeCustomFieldSchema.index({ order: 1, createdAt: 1 });

/**
 * A select must offer something to select.
 *
 * Caught here rather than in the form, because a definition created through the
 * API with no options renders as an unusable control on every employee form.
 */
employeeCustomFieldSchema.pre('validate', function requireOptionsForChoiceTypes(next) {
  if ((this.type === 'select' || this.type === 'multiselect') && (this.options ?? []).length === 0) {
    return next(new Error(`A "${this.type}" custom field needs at least one option.`));
  }
  return next();
});

export default mongoose.models.EmployeeCustomField ||
  mongoose.model('EmployeeCustomField', employeeCustomFieldSchema);
