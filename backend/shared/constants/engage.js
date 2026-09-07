/**
 * Engage vocabulary.
 *
 * A file of its own, as every other module has — the Phase 0 `hrms.js` carries
 * the foundation values and says so; module enums arrive with their module.
 *
 * Dependency-free and environment-free: this is bundled into the browser as
 * well as run in Node, so a `process.env` here would be a runtime crash in the
 * SPA (`shared/README.md` rule 1, enforced by the guard in shared-foundation).
 *
 * Every enum is `packages/shared-types/src/engage.ts` verbatim. Nothing is
 * invented — a kind the reference does not have does not appear here.
 */

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

export const POLL_KINDS = Object.freeze(['single', 'multi', 'scale', 'open_ended']);

export const POLL_KIND_LABELS = Object.freeze({
  single: 'Single choice',
  multi: 'Multiple choice',
  scale: '1–10 scale',
  open_ended: 'Open-ended',
});

/** Kinds whose answer is a set of option keys rather than free text. */
export const CHOICE_POLL_KINDS = Object.freeze(['single', 'multi']);

/** A choice poll is meaningless with fewer than two things to choose between. */
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 20;

/**
 * The scale poll's bounds.
 *
 * 🔴 The reference validates `1..10` on the server and its UI submits
 * `scale_0`..`scale_10` as OPTION KEYS instead — so a scale poll answered
 * through the reference's own form stores keys, never a number, and
 * `scaleAverage` comes back `null` every time. The two agree here.
 */
export const POLL_SCALE_MIN = 1;
export const POLL_SCALE_MAX = 10;

// ---------------------------------------------------------------------------
// eNPS
// ---------------------------------------------------------------------------

/**
 * The classic Net Promoter bands, exactly as the reference's service documents
 * and implements them.
 *
 *   promoters   9-10
 *   passives    7-8
 *   detractors  0-6
 *
 * Declared as data so the scoring function and the UI legend cannot drift.
 */
export const ENPS_SCORE_MIN = 0;
export const ENPS_SCORE_MAX = 10;
export const ENPS_PROMOTER_MIN = 9;
export const ENPS_PASSIVE_MIN = 7;

export const ENPS_BANDS = Object.freeze(['promoters', 'passives', 'detractors']);

export const ENPS_BAND_LABELS = Object.freeze({
  promoters: 'Promoters',
  passives: 'Passives',
  detractors: 'Detractors',
});

/** Which band a 0–10 score falls in. One definition, used by both halves. */
export function enpsBandFor(score) {
  if (score >= ENPS_PROMOTER_MIN) return 'promoters';
  if (score >= ENPS_PASSIVE_MIN) return 'passives';
  return 'detractors';
}

/** The question the reference asks. Fixed, so every survey asks the same thing. */
export const ENPS_QUESTION =
  'How likely are you to recommend us as a great place to work?';

// ---------------------------------------------------------------------------
// Announcement
// ---------------------------------------------------------------------------

/**
 * Announcements have no status column — the state is DERIVED from the
 * timestamps, exactly as the reference derives it on the client.
 *
 *   draft      publishedAt is null
 *   published  publishedAt set, and not past expiresAt
 *   expired    publishedAt set, and expiresAt has passed
 */
export const ANNOUNCEMENT_STATES = Object.freeze(['draft', 'published', 'expired']);

export const ANNOUNCEMENT_STATE_LABELS = Object.freeze({
  draft: 'Draft',
  published: 'Published',
  expired: 'Expired',
});

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

/**
 * A badge icon is one or two characters of text — the reference stores an emoji
 * in `iconKey` and its own comment says "e.g. emoji or asset ref". No asset ref
 * is ever produced, so this stays a short string and no storage category is
 * registered for it.
 */
export const BADGE_ICON_MAX_LENGTH = 8;

/** The seed badges the reference ships, for the empty-state suggestion. */
export const SUGGESTED_BADGES = Object.freeze([
  Object.freeze({ name: 'Team Player', iconKey: '🤝' }),
  Object.freeze({ name: 'Above and Beyond', iconKey: '🚀' }),
  Object.freeze({ name: 'Customer Champion', iconKey: '⭐' }),
]);

export default {
  POLL_KINDS,
  POLL_KIND_LABELS,
  CHOICE_POLL_KINDS,
  POLL_MIN_OPTIONS,
  POLL_MAX_OPTIONS,
  POLL_SCALE_MIN,
  POLL_SCALE_MAX,
  ENPS_SCORE_MIN,
  ENPS_SCORE_MAX,
  ENPS_PROMOTER_MIN,
  ENPS_PASSIVE_MIN,
  ENPS_BANDS,
  ENPS_BAND_LABELS,
  enpsBandFor,
  ENPS_QUESTION,
  ANNOUNCEMENT_STATES,
  ANNOUNCEMENT_STATE_LABELS,
  BADGE_ICON_MAX_LENGTH,
  SUGGESTED_BADGES,
};
