/**
 * IANA time zones for Location.
 *
 * The reference hardcodes seven zones in the browser
 * (`LocationsTab.tsx:25-33`) and its server accepts any string up to 60
 * characters. Both halves are wrong in opposite directions: an office in
 * Chennai cannot be given a zone the list omits, and a typo posted directly to
 * the API is stored happily.
 *
 * ---------------------------------------------------------------------------
 * Why the picker list and the validator are NOT the same set
 * ---------------------------------------------------------------------------
 * `Intl.supportedValuesOf('timeZone')` returns the runtime's CANONICAL zone
 * names. On this Node build that list contains `Asia/Calcutta` but not
 * `Asia/Kolkata`, and no `UTC` at all — yet `Intl.DateTimeFormat` accepts both
 * and resolves them. Which spelling is canonical is an ICU-version detail that
 * changes under us between Node releases.
 *
 * So validating by MEMBERSHIP of that list would reject `Asia/Kolkata` — the
 * reference's default, and the zone that matters most here — and would turn a
 * Node upgrade into a data-validation change.
 *
 * The rule is therefore: offer the canonical list, accept anything the runtime
 * can actually resolve. A stored `Asia/Kolkata` stays valid forever; `Mars/Base`
 * never was.
 */

/** The reference's default, kept verbatim. Accepted by every ICU build. */
export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

/** Longest IANA name is ~30 chars; the reference caps the column at 60. */
export const TIME_ZONE_MAX_LENGTH = 60;

/**
 * Zones offered by the picker.
 *
 * The runtime's canonical list, plus the default and UTC, which some ICU builds
 * omit. Union rather than replacement: a value already stored must always be
 * selectable, or editing an unrelated field would silently change the zone.
 */
export const TIME_ZONES = Object.freeze(
  [
    ...new Set([
      ...(typeof Intl.supportedValuesOf === 'function'
        ? Intl.supportedValuesOf('timeZone')
        : []),
      DEFAULT_TIME_ZONE,
      'UTC',
    ]),
  ].sort(),
);

/**
 * Can the runtime actually resolve this zone?
 *
 * The authoritative check, because it is the same one every date calculation
 * downstream will make. Anything that throws here would throw later, somewhere
 * less obvious.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidTimeZone(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > TIME_ZONE_MAX_LENGTH) return false;

  try {
    // Throws RangeError on an unknown zone. Accepts canonical names and the
    // aliases ICU still understands, which is exactly the set we want.
    Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

export default { TIME_ZONES, DEFAULT_TIME_ZONE, TIME_ZONE_MAX_LENGTH, isValidTimeZone };
