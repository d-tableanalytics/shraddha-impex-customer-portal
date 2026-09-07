import { useCallback, useEffect, useMemo, useState } from "react";
import { Star, Award, EyeOff, Lock } from "lucide-react";

import { ErrorState } from "../../../components/hrms/ErrorState";
import { TabNav } from "../../../components/hrms/TabNav";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LoadingSpinner } from "../../../components/ui/LoadingSpinner";
import { Pagination } from "../../../components/ui/Pagination";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Input } from "../../../components/ui/Input";
import { employeesApi } from "../../../services/hrms";
import { useHrmsStore } from "../../../store/hrmsStore";
import { recognitionApi, formatEngageDay } from "../../../services/hrms/engage";
import { giveRecognitionSchema, createBadgeSchema } from "@shared/schemas/engage.js";
import { SUGGESTED_BADGES } from "@shared/constants/engage.js";

/**
 * Recognition — peer kudos, with optional badges.
 *
 * The reference's tab: a "Give Recognition" button for everyone and "Manage
 * Badges" for HR, then a **Recognition Wall** and a **You Received** list, each
 * row showing the badge icon, the recipient, the message and `From <name>` or
 * `From Anonymous`.
 *
 * Giving kudos is `engage:view:self` — peer-to-peer, not an HR act. Only the
 * badge catalogue belongs to HR.
 */
export function RecognitionTab({ canManage = false }) {
  const [sub, setSub] = useState("wall");
  const [giving, setGiving] = useState(false);
  const [managingBadges, setManagingBadges] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const tabs = useMemo(
    () => [
      { key: "wall", label: "Wall" },
      { key: "received", label: "You received" },
      { key: "given", label: "You gave" },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <TabNav tabs={tabs} activeKey={sub} onChange={setSub} className="flex-1" />
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="primary" onClick={() => setGiving(true)}>
            <Star size={14} className="mr-1.5" />
            Give recognition
          </Button>
          {canManage && (
            <Button size="sm" variant="outline" onClick={() => setManagingBadges(true)}>
              <Award size={14} className="mr-1.5" />
              Badges
            </Button>
          )}
        </div>
      </div>

      <RecognitionList key={`${sub}-${reloadKey}`} view={sub} />

      <GiveRecognitionDrawer
        open={giving}
        onClose={() => setGiving(false)}
        onGiven={() => {
          setGiving(false);
          setReloadKey((k) => k + 1);
        }}
      />

      <BadgesDrawer open={managingBadges} onClose={() => setManagingBadges(false)} />
    </div>
  );
}

function RecognitionList({ view }) {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const call =
        view === "wall"
          ? recognitionApi.wall
          : view === "received"
            ? recognitionApi.received
            : recognitionApi.given;
      setResult((await call({ page, pageSize: 25 })) ?? { data: [], total: 0 });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, view]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <ErrorState
        variant={error.isForbidden ? "forbidden" : "error"}
        description={error.message}
        onRetry={load}
      />
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[30vh]">
        <LoadingSpinner size={32} />
      </div>
    );
  }

  if (result.data.length === 0) {
    return (
      <div className="p-6 bg-white border border-slate-200 rounded-xl shadow-enterprise">
        <EmptyState
          title={
            view === "wall"
              ? "No recognition yet"
              : view === "received"
                ? "Nothing yet"
                : "You have not given any kudos yet"
          }
          description={
            view === "given"
              ? "Tell a colleague what they did well."
              : "Start giving kudos — they show up here."
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {result.data.map((row) => (
        <RecognitionCard key={row.id} recognition={row} view={view} />
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
  );
}

function RecognitionCard({ recognition, view }) {
  return (
    <article className="flex items-start gap-3 p-4 bg-white border border-slate-200 rounded-xl shadow-enterprise">
      <span
        aria-hidden="true"
        className="shrink-0 flex items-center justify-center w-9 h-9 rounded-full bg-slate-50 border border-slate-200 text-lg"
      >
        {recognition.badgeIconKey || "⭐"}
      </span>

      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-slate-900">{recognition.toName}</span>
          {recognition.badgeName && (
            <Badge variant="primary" className="text-[10px] px-1.5 py-0">
              {recognition.badgeName}
            </Badge>
          )}
          {!recognition.teamVisible && (
            <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-slate-500">
              <Lock size={11} />
              Private
            </span>
          )}
        </div>

        <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
          {recognition.message}
        </p>

        <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-slate-500">
          {view !== "given" && (
            <span className="inline-flex items-center gap-1">
              {recognition.anonymous && <EyeOff size={11} />}
              From {recognition.fromName ?? "Unknown"}
            </span>
          )}
          <span className="tabular-nums">
            {view !== "given" && "• "}
            {formatEngageDay(recognition.createdAt?.slice(0, 10))}
          </span>
        </div>
      </div>
    </article>
  );
}

function GiveRecognitionDrawer({ open, onClose, onGiven }) {
  const [colleagues, setColleagues] = useState([]);
  const [badges, setBadges] = useState([]);
  const myEmployeeId = useHrmsStore((s) => s.actor?.employeeId ?? null);
  const [values, setValues] = useState({
    toEmployeeId: null,
    badgeId: null,
    message: "",
    teamVisible: true,
    anonymous: false,
  });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({
      toEmployeeId: null,
      badgeId: null,
      message: "",
      teamVisible: true,
      anonymous: false,
    });
    setErrors({});
    setFailure(null);

    Promise.all([employeesApi.list({ page: 1, pageSize: 200 }), recognitionApi.listBadges()])
      .then(([emps, bs]) => {
        // Nobody recognises themselves; the server refuses it either way.
        setColleagues(
          (emps?.data ?? []).filter((e) => String(e.id) !== String(myEmployeeId ?? "")),
        );
        setBadges(bs ?? []);
      })
      .catch(() => setFailure("The colleague or badge list could not be loaded."));
  }, [open, myEmployeeId]);

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const parsed = giveRecognitionSchema.safeParse({
      toEmployeeId: values.toEmployeeId,
      badgeId: values.badgeId || undefined,
      message: values.message,
      teamVisible: values.teamVisible,
      anonymous: values.anonymous,
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
      await recognitionApi.give(parsed.data);
      onGiven();
    } catch (err) {
      setFailure(err?.message ?? "That recognition could not be sent.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <Drawer isOpen onClose={onClose} title="Give recognition" maxWidth="max-w-lg">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <SearchableSelect
          label="Recognise"
          value={values.toEmployeeId}
          onChange={(v) => {
            setValues((prev) => ({ ...prev, toEmployeeId: v }));
            setErrors((e) => ({ ...e, toEmployeeId: undefined }));
          }}
          options={colleagues.map((e) => ({
            value: e.id,
            label: `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim(),
            hint: e.employeeCode,
          }))}
          placeholder="Choose a colleague"
          error={errors.toEmployeeId}
        />

        <SearchableSelect
          label="Badge"
          value={values.badgeId}
          onChange={(v) => setValues((prev) => ({ ...prev, badgeId: v }))}
          options={badges.map((b) => ({
            value: b.id,
            label: `${b.iconKey} ${b.name}`,
            hint: b.description ?? undefined,
          }))}
          placeholder="Optional"
          error={errors.badgeId}
        />

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="recognition-message" className="text-xs font-semibold text-slate-700">
            Message
          </label>
          <textarea
            id="recognition-message"
            rows={4}
            value={values.message}
            onChange={(e) => {
              setValues((v) => ({ ...v, message: e.target.value }));
              setErrors((x) => ({ ...x, message: undefined }));
            }}
            placeholder="What did they do, and why did it matter?"
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none placeholder-slate-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          {errors.message && (
            <span className="text-xs text-error-500 font-medium">{errors.message}</span>
          )}
        </div>

        <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 select-none">
          <input
            type="checkbox"
            checked={values.teamVisible}
            onChange={(e) => setValues((v) => ({ ...v, teamVisible: e.target.checked }))}
            className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
          />
          Show on the recognition wall
        </label>

        <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 select-none">
          <input
            type="checkbox"
            checked={values.anonymous}
            onChange={(e) => setValues((v) => ({ ...v, anonymous: e.target.checked }))}
            className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
          />
          Send anonymously
        </label>

        {values.anonymous && (
          <p className="flex gap-2 p-3 text-[11px] text-slate-600 leading-relaxed bg-slate-50 border border-slate-200 rounded-lg">
            <EyeOff size={14} className="shrink-0 mt-0.5 text-slate-500" />
            <span>
              Your name is hidden from the recipient and from the wall, and this still appears
              under &ldquo;You gave&rdquo; for you. It is <strong>not</strong> anonymous to the
              company: the sender is recorded so abusive messages can be dealt with.
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

function BadgesDrawer({ open, onClose }) {
  const [badges, setBadges] = useState([]);
  const [values, setValues] = useState({ name: "", iconKey: "", description: "" });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBadges((await recognitionApi.listBadges()) ?? []);
    } catch {
      setFailure("The badge list could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setValues({ name: "", iconKey: "", description: "" });
    setErrors({});
    setFailure(null);
    load();
  }, [open, load]);

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const parsed = createBadgeSchema.safeParse({
      name: values.name,
      iconKey: values.iconKey,
      description: values.description || undefined,
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
      await recognitionApi.createBadge(parsed.data);
      setValues({ name: "", iconKey: "", description: "" });
      await load();
    } catch (err) {
      setFailure(err?.message ?? "That badge could not be created.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <Drawer isOpen onClose={onClose} title="Recognition badges" maxWidth="max-w-lg">
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-600">
            Existing badges
          </h3>
          {loading ? (
            <div className="flex justify-center py-6">
              <LoadingSpinner size={20} />
            </div>
          ) : badges.length === 0 ? (
            <p className="text-xs text-slate-500">
              None yet. A badge gives a kudos a shape — {SUGGESTED_BADGES.map((b) => b.name).join(", ")} are
              common starting points.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {badges.map((b) => (
                <li
                  key={b.id}
                  className="flex items-center gap-2.5 p-2.5 border border-slate-200 rounded-lg"
                >
                  <span aria-hidden="true" className="text-lg">
                    {b.iconKey}
                  </span>
                  <span className="flex flex-col min-w-0">
                    <span className="text-sm font-semibold text-slate-900">{b.name}</span>
                    {b.description && (
                      <span className="text-[11px] text-slate-500">{b.description}</span>
                    )}
                  </span>
                  <span className="ml-auto text-[11px] text-slate-500 tabular-nums">
                    {b.awardedCount} awarded
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <form onSubmit={submit} className="flex flex-col gap-4 pt-4 border-t border-slate-200">
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-600">New badge</h3>

          <div className="grid grid-cols-[90px_1fr] gap-3">
            <Input
              label="Icon"
              aria-label="Icon"
              placeholder="⭐"
              value={values.iconKey}
              onChange={(e) => {
                setValues((v) => ({ ...v, iconKey: e.target.value }));
                setErrors((x) => ({ ...x, iconKey: undefined }));
              }}
              error={errors.iconKey}
            />
            <Input
              label="Name"
              aria-label="Name"
              placeholder="e.g. Team Player"
              value={values.name}
              onChange={(e) => {
                setValues((v) => ({ ...v, name: e.target.value }));
                setErrors((x) => ({ ...x, name: undefined }));
              }}
              error={errors.name}
            />
          </div>

          <Input
            label="Description"
            aria-label="Description"
            placeholder="Optional"
            value={values.description}
            onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))}
            error={errors.description}
          />

          <p className="text-[11px] text-slate-500">
            An emoji works well as an icon. Badge names are unique, and a badge already awarded
            keeps its name on the kudos it was given with.
          </p>

          {failure && (
            <p role="alert" className="text-xs text-error-500 font-medium">
              {failure}
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={submitting}>
              Create badge
            </Button>
          </div>
        </form>
      </div>
    </Drawer>
  );
}

export default RecognitionTab;
