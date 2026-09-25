import { API_ORIGIN } from "./apiBase";

/**
 * Make a storage URL openable from the browser.
 *
 * ---------------------------------------------------------------------------
 * 🔴 THE BUG THIS EXISTS TO FIX
 * ---------------------------------------------------------------------------
 * The storage layer issues short-lived read URLs, and the two drivers return
 * different SHAPES of URL:
 *
 *   s3     → https://bucket.s3.../key?X-Amz-Signature=…   (absolute)
 *   local  → /api/v1/hrms/files/local?key=…&sig=…         (RELATIVE)
 *
 * A relative URL is resolved against the page's origin. In development — and in
 * any deployment where the API is not served from the same origin as the SPA —
 * that origin is the frontend, so `window.open('/api/v1/hrms/files/local?…')`
 * opened the SPA at a path with no route and React Router rendered its own
 * error page:
 *
 *   Unexpected Application Error!  404 Not Found
 *
 * which reads as "the app is broken", not as "that link went to the wrong
 * host". Every file in the product was affected on the local driver — O2D
 * documents, HR documents, payslips, offer letters, resumes, expense receipts,
 * academy certificates and lesson content.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS FIXED HERE AND NOT IN THE DRIVER
 * ---------------------------------------------------------------------------
 * The relative URL is not wrong — it is the CORRECT answer behind a reverse
 * proxy that serves the SPA and the API on one origin, and it is the only
 * answer the storage layer can give, because it runs with no request context
 * and genuinely does not know what public address it is reachable at.
 *
 * The frontend does know: `API_ORIGIN`. So resolution belongs here, and it
 * stays correct in all three deployment shapes `apiBase.js` describes —
 * same-origin builds have an empty `API_ORIGIN`, so the URL is handed back
 * relative, exactly as it arrived.
 */
export function fileUrl(url) {
  if (!url) return url;

  /**
   * Anything with a scheme, or protocol-relative, is already absolute.
   *
   * This is what S3 returns, and rewriting it would corrupt a working presigned
   * URL — the signature covers the host.
   */
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return url;

  // Same-origin deployment: `API_ORIGIN` is "", and the URL stays relative.
  if (!API_ORIGIN) return url;

  return `${API_ORIGIN}${url.startsWith("/") ? "" : "/"}${url}`;
}

/**
 * Open a storage URL in a new tab.
 *
 * `noopener` because the target is a storage origin and must never get a handle
 * on this window — the reason every call site already passed it, now in one
 * place so a new one cannot forget.
 */
export function openFile(url) {
  return window.open(fileUrl(url), "_blank", "noopener,noreferrer");
}

export default fileUrl;
