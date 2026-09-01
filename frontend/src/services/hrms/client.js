import { api } from "../api";

/**
 * HRMS API client.
 *
 * Deliberately NOT a second HTTP client. It wraps the existing axios instance,
 * which already carries the Bearer header, the refresh-cookie credentials and
 * the single-flight 401 refresh added in Phase 0. A separate instance would
 * need all three reimplemented, and would drift.
 *
 * What this adds is the `/hrms` prefix in one place, and a normalised error, so
 * every HRMS service reads the same and no screen has to unwrap
 * `err.response.data.message` itself.
 */

const HRMS_PREFIX = "/hrms";

/**
 * A failed HRMS request.
 *
 * `code` is the stable identifier the backend's HrmsError carries; branch on
 * that, never on the message.
 */
export class HrmsApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = "HrmsApiError";
    this.status = status ?? 0;
    this.code = code ?? null;
    this.details = details ?? null;
  }

  /** The capability exists but is not built yet - not a failure to report as one. */
  get isNotImplemented() {
    return this.status === 503 || this.code === "HRMS_NOT_IMPLEMENTED";
  }

  /** The caller is authenticated but not authorised. */
  get isForbidden() {
    return this.status === 403;
  }
}

const normalise = (error) => {
  const res = error?.response;
  const body = res?.data ?? {};
  return new HrmsApiError(
    body.message || error?.message || "Something went wrong.",
    { status: res?.status, code: body.code, details: body.details ?? body.errors ?? null },
  );
};

/** Unwraps the `{ success, data }` envelope every HRMS endpoint returns. */
async function request(method, path, { data, params } = {}) {
  try {
    const res = await api.request({
      method,
      url: `${HRMS_PREFIX}${path}`,
      data,
      params,
    });
    return res.data?.data;
  } catch (error) {
    throw normalise(error);
  }
}

export const hrmsClient = {
  get: (path, params) => request("get", path, { params }),
  post: (path, data) => request("post", path, { data }),
  put: (path, data) => request("put", path, { data }),
  patch: (path, data) => request("patch", path, { data }),
  delete: (path) => request("delete", path),
};

export default hrmsClient;
