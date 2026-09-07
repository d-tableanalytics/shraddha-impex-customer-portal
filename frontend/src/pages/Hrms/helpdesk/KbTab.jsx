import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Search, Plus, ArrowLeft, Pencil, Trash2 } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { helpdeskApi, formatInstant } from "../../../services/hrms";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";
import { createKbArticleSchema } from "@shared/schemas/helpdesk.js";

/**
 * The knowledge base.
 *
 * The reference's `KbTab` — a search box, a list, and a reading view — plus the
 * authoring its own model demands. Its `list` filters on `publishedAt != null`
 * and no endpoint can ever set that field, so its knowledge base is permanently
 * empty. Its search also truncates before it filters, so a match outside the
 * newest twenty can never be found; here the search is a query, and the paging
 * happens after it.
 */

const PAGE_SIZE = 15;

export function KbTab() {
  const { can } = useHrmsPermissions();
  const isAuthor =
    can(M.HELPDESK, A.RESOLVE, S.ORG) ||
    can(M.HELPDESK_HR, A.RESOLVE, S.ORG) ||
    can(M.HELPDESK_PAYROLL, A.RESOLVE, S.ORG) ||
    can(M.HELPDESK_IT, A.RESOLVE, S.ORG);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [includeDrafts, setIncludeDrafts] = useState(false);

  const [result, setResult] = useState({ data: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [reading, setReading] = useState(null);
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { page, pageSize: PAGE_SIZE };
      if (applied) params.search = applied;
      if (includeDrafts && isAuthor) params.includeDrafts = "true";
      setResult(await helpdeskApi.articles(params));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, applied, includeDrafts, isAuthor]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async () => {
    const target = confirming;
    setConfirming(null);
    try {
      await helpdeskApi.removeArticle(target.id);
      toast.success(`${target.title} deleted.`);
      await load();
    } catch (err) {
      toast.error(err?.message ?? "That article could not be deleted.");
    }
  };

  // Reading view — the reference's "Back to results" pattern.
  if (reading) {
    return (
      <div>
        <Button variant="secondary" size="sm" onClick={() => setReading(null)}>
          <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
          Back to articles
        </Button>

        <article className="mt-4 rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-slate-900">{reading.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            {reading.authorName && <span>{reading.authorName}</span>}
            {reading.publishedAt && <span>· {formatInstant(reading.publishedAt)}</span>}
            {!reading.published && <Badge variant="warning">Draft</Badge>}
          </div>
          {reading.searchTags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {reading.searchTags.map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
          <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
            {reading.body}
          </p>
        </article>
      </div>
    );
  }

  const columns = [
    {
      header: "Article",
      accessorKey: "title",
      cell: (row) => (
        <div className="leading-tight">
          <div className="font-medium text-slate-900">{row.title}</div>
          {row.searchTags.length > 0 && (
            <div className="text-xs text-slate-500">
              {row.searchTags.map((t) => `#${t}`).join(" ")}
            </div>
          )}
        </div>
      ),
    },
    {
      header: "Status",
      className: "w-28",
      cell: (row) =>
        row.published ? (
          <Badge variant="success">Published</Badge>
        ) : (
          <Badge variant="warning">Draft</Badge>
        ),
    },
    { header: "Author", className: "w-40", cell: (row) => row.authorName ?? "—" },
    {
      header: "Published",
      className: "w-32",
      cell: (row) => (row.publishedAt ? formatInstant(row.publishedAt) : "—"),
    },
    {
      header: "",
      className: "w-40",
      cell: (row) => (
        <div className="flex justify-end gap-2">
          <Button size="xs" variant="secondary" onClick={() => setReading(row)}>
            Read
          </Button>
          {isAuthor && (
            <>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Edit ${row.title}`}
                onClick={() => setEditing(row)}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Delete ${row.title}`}
                onClick={() => setConfirming(row)}
              >
                <Trash2 className="h-3.5 w-3.5 text-error-600" aria-hidden="true" />
              </Button>
            </>
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
          <label htmlFor="kb-search" className="sr-only">
            Search articles
          </label>
          <Input
            id="kb-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search the knowledge base…"
            className="w-72"
          />
          <Button type="submit" size="sm" variant="secondary">
            <Search className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Search</span>
          </Button>
        </form>

        {isAuthor && (
          <>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={includeDrafts}
                onChange={(e) => {
                  setIncludeDrafts(e.target.checked);
                  setPage(1);
                }}
                className="h-4 w-4 rounded border-slate-300"
              />
              Show drafts
            </label>
            <Button className="ml-auto" onClick={() => setEditing({})}>
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
              New article
            </Button>
          </>
        )}
      </div>

      <HrmsDataTable
        columns={columns}
        rows={result.data ?? []}
        loading={loading}
        error={error}
        onRetry={load}
        page={page}
        pageSize={PAGE_SIZE}
        total={result.total ?? 0}
        onPageChange={setPage}
        emptyTitle={applied ? "Nothing matched" : "No articles yet"}
        emptyDescription={
          applied
            ? "Try a different word, or raise a ticket instead."
            : "Answers to common questions will appear here."
        }
      />

      {editing && (
        <ArticleDrawer
          article={editing}
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
        title={confirming ? `Delete "${confirming.title}"?` : ""}
        description="It stops appearing in the knowledge base immediately."
        confirmText="Delete"
        variant="danger"
      />
    </div>
  );
}

function ArticleDrawer({ article, onClose, onSaved }) {
  const isEdit = Boolean(article?.id);
  const [form, setForm] = useState({
    title: article?.title ?? "",
    body: article?.body ?? "",
    tags: (article?.searchTags ?? []).join(", "),
    published: article?.published ?? false,
  });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const submit = async (event) => {
    event.preventDefault();
    const payload = {
      title: form.title.trim(),
      body: form.body.trim(),
      searchTags: form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      published: form.published,
    };

    const parsed = createKbArticleSchema.safeParse(payload);
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) next[issue.path.join(".")] = issue.message;
      setErrors(next);
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        await helpdeskApi.updateArticle(article.id, parsed.data);
        toast.success("Article updated.");
      } else {
        await helpdeskApi.createArticle(parsed.data);
        toast.success(parsed.data.published ? "Article published." : "Draft saved.");
      }
      onSaved?.();
    } catch (err) {
      toast.error(err?.message ?? "That article could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen
      onClose={saving ? () => {} : onClose}
      title={isEdit ? "Edit article" : "New article"}
      maxWidth="max-w-2xl"
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="kb-title" className="mb-1 block text-sm font-medium text-slate-700">
            Title
          </label>
          <Input
            id="kb-title"
            value={form.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="e.g. How to reset your VPN"
            maxLength={200}
          />
          {errors.title && <p className="mt-1 text-xs text-error-600">{errors.title}</p>}
        </div>

        <div>
          <label htmlFor="kb-body" className="mb-1 block text-sm font-medium text-slate-700">
            Article
          </label>
          <textarea
            id="kb-body"
            rows={12}
            maxLength={50_000}
            value={form.body}
            onChange={(e) => set({ body: e.target.value })}
            placeholder="Write the answer as you would explain it to a colleague."
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
          {errors.body && <p className="mt-1 text-xs text-error-600">{errors.body}</p>}
        </div>

        <div>
          <label htmlFor="kb-tags" className="mb-1 block text-sm font-medium text-slate-700">
            Tags <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <Input
            id="kb-tags"
            value={form.tags}
            onChange={(e) => set({ tags: e.target.value })}
            placeholder="vpn, network, remote"
          />
          <p className="mt-1 text-xs text-slate-500">Comma separated, and searchable.</p>
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.published}
            onChange={(e) => set({ published: e.target.checked })}
            className="mt-0.5 h-4 w-4 rounded border-slate-300"
          />
          <span>
            Published
            <span className="block text-xs text-slate-500">
              Unpublished articles are visible only to resolver teams.
            </span>
          </span>
        </label>

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

export default KbTab;
