import { useState } from "react";
import toast from "react-hot-toast";
import { FileText, Download, Loader2 } from "lucide-react";

import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { documentsApi, formatFileSize } from "../../../services/hrms";

/**
 * Small pieces the document tabs share.
 */

/**
 * Open a document.
 *
 * Asks the server for a short-lived URL and follows it. The reference points an
 * anchor straight at a streaming endpoint that echoes the client-supplied
 * content type with `Content-Disposition: inline` — so a document is never a
 * plain link here, and the storage key is never in the page at all.
 */
export function OpenDocumentButton({ documentId, label = "Open", size = "xs" }) {
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    try {
      const { url } = await documentsApi.fileUrl(documentId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(error?.message ?? "That document could not be opened.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button type="button" size={size} variant="secondary" disabled={busy} onClick={open}>
      {busy ? (
        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
      )}
      {label}
    </Button>
  );
}

/** Name, type and size in one cell. */
export function DocumentIdentity({ name, mimeType, fileSize }) {
  return (
    <div className="flex items-start gap-2 leading-tight">
      <FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
      <div>
        <div className="font-medium text-slate-900">{name}</div>
        <div className="text-xs text-slate-500">
          {shortType(mimeType)} · {formatFileSize(fileSize)}
        </div>
      </div>
    </div>
  );
}

/** `application/pdf` -> `PDF`; the Office types -> `DOCX` and friends. */
function shortType(mimeType) {
  if (!mimeType) return "File";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.startsWith("image/")) return mimeType.slice(6).toUpperCase();
  if (mimeType.includes("wordprocessingml")) return "DOCX";
  if (mimeType.includes("spreadsheetml")) return "XLSX";
  if (mimeType.includes("presentationml")) return "PPTX";
  if (mimeType === "application/msword") return "DOC";
  if (mimeType === "application/vnd.ms-excel") return "XLS";
  if (mimeType === "application/vnd.ms-powerpoint") return "PPT";
  if (mimeType === "text/csv") return "CSV";
  if (mimeType === "text/plain") return "TXT";
  return "File";
}

/** Tag chips, capped so a long list does not push the row out of shape. */
export function TagList({ tags = [], max = 3 }) {
  if (tags.length === 0) return <span className="text-slate-400">—</span>;
  const shown = tags.slice(0, max);
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((tag) => (
        <span
          key={tag}
          className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600"
        >
          {tag}
        </span>
      ))}
      {tags.length > max && (
        <span className="text-xs text-slate-400">+{tags.length - max}</span>
      )}
    </div>
  );
}

/**
 * Where a policy stands.
 *
 * `Expired` is a state the reference cannot show: it stores an expiry date and
 * never reads it, so an expired policy stays listed and actionable forever.
 */
export function PolicyStateBadge({ policy, acknowledgedByMe }) {
  if (!policy) return null;
  if (policy.isExpired) return <Badge variant="neutral">Expired</Badge>;
  if (!policy.isLive) return <Badge variant="warning">Not yet in effect</Badge>;
  if (acknowledgedByMe) return <Badge variant="success">Acknowledged</Badge>;
  return <Badge variant="danger">Action needed</Badge>;
}

/** A labelled value in the detail grids. */
export function Field({ label, children, wide = false }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children ?? "—"}</dd>
    </div>
  );
}
