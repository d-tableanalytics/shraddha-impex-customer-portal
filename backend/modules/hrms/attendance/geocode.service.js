/**
 * Reverse geocoding for punch coordinates.
 *
 * ---------------------------------------------------------------------------
 * AFTER the punch, never during it (AD-15, defect 3)
 * ---------------------------------------------------------------------------
 * The reference awaits a Nominatim call INSIDE `clockIn`, before it opens its
 * transaction. An employee clocking in therefore waits on a third-party HTTP
 * request that its own code allows up to four seconds, and 200 people arriving
 * at 09:00 hit a public service that asks for one request per second. When that
 * service is slow, clocking in is slow; when it is down, the whole punch takes
 * the four-second timeout.
 *
 * Here the record is written first and `resolveLater` is fired without being
 * awaited. The coordinates ARE the record; the label is a convenience that
 * arrives shortly afterwards, or does not arrive at all. Nothing about a punch
 * depends on it.
 *
 * ---------------------------------------------------------------------------
 * A driver, matching AD-7's storage pattern
 * ---------------------------------------------------------------------------
 * `setGeocoder` swaps the provider. The default is Nominatim; tests inject a
 * stub, and a paid provider can be dropped in without touching a caller. The
 * `null` geocoder is a legitimate configuration: coordinates are stored,
 * labels simply are not resolved.
 */

import AttendanceRecord from '../../../models/hrms/AttendanceRecord.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';

/**
 * Nominatim's usage policy REQUIRES an identifying User-Agent and will block
 * traffic without one. Overridable so a deployment identifies itself rather
 * than this repository.
 */
const USER_AGENT =
  process.env.HRMS_GEOCODER_USER_AGENT ||
  'Shraddha Impex HRMS (contact: hr@shraddhaimpex.example)';

/** Hard ceiling on the outbound call. Nothing waits on it, but it must still end. */
const REQUEST_TIMEOUT_MS = Number(process.env.HRMS_GEOCODER_TIMEOUT_MS ?? 4000);

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Coordinates rounded to four decimal places (~11 m).
 *
 * An office produces hundreds of punches from one spot, so this collapses a
 * whole building to a single lookup and keeps the burst at 09:00 to one
 * outbound call rather than two hundred.
 */
const cacheKey = (lat, lng) => `${lat.toFixed(4)},${lng.toFixed(4)}`;

const cache = new Map();

/** Test seam. */
export function __resetGeocodeCache() {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * Turn a Nominatim address block into "Road, Suburb, City".
 *
 * The field names are sparse and inconsistent between places, so each tier
 * tries several synonyms; a tier that cannot be filled is dropped rather than
 * failing the whole label. Duplicates are removed because `suburb` and
 * `city_district` frequently repeat the same word.
 */
function labelFromAddress(data) {
  const a = data?.address ?? {};

  const street =
    a.road ?? a.pedestrian ?? a.residential ?? a.street ?? a.footway ?? a.cycleway ?? a.path;
  const streetWithNumber = street
    ? a.house_number
      ? `${a.house_number} ${street}`
      : street
    : undefined;
  const area =
    a.suburb ?? a.neighbourhood ?? a.quarter ?? a.borough ?? a.city_district ?? a.hamlet ?? a.locality;
  const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state_district;

  const seen = new Set();
  const parts = [];
  for (const part of [streetWithNumber, area, city]) {
    if (!part) continue;
    const key = String(part).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }

  if (parts.length > 0) return parts.join(', ');

  // Last resort: the first three chunks of Nominatim's own display_name,
  // which is ordered road, area, city, district, state, postcode.
  if (data?.display_name) {
    return (
      String(data.display_name)
        .split(',')
        .slice(0, 3)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(', ') || null
    );
  }
  return null;
}

async function nominatimGeocoder(lat, lng) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${NOMINATIM_URL}?lat=${lat}&lon=${lng}&format=json&zoom=18&addressdetails=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return labelFromAddress(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

let geocoder = nominatimGeocoder;

/**
 * Swap the provider.
 *
 * @param {null | ((lat: number, lng: number) => Promise<string|null>)} fn
 *   `null` disables reverse geocoding entirely — a supported configuration,
 *   not a broken one.
 */
export function setGeocoder(fn) {
  geocoder = typeof fn === 'function' ? fn : null;
}

export function __resetGeocoder() {
  geocoder = nominatimGeocoder;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * A label for a position, from cache where possible.
 *
 * Never throws. A failure is cached as `null` for the same window, so a broken
 * or rate-limiting provider is asked once rather than on every punch.
 */
export async function reverseGeocode(lat, lng) {
  if (!geocoder) return null;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  const key = cacheKey(lat, lng);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.label;

  let label = null;
  try {
    label = (await geocoder(lat, lng)) ?? null;
  } catch {
    label = null;
  }
  cache.set(key, { label, at: Date.now() });
  return label;
}

/**
 * Resolve a punch's label and write it back, in the background.
 *
 * Returns a promise so a test can await it, but production callers
 * deliberately do NOT — that is the whole point. Every failure path is
 * swallowed: this runs detached, so an unhandled rejection here would crash
 * the process for a cosmetic label.
 *
 * @param {string} recordId
 * @param {'in'|'out'} punch
 * @param {{lat:number,lng:number}} geo
 */
export async function resolveLater(recordId, punch, geo) {
  try {
    if (!geo || typeof geo.lat !== 'number' || typeof geo.lng !== 'number') return null;

    const label = await reverseGeocode(geo.lat, geo.lng);
    if (!label) return null;

    const field = punch === 'in' ? 'clockInCapture.locationLabel' : 'clockOutCapture.locationLabel';

    /**
     * Only fill a label that is still empty.
     *
     * Two guards in one: a client that already supplied a label is not
     * overwritten, and a consent withdrawal that erased the capture between
     * the punch and this write does not have the label quietly restored.
     */
    const coordField = punch === 'in' ? 'clockInCapture.geo' : 'clockOutCapture.geo';
    await AttendanceRecord.updateOne(
      { _id: recordId, [field]: null, [coordField]: { $ne: null } },
      { $set: { [field]: label } },
    );
    return label;
  } catch {
    return null;
  }
}

export default { reverseGeocode, resolveLater, setGeocoder };
