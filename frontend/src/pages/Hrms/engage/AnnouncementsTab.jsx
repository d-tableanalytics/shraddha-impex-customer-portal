import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Send, Trash2, Megaphone } from "lucide-react";

import { ErrorState } from "../../../components/hrms/ErrorState";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LoadingSpinner } from "../../../components/ui/LoadingSpinner";
import { Pagination } from "../../../components/ui/Pagination";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Input } from "../../../components/ui/Input";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { departmentsApi } from "../../../services/hrms";
import {
  announcementsApi,
  ANNOUNCEMENT_STATE_TONES,
  formatEngageDay,
  audienceOf,
} from "../../../services/hrms/engage";
import { createAnnouncementSchema } from "@shared/schemas/engage.js";
import { ANNOUNCEMENT_STATE_LABELS } from "@shared/constants/engage.js";
import { HRMS_ROLE_LIST, HRMS_ROLE_LABELS } from "@shared/permissions/constants.js";

const ROLE_OPTIONS = HRMS_ROLE_LIST.map((value) => ({
  value,
  label: HRMS_ROLE_LABELS[value] ?? value,
}));

/**
 * Announcements — the company news feed.
 *
 * The reference's tab: a "New Announcement" button for HR, then the list split
 * into a **Drafts** section (Publish + Delete) and a **Published** section
 * (Delete), each row showing the title, a two-line body clamp, and either the
 * audience tags or `Published <date> • Expires <date>`.
 *
 * A reader who is not HR sees only what is addressed to them — the server
 * decides that inside the query, so this component renders whatever it is
 * given without a second opinion.
 */
export function AnnouncementsTab({ canManage = false }) {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(
        (await announcementsApi.list({ page, pageSize: 25 })) ?? { data: [], total: 0 },
      );
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const publish = useCallback(
    async (row) => {
      setBusy(row.id);
      setFailure(null);
      try {
        await announcementsApi.publish(row.id);
        await load();
      } catch (err) {
        setFailure(err?.message ?? "That announcement could not be published.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  /** The reference splits the feed the same way, and HR is the only one who sees drafts. */
  const { drafts, live } = useMemo(
    () => ({
      drafts: result.data.filter((a) => a.state === "draft"),
      live: result.data.filter((a) => a.state !== "draft"),
    }),
    [result.data],
  );

  return (
    <div className="flex flex-col gap-4">
      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            <Plus size={14} className="mr-1.5" />
            New announcement
          </Button>
        </div>
      )}

      {failure && (
        <p role="alert" className="text-xs text-error-500 font-medium">
          {failure}
        </p>
      )}

      {error ? (
        <ErrorState
          variant={error.isForbidden ? "forbidden" : "error"}
          description={error.message}
          onRetry={load}
        />
      ) : loading ? (
        <div className="flex items-center justify-center min-h-[30vh]">
          <LoadingSpinner size={32} />
        </div>
      ) : result.data.length === 0 ? (
        <div className="p-6 bg-white border border-slate-200 rounded-xl shadow-enterprise">
          <EmptyState
            title="No announcements yet"
            description={
              canManage
                ? "Write one to tell the company something."
                : "When there is company news, it appears here."
            }
          />
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {drafts.length > 0 && (
            <Section title="Drafts">
              {drafts.map((row) => (
                <AnnouncementRow
                  key={row.id}
                  row={row}
                  canManage={canManage}
                  busy={busy === row.id}
                  onPublish={() => publish(row)}
                  onDelete={() => setDeleting(row)}
                />
              ))}
            </Section>
          )}

          {live.length > 0 && (
            <Section title="Published">
              {live.map((row) => (
                <AnnouncementRow
                  key={row.id}
                  row={row}
                  canManage={canManage}
                  busy={busy === row.id}
                  onDelete={() => setDeleting(row)}
                />
              ))}
            </Section>
          )}

          {result.total > (result.pageSize ?? 25) && (
            <Pagination
              page={result.page ?? page}
              pageSize={result.pageSize ?? 25}
              totalItems={result.total ?? 0}
              onPageChange={setPage}
            />
          )}
        </div>
      )}

      <AnnouncementDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          load();
        }}
      />

      <ConfirmationDialog
        isOpen={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          const row = deleting;
          setDeleting(null);
          if (!row) return;
          setFailure(null);
          try {
            await announcementsApi.remove(row.id);
            await load();
          } catch (err) {
            setFailure(err?.message ?? "That announcement could not be deleted.");
          }
        }}
        title="Delete this announcement?"
        description={
          deleting
            ? `"${deleting.title}" will be removed for everyone. This cannot be undone.`
            : ""
        }
        confirmText="Delete"
        variant="danger"
      />
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">{title}</h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function AnnouncementRow({ row, canManage, busy, onPublish, onDelete }) {
  return (
    <article className="flex items-start justify-between gap-4 p-4 bg-white border border-slate-200 rounded-xl shadow-enterprise">
      <div className="flex flex-col gap-1.5 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Megaphone size={14} className="shrink-0 text-slate-400" />
          <h4 className="text-sm font-bold text-slate-900">{row.title}</h4>
          <Badge variant={ANNOUNCEMENT_STATE_TONES[row.state] ?? "neutral"}>
            {ANNOUNCEMENT_STATE_LABELS[row.state] ?? row.state}
          </Badge>
        </div>

        <p className="text-sm text-slate-600 leading-relaxed line-clamp-2 whitespace-pre-wrap">
          {row.body}
        </p>

        <div className="flex items-center gap-2 flex-wrap text-[11px] text-slate-500">
          {row.state === "draft" ? (
            <Badge variant={row.orgWide ? "primary" : "neutral"} className="text-[10px] px-1.5 py-0">
              {audienceOf(row)}
            </Badge>
          ) : (
            <>
              <span className="tabular-nums">
                Published {formatEngageDay(row.publishedAt?.slice(0, 10))}
              </span>
              {row.expiresAt && (
                <span className="tabular-nums">
                  • Expires {formatEngageDay(row.expiresAt.slice(0, 10))}
                </span>
              )}
              <span>• {audienceOf(row)}</span>
            </>
          )}
          {row.createdByName && <span>• {row.createdByName}</span>}
        </div>
      </div>

      {canManage && (
        <div className="flex shrink-0 gap-1.5">
          {row.state === "draft" && (
            <Button size="xs" variant="primary" loading={busy} onClick={onPublish}>
              <Send size={11} className="mr-1" />
              Publish
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            className="text-error-500"
            aria-label={`Delete ${row.title}`}
            onClick={onDelete}
          >
            <Trash2 size={13} />
          </Button>
        </div>
      )}
    </article>
  );
}

function AnnouncementDrawer({ open, onClose, onSaved }) {
  const [departments, setDepartments] = useState([]);
  const [values, setValues] = useState({ title: "", body: "", expiresAt: "", publishNow: false });
  const [roleKeys, setRoleKeys] = useState([]);
  const [departmentIds, setDepartmentIds] = useState([]);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({ title: "", body: "", expiresAt: "", publishNow: false });
    setRoleKeys([]);
    setDepartmentIds([]);
    setErrors({});
    setFailure(null);
    departmentsApi
      .list()
      .then((res) => setDepartments(res ?? []))
      .catch(() => setFailure("The department list could not be loaded."));
  }, [open]);

  const set = (key) => (event) => {
    setValues((v) => ({ ...v, [key]: event.target.value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    // The SERVER's schema, imported from @shared — the rules the form enforces
    // are literally the rules the API enforces, role keys included.
    const parsed = createAnnouncementSchema.safeParse({
      title: values.title,
      body: values.body,
      publishNow: values.publishNow,
      expiresAt: values.expiresAt ? new Date(values.expiresAt).toISOString() : undefined,
      targetRoleKeys: roleKeys,
      targetDepartmentIds: departmentIds,
    });
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path?.[0];
        if (field && !next[field]) next[field] = issue.message;
      }
      setErrors(next);
      return;
    }

    setSubmitting(true);
    try {
      await announcementsApi.create(parsed.data);
      onSaved();
    } catch (err) {
      setFailure(err?.message ?? "That announcement could not be saved.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const orgWide = roleKeys.length === 0 && departmentIds.length === 0;

  return (
    <Drawer isOpen onClose={onClose} title="New announcement" maxWidth="max-w-xl">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Title"
          aria-label="Title"
          placeholder="e.g. Office closed on Friday"
          value={values.title}
          onChange={set("title")}
          error={errors.title}
        />

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="announcement-body" className="text-xs font-semibold text-slate-700">
            Body
          </label>
          <textarea
            id="announcement-body"
            rows={6}
            value={values.body}
            onChange={set("body")}
            placeholder="Write your announcement…"
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none placeholder-slate-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          {errors.body && (
            <span className="text-xs text-error-500 font-medium">{errors.body}</span>
          )}
        </div>

        <MultiPicker
          label="Target roles"
          placeholder="Add a role"
          options={ROLE_OPTIONS}
          selected={roleKeys}
          onChange={setRoleKeys}
          error={errors.targetRoleKeys}
        />

        <MultiPicker
          label="Target departments"
          placeholder="Add a department"
          options={departments.map((d) => ({ value: d.id, label: `${d.code} · ${d.name}` }))}
          selected={departmentIds}
          onChange={setDepartmentIds}
          error={errors.targetDepartmentIds}
        />

        <p
          className={
            orgWide
              ? "text-[11px] font-semibold text-primary-700"
              : "text-[11px] text-slate-500"
          }
        >
          {orgWide
            ? "Leave both empty and this goes to everyone in the company."
            : "Only people matching a chosen role or department will see this."}
        </p>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="announcement-expires" className="text-xs font-semibold text-slate-700">
            Expires (optional)
          </label>
          <input
            id="announcement-expires"
            type="datetime-local"
            value={values.expiresAt}
            onChange={set("expiresAt")}
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          {errors.expiresAt && (
            <span className="text-xs text-error-500 font-medium">{errors.expiresAt}</span>
          )}
          <span className="text-xs text-slate-500">
            After this it drops out of the feed. Must be in the future.
          </span>
        </div>

        <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 select-none">
          <input
            type="checkbox"
            checked={values.publishNow}
            onChange={(e) => setValues((v) => ({ ...v, publishNow: e.target.checked }))}
            className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
          />
          Publish immediately
        </label>

        {failure && (
          <p role="alert" className="text-xs text-error-500 font-medium">
            {failure}
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            {values.publishNow ? "Publish" : "Save draft"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/**
 * A multi-select built from the single-select primitive.
 *
 * The reference uses AntD's `mode="multiple"`; Shraddha's `SearchableSelect` is
 * single by design, so a chosen value becomes a removable chip and the picker
 * offers what is left. Same interaction, existing primitive.
 */
function MultiPicker({ label, placeholder, options, selected, onChange, error }) {
  const chosen = options.filter((o) => selected.includes(o.value));
  const remaining = options.filter((o) => !selected.includes(o.value));

  return (
    <div className="flex flex-col gap-1.5">
      <SearchableSelect
        label={label}
        value={null}
        onChange={(value) => value && onChange([...selected, value])}
        options={remaining}
        allowClear={false}
        placeholder={placeholder}
        error={error}
      />
      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chosen.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(selected.filter((v) => v !== o.value))}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-50 border border-primary-200 text-[11px] font-semibold text-primary-700 hover:bg-primary-100"
            >
              {o.label}
              <span aria-hidden="true">×</span>
              <span className="sr-only">Remove {o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default AnnouncementsTab;
