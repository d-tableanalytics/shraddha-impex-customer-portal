import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { Paperclip, Upload, Loader2 } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { expensesApi, uploadReceipt, formatDay } from "../../../services/hrms";
import { Money } from "./expensesShared";

/**
 * The line items of one claim, with its receipts.
 *
 * The reference renders this as an expanded row under the claims table, and so
 * does the caller here.
 *
 * ---------------------------------------------------------------------------
 * A receipt is never a plain link
 * ---------------------------------------------------------------------------
 * The reference points an anchor at `/expenses/claims/line-items/:id/receipt`
 * and lets the browser fetch it. Ours asks the server for a short-lived URL
 * first: the object has no publicly addressable form, the read is authorised
 * against the claim, and the server records who looked. The URL is used
 * immediately and never stored, because it expires.
 */

const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";

export function ClaimLines({ claim, canUpload = false, onChange }) {
  const lines = claim?.lineItems ?? [];

  if (lines.length === 0) {
    return <p className="px-4 py-3 text-sm text-slate-500">This claim has no line items.</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <th className="px-3 py-2 font-semibold">Date</th>
          <th className="px-3 py-2 font-semibold">Category</th>
          <th className="px-3 py-2 text-right font-semibold">Amount</th>
          <th className="px-3 py-2 font-semibold">Description</th>
          <th className="px-3 py-2 font-semibold">Receipt</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.id} className="border-b border-slate-100 last:border-0">
            <td className="whitespace-nowrap px-3 py-2 text-slate-600">{formatDay(line.date)}</td>
            <td className="px-3 py-2">
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
                {line.categoryCode ?? "—"}
              </span>{" "}
              <span className="text-slate-600">{line.categoryName ?? ""}</span>
            </td>
            <td className="px-3 py-2">
              <Money value={line.amount} />
            </td>
            <td className="px-3 py-2 text-slate-700">{line.description}</td>
            <td className="px-3 py-2">
              <ReceiptCell
                claimId={claim.id}
                line={line}
                canUpload={canUpload}
                onChange={onChange}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReceiptCell({ claimId, line, canUpload, onChange }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);

  /** Ask for a fresh URL, then open it. Never cached — it expires. */
  const view = async () => {
    setBusy(true);
    try {
      const { url } = await expensesApi.receiptUrl(claimId, line.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(error?.message ?? "Could not open that receipt.");
    } finally {
      setBusy(false);
    }
  };

  const attach = async (event) => {
    const file = event.target.files?.[0];
    // Clearing the input lets the same file be chosen again after a failure.
    event.target.value = "";
    if (!file) return;

    setBusy(true);
    try {
      const updated = await uploadReceipt(claimId, line.id, file);
      toast.success("Receipt attached.");
      onChange?.(updated);
    } catch (error) {
      // The server reads the file's leading bytes, so a renamed executable is
      // refused here even though the picker accepted it.
      toast.error(error?.response?.data?.message ?? error?.message ?? "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  if (line.hasReceipt) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={view}
        disabled={busy}
        aria-label={`View receipt for ${line.description}`}
      >
        {busy ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Paperclip className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
        )}
        View
      </Button>
    );
  }

  if (!canUpload) return <span className="text-slate-400">—</span>;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={attach}
        aria-label={`Attach a receipt for ${line.description}`}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
      >
        {busy ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Upload className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
        )}
        Upload
      </Button>
    </>
  );
}

export default ClaimLines;
