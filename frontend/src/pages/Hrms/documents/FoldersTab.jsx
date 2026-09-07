import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Plus, Pencil, Trash2 } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { documentsApi, FOLDER_VISIBILITY_LABELS } from "../../../services/hrms";
import { departmentsApi } from "../../../services/hrms";
import { HRMS_ROLES as R } from "@shared/permissions/constants.js";
import { createFolderSchema } from "@shared/schemas/document.js";

/**
 * The folder tree, and who can see what is in it.
 *
 * The reference's `FoldersTab`. Its visibility select offers a fourth value,
 * `employee`, whose access check returns false unconditionally — a folder
 * marked that way is invisible to everyone but HR, permanently. Only the three
 * that work are offered here; personal documents live in My Documents, which is
 * what actually addresses them.
 */

export function FoldersTab() {
  const [rows, setRows] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await documentsApi.folders();
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    departmentsApi
      ?.list?.()
      .then((data) => setDepartments(Array.isArray(data) ? data : (data?.data ?? [])))
      .catch(() => setDepartments([]));
  }, []);

  const remove = async () => {
    const target = confirming;
    setConfirming(null);
    try {
      await documentsApi.removeFolder(target.id);
      toast.success(`${target.name} deleted.`);
      await load();
    } catch (err) {
      // The server refuses while the folder still holds anything, and says how
      // many documents and subfolders.
      toast.error(err?.message ?? "That folder could not be deleted.");
    }
  };

  const columns = [
    {
      header: "Folder",
      accessorKey: "name",
      cell: (row) => (
        <div>
          <div className="font-medium text-slate-900">{row.name}</div>
          {row.parentId && (
            <div className="text-xs text-slate-500">
              inside {rows.find((f) => f.id === row.parentId)?.name ?? "another folder"}
            </div>
          )}
        </div>
      ),
    },
    {
      header: "Who can see it",
      className: "w-56",
      cell: (row) => (
        <div>
          <Badge variant={row.visibility === "org" ? "success" : "warning"}>
            {FOLDER_VISIBILITY_LABELS[row.visibility] ?? row.visibility}
          </Badge>
          {row.visibility === "role" && row.roleKeys.length > 0 && (
            <div className="mt-1 text-xs text-slate-500">
              {row.roleKeys.map((k) => k.replace(/^hrms_/, "").replace(/_/g, " ")).join(", ")}
            </div>
          )}
        </div>
      ),
    },
    { header: "Documents", className: "w-28", cell: (row) => row.documentCount },
    {
      header: "",
      className: "w-24",
      cell: (row) => (
        <div className="flex justify-end gap-1">
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Edit ${row.name}`}
            onClick={() => setEditing(row)}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
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
          A folder decides who can see the documents inside it.
        </p>
        <Button onClick={() => setEditing({})}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          New folder
        </Button>
      </div>

      <HrmsDataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={load}
        emptyTitle="No folders yet"
        emptyDescription="Group the library by audience — everyone, a role, or a department."
      />

      {editing && (
        <FolderDrawer
          folder={editing}
          folders={rows}
          departments={departments}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      <ConfirmationDialog
        isOpen={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={remove}
        title={confirming ? `Delete ${confirming.name}?` : ""}
        description="A folder that still holds documents or subfolders cannot be deleted — move those first."
        confirmText="Delete"
        variant="danger"
      />
    </div>
  );
}

function FolderDrawer({ folder, folders, departments, onClose, onSaved }) {
  const isEdit = Boolean(folder?.id);
  const [form, setForm] = useState({
    name: folder?.name ?? "",
    parentId: folder?.parentId ?? "",
    visibility: folder?.visibility ?? "org",
    roleKeys: folder?.roleKeys ?? [],
    departmentIds: folder?.departmentIds ?? [],
  });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const toggle = (key, value) =>
    setForm((c) => ({
      ...c,
      [key]: c[key].includes(value) ? c[key].filter((v) => v !== value) : [...c[key], value],
    }));

  const submit = async (event) => {
    event.preventDefault();
    const payload = {
      name: form.name.trim(),
      parentId: form.parentId || null,
      visibility: form.visibility,
      roleKeys: form.visibility === "role" ? form.roleKeys : [],
      departmentIds: form.visibility === "department" ? form.departmentIds : [],
    };

    const parsed = createFolderSchema.safeParse(payload);
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) next[issue.path.join(".")] = issue.message;
      setErrors(next);
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        await documentsApi.updateFolder(folder.id, parsed.data);
        toast.success("Folder updated.");
      } else {
        await documentsApi.createFolder(parsed.data);
        toast.success("Folder created.");
      }
      onSaved?.();
    } catch (err) {
      toast.error(err?.message ?? "That folder could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen
      onClose={saving ? () => {} : onClose}
      title={isEdit ? "Edit folder" : "New folder"}
      maxWidth="max-w-lg"
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="folder-name" className="mb-1 block text-sm font-medium text-slate-700">
            Name
          </label>
          <Input
            id="folder-name"
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="e.g. Handbooks"
            maxLength={120}
          />
          {errors.name && <p className="mt-1 text-xs text-error-600">{errors.name}</p>}
        </div>

        <div>
          <label htmlFor="folder-parent" className="mb-1 block text-sm font-medium text-slate-700">
            Inside <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <select
            id="folder-parent"
            value={form.parentId}
            onChange={(e) => set({ parentId: e.target.value })}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">Top level</option>
            {folders
              .filter((f) => f.id !== folder?.id)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="folder-visibility"
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            Who can see it
          </label>
          <select
            id="folder-visibility"
            value={form.visibility}
            onChange={(e) => set({ visibility: e.target.value })}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            {Object.entries(FOLDER_VISIBILITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {form.visibility === "role" && (
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-slate-700">Roles</legend>
            <div className="grid grid-cols-2 gap-2">
              {Object.values(R).map((role) => (
                <label key={role} className="flex items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={form.roleKeys.includes(role)}
                    onChange={() => toggle("roleKeys", role)}
                    className="h-3.5 w-3.5 rounded border-slate-300"
                  />
                  {role.replace(/^hrms_/, "").replace(/_/g, " ")}
                </label>
              ))}
            </div>
            {errors.roleKeys && <p className="mt-1 text-xs text-error-600">{errors.roleKeys}</p>}
          </fieldset>
        )}

        {form.visibility === "department" && (
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-slate-700">Departments</legend>
            {departments.length === 0 ? (
              <p className="text-xs text-slate-500">No departments are configured yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {departments.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={form.departmentIds.includes(d.id)}
                      onChange={() => toggle("departmentIds", d.id)}
                      className="h-3.5 w-3.5 rounded border-slate-300"
                    />
                    {d.name}
                  </label>
                ))}
              </div>
            )}
            {errors.departmentIds && (
              <p className="mt-1 text-xs text-error-600">{errors.departmentIds}</p>
            )}
          </fieldset>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default FoldersTab;
