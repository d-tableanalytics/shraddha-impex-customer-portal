import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { TabNav } from "../../../components/hrms/TabNav";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Modal } from "../../../components/ui/Modal";
import { Input } from "../../../components/ui/Input";
import { Pagination } from "../../../components/ui/Pagination";
import { employeesApi } from "../../../services/hrms";
import {
  reviewsApi,
  cyclesApi,
  formatPerfDay,
  formatRating,
} from "../../../services/hrms/performance";
import { createReviewSchema, submitReviewSchema } from "@shared/schemas/performance.js";
import {
  REVIEW_KINDS,
  REVIEW_KIND_LABELS,
  RATING_MIN,
  RATING_MAX,
  RESPONSE_OPEN_PHASES,
} from "@shared/constants/performance.js";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";

const KIND_OPTIONS = REVIEW_KINDS.map((value) => ({
  value,
  label: REVIEW_KIND_LABELS[value] ?? value,
}));

/**
 * Reviews.
 *
 * The reference's Reviews tab is the queue of reviews assigned to ME, with a
 * "Fill in" button per row and a modal that renders one 1–5 input per
 * competency. That is reproduced exactly.
 *
 * 🔴 A second sub-tab is added: "About me". The reference collects self,
 * manager and peer reviews and has no endpoint that shows any of them to their
 * subject — the person the whole exercise is about never sees a word of it.
 */
export function ReviewsTab({ canAssign = false, isHr = false }) {
  const [sub, setSub] = useState("mine");

  const tabs = useMemo(
    () => [
      { key: "mine", label: "Assigned to me" },
      { key: "about-me", label: "About me" },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      <TabNav tabs={tabs} activeKey={sub} onChange={setSub} />
      {sub === "mine" ? <MyReviews canAssign={canAssign} isHr={isHr} /> : <ReviewsAboutMe />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assigned to me
// ---------------------------------------------------------------------------

function MyReviews({ canAssign, isHr }) {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [cycles, setCycles] = useState([]);
  const [filling, setFilling] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult((await reviewsApi.mine({ page, pageSize: 25 })) ?? { data: [], total: 0 });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
    // The competency template lives on the cycle, and the fill-in modal needs
    // it to know what to ask for.
    cyclesApi
      .list({ page: 1, pageSize: 100 })
      .then((res) => setCycles(res?.data ?? []))
      .catch(() => setCycles([]));
  }, [load]);

  const columns = useMemo(
    () => [
      {
        header: "Cycle",
        className: `${CELL} font-semibold text-slate-900`,
        headerClassName: HEAD,
        cell: (row) => row.cycleName ?? "—",
      },
      {
        header: "Employee",
        className: `${CELL} text-sm text-slate-700`,
        headerClassName: HEAD,
        cell: (row) => row.employeeName ?? "—",
      },
      {
        header: "Kind",
        className: `${CELL} w-[120px]`,
        headerClassName: HEAD,
        cell: (row) => <Badge variant="neutral">{REVIEW_KIND_LABELS[row.kind] ?? row.kind}</Badge>,
      },
      {
        header: "Status",
        className: `${CELL} w-[160px]`,
        headerClassName: HEAD,
        cell: (row) =>
          row.submittedAt ? (
            <Badge variant="success">
              Submitted {formatPerfDay(row.submittedAt.slice(0, 10))}
            </Badge>
          ) : (
            <Badge variant="warning">Pending</Badge>
          ),
      },
      {
        header: "Overall",
        className: `${CELL} w-[90px] text-right tabular-nums`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => formatRating(row.overallRating),
      },
      {
        header: "",
        className: `${CELL} w-[120px]`,
        headerClassName: HEAD,
        cell: (row) =>
          row.submittedAt ? null : (
            <Button
              size="xs"
              variant="primary"
              onClick={() =>
                setFilling({
                  review: row,
                  competencies:
                    cycles.find((c) => c.id === row.cycleId)?.competencies ?? [],
                })
              }
            >
              Fill in
            </Button>
          ),
      },
    ],
    [cycles],
  );

  return (
    <>
      {canAssign && (
        <div className="flex justify-end">
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            <Plus size={14} className="mr-1.5" />
            Start review
          </Button>
        </div>
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
        emptyTitle="No reviews assigned to you"
        emptyDescription="When a cycle opens and somebody puts you on a review, it appears here."
      />

      <StartReviewDrawer
        open={creating}
        isHr={isHr}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          load();
        }}
      />

      <FillReviewModal
        target={filling}
        onClose={() => setFilling(null)}
        onDone={() => {
          setFilling(null);
          load();
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// About me
// ---------------------------------------------------------------------------

/**
 * The reviews written about the caller.
 *
 * Submitted only, and only once the cycle reaches calibration — the server
 * decides both. A peer or skip-level reviewer is not named.
 */
function ReviewsAboutMe() {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult((await reviewsApi.aboutMe({ page, pageSize: 25 })) ?? { data: [], total: 0 });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-col gap-3">
      {result.data.length === 0 && !loading && !error ? null : (
        <p className="text-[11px] text-slate-500">
          Reviews become visible once their cycle reaches calibration. Peer and skip-level
          reviewers are not named.
        </p>
      )}

      {loading || error || result.data.length === 0 ? (
        <HrmsDataTable
          columns={[{ header: "Cycle", className: CELL, headerClassName: HEAD, cell: () => null }]}
          rows={[]}
          loading={loading}
          error={error}
          onRetry={load}
          page={1}
          pageSize={25}
          total={0}
          emptyTitle="Nothing to read yet"
          emptyDescription="Once a cycle reaches calibration, the reviews written about you appear here."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {result.data.map((row) => (
            <article
              key={row.id}
              className="p-4 bg-white border border-slate-200 rounded-xl shadow-enterprise"
            >
              <header className="flex flex-wrap items-center gap-2">
                <Badge variant="neutral">{REVIEW_KIND_LABELS[row.kind] ?? row.kind}</Badge>
                <span className="text-sm font-semibold text-slate-900">
                  {row.reviewerName ?? "A reviewer"}
                </span>
                <span className="text-[11px] text-slate-500">{row.cycleName}</span>
                <span className="ml-auto text-sm font-bold text-slate-900 tabular-nums">
                  {formatRating(row.overallRating)}
                </span>
              </header>

              {Object.keys(row.ratings ?? {}).length > 0 && (
                <p className="mt-2 text-xs text-slate-600 tabular-nums">
                  {Object.entries(row.ratings)
                    .map(([k, v]) => `${k}: ${v}/${RATING_MAX}`)
                    .join(" · ")}
                </p>
              )}

              {row.comments && (
                <p className="mt-2 text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {row.comments}
                </p>
              )}
            </article>
          ))}
        </div>
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
  );
}

// ---------------------------------------------------------------------------
// Start a review
// ---------------------------------------------------------------------------

function StartReviewDrawer({ open, isHr, onClose, onCreated }) {
  const [cycles, setCycles] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [values, setValues] = useState({
    cycleId: null,
    employeeId: null,
    kind: null,
    reviewerEmployeeId: null,
  });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({ cycleId: null, employeeId: null, kind: null, reviewerEmployeeId: null });
    setErrors({});
    setFailure(null);

    Promise.all([
      cyclesApi.list({ page: 1, pageSize: 100 }),
      employeesApi.list({ page: 1, pageSize: 200 }),
    ])
      .then(([c, e]) => {
        // Only a cycle that actually accepts reviews; the server refuses the rest.
        setCycles((c?.data ?? []).filter((x) => RESPONSE_OPEN_PHASES.includes(x.phase)));
        setEmployees(e?.data ?? []);
      })
      .catch(() => setFailure("The cycle or employee list could not be loaded."));
  }, [open]);

  /** Peer and skip-level need an explicit reviewer; self and manager derive theirs. */
  const needsReviewer = values.kind === "peer" || values.kind === "skip_level";

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const parsed = createReviewSchema.safeParse({
      cycleId: values.cycleId,
      employeeId: values.employeeId,
      kind: values.kind,
      reviewerEmployeeId: needsReviewer ? values.reviewerEmployeeId : undefined,
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
      await reviewsApi.create(parsed.data);
      onCreated();
    } catch (err) {
      setFailure(err?.message ?? "That review could not be opened.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const employeeOptions = employees.map((e) => ({
    value: e.id,
    label: `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim(),
    hint: e.employeeCode,
  }));

  return (
    <Drawer isOpen onClose={onClose} title="Start a review" maxWidth="max-w-lg">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <SearchableSelect
          label="Cycle"
          value={values.cycleId}
          onChange={(v) => {
            setValues((prev) => ({ ...prev, cycleId: v }));
            setErrors((e) => ({ ...e, cycleId: undefined }));
          }}
          options={cycles.map((c) => ({ value: c.id, label: c.name, hint: c.phase }))}
          placeholder="A cycle that is accepting reviews"
          error={errors.cycleId}
        />

        <SearchableSelect
          label="Employee"
          value={values.employeeId}
          onChange={(v) => {
            setValues((prev) => ({ ...prev, employeeId: v }));
            setErrors((e) => ({ ...e, employeeId: undefined }));
          }}
          options={employeeOptions}
          placeholder="Who is being reviewed"
          error={errors.employeeId}
        />

        <SearchableSelect
          label="Review kind"
          value={values.kind}
          onChange={(v) => {
            setValues((prev) => ({ ...prev, kind: v, reviewerEmployeeId: null }));
            setErrors((e) => ({ ...e, kind: undefined }));
          }}
          options={KIND_OPTIONS}
          allowClear={false}
          placeholder="Choose"
          error={errors.kind}
        />

        {needsReviewer && (
          <SearchableSelect
            label="Reviewer"
            value={values.reviewerEmployeeId}
            onChange={(v) => {
              setValues((prev) => ({ ...prev, reviewerEmployeeId: v }));
              setErrors((e) => ({ ...e, reviewerEmployeeId: undefined }));
            }}
            options={employeeOptions.filter((o) => o.value !== values.employeeId)}
            placeholder="Who should write it"
            error={errors.reviewerEmployeeId}
          />
        )}

        <p className="text-[11px] text-slate-500 leading-relaxed">
          A <strong>self</strong> review can only be opened by the employee themselves, and a{" "}
          <strong>manager</strong> review is assigned to their reporting manager. Peer and
          skip-level reviews go to the colleague you choose
          {isHr ? "" : " — your own reports only"}.
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
            Create
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Fill in
// ---------------------------------------------------------------------------

function FillReviewModal({ target, onClose, onDone }) {
  const [ratings, setRatings] = useState({});
  const [overall, setOverall] = useState("");
  const [comments, setComments] = useState("");
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setRatings({});
    setOverall("");
    setComments("");
    setErrors({});
    setFailure(null);
  }, [target]);

  if (!target) return null;

  const { review, competencies } = target;

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const scored = Object.fromEntries(
      Object.entries(ratings).filter(([, v]) => Number.isFinite(v)),
    );

    const parsed = submitReviewSchema.safeParse({
      ratings: scored,
      overallRating: overall === "" ? undefined : Number(overall),
      comments: comments || undefined,
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
      await reviewsApi.submit(review.id, parsed.data);
      onDone();
    } catch (err) {
      // "Already submitted" and "the cycle no longer accepts reviews" both
      // arrive here as readable rules.
      setFailure(err?.message ?? "That review could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`${REVIEW_KIND_LABELS[review.kind] ?? review.kind} review — ${review.employeeName}`}
      size="lg"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-xs text-slate-500">
          Cycle: <strong className="text-slate-700">{review.cycleName}</strong>
        </p>

        {competencies.length === 0 ? (
          <p className="text-sm text-slate-500">
            This cycle has no competencies configured, so there is nothing to rate.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {competencies.map((c) => (
              <Input
                key={c.key}
                type="number"
                min={RATING_MIN}
                max={RATING_MAX}
                label={`${c.label} (weight ${c.weight})`}
                aria-label={c.label}
                value={ratings[c.key] ?? ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  setRatings((r) => {
                    const next = { ...r };
                    if (raw === "") delete next[c.key];
                    else next[c.key] = Number(raw);
                    return next;
                  });
                  setErrors((x) => ({ ...x, ratings: undefined }));
                }}
              />
            ))}
          </div>
        )}
        {errors.ratings && (
          <span role="alert" className="-mt-2 text-xs text-error-500 font-medium">
            {errors.ratings}
          </span>
        )}

        <Input
          type="number"
          min={RATING_MIN}
          max={RATING_MAX}
          label={`Overall rating (${RATING_MIN}–${RATING_MAX})`}
          aria-label="Overall rating"
          className="w-32"
          value={overall}
          onChange={(e) => {
            setOverall(e.target.value);
            setErrors((x) => ({ ...x, overallRating: undefined }));
          }}
          error={errors.overallRating}
        />

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="review-comments" className="text-xs font-semibold text-slate-700">
            Comments
          </label>
          <textarea
            id="review-comments"
            rows={4}
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            placeholder="Highlights, gaps, growth opportunities"
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none placeholder-slate-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
        </div>

        <p className="text-[11px] text-slate-500">
          A review can be submitted once and cannot be revised afterwards.
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
            Submit
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default ReviewsTab;
