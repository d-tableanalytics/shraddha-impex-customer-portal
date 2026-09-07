import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Upload, Search, Trash2, Megaphone } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { documentsApi, formatInstant } from "../../../services/hrms";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";
import { DocumentIdentity, TagList, OpenDocumentButton } from "./documentsShared";
import { UploadDocumentDrawer } from "./UploadDocumentDrawer";
import { PublishPolicyDrawer } from "./PoliciesTab";

/**
 * The company library.
 *
 * The reference's `LibraryTab` — Name / Folder / Size / Tags / Uploaded /
 * Open + Delete — with the rows coming from a scoped, searched, paged query
 * rather than from `documents.filter(d => !d.employeeId)` over a full download.
 */

const PAGE_SIZE = 15;

export function LibraryTab() {
  const { can } = useHrmsPermissions();
  const isHr = can(M.DOCUMENTS, A.EDIT, S.ORG);

  const [page, setPage] = useState(1);
  const [folderId, setFolderId] = useState("");
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");

  const [result, setResult] = useState({ data: [], total: 0 });
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [publishOn, setPublishOn] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { scope: "company", page, pageSize: PAGE_SIZE };
      if (folderId) params.folderId = folderId;
      if (applied) params.search = applied;
      setResult(await documentsApi.list(params));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, folderId, applied]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    documentsApi
      .folders()
      .then((rows) => setFolders(Array.isArray(rows) ? rows : []))
      .catch(() => setFolders([]));
  }, []);

  const remove = async () => {
    const target = confirming;
    setConfirming(null);
    try {
      await documentsApi.remove(target.id);
      toast.success(`${target.name} deleted.`);
      await load();
    } catch (err) {
      // A policy people have acknowledged is a record, and the server says so.
      toast.error(err?.message ?? "That document could not be deleted.");
    }
  };

  const rows = result.data ?? [];

  const columns = [
    {
      header: "Document",
      accessorKey: "name",
      cell: (row) => (
        <DocumentIdentity name={row.name} mimeType={row.mimeType} fileSize={row.fileSize} />
      ),
    },
    {
      header: "Folder",
      className: "w-40",
      cell: (row) =>
        row.folderName ?? <span className="text-slate-400">Library root</span>,
    },
    { header: "Tags", className: "w-44", cell: (row) => <TagList tags={row.tags} /> },
    {
      header: "Uploaded",
      className: "w-32",
      cell: (row) => formatInstant(row.uploadedAt),
    },
    {
      header: "",
      className: "w-56",
      cell: (row) => (
        <div className="flex justify-end gap-2">
          <OpenDocumentButton documentId={row.id} />
          {isHr && !row.policy && (
            <Button
              size="xs"
              variant="secondary"
              onClick={() => setPublishOn(row)}
              title="Publish as a policy"
            >
              <Megaphone className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              Publish
            </Button>
          )}
          {isHr && (
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Delete ${row.name}`}
              onClick={() => setConfirming(row)}
            >
              <Trash2 className="h-3.5 w-3.5 text-error-600" aria-hidden="true" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(search.trim());
            setPage(1);
          }}
        >
          <label htmlFor="library-search" className="sr-only">
            Search documents
          </label>
          <Input
            id="library-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or tag…"
            className="w-56"
          />
          <Button type="submit" size="sm" variant="secondary">
            <Search className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Search</span>
          </Button>
        </form>

        <label htmlFor="library-folder" className="sr-only">
          Filter by folder
        </label>
        <select
          id="library-folder"
          value={folderId}
          onChange={(e) => {
            setFolderId(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">All folders</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>

        {isHr && (
          <Button className="ml-auto" onClick={() => setUploadOpen(true)}>
            <Upload className="mr-1 h-4 w-4" aria-hidden="true" />
            Upload
          </Button>
        )}
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
        emptyTitle="Nothing in the library yet"
        emptyDescription={
          isHr
            ? "Upload handbooks, policies and forms for everyone to read."
            : "Documents shared with you will appear here."
        }
      />

      <UploadDocumentDrawer
        open={uploadOpen}
        folders={folders}
        onClose={() => setUploadOpen(false)}
        onUploaded={() => {
          setPage(1);
          load();
        }}
      />

      {publishOn && (
        <PublishPolicyDrawer
          document={publishOn}
          onClose={() => setPublishOn(null)}
          onPublished={() => {
            setPublishOn(null);
            load();
          }}
        />
      )}

      <ConfirmationDialog
        isOpen={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={remove}
        title={confirming ? `Delete ${confirming.name}?` : ""}
        description="The file is removed from storage. A policy that people have already acknowledged cannot be deleted."
        confirmText="Delete"
        variant="danger"
      />
    </div>
  );
}

export default LibraryTab;
