/**
 * What a product's descriptive content may contain.
 *
 * Product details — the description, the photographs and the videos —
 * are CATALOGUE CONTENT, not inventory. Nothing here affects a balance, a band,
 * a reorder point or a price. That separation is the reason this lives in its
 * own collection keyed by SKU rather than as more fields on the product master:
 * a marketing description changing must never touch a row the ledger reads.
 *
 * Pure, and the single definition of these limits server-side — the upload
 * middleware, the controller, the bulk-import template and the admin screen all
 * read them from here. Expressed separately in each place they would drift, and
 * the direction that drift fails in is a file the middleware accepts and the
 * service then refuses, with the bytes already on disk.
 */

/* ── Images ───────────────────────────────────────────────────────────────── */

/**
 * 5 MB per image.
 *
 * Product photographs, not print masters. Anything larger is an unresized
 * camera original, and serving one to a slide-over costs the viewer more than
 * it shows them. nginx caps a whole request at 30 MB (see
 * deploy/nginx/shraddha-impex-app.conf), which is what bounds a batch rather
 * than this.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Files one upload request may carry. Five 5 MB images sits inside nginx's cap. */
export const MAX_IMAGES_PER_REQUEST = 5;

/** Photographs one SKU may hold. A gallery, not an archive. */
export const MAX_IMAGES_PER_SKU = 12;

/**
 * What an image may be, by MIME type AND by extension — both are checked.
 *
 * The browser supplies the MIME type and a determined uploader can supply any
 * MIME type they like, so it is never trusted alone; the extension decides what
 * lands on disk and therefore what the serving route will claim it is.
 *
 * SVG is deliberately absent. An SVG is a document that can carry script, and
 * serving one from the application's own origin would run that script with the
 * portal's origin — a stored XSS through the product gallery.
 */
export const ALLOWED_IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

/** Extensions accepted on the way in, including the spellings of the above. */
export const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];

/** The extension an accepted upload is stored under. */
export const extensionFor = (mimeType, originalName = '') => {
  const byMime = ALLOWED_IMAGE_TYPES[String(mimeType).toLowerCase()];
  if (byMime) return byMime;
  const ext = String(originalName).toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  return ALLOWED_IMAGE_EXTENSIONS.includes(ext) ? (ext === '.jpeg' ? '.jpg' : ext) : null;
};

/** The MIME type a stored file is served as, derived from its extension. */
export const mimeTypeFor = (extension) => {
  const ext = String(extension).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  const found = Object.entries(ALLOWED_IMAGE_TYPES).find(([, e]) => e === ext);
  return found ? found[0] : 'application/octet-stream';
};

/**
 * Is this a file we are willing to store?
 *
 * @returns {string|null} the reason it is refused, or null
 */
export const problemWithImage = ({ mimeType, originalName, size } = {}) => {
  const ext = String(originalName || '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? null;
  if (!ext) return `"${originalName || 'this file'}" has no file extension, so it cannot be identified.`;
  if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
    return `"${originalName}" is a ${ext} file. Images must be ${ALLOWED_IMAGE_EXTENSIONS.join(', ')}.`;
  }
  if (mimeType && !ALLOWED_IMAGE_TYPES[String(mimeType).toLowerCase()]) {
    return `"${originalName}" was sent as ${mimeType}, which is not an image type this accepts.`;
  }
  if (size !== undefined && size !== null && Number(size) > MAX_IMAGE_BYTES) {
    return `"${originalName}" is ${(Number(size) / 1024 / 1024).toFixed(1)} MB. `
      + `Images must be ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB or smaller.`;
  }
  if (size !== undefined && size !== null && Number(size) <= 0) {
    return `"${originalName}" is empty.`;
  }
  return null;
};

/**
 * The SKU codes a bulk-uploaded photograph's filename might be naming, best
 * guess first.
 *
 * `14405M-10.jpg` names 14405M-10. A second or third photograph of the same
 * part carries a sequence the SKU does not: `14405M-10_2.jpg`,
 * `14405M-10 (2).webp`, `14405M-10 copy.jpg`.
 *
 * WHY A CONVENTION AT ALL. A spreadsheet cannot carry an image, and attaching
 * photographs one SKU at a time is the thing the bulk endpoint exists to avoid.
 * The filename is the only channel a folder of images has for saying which part
 * it belongs to, and this is the shape those names actually arrive in.
 *
 * WHY CANDIDATES RATHER THAN ONE ANSWER. Real SKU codes end in exactly what a
 * sequence suffix looks like — 14405M-10, BIX-100, 3300M-2 — so a rule that
 * strips "-10" to find the SKU turns a correctly named file into a photograph
 * of a different part, silently. There is no pattern that can tell the two
 * apart, so this does not try: it returns the WHOLE NAME first and the stripped
 * form only as a fallback, and the caller resolves them against the catalogue in
 * that order. A file named after a real SKU therefore always files against that
 * SKU, whatever its code happens to end with.
 *
 * Nothing here guesses beyond that. Neither candidate resolving means the file
 * is reported and skipped, never fuzzily matched onto the nearest code.
 *
 * @returns {string[]} zero, one or two candidates, most literal first
 */
export const skuCandidatesFromFileName = (fileName) => {
  const base = String(fileName ?? '').replace(/\.[^.]+$/, '').trim();
  if (!base) return [];

  /**
   * Each strip is offered as its OWN candidate, not chained into one answer.
   *
   * Chaining them is subtly wrong: "14405M-10 (3).png" loses its "(3)" to the
   * first rule and then its real "-10" to the second, arriving at 14405M — a
   * different part. Offering the intermediate form means the true SKU is tried
   * before the over-stripped one and wins.
   */
  const candidates = [base];

  // " (2)" — what Windows and browsers add to a duplicate download.
  const withoutParen = base.replace(/\s*\(\d{1,3}\)\s*$/, '').trim();
  if (withoutParen) candidates.push(withoutParen);

  // "_2", "-2", " 2", " copy" — what people add by hand.
  const withoutSuffix = withoutParen.replace(/[ _-]+(copy|\d{1,3})$/i, '').trim();
  if (withoutSuffix) candidates.push(withoutSuffix);

  return [...new Set(candidates)];
};

/* ── Description ──────────────────────────────────────────────────────────── */

/**
 * 8,000 characters — an overview, features, specifications and usage notes with
 * room to spare, and short enough that a pasted web page is caught as the
 * mistake it is rather than stored.
 */
export const MAX_DESCRIPTION_LENGTH = 8000;

/**
 * Read a description.
 *
 * An empty description is a legitimate value: it CLEARS the text, which is the
 * only way an admin can undo a wrong one. That is different from images, where
 * blank means "leave alone" — here the field is the whole edit, so the absence
 * of text is an instruction rather than a gap.
 */
export const parseDescription = (raw) => {
  if (raw === undefined) return { value: undefined };
  if (raw === null) return { value: null };
  const text = String(raw).replace(/\r\n/g, '\n').trim();
  if (text.length > MAX_DESCRIPTION_LENGTH) {
    return { problem: `The description is ${text.length} characters. The limit is ${MAX_DESCRIPTION_LENGTH}.` };
  }
  return { value: text === '' ? null : text };
};

/* ── Videos ───────────────────────────────────────────────────────────────── */

/** Videos one SKU may carry. The bulk template offers three. */
export const MAX_VIDEOS_PER_SKU = 6;

export const MAX_VIDEO_TITLE_LENGTH = 120;

/**
 * Pull the video id out of a YouTube URL.
 *
 * Every shape people actually paste is accepted — a watch link, a share link, an
 * embed, a Shorts link, with or without a playlist or timestamp hanging off it.
 * What is NOT accepted is anything that is not YouTube: the slide-over embeds
 * the result in an iframe, and embedding an arbitrary URL from a text field is
 * how a "video link" becomes a page under someone else's control inside the
 * portal's chrome.
 *
 * A YouTube id is 11 characters of the URL-safe alphabet. Matching that exactly,
 * rather than "whatever came after v=", is what makes the stored value safe to
 * interpolate into an embed URL.
 */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com',
  'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
  'youtu.be', 'www.youtu.be',
]);

export const parseYouTubeUrl = (raw) => {
  const text = String(raw ?? '').trim();
  if (!text) return { problem: 'is required' };

  // A bare id is accepted — people paste them out of a spreadsheet column.
  if (YOUTUBE_ID.test(text)) return { videoId: text };

  let url;
  try {
    url = new URL(text.match(/^https?:\/\//i) ? text : `https://${text}`);
  } catch {
    return { problem: `"${text}" is not a URL` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { problem: 'must be an http or https link' };
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    return { problem: `${url.hostname} is not YouTube — only YouTube links can be played here` };
  }

  const path = url.pathname.replace(/^\/+/, '');
  const candidate =
    url.searchParams.get('v')
    ?? (url.hostname.toLowerCase().endsWith('youtu.be') ? path : null)
    ?? path.match(/^(?:embed|shorts|v|live)\/([^/?#]+)/)?.[1]
    ?? null;

  if (!candidate) return { problem: `"${text}" does not name a video` };
  if (!YOUTUBE_ID.test(candidate)) return { problem: `"${candidate}" is not a YouTube video id` };

  return { videoId: candidate };
};

/** The canonical watch link stored for a video id. */
export const watchUrlFor = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;

/**
 * Read one video entry.
 *
 * The URL is normalised to its canonical watch form, so the same video pasted
 * as a Shorts link and as a share link is stored — and de-duplicated — once.
 */
export const parseVideo = (raw) => {
  const source = typeof raw === 'string' ? { url: raw } : (raw || {});
  const parsed = parseYouTubeUrl(source.url);
  if (parsed.problem) return { problem: `Video link ${parsed.problem}.` };

  const title = String(source.title ?? '').trim().slice(0, MAX_VIDEO_TITLE_LENGTH);
  return {
    value: {
      videoId: parsed.videoId,
      url: watchUrlFor(parsed.videoId),
      title: title || null,
      provider: 'youtube',
    },
  };
};

/**
 * Read a whole list of videos, in the order given.
 *
 * Blank entries are dropped rather than reported: the bulk template has three
 * fixed video columns and most rows fill in one, so an empty column two is the
 * normal case and not a mistake worth a row error.
 *
 * @returns {{ values: Array, problems: string[] }}
 */
export const parseVideos = (list) => {
  const values = [];
  const problems = [];
  const seen = new Set();

  for (const [i, raw] of (Array.isArray(list) ? list : []).entries()) {
    const isBlank = raw === null || raw === undefined
      || (typeof raw === 'string' && raw.trim() === '')
      || (typeof raw === 'object' && String(raw.url ?? '').trim() === '');
    if (isBlank) continue;

    const parsed = parseVideo(raw);
    if (parsed.problem) { problems.push(`Video ${i + 1}: ${parsed.problem}`); continue; }
    // The same video twice is a paste error, and two identical players in the
    // slide-over help nobody.
    if (seen.has(parsed.value.videoId)) continue;
    seen.add(parsed.value.videoId);
    values.push({ ...parsed.value, order: values.length });
  }

  if (values.length > MAX_VIDEOS_PER_SKU) {
    problems.push(`A SKU may have at most ${MAX_VIDEOS_PER_SKU} videos; ${values.length} were given.`);
  }

  return { values, problems };
};

export default {
  MAX_IMAGE_BYTES, MAX_IMAGES_PER_REQUEST, MAX_IMAGES_PER_SKU,
  ALLOWED_IMAGE_TYPES, ALLOWED_IMAGE_EXTENSIONS, extensionFor, mimeTypeFor, problemWithImage,
  skuCandidatesFromFileName,
  MAX_DESCRIPTION_LENGTH, parseDescription,
  MAX_VIDEOS_PER_SKU, parseYouTubeUrl, watchUrlFor, parseVideo, parseVideos,
};
