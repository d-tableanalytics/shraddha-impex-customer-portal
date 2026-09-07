import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Upload, Trash2 } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { documentsApi, formatInstant } from "../../../services/hrms";
import { useHrmsStore } from "../../../store/hrmsStore";
import { DocumentIdentity, TagList, OpenDocumentButton } from "./documentsShared";
import { UploadDocumentDrawer } from "./UploadDocumentDrawer";

/**
 * The signed-in employee's own documents.
 *
 * The reference's `MyDocumentsTab` — Name / Size / Uploaded / By / Open — over
 * a dedicated endpoint rather than `documents.filter(d => d.employeeId === me)`
 * across a download of the whole organisation's files.
 */

const PAGE_SIZE = 15;

export function MyDocumentsTab() {
  const actor = useHrmsStore((state) => state.actor);
  const employeeId = actor?.employeeId ? String(actor.employeeId) : null;

  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ data: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await documentsApi.mine({ page, pageSize: PAGE_SIZE }));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async () => {
    const target = confirming;
    setConfirming(null);
    try {
      await documentsApi.remove(target.id);
      toast.success(`${target.name} deleted.`);
      await load();
    } catch (err) {
      toast.error(err?.message ?? "That document could not be deleted.");
    }
  };

  if (!employeeId) {
    return (
      <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
        Your user account is not linked to an employee record, so there is no personal
        repository to show.
      </p>
    );
  }

  const rows = result.data ?? [];

  const columns = [
    {
      header: "Document",
      accessorKey: "name",
      cell: (row) => (
        <DocumentIdentity name={row.name} mimeType={row.mimeType} fileSize={row.fileSize} />
      ),
    },
    { header: "Tags", className: "w-44", cell: (row) => <TagList tags={row.tags} /> },
    {
      header: "Uploaded",
      className: "w-32",
      cell: (row) => formatInstant(row.uploadedAt),
    },
    {
      header: "By",
      className: "w-40",
      cell: (row) => row.uploadedByName ?? "—",
    },
    {
      header: "",
      className: "w-40",
      cell: (row) => (
        <div className="flex justify-end gap-2">
          <OpenDocumentButton documentId={row.id} />
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Delete ${row.name}`}
            onClick={() => setConfirming(row)}
          >
            <Trash2 className="h-3.5 w-3.5 text-error-600" aria-hidden="true" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          Your contracts, ID proofs and certificates. Only you and HR can see these.
        </p>
        <Button onClick={() => setUploadOpen(true)}>
          <Upload className="mr-1 h-4 w-4" aria-hidden="true" />
          Upload
        </Button>
      </div>

      <HrmsDataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={load}
        page={page}
        pageSize={PAGE_SIZE}
        total={result.total ?? 0}
        onPageChange={setPage}
        emptyTitle="No personal documents yet"
        emptyDescription="Upload your ID proof, certificates or anything HR has asked you for."
      />

      <UploadDocumentDrawer
        open={uploadOpen}
        employeeId={employeeId}
        onClose={() => setUploadOpen(false)}
        onUploaded={() => {
          setPage(1);
          load();
        }}
      />

      <ConfirmationDialog
        isOpen={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={remove}
        title={confirming ? `Delete ${confirming.name}?` : ""}
        description="The file is removed from storage and cannot be recovered."
        confirmText="Delete"
        variant="danger"
      />
    </div>
  );
}

export default MyDocumentsTab;
