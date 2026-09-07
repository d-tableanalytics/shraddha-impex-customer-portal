import { useCallback, useEffect, useState } from "react";
import { Plus, BarChart3, EyeOff, Check } from "lucide-react";

import { ErrorState } from "../../../components/hrms/ErrorState";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LoadingSpinner } from "../../../components/ui/LoadingSpinner";
import { Pagination } from "../../../components/ui/Pagination";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Modal } from "../../../components/ui/Modal";
import { Input } from "../../../components/ui/Input";
import {
  enpsApi,
  ENPS_BAND_TONES,
  formatEngageInstant,
  formatEnpsScore,
} from "../../../services/hrms/engage";
import { createEnpsSchema, submitEnpsSchema } from "@shared/schemas/engage.js";
import {
  ENPS_QUESTION,
  ENPS_SCORE_MIN,
  ENPS_SCORE_MAX,
  ENPS_BAND_LABELS,
  enpsBandFor,
} from "@shared/constants/engage.js";

const SCORE_POINTS = Array.from(
  { length: ENPS_SCORE_MAX - ENPS_SCORE_MIN + 1 },
  (_, i) => ENPS_SCORE_MIN + i,
);

/**
 * eNPS — the pulse survey.
 *
 * ---------------------------------------------------------------------------
 * This tab exists in the reference and nothing renders it
 * ---------------------------------------------------------------------------
 * `ENpsTab.tsx` is 264 lines of working UI that no file imports; `EngagePage`
 * lists three tabs. Four endpoints, two tables and a scoring algorithm ship
 * with no route to any of them. What follows is that component's own
 * information architecture — the question, the 0–10 strip, the optional
 * comment and HR's statistics — wired up.
 *
 * The survey is genuinely anonymous here: an answer is recorded against the
 * caller so a second one can be refused, and audited WITHOUT them. The
 * reference attaches the acting user to its `enps.respond` audit entry, which
 * makes every "anonymous" score attributable from the trail.
 */
export function ENpsTab({ canManage = false }) {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [answering, setAnswering] = useState(null);
  const [viewingResults, setViewingResults] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult((await enpsApi.list({ page, pageSize: 25 })) ?? { data: [], total: 0 });
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
    <div className="flex flex-col gap-4">
      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            <Plus size={14} className="mr-1.5" />
            Launch eNPS survey
          </Button>
        </div>
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
            title="No eNPS surveys yet"
            description={
              canManage
                ? "Launch one to take the company's temperature."
                : "When HR runs a pulse survey, it appears here."
            }
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {result.data.map((row) => (
            <SurveyRow
              key={row.id}
              survey={row}
              canManage={canManage}
              onAnswer={() => setAnswering(row)}
              onResults={() => setViewingResults(row)}
            />
          ))}

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

      <SurveyDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onLaunched={() => {
          setCreating(false);
          load();
        }}
      />

      <AnswerModal
        survey={answering}
        onClose={() => setAnswering(null)}
        onAnswered={() => {
          setAnswering(null);
          load();
        }}
      />

      <ResultsModal survey={viewingResults} onClose={() => setViewingResults(null)} />
    </div>
  );
}

function SurveyRow({ survey, canManage, onAnswer, onResults }) {
  return (
    <article className="flex items-start justify-between gap-4 p-4 bg-white border border-slate-200 rounded-xl shadow-enterprise">
      <div className="flex flex-col gap-1.5 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="text-sm font-bold text-slate-900">{survey.name}</h4>
          <Badge variant={survey.open ? "success" : "neutral"}>
            {survey.open ? "Open" : "Closed"}
          </Badge>
          <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-slate-500">
            <EyeOff size={11} />
            Anonymous
          </span>
        </div>

        <p className="text-sm text-slate-600">{survey.question ?? ENPS_QUESTION}</p>

        <div className="flex items-center gap-2 flex-wrap text-[11px] text-slate-500">
          <span className="tabular-nums">Closes {formatEngageInstant(survey.closesAt)}</span>
          {canManage && (
            <span>
              • {survey.responseCount} response{survey.responseCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {survey.hasResponded ? (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-success-600">
            <Check size={13} />
            Answered
          </span>
        ) : (
          survey.open && (
            <Button size="xs" variant="primary" onClick={onAnswer}>
              Respond
            </Button>
          )
        )}
        {canManage && (
          <Button size="xs" variant="outline" onClick={onResults}>
            <BarChart3 size={11} className="mr-1" />
            Results
          </Button>
        )}
      </div>
    </article>
  );
}

function AnswerModal({ survey, onClose, onAnswered }) {
  const [score, setScore] = useState(null);
  const [comment, setComment] = useState("");
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setScore(null);
    setComment("");
    setFailure(null);
  }, [survey]);

  if (!survey) return null;

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const parsed = submitEnpsSchema.safeParse({
      score,
      comment: comment || undefined,
    });
    if (!parsed.success) {
      setFailure(parsed.error.issues[0]?.message ?? "Pick a score.");
      return;
    }

    setSubmitting(true);
    try {
      await enpsApi.respond(survey.id, parsed.data);
      onAnswered();
    } catch (err) {
      setFailure(err?.message ?? "That answer could not be recorded.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={survey.name} size="lg">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm font-semibold text-slate-900">{survey.question ?? ENPS_QUESTION}</p>

        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Choose a score from 0 to 10</legend>
          <div className="flex flex-wrap gap-1.5">
            {SCORE_POINTS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={score === n}
                aria-label={`${n} out of 10`}
                onClick={() => setScore(n)}
                className={
                  score === n
                    ? "w-11 h-11 rounded-lg border border-primary-600 bg-primary-600 text-white text-sm font-bold tabular-nums"
                    : "w-11 h-11 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 tabular-nums hover:bg-slate-50"
                }
              >
                {n}
              </button>
            ))}
          </div>
          <div className="flex justify-between text-[11px] text-slate-500">
            <span>{ENPS_SCORE_MIN} — not at all likely</span>
            <span>{ENPS_SCORE_MAX} — extremely likely</span>
          </div>
        </fieldset>

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="enps-comment" className="text-xs font-semibold text-slate-700">
            Anything you would like to add? <span className="font-normal">(optional)</span>
          </label>
          <textarea
            id="enps-comment"
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
        </div>

        <p className="flex gap-2 p-3 text-[11px] text-slate-600 leading-relaxed bg-slate-50 border border-slate-200 rounded-lg">
          <EyeOff size={14} className="shrink-0 mt-0.5 text-slate-500" />
          <span>
            This survey is anonymous. Your answer is stored so you cannot respond twice, and it is
            recorded in the audit trail <strong>without your name and without your score</strong>.
            HR sees the totals and the comments, never who wrote them.
          </span>
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

function ResultsModal({ survey, onClose }) {
  const [results, setResults] = useState(null);
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    if (!survey) return;
    setResults(null);
    setFailure(null);
    enpsApi
      .results(survey.id)
      .then(setResults)
      .catch((err) => setFailure(err?.message ?? "Those results could not be loaded."));
  }, [survey]);

  if (!survey) return null;

  const total = results?.totalResponses ?? 0;

  return (
    <Modal isOpen onClose={onClose} title={`eNPS — ${survey.name}`} size="lg">
      {failure ? (
        <p role="alert" className="text-sm text-error-500 font-medium">
          {failure}
        </p>
      ) : results === null ? (
        <div className="flex items-center justify-center py-10">
          <LoadingSpinner size={24} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="p-5 bg-slate-50 border border-slate-200 rounded-xl text-center">
            <p className="text-4xl font-black text-slate-900 tabular-nums">
              {formatEnpsScore(results.score)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Promoters minus detractors, as a percentage. Runs −100 to +100.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {["promoters", "passives", "detractors"].map((band) => (
              <div
                key={band}
                className="flex flex-col items-center gap-1 p-3 bg-white border border-slate-200 rounded-lg"
              >
                <span className="text-2xl font-black text-slate-900 tabular-nums">
                  {results[band] ?? 0}
                </span>
                <Badge variant={ENPS_BAND_TONES[band] ?? "neutral"}>
                  {ENPS_BAND_LABELS[band] ?? band}
                </Badge>
                <span className="text-[10.5px] text-slate-500 tabular-nums">
                  {band === "promoters"
                    ? `${results.bandBoundaries?.promoterMin ?? 9}–${ENPS_SCORE_MAX}`
                    : band === "passives"
                      ? `${results.bandBoundaries?.passiveMin ?? 7}–${(results.bandBoundaries?.promoterMin ?? 9) - 1}`
                      : `${ENPS_SCORE_MIN}–${(results.bandBoundaries?.passiveMin ?? 7) - 1}`}
                </span>
              </div>
            ))}
          </div>

          <p className="text-xs text-slate-500">
            {total} response{total === 1 ? "" : "s"} · no answer is attributed to anybody.
          </p>

          {results.comments?.length > 0 && (
            <section className="flex flex-col gap-2">
              <h4 className="text-xs font-bold uppercase tracking-wide text-slate-600">
                Comments
              </h4>
              <ul className="flex flex-col gap-2">
                {results.comments.map((c, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg"
                  >
                    <Badge variant={ENPS_BAND_TONES[enpsBandFor(c.score)] ?? "neutral"}>
                      {c.score}
                    </Badge>
                    <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                      {c.comment}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

function SurveyDrawer({ open, onClose, onLaunched }) {
  const [values, setValues] = useState({ name: "", closesAt: "" });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({ name: "", closesAt: "" });
    setErrors({});
    setFailure(null);
  }, [open]);

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const parsed = createEnpsSchema.safeParse({
      name: values.name,
      closesAt: values.closesAt ? new Date(values.closesAt).toISOString() : "",
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
      await enpsApi.create(parsed.data);
      onLaunched();
    } catch (err) {
      setFailure(err?.message ?? "That survey could not be launched.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <Drawer isOpen onClose={onClose} title="Launch eNPS survey" maxWidth="max-w-lg">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Name"
          aria-label="Name"
          placeholder="e.g. Q3 2026 pulse"
          value={values.name}
          onChange={(e) => {
            setValues((v) => ({ ...v, name: e.target.value }));
            setErrors((x) => ({ ...x, name: undefined }));
          }}
          error={errors.name}
          helperText="Only HR sees this — everybody is asked the same question."
        />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="enps-closes" className="text-xs font-semibold text-slate-700">
            Closes
          </label>
          <input
            id="enps-closes"
            type="datetime-local"
            value={values.closesAt}
            onChange={(e) => {
              setValues((v) => ({ ...v, closesAt: e.target.value }));
              setErrors((x) => ({ ...x, closesAt: undefined }));
            }}
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          {errors.closesAt && (
            <span className="text-xs text-error-500 font-medium">{errors.closesAt}</span>
          )}
          <span className="text-xs text-slate-500">Must be in the future.</span>
        </div>

        <p className="p-3 text-[11px] text-slate-600 leading-relaxed bg-slate-50 border border-slate-200 rounded-lg">
          Everybody will be asked: <strong>&ldquo;{ENPS_QUESTION}&rdquo;</strong> on a 0–10 scale.
          The survey opens as soon as you launch it, and answers are anonymous — you will see the
          score, the band counts and the comments, never who said what.
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
            Launch
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default ENpsTab;
