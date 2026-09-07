/**
 * Browser camera and geolocation, with truthful failure states.
 *
 * ---------------------------------------------------------------------------
 * Every failure is NAMED, not collapsed
 * ---------------------------------------------------------------------------
 * The reference's `captureGeo` resolves with no coordinates on ANY failure —
 * permission denied, position unavailable, timeout, an insecure origin — and
 * its caller then shows one message: "Location capture failed — please retry".
 * Retrying is useless for three of those four, and the one instruction that
 * would help (turn it on in site settings) is never given.
 *
 * These return a discriminated reason so the UI can say what actually happened
 * and what, if anything, the person can do about it.
 *
 * ---------------------------------------------------------------------------
 * The API may simply not be there
 * ---------------------------------------------------------------------------
 * `navigator.mediaDevices` is undefined on a plain-HTTP origin and in some
 * embedded webviews, and reading `.getUserMedia` off it throws. Every entry
 * point below checks before it touches anything, so an unsupported browser
 * gets an honest message rather than a blank screen.
 */

/** Camera and geolocation are both gated on a secure context. */
export function isSecureContextAvailable() {
  return typeof window !== "undefined" && window.isSecureContext === true;
}

export function isCameraSupported() {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export function isGeolocationSupported() {
  return typeof navigator !== "undefined" && Boolean(navigator.geolocation);
}

/** Reason codes the UI branches on. Never render a raw browser error. */
export const CAPTURE_REASONS = Object.freeze({
  INSECURE_CONTEXT: "insecure_context",
  UNSUPPORTED: "unsupported",
  PERMISSION_DENIED: "permission_denied",
  UNAVAILABLE: "unavailable",
  TIMEOUT: "timeout",
  FAILED: "failed",
});

export const CAPTURE_MESSAGES = Object.freeze({
  [CAPTURE_REASONS.INSECURE_CONTEXT]:
    "Your browser blocks the camera and location on insecure (http://) pages. Ask IT to open the portal over https.",
  [CAPTURE_REASONS.UNSUPPORTED]:
    "This browser does not support the feature. Try a current Chrome, Edge, Firefox or Safari.",
  [CAPTURE_REASONS.PERMISSION_DENIED]:
    "Access is blocked for this site. Click the padlock in the address bar, set it to Allow, then try again.",
  [CAPTURE_REASONS.UNAVAILABLE]:
    "Your device could not provide a reading. It may be in use by another app, or you may be indoors with no signal.",
  [CAPTURE_REASONS.TIMEOUT]: "Your device took too long to respond. Try again.",
  [CAPTURE_REASONS.FAILED]: "Something went wrong. Try again.",
});

export const captureMessage = (reason) =>
  CAPTURE_MESSAGES[reason] ?? CAPTURE_MESSAGES[CAPTURE_REASONS.FAILED];

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/**
 * Open the front camera.
 *
 * The CALLER owns the returned stream and MUST call `stopStream` on it — an
 * unstopped track leaves the camera indicator lit after the modal closes,
 * which reads to the person as being recorded.
 *
 * @returns {Promise<{ok: true, stream: MediaStream} | {ok: false, reason: string}>}
 */
export async function openCamera() {
  if (!isSecureContextAvailable()) {
    return { ok: false, reason: CAPTURE_REASONS.INSECURE_CONTEXT };
  }
  if (!isCameraSupported()) {
    return { ok: false, reason: CAPTURE_REASONS.UNSUPPORTED };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    });
    return { ok: true, stream };
  } catch (err) {
    // The spec's own names, which distinguish "the person said no" from "the
    // camera is busy" — a distinction the reference discards entirely.
    if (err?.name === "NotAllowedError" || err?.name === "SecurityError") {
      return { ok: false, reason: CAPTURE_REASONS.PERMISSION_DENIED };
    }
    if (err?.name === "NotFoundError" || err?.name === "NotReadableError") {
      return { ok: false, reason: CAPTURE_REASONS.UNAVAILABLE };
    }
    return { ok: false, reason: CAPTURE_REASONS.FAILED };
  }
}

/** Stop every track. Safe to call with null, and safe to call twice. */
export function stopStream(stream) {
  try {
    stream?.getTracks?.().forEach((track) => track.stop());
  } catch {
    // A stream already torn down by the browser throws here. Nothing to do —
    // the tracks are stopped either way, which is all this function is for.
  }
}

/**
 * Draw the current video frame to a downscaled JPEG blob.
 *
 * 640 px and q0.7, which AD-15 asks for: roughly 30–50 KB instead of a
 * multi-megabyte camera capture. Downscaling in the browser is what keeps the
 * upload under the server's 2 MB ceiling on a modern phone, where a raw frame
 * would otherwise blow straight past it.
 */
export function captureFrame(video, { maxWidth = 640, quality = 0.7 } = {}) {
  return new Promise((resolve) => {
    if (!video?.videoWidth) {
      resolve(null);
      return;
    }

    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);

    const context = canvas.getContext("2d");
    if (!context) {
      resolve(null);
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    // jsdom implements neither toBlob nor toDataURL, so a guard here keeps the
    // component testable without stubbing a canvas.
    if (typeof canvas.toBlob !== "function") {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob ?? null), "image/jpeg", quality);
  });
}

// ---------------------------------------------------------------------------
// Geolocation
// ---------------------------------------------------------------------------

/**
 * Read the current position once.
 *
 * `maximumAge: 0` — a punch must record where the person IS, not a cached fix
 * from wherever they were an hour ago. The reference passes 60_000, so a punch
 * can be stamped with a minute-old location; for a record whose whole purpose
 * is verifying a specific moment, that is the wrong trade.
 *
 * @returns {Promise<{ok: true, geo: {lat,lng,accuracy}} | {ok: false, reason: string}>}
 */
export function readPosition({ timeout = 10_000 } = {}) {
  if (!isSecureContextAvailable()) {
    return Promise.resolve({ ok: false, reason: CAPTURE_REASONS.INSECURE_CONTEXT });
  }
  if (!isGeolocationSupported()) {
    return Promise.resolve({ ok: false, reason: CAPTURE_REASONS.UNSUPPORTED });
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          ok: true,
          geo: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            // Rounded: sub-metre precision on a confidence radius is noise,
            // and the server caps what it will accept anyway.
            accuracy:
              typeof position.coords.accuracy === "number"
                ? Math.round(position.coords.accuracy)
                : undefined,
          },
        }),
      (error) => {
        const reason =
          error?.code === 1
            ? CAPTURE_REASONS.PERMISSION_DENIED
            : error?.code === 3
              ? CAPTURE_REASONS.TIMEOUT
              : CAPTURE_REASONS.UNAVAILABLE;
        resolve({ ok: false, reason });
      },
      { timeout, maximumAge: 0, enableHighAccuracy: true },
    );
  });
}

export default {
  openCamera,
  stopStream,
  captureFrame,
  readPosition,
  captureMessage,
  CAPTURE_REASONS,
  isCameraSupported,
  isGeolocationSupported,
  isSecureContextAvailable,
};
