/**
 * Engage collections.
 *
 * Ported from the reference's Prisma models, adapted to Mongoose and the
 * accepted decisions:
 *
 *   AD-1   single tenant, so no organizationId
 *   AD-2   ObjectId keys, no foreign keys — the services check references
 *   AD-4   the Employee is the canonical identity, not the User account
 *   AD-13  every list is server-paginated, so the indexes below matter
 *
 * Grouped in one file because these five collections are one module: a poll
 * response is meaningless without its poll, and a recognition without its
 * badge is still a recognition but never queried apart from one.
 *
 * ---------------------------------------------------------------------------
 * There is no money in Engage, so there is no Decimal128 here
 * ---------------------------------------------------------------------------
 * Checked against the reference: not one field in any of its seven tables is a
 * monetary amount. The scores are small integers and the counts are counts.
 *
 * ---------------------------------------------------------------------------
 * `mediaKeys` is deliberately absent
 * ---------------------------------------------------------------------------
 * The reference declares `Announcement.mediaKeys String[]`, returns it from
 * every read, and NEVER writes it — there is no upload endpoint, no multer and
 * no storage call anywhere in its engage module. Carrying an always-empty array
 * across would be carrying a column, not a feature, and would imply a file
 * surface that does not exist. No storage category is registered for Engage.
 */

import mongoose from 'mongoose';

import {
  POLL_KINDS,
  ENPS_SCORE_MIN,
  ENPS_SCORE_MAX,
  POLL_SCALE_MIN,
  POLL_SCALE_MAX,
  BADGE_ICON_MAX_LENGTH,
} from '../../shared/constants/engage.js';

const { Schema } = mongoose;

// ---------------------------------------------------------------------------
// Announcement
// ---------------------------------------------------------------------------

const announcementSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 20_000 },

    /**
     * The state is DERIVED from these two, never stored — the reference derives
     * it on the client and a stored status would be a second source of truth
     * able to disagree with the timestamps beside it.
     */
    publishedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },

    /**
     * Targeting. Empty on BOTH means org-wide, which is the reference's rule.
     *
     * Indexed, because the reader's visibility filter runs IN the query here
     * rather than in memory after a `take: 100` — see the service's note.
     */
    targetRoleKeys: { type: [String], default: [] },
    targetDepartmentIds: { type: [Schema.Types.ObjectId], default: [] },

    /** Denormalised at write time so a list needs no join. */
    createdByEmployeeId: { type: Schema.Types.ObjectId, default: null },
    createdByName: { type: String, default: null, trim: true, maxlength: 200 },
    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_announcements' },
);

/** The feed's ordering: newest published first, then newest drafted. */
announcementSchema.index({ publishedAt: -1, createdAt: -1 });
/** The reader's visibility filter is an $or across these two plus "untargeted". */
announcementSchema.index({ targetRoleKeys: 1 });
announcementSchema.index({ targetDepartmentIds: 1 });
announcementSchema.index({ expiresAt: 1 });

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

const pollOptionSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 60 },
    label: { type: String, required: true, trim: true, maxlength: 200 },
  },
  { _id: false },
);

const pollSchema = new Schema(
  {
    question: { type: String, required: true, trim: true, maxlength: 500 },
    kind: { type: String, required: true, enum: POLL_KINDS },

    /**
     * A typed subdocument array rather than the reference's free `Json` column.
     * `optionCounts` is keyed on `option.key`, so a malformed key is a tally
     * that can never be read back.
     */
    options: { type: [pollOptionSchema], default: [] },

    /**
     * Stored and never read, exactly as the reference leaves it — its poll list
     * applies no targeting at all. Kept for parity and documented as advisory.
     */
    targetRoleKeys: { type: [String], default: [] },

    launchedAt: { type: Date, default: null },
    closesAt: { type: Date, default: null },

    /**
     * Anonymity is a PRESENTATION and AUDIT rule, not a storage one — the
     * respondent is always recorded so a second response can be refused. What
     * changes is that an anonymous poll's response is audited WITHOUT the
     * actor; see the service.
     */
    anonymous: { type: Boolean, required: true, default: false },

    createdByEmployeeId: { type: Schema.Types.ObjectId, default: null },
    createdByName: { type: String, default: null, trim: true, maxlength: 200 },
    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_polls' },
);

pollSchema.index({ launchedAt: -1, createdAt: -1 });
pollSchema.index({ closesAt: 1 });

const pollResponseSchema = new Schema(
  {
    pollId: { type: Schema.Types.ObjectId, required: true },
    /** The respondent, always recorded — see the poll's note on anonymity. */
    respondentEmployeeId: { type: Schema.Types.ObjectId, required: true },

    /** Chosen option keys, for single and multi. */
    keys: { type: [String], default: [] },
    /** Free text, for open-ended. */
    text: { type: String, default: null, trim: true, maxlength: 4000 },
    /** A number, for scale — see the schema's note 3 on the reference's mismatch. */
    scale: { type: Number, default: null, min: POLL_SCALE_MIN, max: POLL_SCALE_MAX },

    submittedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true, collection: 'hrms_poll_responses' },
);

/**
 * ONE RESPONSE PER PERSON PER POLL, enforced by the database.
 *
 * The reference declares the same unique constraint and also pre-checks with a
 * `findUnique`; the pre-check is kept only to produce a better message than a
 * duplicate-key error.
 */
pollResponseSchema.index({ pollId: 1, respondentEmployeeId: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

const recognitionBadgeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    /**
     * An emoji, not an asset reference. The reference's comment says "e.g.
     * emoji or asset ref" and it only ever stores an emoji — no storage
     * category is registered for Engage.
     */
    iconKey: { type: String, required: true, trim: true, maxlength: BADGE_ICON_MAX_LENGTH },
    description: { type: String, default: null, trim: true, maxlength: 500 },

    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_recognition_badges' },
);

/** The reference's `@@unique([organizationId, name])`, minus the tenant (AD-1). */
recognitionBadgeSchema.index({ name: 1 }, { unique: true });

const recognitionSchema = new Schema(
  {
    /**
     * The sender is ALWAYS recorded, even for anonymous kudos.
     *
     * The reference does the same and gives the reason — moderation — then
     * scrubs it from the DTO. Nothing in this collection is anonymous at rest.
     */
    fromEmployeeId: { type: Schema.Types.ObjectId, required: true },
    fromName: { type: String, default: null, trim: true, maxlength: 200 },

    toEmployeeId: { type: Schema.Types.ObjectId, required: true },
    toName: { type: String, default: null, trim: true, maxlength: 200 },

    badgeId: { type: Schema.Types.ObjectId, default: null },
    /** Copied at write time, so renaming or removing a badge never rewrites history. */
    badgeName: { type: String, default: null, trim: true, maxlength: 60 },
    badgeIconKey: { type: String, default: null, trim: true, maxlength: BADGE_ICON_MAX_LENGTH },

    message: { type: String, required: true, trim: true, maxlength: 1000 },

    /** On the public wall, or between the two of them only. */
    teamVisible: { type: Boolean, required: true, default: true },
    anonymous: { type: Boolean, required: true, default: false },

    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_recognitions' },
);

/** The wall: team-visible, newest first. */
recognitionSchema.index({ teamVisible: 1, createdAt: -1 });
recognitionSchema.index({ toEmployeeId: 1, createdAt: -1 });
recognitionSchema.index({ fromEmployeeId: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// eNPS
// ---------------------------------------------------------------------------

const enpsSurveySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    /** A survey is launched on creation, as the reference launches it. */
    launchedAt: { type: Date, required: true, default: Date.now },
    closesAt: { type: Date, required: true },

    createdByEmployeeId: { type: Schema.Types.ObjectId, default: null },
    createdByName: { type: String, default: null, trim: true, maxlength: 200 },
    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_enps_surveys' },
);

enpsSurveySchema.index({ launchedAt: -1 });
enpsSurveySchema.index({ closesAt: 1 });

const enpsResponseSchema = new Schema(
  {
    surveyId: { type: Schema.Types.ObjectId, required: true },
    /**
     * Recorded so a second response can be refused — and for nothing else.
     *
     * An eNPS survey is anonymous by its nature: the results endpoint returns
     * only band counts, no read path joins a response to a person, and the
     * response is audited WITHOUT the actor. The reference stores the same
     * column and then audits `enps.respond` with the acting user attached,
     * which makes every "anonymous" answer attributable from the audit log.
     */
    respondentEmployeeId: { type: Schema.Types.ObjectId, required: true },

    score: { type: Number, required: true, min: ENPS_SCORE_MIN, max: ENPS_SCORE_MAX },
    comment: { type: String, default: null, trim: true, maxlength: 2000 },

    submittedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true, collection: 'hrms_enps_responses' },
);

/** ONE RESPONSE PER PERSON PER SURVEY, enforced by the database. */
enpsResponseSchema.index({ surveyId: 1, respondentEmployeeId: 1 }, { unique: true });

// ---------------------------------------------------------------------------

export const Announcement =
  mongoose.models.Announcement || mongoose.model('Announcement', announcementSchema);

export const Poll = mongoose.models.Poll || mongoose.model('Poll', pollSchema);

export const PollResponse =
  mongoose.models.PollResponse || mongoose.model('PollResponse', pollResponseSchema);

export const RecognitionBadge =
  mongoose.models.RecognitionBadge ||
  mongoose.model('RecognitionBadge', recognitionBadgeSchema);

export const Recognition =
  mongoose.models.Recognition || mongoose.model('Recognition', recognitionSchema);

export const ENpsSurvey =
  mongoose.models.ENpsSurvey || mongoose.model('ENpsSurvey', enpsSurveySchema);

export const ENpsResponse =
  mongoose.models.ENpsResponse || mongoose.model('ENpsResponse', enpsResponseSchema);

export default {
  Announcement,
  Poll,
  PollResponse,
  RecognitionBadge,
  Recognition,
  ENpsSurvey,
  ENpsResponse,
};
