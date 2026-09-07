import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Upload } from "lucide-react";

import { Drawer } from "../../../components/ui/Drawer";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import {
  uploadDocument,
  formatFileSize,
  ACCEPTED_DOCUMENT_TYPES,
} from "../../../services/hrms";

/**
 * Upload a document.
 *
 * One drawer for both destinations — the company library (HR, optionally into a
 * folder) and a personal repository. The reference has two nearly identical
 * drawers, one per tab.
 *
 * The `accept` attribute narrows the picker; it is not the control. The server
 * reads the file's leading bytes and refuses anything not on its whitelist,
 * which is what stops an HTML file being stored as a PDF.
 */

export function UploadDocumentDrawer({
  open,
  onClose,
  onUploaded,
  /** When set, the upload goes to this employee's repository. */
  employeeId = null,
  /** Offered only for a library upload. */
  folders = [],
}) {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [name, setName] = useState("");
  const [folderId, setFolderId] = useState("");
  const [tags, setTags] = useState("");
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const personal = Boolean(employeeId);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setName("");
    setFolderId("");
    setTags("");
    setErrors({});
  }, [open]);

  const choose = (event) => {
    const chosen = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!chosen) return;
    setFile(chosen);
    // A sensible default the person can overwrite, not a name they must invent.
    if (!name) setName(chosen.name.replace(/\.[^.]+$/, ""));
  };

  const submit = async (event) => {
    event.preventDefault();

    const next = {};
    if (!file) next.file = "Choose a file to upload.";
    if (!name.trim()) next.name = "Give the document a name.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }

    setSaving(true);
    try {
      const created = await uploadDocument({
        file,
        name: name.trim(),
        folderId: personal ? null : folderId || null,
        employeeId: employeeId || null,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      toast.success("Document uploaded.");
      onUploaded?.(created);
      onClose?.();
    } catch (error) {
      // The server reads the leading bytes, so a renamed executable is refused
      // here even though the picker accepted it.
      toast.error(
        error?.response?.data?.message ?? error?.message ?? "That upload failed.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen={open}
      onClose={saving ? () => {} : onClose}
      title={personal ? "Upload a personal document" : "Upload to the library"}
      maxWidth="max-w-lg"
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <span className="mb-1 block text-sm font-medium text-slate-700">File</span>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED_DOCUMENT_TYPES}
            className="sr-only"
            onChange={choose}
            aria-label="Choose a file to upload"
          />
          <div className="flex items-center gap-3">
            <Button type="button" variant="secondary" onClick={() => inputRef.current?.click()}>
              <Upload className="mr-1 h-4 w-4" aria-hidden="true" />
              Choose file
            </Button>
            {file ? (
              <span className="text-sm text-slate-600">
                {file.name}{" "}
                <span className="text-slate-400">({formatFileSize(file.size)})</span>
              </span>
            ) : (
              <span className="text-sm text-slate-400">Nothing chosen</span>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            PDF, images, Office documents or plain text, up to 10 MB.
          </p>
          {errors.file && <p className="mt-1 text-xs text-error-600">{errors.file}</p>}
        </div>

        <div>
          <label htmlFor="doc-name" className="mb-1 block text-sm font-medium text-slate-700">
            Name
          </label>
          <Input
            id="doc-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={personal ? "e.g. PAN card" : "e.g. Leave policy 2026"}
            maxLength={200}
          />
          {errors.name && <p className="mt-1 text-xs text-error-600">{errors.name}</p>}
        </div>

        {!personal && (
          <div>
            <label htmlFor="doc-folder" className="mb-1 block text-sm font-medium text-slate-700">
              Folder <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <select
              id="doc-folder"
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Library root — everyone can see it</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              A folder decides who can see what is inside it.
            </p>
          </div>
        )}

        <div>
          <label htmlFor="doc-tags" className="mb-1 block text-sm font-medium text-slate-700">
            Tags <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <Input
            id="doc-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="policy, hr, 2026"
          />
          <p className="mt-1 text-xs text-slate-500">Comma separated. Tags are searchable.</p>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Uploading…" : "Upload"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default UploadDocumentDrawer;
