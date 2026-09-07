import { api } from "../api";
import { hrmsClient } from "./client";

/**
 * Documents API.
 *
 * Mirrors the reference's `api/document.ts`, with three differences worth
 * knowing at the call site:
 *
 *   1. THE LISTS ARE SCOPED, SEARCHED AND PAGED BY THE SERVER. The reference
 *      fetches every document in the organisation on every call and filters the
 *      array in the browser — `documents.filter(d => !d.employeeId)` for the
 *      library, `filter(d => d.employeeId === me)` for the personal repo.
 *
 *   2. A FILE IS READ THROUGH A SHORT-LIVED URL. The reference points an anchor
 *      at `/documents/:id/download`, which streams the bytes back with the
 *      client-supplied content type and `Content-Disposition: inline`.
 *
 *   3. THE STORAGE KEY IS NEVER IN THE PAYLOAD. The reference returns `fileKey`
 *      in every DTO.
 */

export const documentsApi = {
  // -- Folders --------------------------------------------------------------
  folders: () => hrmsClient.get("/documents/folders"),
  createFolder: (dto) => hrmsClient.post("/documents/folders", dto),
  updateFolder: (id, dto) => hrmsClient.patch(`/documents/folders/${id}`, dto),
  /** Soft delete. Refused while the folder still holds anything. */
  removeFolder: (id) => hrmsClient.delete(`/documents/folders/${id}`),

  // -- Documents ------------------------------------------------------------
  /** `{ data, total, page, pageSize }` — scoped by the server. */
  list: (params = {}) => hrmsClient.get("/documents", params),
  /** The signed-in employee's own repository. */
  mine: (params = {}) => hrmsClient.get("/documents/me", params),
  get: (id) => hrmsClient.get(`/documents/${id}`),
  update: (id, dto) => hrmsClient.patch(`/documents/${id}`, dto),
  remove: (id) => hrmsClient.delete(`/documents/${id}`),

  /** `{ url, expiresInSeconds, name }`. The URL expires; do not cache it. */
  fileUrl: (id) => hrmsClient.get(`/documents/${id}/url`),

  // -- Policies -------------------------------------------------------------
  publishPolicy: (id, dto) => hrmsClient.post(`/documents/${id}/policy`, dto),
  acknowledge: (id, dto = {}) => hrmsClient.post(`/documents/${id}/acknowledge`, dto),
  acknowledgments: (id) => hrmsClient.get(`/documents/${id}/acknowledgments`),
  /** `{ data, pending }` — live policies this employee still owes. */
  pendingPolicies: () => hrmsClient.get("/documents/policies/pending"),
};

/**
 * Upload a document.
 *
 * Multipart, so it goes through `api` directly rather than `hrmsClient` — the
 * same shape as the receipt and selfie uploads. The server decides the file's
 * type by reading its leading bytes, so the `accept` attribute on the input is
 * a convenience, never the control.
 */
export async function uploadDocument({ file, name, folderId, employeeId, tags }) {
  const form = new FormData();
  form.append("name", name);
  if (folderId) form.append("folderId", folderId);
  if (employeeId) form.append("employeeId", employeeId);
  if (tags?.length) form.append("tags", tags.join(","));
  form.append("file", file, file.name ?? "document");

  const res = await api.request({
    method: "post",
    url: "/hrms/documents",
    data: form,
  });
  return res.data?.data ?? null;
}

/** What the file picker offers. The server's whitelist is the real rule. */
export const ACCEPTED_DOCUMENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/tiff",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "text/plain",
  "text/csv",
].join(",");

export const FOLDER_VISIBILITY_LABELS = {
  org: "Everyone",
  role: "Specific roles",
  department: "Specific departments",
};

/** `1536` -> `1.5 KB`. The reference's own thresholds. */
export function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default {
  documentsApi,
  uploadDocument,
  formatFileSize,
  ACCEPTED_DOCUMENT_TYPES,
  FOLDER_VISIBILITY_LABELS,
};
