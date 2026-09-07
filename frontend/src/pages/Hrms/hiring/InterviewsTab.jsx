import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, ExternalLink, MessageSquare } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { TabNav } from "../../../components/hrms/TabNav";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Modal } from "../../../components/ui/Modal";
import { Drawer } from "../../../components/ui/Drawer";
import { Input } from "../../../components/ui/Input";
import { DateField } from "../../../components/ui/DateField";
import { LoadingSpinner } from "../../../components/ui/LoadingSpinner";
import { employeesApi } from "../../../services/hrms";
import {
  interviewsApi,
  applicationsApi,
  DECISION_LABELS,
  STAGE_LABELS,
} from "../../../services/hrms/hiring";
import { scheduleInterviewSchema, submitFeedbackSchema } from "@shared/schemas/hiring.js";
import {
  INTERVIEW_DECISIONS,
  FEEDBACK_RATING_MIN,
  FEEDBACK_RATING_MAX,
} from "@shared/constants/hiring.js";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";

const STATUS_TONES = {
  scheduled: "primary",
  completed: "success",
  cancelled: "neutral",
  no_show: "warning",
};

const STATUS_LABELS = {
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No show",
};

/**
 * The three criteria the reference scores on.
 *
 * `ratings` is an open map on the wire — the schema bounds each value to 1–5
 * and requires at least one — so these are the form's criteria, not the API's.
 * Feedback filed by a script with a different key set still validates, and the
 * viewer below renders whatever keys it is given rather than assuming these.
 */
const RATING_CRITERIA = [
  { key: "culture", label: "Culture" },
  { key: "technical", label: "Technical" },
  { key: "communication", label: "Communication" },
];

const DECISION_TONES = {
  strong_hire: "success",
  hire: "success",
  no_hire: "danger",
  strong_no_hire: "danger",
};

const formatWhen = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

/**
 * Interviews.
 *
 * Two sub-tabs, exactly as the reference has them: "Assigned to me" — the
 * panellist's own queue, and the default, because most people who open this
 * screen are here to file a review — and "All interviews", for recruiters.
 *
 * The split matters for more than layout. `/interviews/mine` takes no id: the
 * server scopes it to the caller's own employee record, so a panellist needs no
 * grant beyond having one, and there is nothing in the request to tamper with.
 */
export function InterviewsTab({ canEdit = false }) {
  const [sub, setSub] = useState("mine");

  const tabs = useMemo(() => {
    const items = [{ key: "mine", label: "Assigned to me" }];
    if (canEdit) items.push({ key: "all", label: "All interviews" });
    return items;
  }, [canEdit]);

  return (
    <div className="flex flex-col gap-3">
      {tabs.length > 1 && <TabNav tabs={tabs} activeKey={sub} onChange={setSub} />}
      {sub === "all" && canEdit ? <AllInterviews /> : <MyInterviews />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assigned to me
// ---------------------------------------------------------------------------

function MyInterviews() {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [reviewing, setReviewing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult((await interviewsApi.mine({ page, pageSize: 25 })) ?? { data: [], total: 0 });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const columns = useMemo(
    () => [
      {
        header: "Candidate",
        className: CELL + " font-semibold text-slate-900",
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-col">
            <span>{row.candidateName ?? "—"}</span>
            <span className="text-[11px] font-normal text-slate-500">{row.requisitionTitle}</span>
          </div>
        ),
      },
      {
        header: "Round",
        className: CELL + " w-[80px]",
        headerClassName: HEAD,
        cell: (row) => <Badge variant="neutral">R{row.round}</Badge>,
      },
      {
        header: "When",
        className: CELL + " w-[200px] text-xs text-slate-600 tabular-nums",
        headerClassName: HEAD,
        cell: (row) => (
          <span>
            {formatWhen(row.scheduledAt)}
            <span className="block text-[10.5px] text-slate-400">{row.durationMinutes} min</span>
          </span>
        ),
      },
      {
        header: "Status",
        className: CELL + " w-[110px]",
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-col gap-1">
            <Badge variant={STATUS_TONES[row.status] ?? "neutral"}>
              {STATUS_LABELS[row.status] ?? row.status}
            </Badge>
            {row.awaitingMyFeedback && (
              <span className="text-[10.5px] font-semibold text-warning-600">
                Your review is due
              </span>
            )}
          </div>
        ),
      },
      {
        header: "Panel",
        className: CELL + " text-xs text-slate-600",
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-wrap gap-1">
            {(row.panel ?? []).map((p) => (
              <span
                key={p.employeeId}
                className="px-1.5 py-0.5 rounded-full bg-slate-100 text-[10.5px] font-medium text-slate-600"
              >
                {p.name}
              </span>
            ))}
          </div>
        ),
      },
      {
        header: "",
        className: CELL + " w-[190px]",
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-wrap gap-1.5">
            {row.meetingLink && (
              <a
                href={row.meetingLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100"
              >
                <ExternalLink size={11} />
                Join
              </a>
            )}
            <Button
              size="xs"
              variant="primary"
              // The server refuses feedback on anything but a scheduled
              // interview; a button that always 409s is not a button.
              disabled={row.status !== "scheduled"}
              onClick={() => setReviewing(row)}
            >
              <MessageSquare size={11} className="mr-1" />
              Feedback
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <>
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
        emptyTitle="No interviews assigned to you"
        emptyDescription="When a recruiter puts you on a panel, it appears here."
      />

      <FeedbackDialog
        interview={reviewing}
        onClose={() => setReviewing(null)}
        onDone={() => {
          setReviewing(null);
          load();
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// All interviews
// ---------------------------------------------------------------------------

function AllInterviews() {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [scheduling, setScheduling] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult((await interviewsApi.list({ page, pageSize: 25 })) ?? { data: [], total: 0 });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const setStatus = useCallback(
    async (row, status) => {
      setBusy(row.id);
      setFailure(null);
      try {
        await interviewsApi.setStatus(row.id, status);
        await load();
      } catch (err) {
        setFailure(err?.message ?? "That interview could not be updated.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const columns = useMemo(
    () => [
      {
        header: "Candidate",
        className: CELL + " font-semibold text-slate-900",
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-col">
            <span>{row.candidateName ?? "—"}</span>
            <span className="text-[11px] font-normal text-slate-500">{row.requisitionTitle}</span>
          </div>
        ),
      },
      {
        header: "Round",
        className: CELL + " w-[70px]",
        headerClassName: HEAD,
        cell: (row) => <Badge variant="neutral">R{row.round}</Badge>,
      },
      {
        header: "When",
        className: CELL + " w-[180px] text-xs text-slate-600 tabular-nums",
        headerClassName: HEAD,
        cell: (row) => formatWhen(row.scheduledAt),
      },
      {
        header: "Panel",
        className: CELL + " text-xs text-slate-600",
        headerClassName: HEAD,
        cell: (row) => (row.panel ?? []).map((p) => p.name).join(", ") || "—",
      },
      {
        header: "Feedback",
        className: CELL + " w-[90px] text-right text-xs tabular-nums",
        headerClassName: HEAD + " text-right",
        cell: (row) => (
          <span
            className={
              row.feedbackCount >= (row.panel?.length ?? 0)
                ? "font-semibold text-success-600"
                : "text-slate-600"
            }
          >
            {row.feedbackCount}/{row.panel?.length ?? 0}
          </span>
        ),
      },
      {
        header: "Status",
        className: CELL + " w-[110px]",
        headerClassName: HEAD,
        cell: (row) => (
          <Badge variant={STATUS_TONES[row.status] ?? "neutral"}>
            {STATUS_LABELS[row.status] ?? row.status}
          </Badge>
        ),
      },
      {
        header: "",
        className: CELL + " w-[260px]",
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="xs" variant="outline" onClick={() => setViewing(row)}>
              View feedback
            </Button>
            {/*
              Only a scheduled interview can be resolved, and a resolved one is
              final — the server's transition table, mirrored here so the
              control disappears rather than failing.
            */}
            {row.status === "scheduled" && (
              <SearchableSelect
                className="w-[128px]"
                value={null}
                onChange={(value) => value && setStatus(row, value)}
                options={[
                  { value: "completed", label: "Completed" },
                  { value: "cancelled", label: "Cancelled" },
                  { value: "no_show", label: "No show" },
                ]}
                allowClear={false}
                loading={busy === row.id}
                placeholder="Set status"
              />
            )}
          </div>
        ),
      },
    ],
    [busy, setStatus],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button size="sm" variant="primary" onClick={() => setScheduling(true)}>
          <Plus size={14} className="mr-1.5" />
          Schedule interview
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
        emptyTitle="No interviews scheduled"
        emptyDescription="Schedule one from an application in the pipeline."
      />

      <ScheduleDrawer
        open={scheduling}
        onClose={() => setScheduling(false)}
        onDone={() => {
          setScheduling(false);
          load();
        }}
      />

      <FeedbackViewer interview={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

function ScheduleDrawer({ open, onClose, onDone }) {
  const [applications, setApplications] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [values, setValues] = useState({
    applicationId: null,
    round: 1,
    durationMinutes: 45,
    day: "",
    time: "10:00",
    meetingLink: "",
  });
  const [panel, setPanel] = useState([]);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({
      applicationId: null,
      round: 1,
      durationMinutes: 45,
      day: "",
      time: "10:00",
      meetingLink: "",
    });
    setPanel([]);
    setErrors({});
    setFailure(null);

    Promise.all([
      applicationsApi.list({ page: 1, pageSize: 200 }),
      employeesApi.list({ page: 1, pageSize: 200 }),
    ])
      .then(([apps, emps]) => {
        // A closed application cannot take another round; offering it would
        // only produce a 409.
        setApplications(
          (apps?.data ?? []).filter((a) => !["hired", "rejected"].includes(a.stage)),
        );
        setEmployees(emps?.data ?? []);
      })
      .catch(() => setFailure("The application or employee list could not be loaded."));
  }, [open]);

  const set = (key) => (event) => {
    setValues((v) => ({ ...v, [key]: event.target.value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const addPanellist = (employeeId) => {
    if (!employeeId || panel.includes(employeeId)) return;
    setPanel((p) => [...p, employeeId]);
    setErrors((e) => ({ ...e, panelEmployeeIds: undefined }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    if (!values.day) {
      setErrors((e) => ({ ...e, scheduledAt: "Choose a date." }));
      return;
    }
    // Local wall-clock in, ISO out — the server stores an instant, and a
    // recruiter types the time the interview actually starts in their own
    // timezone.
    const scheduled = new Date(`${values.day}T${values.time || "00:00"}`);
    if (Number.isNaN(scheduled.getTime())) {
      setErrors((e) => ({ ...e, scheduledAt: "That is not a valid date and time." }));
      return;
    }

    const dto = {
      applicationId: values.applicationId,
      round: Number(values.round) || 1,
      panelEmployeeIds: panel,
      scheduledAt: scheduled.toISOString(),
      durationMinutes: Number(values.durationMinutes) || 45,
      meetingLink: values.meetingLink || undefined,
    };

    const parsed = scheduleInterviewSchema.safeParse(dto);
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
      await interviewsApi.schedule(parsed.data);
      onDone();
    } catch (err) {
      // "In the past", "round already scheduled" and "application closed" all
      // arrive here as readable rules.
      setFailure(err?.message ?? "That interview could not be scheduled.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const employeeName = (id) => {
    const e = employees.find((x) => x.id === id);
    return e ? `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim() : id;
  };

  return (
    <Drawer isOpen onClose={onClose} title="Schedule interview" maxWidth="max-w-xl">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <SearchableSelect
          label="Application"
          value={values.applicationId}
          onChange={(v) => {
            setValues((prev) => ({ ...prev, applicationId: v }));
            setErrors((e) => ({ ...e, applicationId: undefined }));
          }}
          options={applications.map((a) => ({
            value: a.id,
            label: `${a.candidateName} — ${a.requisitionTitle}`,
            hint: STAGE_LABELS[a.stage] ?? a.stage,
          }))}
          placeholder="Choose an application"
          error={errors.applicationId}
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            type="number"
            min={1}
            max={10}
            label="Round"
            aria-label="Round"
            value={values.round}
            onChange={set("round")}
            error={errors.round}
          />
          <Input
            type="number"
            min={15}
            max={300}
            label="Duration (min)"
            aria-label="Duration (min)"
            value={values.durationMinutes}
            onChange={set("durationMinutes")}
            error={errors.durationMinutes}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-700">Date</label>
            <DateField
              value={values.day}
              onChange={(day) => {
                setValues((v) => ({ ...v, day }));
                setErrors((e) => ({ ...e, scheduledAt: undefined }));
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="interview-time" className="text-xs font-semibold text-slate-700">
              Time
            </label>
            <input
              id="interview-time"
              type="time"
              value={values.time}
              onChange={set("time")}
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            />
          </div>
        </div>
        {errors.scheduledAt && (
          <span className="-mt-2 text-xs text-error-500 font-medium">{errors.scheduledAt}</span>
        )}

        <div className="flex flex-col gap-1.5">
          <SearchableSelect
            label="Panel"
            value={null}
            onChange={addPanellist}
            options={employees
              .filter((e) => !panel.includes(e.id))
              .map((e) => ({
                value: e.id,
                label: `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim(),
                hint: e.employeeCode,
              }))}
            allowClear={false}
            placeholder="Add a panellist"
            error={errors.panelEmployeeIds}
          />
          {panel.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {panel.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setPanel((p) => p.filter((x) => x !== id))}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-50 border border-primary-200 text-[11px] font-semibold text-primary-700 hover:bg-primary-100"
                >
                  {employeeName(id)}
                  <span aria-hidden="true">×</span>
                  <span className="sr-only">Remove {employeeName(id)}</span>
                </button>
              ))}
            </div>
          )}
          <span className="text-xs text-slate-500">
            Panellists are employees, not user accounts — somebody without a login can still sit on
            a panel, and only these people can file feedback.
          </span>
        </div>

        <Input
          label="Meeting link"
          aria-label="Meeting link"
          placeholder="https://meet.google.com/…"
          value={values.meetingLink}
          onChange={set("meetingLink")}
          error={errors.meetingLink}
        />

        <p className="text-[11px] text-slate-500">
          Scheduling moves the application to <strong>{STAGE_LABELS.interview}</strong> if it is not
          there already.
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
            Schedule
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

function FeedbackDialog({ interview, onClose, onDone }) {
  const [ratings, setRatings] = useState({});
  const [comments, setComments] = useState("");
  const [decision, setDecision] = useState(null);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setRatings({});
    setComments("");
    setDecision(null);
    setErrors({});
    setFailure(null);
  }, [interview]);

  if (!interview) return null;

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const scored = Object.fromEntries(
      Object.entries(ratings).filter(([, v]) => Number.isFinite(v)),
    );

    const parsed = submitFeedbackSchema.safeParse({
      ratings: scored,
      comments: comments || undefined,
      decision,
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
      await interviewsApi.submitFeedback(interview.id, parsed.data);
      onDone();
    } catch (err) {
      // The server refuses anyone not on this panel, and refuses a second
      // review from the same person.
      setFailure(err?.message ?? "That feedback could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Feedback — ${interview.candidateName ?? "candidate"}, round ${interview.round}`}
      size="md"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-3">
          {RATING_CRITERIA.map((criterion) => (
            <Input
              key={criterion.key}
              type="number"
              min={FEEDBACK_RATING_MIN}
              max={FEEDBACK_RATING_MAX}
              label={criterion.label}
              aria-label={criterion.label}
              value={ratings[criterion.key] ?? ""}
              onChange={(e) => {
                const raw = e.target.value;
                setRatings((r) => {
                  const next = { ...r };
                  if (raw === "") delete next[criterion.key];
                  else next[criterion.key] = Number(raw);
                  return next;
                });
                setErrors((e2) => ({ ...e2, ratings: undefined }));
              }}
            />
          ))}
        </div>
        <span className="-mt-2 text-xs text-slate-500">
          {FEEDBACK_RATING_MIN}–{FEEDBACK_RATING_MAX}. Score at least one.
        </span>
        {errors.ratings && (
          <span className="-mt-3 text-xs text-error-500 font-medium">{errors.ratings}</span>
        )}

        <SearchableSelect
          label="Overall decision"
          value={decision}
          onChange={(v) => {
            setDecision(v);
            setErrors((e) => ({ ...e, decision: undefined }));
          }}
          options={INTERVIEW_DECISIONS.map((value) => ({
            value,
            label: DECISION_LABELS[value] ?? value,
          }))}
          allowClear={false}
          placeholder="Choose"
          error={errors.decision}
        />

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="feedback-comments" className="text-xs font-semibold text-slate-700">
            Comments
          </label>
          <textarea
            id="feedback-comments"
            rows={4}
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            placeholder="Signal, gaps, follow-ups"
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none placeholder-slate-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
        </div>

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
            Submit feedback
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function FeedbackViewer({ interview, onClose }) {
  const [rows, setRows] = useState(null);
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    if (!interview) return;
    setRows(null);
    setFailure(null);
    interviewsApi
      .feedback(interview.id)
      .then((data) => setRows(data ?? []))
      .catch((err) => setFailure(err?.message ?? "That feedback could not be loaded."));
  }, [interview]);

  if (!interview) return null;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Panel feedback — ${interview.candidateName ?? "candidate"}`}
      size="lg"
    >
      {failure ? (
        <p role="alert" className="text-sm text-error-500 font-medium">
          {failure}
        </p>
      ) : rows === null ? (
        <div className="flex items-center justify-center py-10">
          <LoadingSpinner size={24} />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">No feedback submitted yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <article
              key={row.id}
              className="flex flex-col gap-1.5 p-3 border border-slate-200 rounded-lg"
            >
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm text-slate-900">
                  {row.interviewerName ?? "Panellist"}
                </strong>
                <Badge variant={DECISION_TONES[row.decision] ?? "neutral"}>
                  {DECISION_LABELS[row.decision] ?? row.decision}
                </Badge>
                <span className="text-[11px] text-slate-500 tabular-nums">
                  {formatWhen(row.submittedAt)}
                </span>
              </div>

              {Object.keys(row.ratings ?? {}).length > 0 && (
                <p className="text-xs text-slate-600 tabular-nums">
                  {Object.entries(row.ratings)
                    .map(([k, v]) => `${k}: ${v}/${FEEDBACK_RATING_MAX}`)
                    .join(" · ")}
                </p>
              )}

              {row.comments && (
                <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
                  {row.comments}
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default InterviewsTab;
