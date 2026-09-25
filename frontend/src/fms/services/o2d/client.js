import { api } from "../api";

/**
 * O2D API client.
 *
 * A sibling of `services/hrms/client.js`, not a reuse of it: that one hardcodes
 * the `/hrms` prefix, and O2D is mounted at `/api/v1/o2d` because it is a portal
 * module rather than an HRMS one. Everything else is deliberately identical —
 * the same axios instance underneath (so the Bearer header, the refresh cookie
 * and the single-flight 401 refresh all still apply), the same `{ success,
 * data }` unwrapping, the same normalised error.
 *
 * What it adds over the HRMS client is `data` on the error. The O2D backend
 * returns a payload alongside a refusal in one case that matters — a duplicate
 * PO comes back as 409 WITH the offending order, so the screen can offer "open
 * the existing order" instead of leaving the user stuck.
 */

const O2D_PREFIX = "/o2d";

/**
 * A failed O2D request.
 *
 * `code` is the stable identifier `O2dWorkflowError` carries — `O2D_DUPLICATE_PO`,
 * `O2D_PROMISE_DATE_REQUIRED`, `O2D_NOT_YOUR_STAGE`. Branch on that, never on
 * the message, which is written for a human and will be reworded.
 */
export class O2dApiError extends Error {
  constructor(message, { status, code, details, data } = {}) {
    super(message);
    this.name = "O2dApiError";
    this.status = status ?? 0;
    this.code = code ?? null;
    this.details = details ?? null;
    /** Payload sent WITH the refusal, e.g. the order that caused a 409. */
    this.data = data ?? null;
  }

  get isForbidden() {
    return this.status === 403;
  }

  /** The order exists but this role may not move it — §37, not a bug. */
  get isNotYourStage() {
    return this.code === "O2D_NOT_YOUR_STAGE";
  }

  /**
   * A refusal the user can resolve by changing what they typed, rather than a
   * failure to report. Drives whether the form shows an inline message or a
   * red toast.
   */
  get isUserCorrectable() {
    return this.status === 400 || this.status === 409 || this.status === 422;
  }
}

const normalise = (error) => {
  const res = error?.response;
  const body = res?.data ?? {};
  return new O2dApiError(body.message || error?.message || "Something went wrong.", {
    status: res?.status,
    code: body.code,
    details: body.details ?? body.errors ?? null,
    data: body.data ?? null,
  });
};

async function request(method, path, { data, params } = {}) {
  try {
    const res = await api.request({ method, url: `${O2D_PREFIX}${path}`, data, params });
    return res.data?.data;
  } catch (error) {
    throw normalise(error);
  }
}

export const o2dClient = {
  get: (path, params) => request("get", path, { params }),
  post: (path, data) => request("post", path, { data }),
  put: (path, data) => request("put", path, { data }),
  patch: (path, data) => request("patch", path, { data }),
  delete: (path) => request("delete", path),

  /**
   * Fetch a file as a Blob.
   *
   * Goes through axios rather than being an `<a href>`, because the export
   * route requires the Authorization header and a plain link cannot carry one —
   * it would hit the endpoint unauthenticated and save the resulting 401 as a
   * file called `orders.xlsx`. `responseType: "blob"` also stops axios trying to
   * parse a binary workbook as JSON.
   *
   * Returns the Blob itself, not the `{ success, data }` envelope: a file
   * response has no envelope.
   */
  download: async (path, params) => {
    try {
      const res = await api.request({
        method: "get",
        url: `${O2D_PREFIX}${path}`,
        params,
        responseType: "blob",
      });
      return res.data;
    } catch (error) {
      throw normalise(error);
    }
  },

  /**
   * Multipart upload.
   *
   * Goes through the same axios instance so the session headers still apply.
   * The Content-Type is left UNSET on purpose: the browser must set it, because
   * only it knows the multipart boundary it generated.
   */
  upload: async (path, formData) => {
    try {
      const res = await api.request({
        method: "post",
        url: `${O2D_PREFIX}${path}`,
        data: formData,
      });
      return res.data?.data;
    } catch (error) {
      throw normalise(error);
    }
  },
};

export default o2dClient;
