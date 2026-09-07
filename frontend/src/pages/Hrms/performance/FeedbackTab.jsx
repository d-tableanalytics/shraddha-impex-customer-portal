import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, EyeOff } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { TabNav } from "../../../components/hrms/TabNav";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Input } from "../../../components/ui/Input";
import { employeesApi } from "../../../services/hrms";
import {
  feedbackApi,
  FEEDBACK_KIND_TONES,
  formatPerfDay,
} from "../../../services/hrms/performance";
import { giveFeedbackSchema } from "@shared/schemas/performance.js";
import { FEEDBACK_KINDS, FEEDBACK_KIND_LABELS } from "@shared/constants/performance.js";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";

const KIND_OPTIONS = FEEDBACK_KINDS.map((value) => ({
  value,
  label: FEEDBACK_KIND_LABELS[value] ?? value,
}));

const VISIBILITY_OPTIONS = [
  { value: "visible", label: "Visible (your name is shown)" },
  { value: "anonymous", label: "Anonymous" },
];

/**
 * Continuous feedback — praise and constructive notes.
 *
 * The reference's Feedback tab: a "Give feedback" button above nested
 * Received / Given sub-tabs, each a table of who, kind, visibility, message,
 * tags and when.
 *
 * Anonymity is applied by the SERVER: a recipient sees "Anonymous" and no
 * sender id at all, while the sender always sees their own note in Given. The
 * form says so plainly, because somebody choosing "anonymous" should know
 * exactly what that does and does not hide.
 */
export function FeedbackTab() {
  const [sub, setSub] = useState("received");
  const [giving, setGiving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const tabs = useMemo(
    () => [
      { key: "received", label: "Received" },
      { key: "given", label: "Given" },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <TabNav tabs={tabs} activeKey={sub} onChange={setSub} className="flex-1" />
        <Button size="sm" variant="primary" onClick={() => setGiving(true)}>
          <Plus size={14} className="mr-1.5" />
          Give feedback
        </Button>
      </div>

      <FeedbackList key={`${sub}-${reloadKey}`} direction={sub} />

      <GiveFeedbackDrawer
        open={giving}
        onClose={() => setGiving(false)}
        onSent={() => {
          setGiving(false);
          setReloadKey((k) => k + 1);
        }}
      />
    </div>
  );
}

function FeedbackList({ direction }) {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);

  const received = direction === "received";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const call = received ? feedbackApi.received : feedbackApi.given;
      setResult((await call({ page, pageSize: 25 })) ?? { data: [], total: 0 });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, received]);

  useEffect(() => {
    load();
  }, [load]);

  const columns = useMemo(
    () => [
      {
        header: received ? "From" : "To",
        className: `${CELL} font-semibold text-slate-900 w-[190px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <span className="inline-flex items-center gap-1.5">
            {received && row.anonymous && <EyeOff size={12} className="text-slate-400" />}
            {received ? row.fromName ?? "—" : row.toName ?? "—"}
          </span>
        ),
      },
      {
        header: "Kind",
        className: `${CELL} w-[130px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <Badge variant={FEEDBACK_KIND_TONES[row.kind] ?? "neutral"}>
            {FEEDBACK_KIND_LABELS[row.kind] ?? row.kind}
          </Badge>
        ),
      },
      {
        header: "Message",
        className: `${CELL} text-sm text-slate-700`,
        headerClassName: HEAD,
        cell: (row) => <p className="leading-relaxed whitespace-pre-wrap">{row.message}</p>,
      },
      {
        header: "Tags",
        className: `${CELL} w-[170px]`,
        headerClassName: HEAD,
        cell: (row) =>
          row.tags?.length ? (
            <div className="flex flex-wrap gap-1">
              {row.tags.map((t) => (
                <Badge key={t} variant="neutral" className="text-[10px] px-1.5 py-0">
                  {t}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-slate-400 text-xs">—</span>
          ),
      },
      {
        header: "When",
        className: `${CELL} w-[130px] text-xs text-slate-600 tabular-nums`,
        headerClassName: HEAD,
        cell: (row) => formatPerfDay(row.createdAt?.slice(0, 10)),
      },
    ],
    [received],
  );

  return (
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
      emptyTitle={received ? "No feedback yet" : "You have not given any feedback yet"}
      emptyDescription={
        received
          ? "When a colleague writes to you, it appears here."
          : "Tell a colleague what went well, or what could go better."
      }
    />
  );
}

function GiveFeedbackDrawer({ open, onClose, onSent }) {
  const [employees, setEmployees] = useState([]);
  const [values, setValues] = useState({
    toEmployeeId: null,
    kind: "praise",
    message: "",
    visibility: "visible",
    tagsCsv: "",
  });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({
      toEmployeeId: null,
      kind: "praise",
      message: "",
      visibility: "visible",
      tagsCsv: "",
    });
    setErrors({});
    setFailure(null);
    employeesApi
      .list({ page: 1, pageSize: 200 })
      .then((res) => setEmployees(res?.data ?? []))
      .catch(() => setFailure("The colleague list could not be loaded."));
  }, [open]);

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const parsed = giveFeedbackSchema.safeParse({
      toEmployeeId: values.toEmployeeId,
      kind: values.kind,
      message: values.message,
      visibility: values.visibility,
      tags: values.tagsCsv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
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
      await feedbackApi.give(parsed.data);
      onSent();
    } catch (err) {
      // "You cannot give feedback to yourself" arrives here.
      setFailure(err?.message ?? "That feedback could not be sent.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <Drawer isOpen onClose={onClose} title="Give feedback" maxWidth="max-w-lg">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <SearchableSelect
          label="To"
          value={values.toEmployeeId}
          onChange={(v) => {
            setValues((prev) => ({ ...prev, toEmployeeId: v }));
            setErrors((e) => ({ ...e, toEmployeeId: undefined }));
          }}
          options={employees.map((e) => ({
            value: e.id,
            label: `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim(),
            hint: e.employeeCode,
          }))}
          placeholder="Choose a colleague"
          error={errors.toEmployeeId}
        />

        <div className="grid grid-cols-2 gap-3">
          <SearchableSelect
            label="Kind"
            value={values.kind}
            onChange={(v) => setValues((prev) => ({ ...prev, kind: v ?? "praise" }))}
            options={KIND_OPTIONS}
            allowClear={false}
            error={errors.kind}
          />
          <SearchableSelect
            label="Visibility"
            value={values.visibility}
            onChange={(v) => setValues((prev) => ({ ...prev, visibility: v ?? "visible" }))}
            options={VISIBILITY_OPTIONS}
            allowClear={false}
            error={errors.visibility}
          />
        </div>

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="feedback-message" className="text-xs font-semibold text-slate-700">
            Message
          </label>
          <textarea
            id="feedback-message"
            rows={5}
            value={values.message}
            onChange={(e) => {
              setValues((v) => ({ ...v, message: e.target.value }));
              setErrors((x) => ({ ...x, message: undefined }));
            }}
            placeholder="Be specific — what happened, and what its impact was"
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none placeholder-slate-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          {errors.message && (
            <span className="text-xs text-error-500 font-medium">{errors.message}</span>
          )}
        </div>

        <Input
          label="Tags"
          aria-label="Tags"
          placeholder="ownership, communication"
          value={values.tagsCsv}
          onChange={(e) => setValues((v) => ({ ...v, tagsCsv: e.target.value }))}
          error={errors.tags}
          helperText="Comma-separated, up to ten."
        />

        {values.visibility === "anonymous" && (
          <p className="flex gap-2 p-3 text-[11px] text-slate-600 leading-relaxed bg-slate-50 border border-slate-200 rounded-lg">
            <EyeOff size={14} className="shrink-0 mt-0.5 text-slate-500" />
            <span>
              Your name is hidden from the recipient, and this note will still appear under
              &ldquo;Given&rdquo; for you. It is <strong>not</strong> anonymous to the company: the
              sender is recorded so that abusive feedback can be dealt with.
            </span>
          </p>
        )}

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
            Send
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default FeedbackTab;
