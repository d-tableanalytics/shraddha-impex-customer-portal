import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Copy, Check, Sparkles } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Input } from "../../../components/ui/Input";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { requisitionsApi, postingsApi, jdApi } from "../../../services/hrms/hiring";
import { createPostingSchema } from "@shared/schemas/hiring.js";
import { AI_JD_SENIORITIES } from "@shared/constants/hiring.js";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";

const SENIORITY_LABELS = {
  junior: "Junior",
  mid: "Mid",
  senior: "Senior",
  lead: "Lead",
};

/** The public careers URL for a slug, on whatever origin the app is served from. */
const publicUrlFor = (slug) =>
  typeof window === "undefined" ? `/careers/${slug}` : `${window.location.origin}/careers/${slug}`;

/**
 * Postings — the public advert for an approved requisition.
 *
 * A posting is drafted, then published, then closed; publishing is what puts
 * the role on the careers page and moves its requisition to `open`. The
 * advert's text is all that crosses to an anonymous visitor — headcount, budget
 * and the business justification stay on the requisition and never appear in
 * the public DTO.
 */
export function PostingsTab() {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [liveOnly, setLiveOnly] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [closing, setClosing] = useState(null);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);
  const [copied, setCopied] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(
        (await postingsApi.list({
          page,
          pageSize: 25,
          ...(liveOnly ? { published: true } : {}),
        })) ?? { data: [], total: 0 },
      );
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, liveOnly]);

  useEffect(() => {
    load();
  }, [load]);

  const publish = useCallback(
    async (row) => {
      setBusy(row.id);
      setFailure(null);
      try {
        await postingsApi.publish(row.id);
        await load();
      } catch (err) {
        // "Its requisition has not been approved" arrives here, and is the
        // whole reason approval exists.
        setFailure(err?.message ?? "That posting could not be published.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const copyLink = useCallback(async (row) => {
    const url = publicUrlFor(row.publicSlug);
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(row.id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // A denied clipboard is not an error worth a banner; the slug is on
      // screen and can be copied by hand.
      setCopied(null);
    }
  }, []);

  const columns = useMemo(
    () => [
      {
        header: "Role",
        className: CELL + " font-semibold text-slate-900",
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-col">
            <span>{row.requisitionTitle ?? "—"}</span>
            <span className="text-[11px] font-normal text-slate-500 break-all">
              /careers/{row.publicSlug}
            </span>
          </div>
        ),
      },
      {
        header: "Advert",
        className: CELL + " text-xs text-slate-600 max-w-[320px]",
        headerClassName: HEAD,
        cell: (row) => (
          <p className="line-clamp-2 leading-snug">{row.description}</p>
        ),
      },
      {
        header: "Boards",
        className: CELL + " w-[140px]",
        headerClassName: HEAD,
        cell: (row) =>
          row.boardIntegrations?.length ? (
            <div className="flex flex-wrap gap-1">
              {row.boardIntegrations.map((b) => (
                <Badge key={b} variant="neutral" className="text-[10px] px-1.5 py-0">
                  {b}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-slate-400 text-xs">—</span>
          ),
      },
      {
        header: "State",
        className: CELL + " w-[110px]",
        headerClassName: HEAD,
        cell: (row) => (
          <Badge variant={row.isLive ? "success" : row.closedAt ? "neutral" : "warning"}>
            {row.isLive ? "Live" : row.closedAt ? "Closed" : "Draft"}
          </Badge>
        ),
      },
      {
        header: "",
        className: CELL + " w-[230px]",
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-wrap gap-1.5">
            {!row.publishedAt && !row.closedAt && (
              <Button
                size="xs"
                variant="primary"
                loading={busy === row.id}
                onClick={() => publish(row)}
              >
                Publish
              </Button>
            )}
            {row.isLive && (
              <>
                <Button size="xs" variant="outline" onClick={() => copyLink(row)}>
                  {copied === row.id ? (
                    <>
                      <Check size={11} className="mr-1" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy size={11} className="mr-1" />
                      Copy link
                    </>
                  )}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-error-500"
                  onClick={() => setClosing(row)}
                >
                  Close
                </Button>
              </>
            )}
          </div>
        ),
      },
    ],
    [busy, copied, copyLink, publish],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 select-none">
          <input
            type="checkbox"
            checked={liveOnly}
            onChange={(e) => {
              setLiveOnly(e.target.checked);
              setPage(1);
            }}
            className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
          />
          Live adverts only
        </label>
        <Button size="sm" variant="primary" onClick={() => setDrafting(true)}>
          <Plus size={14} className="mr-1.5" />
          Draft a posting
        </Button>
      </div>

      {failure && (
        <p role="alert" className="text-xs text-error-500 font-medium">
          {failure}
        </p>
      )}

      <HrmsDataTable
        columns={columns}
        rows={result.data}
        loading={loading}
        error={error}
        onRetry={load}
        page={result.page ?? page}
        pageSize={result.pageSize ?? 25}
        total={result.total ?? 0}
        onPageChange={setPage}
        emptyTitle="No postings yet"
        emptyDescription="Draft one against an approved requisition to put the role on the careers page."
      />

      <PostingDrawer
        open={drafting}
        onClose={() => setDrafting(false)}
        onSaved={() => {
          setDrafting(false);
          load();
        }}
      />

      <ConfirmationDialog
        isOpen={Boolean(closing)}
        onClose={() => setClosing(null)}
        onConfirm={async () => {
          const row = closing;
          setClosing(null);
          if (!row) return;
          setBusy(row.id);
          setFailure(null);
          try {
            await postingsApi.close(row.id);
            await load();
          } catch (err) {
            setFailure(err?.message ?? "That posting could not be closed.");
          } finally {
            setBusy(null);
          }
        }}
        title="Close this posting?"
        description={
          closing
            ? `"${closing.requisitionTitle}" comes off the careers page immediately and stops accepting applications. Closing cannot be undone — a new posting is the way to advertise again.`
            : ""
        }
        confirmText="Close posting"
        variant="danger"
      />
    </div>
  );
}

function PostingDrawer({ open, onClose, onSaved }) {
  const [requisitions, setRequisitions] = useState([]);
  const [values, setValues] = useState({
    requisitionId: null,
    description: "",
    requirements: "",
    boards: "",
  });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // The drafting aid.
  const [skills, setSkills] = useState("");
  const [seniority, setSeniority] = useState("mid");
  const [drafting, setDrafting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({ requisitionId: null, description: "", requirements: "", boards: "" });
    setErrors({});
    setFailure(null);
    setSkills("");
    setSeniority("mid");
    requisitionsApi
      .list({ page: 1, pageSize: 100 })
      .then((res) =>
        // Only an approved or open requisition can carry an advert; the server
        // refuses the rest, so they are not offered.
        setRequisitions((res?.data ?? []).filter((r) => ["approved", "open"].includes(r.status))),
      )
      .catch(() => setFailure("The requisition list could not be loaded."));
  }, [open]);

  const selected = requisitions.find((r) => r.id === values.requisitionId) ?? null;

  const set = (key) => (event) => {
    setValues((v) => ({ ...v, [key]: event.target.value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const draft = async () => {
    if (!selected) {
      setFailure("Choose a requisition first — the draft is written from its title.");
      return;
    }
    const list = skills
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0) {
      setFailure("List at least one skill for the draft.");
      return;
    }
    setDrafting(true);
    setFailure(null);
    try {
      const result = await jdApi.draft({ title: selected.title, skills: list, seniority });
      setValues((v) => ({
        ...v,
        description: result?.description ?? v.description,
        requirements: result?.requirements ?? v.requirements,
      }));
    } catch (err) {
      setFailure(err?.message ?? "A draft could not be generated.");
    } finally {
      setDrafting(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const dto = {
      requisitionId: values.requisitionId,
      description: values.description,
      requirements: values.requirements,
      boardIntegrations: values.boards
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };

    const parsed = createPostingSchema.safeParse(dto);
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
      await postingsApi.create(parsed.data);
      onSaved();
    } catch (err) {
      setFailure(err?.message ?? "That posting could not be saved.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <Drawer isOpen onClose={onClose} title="Draft a posting" maxWidth="max-w-2xl">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <SearchableSelect
          label="Requisition"
          value={values.requisitionId}
          onChange={(v) => {
            setValues((prev) => ({ ...prev, requisitionId: v }));
            setErrors((e) => ({ ...e, requisitionId: undefined }));
          }}
          options={requisitions.map((r) => ({
            value: r.id,
            label: r.title,
            hint: [r.departmentName, r.locationName].filter(Boolean).join(" · "),
          }))}
          placeholder="An approved requisition"
          error={errors.requisitionId}
        />

        <section className="flex flex-col gap-2 p-3 bg-slate-50 border border-slate-200 rounded-lg">
          <div className="flex items-center gap-1.5">
            <Sparkles size={13} className="text-primary-600" />
            <span className="text-xs font-bold uppercase tracking-wide text-slate-600">
              Start from a template
            </span>
          </div>
          <div className="grid grid-cols-[1fr_140px_auto] gap-2 items-end">
            <Input
              label="Key skills"
              aria-label="Key skills"
              placeholder="React, Node, PostgreSQL"
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
              helperText="Comma-separated"
            />
            <SearchableSelect
              label="Seniority"
              value={seniority}
              onChange={(v) => setSeniority(v ?? "mid")}
              options={AI_JD_SENIORITIES.map((value) => ({
                value,
                label: SENIORITY_LABELS[value] ?? value,
              }))}
              allowClear={false}
            />
            <Button type="button" variant="outline" loading={drafting} onClick={draft}>
              Draft
            </Button>
          </div>
          <p className="text-[11px] text-slate-500">
            Fills the two fields below from a template so there is a starting point rather than a
            blank page. Read it before you publish — it is boilerplate, not a description of this
            role.
          </p>
        </section>

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="posting-description" className="text-xs font-semibold text-slate-700">
            Description
          </label>
          <textarea
            id="posting-description"
            rows={8}
            value={values.description}
            onChange={set("description")}
            placeholder="What the role is, who it works with, what success looks like."
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none placeholder-slate-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          {errors.description && (
            <span className="text-xs text-error-500 font-medium">{errors.description}</span>
          )}
        </div>

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="posting-requirements" className="text-xs font-semibold text-slate-700">
            Requirements
          </label>
          <textarea
            id="posting-requirements"
            rows={6}
            value={values.requirements}
            onChange={set("requirements")}
            placeholder="Experience, skills and anything genuinely non-negotiable."
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none placeholder-slate-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          {errors.requirements && (
            <span className="text-xs text-error-500 font-medium">{errors.requirements}</span>
          )}
        </div>

        <Input
          label="Job boards"
          aria-label="Job boards"
          placeholder="LinkedIn, Naukri"
          value={values.boards}
          onChange={set("boards")}
          error={errors.boardIntegrations}
          helperText="Recorded for your own reference — nothing is posted to these automatically."
        />

        <p className="text-[11px] text-slate-500">
          Saved as a draft. Publishing is a separate step, and is what puts the role on the careers
          page. Only the description and requirements are ever shown publicly.
        </p>

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
            Save draft
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default PostingsTab;
