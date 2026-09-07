import { useCallback, useEffect, useState } from "react";
import { Plus, BarChart3, Rocket, EyeOff, Check } from "lucide-react";

import { ErrorState } from "../../../components/hrms/ErrorState";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LoadingSpinner } from "../../../components/ui/LoadingSpinner";
import { Pagination } from "../../../components/ui/Pagination";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Modal } from "../../../components/ui/Modal";
import { Input } from "../../../components/ui/Input";
import {
  pollsApi,
  POLL_KIND_TONES,
  formatEngageInstant,
} from "../../../services/hrms/engage";
import { createPollSchema } from "@shared/schemas/engage.js";
import {
  POLL_KINDS,
  POLL_KIND_LABELS,
  CHOICE_POLL_KINDS,
  POLL_SCALE_MIN,
  POLL_SCALE_MAX,
} from "@shared/constants/engage.js";

const KIND_OPTIONS = POLL_KINDS.map((value) => ({
  value,
  label: POLL_KIND_LABELS[value] ?? value,
}));

const SCALE_POINTS = Array.from(
  { length: POLL_SCALE_MAX - POLL_SCALE_MIN + 1 },
  (_, i) => POLL_SCALE_MIN + i,
);

/**
 * Polls & Surveys.
 *
 * The reference's tab: a "New Poll" button for HR, an **Active Poll** panel
 * with an inline response form whose control varies by kind, and an **All
 * Polls** list with an Active/Closed tag.
 *
 * 🔴 Two of its behaviours are corrected here and both are visible on screen:
 * a scale poll submits a NUMBER (its form sends option keys the server cannot
 * read), and a draft poll has a **Launch** button (its form offers "save as
 * draft" and then has no endpoint that could ever launch one).
 */
export function PollsTab({ canManage = false }) {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [answering, setAnswering] = useState(null);
  const [viewingResults, setViewingResults] = useState(null);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult((await pollsApi.list({ page, pageSize: 25 })) ?? { data: [], total: 0 });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const launch = useCallback(
    async (row) => {
      setBusy(row.id);
      setFailure(null);
      try {
        await pollsApi.launch(row.id);
        await load();
      } catch (err) {
        setFailure(err?.message ?? "That poll could not be launched.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return (
    <div className="flex flex-col gap-4">
      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            <Plus size={14} className="mr-1.5" />
            New poll
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
            title="No polls yet"
            description={
              canManage ? "Ask the company something." : "When HR runs a poll, it appears here."
            }
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {result.data.map((row) => (
            <PollRow
              key={row.id}
              poll={row}
              canManage={canManage}
              busy={busy === row.id}
              onAnswer={() => setAnswering(row)}
              onLaunch={() => launch(row)}
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

      <PollDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          load();
        }}
      />

      <AnswerModal
        poll={answering}
        onClose={() => setAnswering(null)}
        onAnswered={() => {
          setAnswering(null);
          load();
        }}
      />

      <ResultsModal poll={viewingResults} onClose={() => setViewingResults(null)} />
    </div>
  );
}

function PollRow({ poll, canManage, busy, onAnswer, onLaunch, onResults }) {
  const isDraft = !poll.launchedAt;

  return (
    <article className="flex items-start justify-between gap-4 p-4 bg-white border border-slate-200 rounded-xl shadow-enterprise">
      <div className="flex flex-col gap-1.5 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="text-sm font-bold text-slate-900">{poll.question}</h4>
          <Badge variant={POLL_KIND_TONES[poll.kind] ?? "neutral"}>
            {POLL_KIND_LABELS[poll.kind] ?? poll.kind}
          </Badge>
          <Badge variant={isDraft ? "warning" : poll.open ? "success" : "neutral"}>
            {isDraft ? "Draft" : poll.open ? "Active" : "Closed"}
          </Badge>
          {poll.anonymous && (
            <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-slate-500">
              <EyeOff size={11} />
              Anonymous
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap text-[11px] text-slate-500">
          {poll.closesAt && <span className="tabular-nums">Closes {formatEngageInstant(poll.closesAt)}</span>}
          {canManage && (
            <span>
              • {poll.responseCount} response{poll.responseCount === 1 ? "" : "s"}
            </span>
          )}
          {poll.createdByName && <span>• {poll.createdByName}</span>}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {poll.hasResponded ? (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-success-600">
            <Check size={13} />
            Answered
          </span>
        ) : (
          poll.open && (
            <Button size="xs" variant="primary" onClick={onAnswer}>
              Respond
            </Button>
          )
        )}
        {/* 🔴 The launch step the reference has no endpoint for. */}
        {canManage && isDraft && (
          <Button size="xs" variant="outline" loading={busy} onClick={onLaunch}>
            <Rocket size={11} className="mr-1" />
            Launch
          </Button>
        )}
        {canManage && !isDraft && (
          <Button size="xs" variant="outline" onClick={onResults}>
            <BarChart3 size={11} className="mr-1" />
            Results
          </Button>
        )}
      </div>
    </article>
  );
}

/**
 * The response form.
 *
 * One control per kind, matching the reference: radio for single, checkboxes
 * for multi, a 0–10 strip for scale, a textarea for open-ended — and the scale
 * submits a NUMBER, which the reference's own form does not.
 */
function AnswerModal({ poll, onClose, onAnswered }) {
  const [keys, setKeys] = useState([]);
  const [text, setText] = useState("");
  const [scale, setScale] = useState(null);
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setKeys([]);
    setText("");
    setScale(null);
    setFailure(null);
  }, [poll]);

  if (!poll) return null;

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const answer =
      poll.kind === "scale"
        ? { scale }
        : poll.kind === "open_ended"
          ? { text }
          : { keys };

    // Cheap local checks so an obvious mistake does not need a round trip; the
    // server validates the answer against the poll's own kind regardless.
    if (CHOICE_POLL_KINDS.includes(poll.kind) && keys.length === 0) {
      setFailure(poll.kind === "single" ? "Choose an option." : "Choose at least one option.");
      return;
    }
    if (poll.kind === "scale" && scale === null) {
      setFailure("Pick a rating.");
      return;
    }
    if (poll.kind === "open_ended" && !text.trim()) {
      setFailure("Write an answer.");
      return;
    }

    setSubmitting(true);
    try {
      await pollsApi.respond(poll.id, answer);
      onAnswered();
    } catch (err) {
      setFailure(err?.message ?? "That answer could not be recorded.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={poll.question} size="md">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {poll.anonymous && (
          <p className="flex gap-2 p-3 text-[11px] text-slate-600 leading-relaxed bg-slate-50 border border-slate-200 rounded-lg">
            <EyeOff size={14} className="shrink-0 mt-0.5 text-slate-500" />
            <span>
              This poll is anonymous. Your answer is stored so you cannot vote twice, and it is
              recorded in the audit trail <strong>without your name</strong>. Only the totals are
              ever shown.
            </span>
          </p>
        )}

        {poll.kind === "single" && (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Choose one</legend>
            {poll.options.map((o) => (
              <label
                key={o.key}
                className="flex items-center gap-2.5 p-2.5 border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50"
              >
                <input
                  type="radio"
                  name="poll-answer"
                  checked={keys[0] === o.key}
                  onChange={() => setKeys([o.key])}
                  className="w-4 h-4 border-slate-300 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-sm text-slate-800">{o.label}</span>
              </label>
            ))}
          </fieldset>
        )}

        {poll.kind === "multi" && (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Choose any</legend>
            {poll.options.map((o) => (
              <label
                key={o.key}
                className="flex items-center gap-2.5 p-2.5 border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={keys.includes(o.key)}
                  onChange={(e) =>
                    setKeys((prev) =>
                      e.target.checked ? [...prev, o.key] : prev.filter((k) => k !== o.key),
                    )
                  }
                  className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-sm text-slate-800">{o.label}</span>
              </label>
            ))}
          </fieldset>
        )}

        {poll.kind === "scale" && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs font-semibold text-slate-700">
              {POLL_SCALE_MIN} — not at all · {POLL_SCALE_MAX} — extremely
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {SCALE_POINTS.map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={scale === n}
                  onClick={() => setScale(n)}
                  className={
                    scale === n
                      ? "w-10 h-10 rounded-lg border border-primary-600 bg-primary-600 text-white text-sm font-bold tabular-nums"
                      : "w-10 h-10 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 tabular-nums hover:bg-slate-50"
                  }
                >
                  {n}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {poll.kind === "open_ended" && (
          <div className="w-full flex flex-col gap-1.5">
            <label htmlFor="poll-text" className="text-xs font-semibold text-slate-700">
              Your response
            </label>
            <textarea
              id="poll-text"
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            />
          </div>
        )}

        <p className="text-[11px] text-slate-500">You can only answer once.</p>

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

function ResultsModal({ poll, onClose }) {
  const [results, setResults] = useState(null);
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    if (!poll) return;
    setResults(null);
    setFailure(null);
    pollsApi
      .results(poll.id)
      .then(setResults)
      .catch((err) => setFailure(err?.message ?? "Those results could not be loaded."));
  }, [poll]);

  if (!poll) return null;

  const total = results?.totalResponses ?? 0;

  return (
    <Modal isOpen onClose={onClose} title={`Results — ${poll.question}`} size="lg">
      {failure ? (
        <p role="alert" className="text-sm text-error-500 font-medium">
          {failure}
        </p>
      ) : results === null ? (
        <div className="flex items-center justify-center py-10">
          <LoadingSpinner size={24} />
        </div>
      ) : total === 0 ? (
        <p className="text-sm text-slate-500">Nobody has answered yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-slate-500">
            {total} response{total === 1 ? "" : "s"}
            {results.anonymous && " · answers are not attributed to anybody"}
          </p>

          {CHOICE_POLL_KINDS.includes(results.kind) && (
            <ul className="flex flex-col gap-2">
              {results.options.map((o) => {
                const count = results.optionCounts?.[o.key] ?? 0;
                const pct = total === 0 ? 0 : Math.round((count / total) * 100);
                return (
                  <li key={o.key} className="flex flex-col gap-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-800">{o.label}</span>
                      <span className="font-semibold text-slate-900 tabular-nums">
                        {count} · {pct}%
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary-600"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {results.kind === "scale" && (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-center">
              <p className="text-3xl font-black text-slate-900 tabular-nums">
                {results.scaleAverage ?? "—"}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Average of {total} rating{total === 1 ? "" : "s"}, out of {POLL_SCALE_MAX}
              </p>
            </div>
          )}

          {results.kind === "open_ended" && (
            <ul className="flex flex-col gap-2">
              {results.openTexts.map((t, i) => (
                <li
                  key={i}
                  className="p-3 text-sm text-slate-700 leading-relaxed bg-slate-50 border border-slate-200 rounded-lg whitespace-pre-wrap"
                >
                  {t}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

function PollDrawer({ open, onClose, onSaved }) {
  const [values, setValues] = useState({
    question: "",
    kind: "single",
    optionsText: "",
    closesAt: "",
    anonymous: false,
    launchNow: true,
  });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({
      question: "",
      kind: "single",
      optionsText: "",
      closesAt: "",
      anonymous: false,
      launchNow: true,
    });
    setErrors({});
    setFailure(null);
  }, [open]);

  const set = (key) => (event) => {
    setValues((v) => ({ ...v, [key]: event.target.value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const needsOptions = CHOICE_POLL_KINDS.includes(values.kind);

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const options = needsOptions
      ? values.optionsText
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((label, i) => ({ key: `opt_${i}`, label }))
      : [];

    const parsed = createPollSchema.safeParse({
      question: values.question,
      kind: values.kind,
      options,
      closesAt: values.closesAt ? new Date(values.closesAt).toISOString() : undefined,
      anonymous: values.anonymous,
      launchNow: values.launchNow,
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
      await pollsApi.create(parsed.data);
      onSaved();
    } catch (err) {
      setFailure(err?.message ?? "That poll could not be saved.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <Drawer isOpen onClose={onClose} title="New poll" maxWidth="max-w-xl">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Question"
          aria-label="Question"
          placeholder="What do you want to ask?"
          value={values.question}
          onChange={set("question")}
          error={errors.question}
        />

        <SearchableSelect
          label="Poll type"
          value={values.kind}
          onChange={(v) => setValues((prev) => ({ ...prev, kind: v ?? "single" }))}
          options={KIND_OPTIONS}
          allowClear={false}
          error={errors.kind}
        />

        {needsOptions && (
          <div className="w-full flex flex-col gap-1.5">
            <label htmlFor="poll-options" className="text-xs font-semibold text-slate-700">
              Options
            </label>
            <textarea
              id="poll-options"
              rows={4}
              value={values.optionsText}
              onChange={set("optionsText")}
              placeholder={"Option 1\nOption 2\nOption 3"}
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none placeholder-slate-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            />
            <span className="text-xs text-slate-500">One per line, at least two.</span>
            {errors.options && (
              <span className="text-xs text-error-500 font-medium">{errors.options}</span>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="poll-closes" className="text-xs font-semibold text-slate-700">
            Closes (optional)
          </label>
          <input
            id="poll-closes"
            type="datetime-local"
            value={values.closesAt}
            onChange={set("closesAt")}
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          {errors.closesAt && (
            <span className="text-xs text-error-500 font-medium">{errors.closesAt}</span>
          )}
        </div>

        <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 select-none">
          <input
            type="checkbox"
            checked={values.anonymous}
            onChange={(e) => setValues((v) => ({ ...v, anonymous: e.target.checked }))}
            className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
          />
          Anonymous responses
        </label>

        <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 select-none">
          <input
            type="checkbox"
            checked={values.launchNow}
            onChange={(e) => setValues((v) => ({ ...v, launchNow: e.target.checked }))}
            className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
          />
          Launch immediately
        </label>

        <p className="text-[11px] text-slate-500 leading-relaxed">
          {values.anonymous
            ? "Answers are stored so nobody votes twice, and recorded in the audit trail without a name. Only totals are shown."
            : "A saved draft can be launched later from the list."}
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
            {values.launchNow ? "Launch" : "Save draft"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default PollsTab;
