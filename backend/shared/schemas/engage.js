/**
 * Engage validation schemas (AD-6).
 *
 * Ported from `packages/shared-types/src/engage.ts` and used by both the
 * Express validator and the React forms, so a rule cannot drift between them.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections to the reference
 * ---------------------------------------------------------------------------
 * 1. THE CHOICE-POLL MINIMUM IS IN THE SCHEMA. The reference defaults `options`
 *    to `[]` and then throws from the service, so the rule is absent from the
 *    form and from any other caller.
 *
 * 2. OPTION KEYS MUST BE DISTINCT. The reference collects a free list; two
 *    options sharing a key silently collapse into one tally, because
 *    `optionCounts` is keyed on it.
 *
 * 3. A SCALE ANSWER IS A NUMBER, in a field of its own. The reference validates
 *    `Number(answer.text)` between 1 and 10 while its own UI submits
 *    `scale_0`..`scale_10` as option KEYS — so a scale poll answered through
 *    the reference's form stores keys, never a number, and `scaleAverage` is
 *    always null. Here the answer shape is per-kind and the two agree.
 *
 * 4. TARGET ROLE KEYS ARE VALIDATED against the role vocabulary. The reference
 *    accepts any string, so a typo silently targets nobody and the author has
 *    no way to tell.
 *
 * 5. `closesAt` MUST BE IN THE FUTURE. The reference lets an eNPS survey be
 *    launched already closed.
 */

import { z } from 'zod';

import { objectId, isoDateTime, paginationQuery } from '../validation/common.js';
import { HRMS_ROLE_LIST } from '../permissions/constants.js';
import {
  POLL_KINDS,
  CHOICE_POLL_KINDS,
  POLL_MIN_OPTIONS,
  POLL_MAX_OPTIONS,
  POLL_SCALE_MIN,
  POLL_SCALE_MAX,
  ENPS_SCORE_MIN,
  ENPS_SCORE_MAX,
  BADGE_ICON_MAX_LENGTH,
} from '../constants/engage.js';

/** Present-but-empty and absent both mean "not supplied". */
const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .optional()
    .nullable();

/**
 * A targetable role.
 *
 * 🔴 The reference types these as bare strings and its own form offers
 * `employee`, `hr_admin`, … — none of which match its role keys once an
 * organisation renames a role. Validating against the vocabulary means a
 * mistargeted announcement is refused rather than silently delivered to nobody.
 */
const roleKey = z.enum(HRMS_ROLE_LIST);

/** A future instant. Used for both expiry and poll/survey closing. */
const futureInstant = isoDateTime.refine((v) => new Date(v).getTime() > Date.now(), {
  message: 'Choose a time in the future.',
});

// ---------------------------------------------------------------------------
// Announcement
// ---------------------------------------------------------------------------

export const createAnnouncementSchema = z
  .object({
    title: z.string().trim().min(1, 'A title is required.').max(200),
    body: z.string().trim().min(1, 'Write something.').max(20_000),
    publishNow: z.boolean().default(false),
    expiresAt: futureInstant.optional().nullable(),
    /** Empty on both means org-wide, exactly as the reference reads it. */
    targetRoleKeys: z.array(roleKey).max(20).default([]),
    targetDepartmentIds: z.array(objectId).max(50).default([]),
  })
  .strict();

export const announcementListQuerySchema = paginationQuery
  .extend({
    /** HR's own filter over the draft/published split its list already shows. */
    state: z.enum(['draft', 'published', 'expired']).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

export const pollOptionSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(60)
      // `optionCounts` is keyed on this, so it has to be a safe object key.
      .regex(/^[a-z0-9_]+$/, 'Use lower-case letters, digits and underscores.'),
    label: z.string().trim().min(1).max(200),
  })
  .strict();

export const createPollSchema = z
  .object({
    question: z.string().trim().min(1, 'Ask something.').max(500),
    kind: z.enum(POLL_KINDS),
    options: z.array(pollOptionSchema).max(POLL_MAX_OPTIONS).default([]),
    targetRoleKeys: z.array(roleKey).max(20).default([]),
    closesAt: futureInstant.optional().nullable(),
    anonymous: z.boolean().default(false),
    launchNow: z.boolean().default(true),
  })
  .strict()
  .refine(
    (v) => !CHOICE_POLL_KINDS.includes(v.kind) || v.options.length >= POLL_MIN_OPTIONS,
    {
      message: `A choice poll needs at least ${POLL_MIN_OPTIONS} options.`,
      path: ['options'],
    },
  )
  .refine(
    (v) => {
      const keys = v.options.map((o) => o.key);
      return new Set(keys).size === keys.length;
    },
    { message: 'Two options cannot share a key.', path: ['options'] },
  );

/**
 * A poll answer.
 *
 * Shaped per kind rather than the reference's one loose `{keys, text}` that
 * every kind shares and none of them fully uses — see note 3.
 */
export const pollAnswerSchema = z
  .object({
    keys: z.array(z.string().trim().min(1).max(60)).max(POLL_MAX_OPTIONS).default([]),
    text: optionalText(4000),
    scale: z.number().int().min(POLL_SCALE_MIN).max(POLL_SCALE_MAX).optional().nullable(),
  })
  .strict();

export const pollListQuerySchema = paginationQuery
  .extend({
    kind: z.enum(POLL_KINDS).optional(),
    open: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((v) => v === true || v === 'true')
      .optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

export const createBadgeSchema = z
  .object({
    name: z.string().trim().min(1, 'A name is required.').max(60),
    iconKey: z.string().trim().min(1, 'Pick an icon.').max(BADGE_ICON_MAX_LENGTH),
    description: optionalText(500),
  })
  .strict();

export const giveRecognitionSchema = z
  .object({
    toEmployeeId: objectId,
    badgeId: objectId.optional().nullable(),
    message: z.string().trim().min(1, 'Say why.').max(1000),
    teamVisible: z.boolean().default(true),
    anonymous: z.boolean().default(false),
  })
  .strict();

export const recognitionListQuerySchema = paginationQuery.strict();

// ---------------------------------------------------------------------------
// eNPS
// ---------------------------------------------------------------------------

export const createEnpsSchema = z
  .object({
    name: z.string().trim().min(1, 'A name is required.').max(160),
    /** Must be in the future — the reference accepts an already-closed survey. */
    closesAt: futureInstant,
  })
  .strict();

export const submitEnpsSchema = z
  .object({
    score: z.number().int().min(ENPS_SCORE_MIN).max(ENPS_SCORE_MAX),
    comment: optionalText(2000),
  })
  .strict();

export const enpsListQuerySchema = paginationQuery.strict();

export default {
  createAnnouncementSchema,
  announcementListQuerySchema,
  pollOptionSchema,
  createPollSchema,
  pollAnswerSchema,
  pollListQuerySchema,
  createBadgeSchema,
  giveRecognitionSchema,
  recognitionListQuerySchema,
  createEnpsSchema,
  submitEnpsSchema,
  enpsListQuerySchema,
};
