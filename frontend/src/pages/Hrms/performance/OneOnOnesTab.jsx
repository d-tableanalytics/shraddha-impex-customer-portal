import { useCallback, useEffect, useState } from "react";
import { Plus, Check } from "lucide-react";

import { ErrorState } from "../../../components/hrms/ErrorState";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LoadingSpinner } from "../../../components/ui/LoadingSpinner";
import { Pagination } from "../../../components/ui/Pagination";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Input } from "../../../components/ui/Input";
import { DateField } from "../../../components/ui/DateField";
import { employeesApi } from "../../../services/hrms";
import { useHrmsStore } from "../../../store/hrmsStore";
import {
  oneOnOnesApi,
  ONE_ON_ONE_STATUS_TONES,
  formatPerfInstant,
} from "../../../services/hrms/performance";
import { createOneOnOneSchema } from "@shared/schemas/performance.js";
import {
  ONE_ON_ONE_STATUS_LABELS,
  ONE_ON_ONE_MIN_MINUTES,
  ONE_ON_ONE_MAX_MINUTES,
} from "@shared/constants/performance.js";

/**
 * 1:1s — the shared notepad between a manager and a direct report.
 *
 * The reference's card grid: who it is with, a status tag, the scheduled time,
 * the agenda, a notes area, action-item checkboxes with an "add on Enter"
 * input, and Save / Mark done / Cancel.
 *
 * 🔴 Mark done and Cancel are the MANAGER's here. The reference renders them
 * for both participants and its API accepts either, so a report can cancel
 * their own manager's meeting.
 */
export function OneOnOnesTab({ canSchedule = false }) {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [scheduling, setScheduling] = useState(false);
  const [failure, setFailure] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult((await oneOnOnesApi.mine({ page, pageSize: 25 })) ?? { data: [], total: 0 });
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
      {canSchedule && (
        <div className="flex justify-end">
          <Button size="sm" variant="primary" onClick={() => setScheduling(true)}>
            <Plus size={14} className="mr-1.5" />
            Schedule 1:1
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
            title="No 1:1s yet"
            description={
              canSchedule
                ? "Schedule one with a direct report to start a shared set of notes."
                : "When your manager schedules one, it appears here."
            }
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
            {result.data.map((row) => (
              <OneOnOneCard key={row.id} oneOnOne={row} onChanged={load} onFailure={setFailure} />
            ))}
          </div>
          {result.total > (result.pageSize ?? 25) && (
            <Pagination
              page={result.page ?? page}
              pageSize={result.pageSize ?? 25}
              totalItems={result.total ?? 0}
              onPageChange={setPage}
            />
          )}
        </>
      )}

      <ScheduleDrawer
        open={scheduling}
        onClose={() => setScheduling(false)}
        onScheduled={() => {
          setScheduling(false);
          load();
        }}
      />
    </div>
  );
}

function OneOnOneCard({ oneOnOne, onChanged, onFailure }) {
  const [notesText, setNotesText] = useState(
    (oneOnOne.notes ?? []).map((n) => n.text).join("\n"),
  );
  const [actionItems, setActionItems] = useState(oneOnOne.actionItems ?? []);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const isManager = oneOnOne.viewerIsManager;
  const open = oneOnOne.status === "scheduled";

  const save = async () => {
    setBusy(true);
    onFailure(null);
    try {
      await oneOnOnesApi.update(oneOnOne.id, {
        notes: notesText
          .split("\n")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((text) => ({ text, done: false })),
        actionItems,
      });
      await onChanged();
    } catch (err) {
      onFailure(err?.message ?? "Those notes could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status) => {
    setBusy(true);
    onFailure(null);
    try {
      await oneOnOnesApi.update(oneOnOne.id, { status });
      await onChanged();
    } catch (err) {
      onFailure(err?.message ?? "That 1:1 could not be updated.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="flex flex-col bg-white border border-slate-200 rounded-xl shadow-enterprise overflow-hidden">
      <header className="flex items-start justify-between gap-2 px-4 py-3 border-b border-slate-200">
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-bold text-slate-900 truncate">
            with {isManager ? oneOnOne.reportName ?? "—" : oneOnOne.managerName ?? "—"}
          </span>
          <span className="text-[11px] text-slate-500 tabular-nums">
            {formatPerfInstant(oneOnOne.scheduledAt)} · {oneOnOne.durationMinutes} min
          </span>
        </div>
        <Badge variant={ONE_ON_ONE_STATUS_TONES[oneOnOne.status] ?? "neutral"}>
          {ONE_ON_ONE_STATUS_LABELS[oneOnOne.status] ?? oneOnOne.status}
        </Badge>
      </header>

      <div className="flex flex-col gap-3 p-4">
        <section>
          <h4 className="text-xs font-bold uppercase tracking-wide text-slate-600">Agenda</h4>
          {(oneOnOne.agenda ?? []).length === 0 ? (
            <p className="mt-1 text-xs text-slate-400">None</p>
          ) : (
            <ul className="mt-1 list-disc pl-4 text-sm text-slate-700">
              {oneOnOne.agenda.map((a, i) => (
                <li key={i}>{a.text}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-1.5">
          <label
            htmlFor={`notes-${oneOnOne.id}`}
            className="text-xs font-bold uppercase tracking-wide text-slate-600"
          >
            Notes
          </label>
          <textarea
            id={`notes-${oneOnOne.id}`}
            rows={4}
            value={notesText}
            onChange={(e) => setNotesText(e.target.value)}
            disabled={!open}
            placeholder="Talking points, decisions, what was discussed"
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none placeholder-slate-400 disabled:bg-slate-50 disabled:text-slate-500 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          <span className="text-[10.5px] text-slate-500">
            One note per line. Either of you can edit these.
          </span>
        </section>

        <section className="flex flex-col gap-1.5">
          <h4 className="text-xs font-bold uppercase tracking-wide text-slate-600">Action items</h4>
          {actionItems.length === 0 ? (
            <p className="text-xs text-slate-400">None yet</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {actionItems.map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    id={`ai-${oneOnOne.id}-${i}`}
                    checked={item.done}
                    disabled={!open}
                    onChange={(e) =>
                      setActionItems((prev) =>
                        prev.map((p, idx) => (idx === i ? { ...p, done: e.target.checked } : p)),
                      )
                    }
                    className="mt-0.5 w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                  />
                  <label
                    htmlFor={`ai-${oneOnOne.id}-${i}`}
                    className={
                      item.done ? "text-sm text-slate-400 line-through" : "text-sm text-slate-700"
                    }
                  >
                    {item.text}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {open && (
            <input
              type="text"
              aria-label="Add an action item"
              value={draft}
              placeholder="Add an action item, then press Enter"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const text = draft.trim();
                if (!text) return;
                setActionItems((prev) => [...prev, { text, done: false }]);
                setDraft("");
              }}
              className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg shadow-sm outline-none placeholder-slate-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            />
          )}
        </section>

        {open && (
          <div className="flex flex-wrap gap-1.5 pt-1 border-t border-slate-100">
            <Button size="xs" variant="primary" loading={busy} onClick={save}>
              Save
            </Button>
            {/* Resolving is the manager's — see the header. */}
            {isManager && (
              <>
                <Button size="xs" variant="outline" loading={busy} onClick={() => setStatus("completed")}>
                  <Check size={11} className="mr-1" />
                  Mark done
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-error-500"
                  loading={busy}
                  onClick={() => setStatus("cancelled")}
                >
                  Cancel
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function ScheduleDrawer({ open, onClose, onScheduled }) {
  const [reports, setReports] = useState([]);
  /** The caller's own employee id, to narrow the picker to their direct reports. */
  const myEmployeeId = useHrmsStore((s) => s.actor?.employeeId ?? null);
  const [values, setValues] = useState({
    reportEmployeeId: null,
    day: "",
    time: "10:00",
    durationMinutes: 30,
    agendaText: "",
  });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({
      reportEmployeeId: null,
      day: "",
      time: "10:00",
      durationMinutes: 30,
      agendaText: "",
    });
    setErrors({});
    setFailure(null);
    employeesApi
      .list({ page: 1, pageSize: 200 })
      .then((res) =>
        // Direct reports only — the server refuses anyone else, so offering
        // them would only produce a 403 after a click. The reference filters
        // the same way.
        setReports(
          (res?.data ?? []).filter(
            (e) => myEmployeeId && String(e.reportingManagerId ?? "") === String(myEmployeeId),
          ),
        ),
      )
      .catch(() => setFailure("The employee list could not be loaded."));
  }, [open, myEmployeeId]);

  const set = (key) => (event) => {
    setValues((v) => ({ ...v, [key]: event.target.value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    if (!values.day) {
      setErrors((e) => ({ ...e, scheduledAt: "Choose a date." }));
      return;
    }
    // Local wall-clock in, ISO out — the server stores an instant, and a
    // manager types the time the meeting actually starts in their own timezone.
    const scheduled = new Date(`${values.day}T${values.time || "00:00"}`);
    if (Number.isNaN(scheduled.getTime())) {
      setErrors((e) => ({ ...e, scheduledAt: "That is not a valid date and time." }));
      return;
    }

    const parsed = createOneOnOneSchema.safeParse({
      reportEmployeeId: values.reportEmployeeId,
      scheduledAt: scheduled.toISOString(),
      durationMinutes: Number(values.durationMinutes) || 30,
      agenda: values.agendaText
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean)
        .map((text) => ({ text, done: false })),
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
      await oneOnOnesApi.schedule(parsed.data);
      onScheduled();
    } catch (err) {
      // "Only your own direct reports" and "not in the past" arrive here.
      setFailure(err?.message ?? "That 1:1 could not be scheduled.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <Drawer isOpen onClose={onClose} title="Schedule 1:1" maxWidth="max-w-lg">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <SearchableSelect
          label="Direct report"
          value={values.reportEmployeeId}
          onChange={(v) => {
            setValues((prev) => ({ ...prev, reportEmployeeId: v }));
            setErrors((e) => ({ ...e, reportEmployeeId: undefined }));
          }}
          options={reports.map((e) => ({
            value: e.id,
            label: `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim(),
            hint: e.employeeCode,
          }))}
          placeholder={reports.length === 0 ? "You have no direct reports" : "Choose your direct report"}
          error={errors.reportEmployeeId}
        />

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
            <label htmlFor="one-on-one-time" className="text-xs font-semibold text-slate-700">
              Time
            </label>
            <input
              id="one-on-one-time"
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

        <Input
          type="number"
          min={ONE_ON_ONE_MIN_MINUTES}
          max={ONE_ON_ONE_MAX_MINUTES}
          label="Duration (min)"
          aria-label="Duration (min)"
          value={values.durationMinutes}
          onChange={set("durationMinutes")}
          error={errors.durationMinutes}
        />

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="one-on-one-agenda" className="text-xs font-semibold text-slate-700">
            Agenda
          </label>
          <textarea
            id="one-on-one-agenda"
            rows={4}
            value={values.agendaText}
            onChange={set("agendaText")}
            placeholder={"Progress on Q3 goals\nBlockers\nCareer growth"}
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none placeholder-slate-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          <span className="text-xs text-slate-500">One item per line.</span>
        </div>

        <p className="text-[11px] text-slate-500">
          Only your own direct reports can be chosen. Both of you can edit the notes and action
          items afterwards.
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

export default OneOnOnesTab;
