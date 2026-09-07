/**
 * Location — the second Org Structure catalogue.
 *
 * Ported from the reference's `Location` model (`schema.prisma:270-289`).
 * `organizationId` is gone (AD-1), so `@@unique([organizationId, code])`
 * becomes a unique index on `code`, partial over live rows for the same reason
 * as Department: a retired code must become reusable, two live locations must
 * not collide.
 *
 * Deletion is soft, and the reference check that Postgres used to perform lives
 * in the service layer (O-3).
 *
 * ---------------------------------------------------------------------------
 * timezone
 * ---------------------------------------------------------------------------
 * The reference offers seven hardcoded zones in the browser and accepts any
 * 60-character string on the server. Here the value is checked against what the
 * runtime can actually resolve, which accepts every real IANA name — including
 * `Asia/Kolkata`, which this Node build does not list as canonical but does
 * resolve. See ../../shared/constants/timezones.js for why the picker list and
 * the validator are deliberately different sets.
 */

import mongoose from 'mongoose';

import {
  ORG_CODE_PATTERN,
  ORG_CODE_MAX_LENGTH,
  ORG_NAME_MAX_LENGTH,
  LOCATION_ADDRESS_MAX_LENGTH,
  LOCATION_CITY_MAX_LENGTH,
  LOCATION_COUNTRY_MAX_LENGTH,
} from '../../shared/constants/hrms.js';
import {
  DEFAULT_TIME_ZONE,
  TIME_ZONE_MAX_LENGTH,
  isValidTimeZone,
} from '../../shared/constants/timezones.js';

const { Schema } = mongoose;

const locationSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: ORG_CODE_MAX_LENGTH,
      match: [ORG_CODE_PATTERN, 'Use uppercase letters, numbers, hyphen or underscore only.'],
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: ORG_NAME_MAX_LENGTH,
    },

    address: { type: String, default: null, trim: true, maxlength: LOCATION_ADDRESS_MAX_LENGTH },
    city: { type: String, default: null, trim: true, maxlength: LOCATION_CITY_MAX_LENGTH },
    country: { type: String, default: null, trim: true, maxlength: LOCATION_COUNTRY_MAX_LENGTH },

    timezone: {
      type: String,
      required: true,
      trim: true,
      default: DEFAULT_TIME_ZONE,
      maxlength: TIME_ZONE_MAX_LENGTH,
      validate: {
        validator: isValidTimeZone,
        message: (props) => `"${props.value}" is not a recognised IANA time zone.`,
      },
    },

    /** Soft delete (O-3). Null means live. */
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_locations' },
);

locationSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

locationSchema.index({ deletedAt: 1, name: 1 });

export const Location = mongoose.models.Location || mongoose.model('Location', locationSchema);

export default Location;
