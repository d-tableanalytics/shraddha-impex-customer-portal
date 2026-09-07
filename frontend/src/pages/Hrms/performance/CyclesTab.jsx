import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, BarChart3 } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Modal } from "../../../components/ui/Modal";
import { Input } from "../../../components/ui/Input";
import { DateField } from "../../../components/ui/DateField";
import { LoadingSpinner } from "../../../components/ui/LoadingSpinner";
import {
  cyclesApi,
  PHASE_TONES,
  formatPerfDay,
  formatRating,
} from "../../../services/hrms/performance";
import { createCycleSchema } from "@shared/schemas/performance.js";
import {
  PHASE_LABELS,
  DEFAULT_COMPETENCIES,
  RATING_MIN,
  RATING_MAX,
} from "@shared/constants/performance.js";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";

const emptyCompetency = () => ({ key: "", label: "", weight: 1 });

/**
 * Cycles & calibration — HR's tab.
 *
 * The reference's Cycles tab: Name, Window, Phase tag, Competencies,
 * Responses, an "Advance to" picker and a Calibration button; a create drawer
 * seeded with three default competencies; and a calibration modal with a 1–5
 * distribution strip above a per-employee table.
 *
 * 🔴 The phase picker offers only the transitions the SERVER permits. The
 * reference offers every phase but the current one, so a cycle in calibration
 * can be shoved back to goal setting and every review under it is invalidated.
 */
export function CyclesTab() {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [calibrating, setCalibrating] = useState(null);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult((await cyclesApi.list({ page, pageSize: 25 })) ?? { data: [], total: 0 });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const advance = useCallback(
    async (row, phase) => {
      setBusy(row.id);
      setFailure(null);
      try {
        await cyclesApi.advancePhase(row.id, phase);
        await load();
      } catch (err) {
        // "Reviews have already been submitted" arrives here — a rule worth
        // reading rather than a control that quietly does nothing.
        setFailure(err?.message ?? "That cycle could not be moved.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const columns = useMemo(
    () => [
      {
        header: "Name",
        className: `${CELL} font-semibold text-slate-900`,
        headerClassName: HEAD,
        cell: (row) => row.name,
      },
      {
        header: "Window",
        className: `${CELL} w-[210px] text-xs text-slate-600 tabular-nums`,
        headerClassName: HEAD,
        cell: (row) => `${formatPerfDay(row.startDate)} → ${formatPerfDay(row.endDate)}`,
      },
      {
        header: "Phase",
        className: `${CELL} w-[150px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <Badge variant={PHASE_TONES[row.phase] ?? "neutral"}>
            {PHASE_LABELS[row.phase] ?? row.phase}
          </Badge>
        ),
      },
      {
        header: "Competencies",
        className: `${CELL} text-xs text-slate-600`,
        headerClassName: HEAD,
        cell: (row) => row.competencies.map((c) => c.label).join(", ") || "—",
      },
      {
        header: "Responses",
        className: `${CELL} w-[120px] text-right text-xs tabular-nums`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => (
          <span>
            {row.submittedCount}/{row.responseCount}
            <span className="block text-[10.5px] text-slate-400">
              {row.goalCount} goal{row.goalCount === 1 ? "" : "s"}
            </span>
          </span>
        ),
      },
      {
        header: "",
        className: `${CELL} w-[250px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-wrap items-center gap-1.5">
            {row.nextPhases.length > 0 && (
              <SearchableSelect
                className="w-[132px]"
                value={null}
                onChange={(phase) => phase && advance(row, phase)}
                options={row.nextPhases.map((p) => ({ value: p, label: PHASE_LABELS[p] ?? p }))}
                allowClear={false}
                loading={busy === row.id}
                placeholder="Advance to"
              />
            )}
            <Button size="xs" variant="outline" onClick={() => setCalibrating(row)}>
              <BarChart3 size={11} className="mr-1" />
              Calibration
            </Button>
          </div>
        ),
      },
    ],
    [advance, busy],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          <Plus size={14} className="mr-1.5" />
          New cycle
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
        emptyTitle="No review cycles yet"
        emptyDescription="Create one to open goal setting and, later, the reviews themselves."
      />

      <CycleDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          load();
        }}
      />

      <CalibrationModal cycle={calibrating} onClose={() => setCalibrating(null)} />
    </div>
  );
}

function CycleDrawer({ open, onClose, onSaved }) {
  const [values, setValues] = useState({ name: "", startDate: "", endDate: "" });
  const [competencies, setCompetencies] = useState(DEFAULT_COMPETENCIES.map((c) => ({ ...c })));
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({ name: "", startDate: "", endDate: "" });
    // Seeded with the reference's three defaults.
    setCompetencies(DEFAULT_COMPETENCIES.map((c) => ({ ...c })));
    setErrors({});
    setFailure(null);
  }, [open]);

  const setCompetency = (index, patch) =>
    setCompetencies((list) => list.map((c, i) => (i === index ? { ...c, ...patch } : c)));

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const parsed = createCycleSchema.safeParse({
      name: values.name,
      startDate: values.startDate,
      endDate: values.endDate,
      competencies: competencies.map((c) => ({
        key: c.key,
        label: c.label,
        weight: Number(c.weight) || 1,
      })),
    });
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path?.[0];
        const key = field === "competencies" ? "competencies" : field;
        if (key && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }

    setSubmitting(true);
    try {
      await cyclesApi.create(parsed.data);
      onSaved();
    } catch (err) {
      setFailure(err?.message ?? "That cycle could not be saved.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <Drawer isOpen onClose={onClose} title="New review cycle" maxWidth="max-w-2xl">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Name"
          aria-label="Name"
          placeholder="e.g. Q3 2026 Review"
          value={values.name}
          onChange={(e) => {
            setValues((v) => ({ ...v, name: e.target.value }));
            setErrors((x) => ({ ...x, name: undefined }));
          }}
          error={errors.name}
        />

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-700">Start date</label>
            <DateField
              value={values.startDate}
              onChange={(startDate) => {
                setValues((v) => ({ ...v, startDate }));
                setErrors((x) => ({ ...x, startDate: undefined }));
              }}
            />
            {errors.startDate && (
              <span className="text-xs text-error-500 font-medium">{errors.startDate}</span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-700">End date</label>
            <DateField
              value={values.endDate}
              onChange={(endDate) => {
                setValues((v) => ({ ...v, endDate }));
                setErrors((x) => ({ ...x, endDate: undefined }));
              }}
            />
            {errors.endDate && (
              <span className="text-xs text-error-500 font-medium">{errors.endDate}</span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-bold uppercase tracking-wide text-slate-600">
            Competencies
          </span>

          {competencies.map((c, index) => (
            <div
              key={index}
              className="grid grid-cols-[1fr_1.4fr_90px_auto] gap-2 items-end p-2.5 bg-slate-50 border border-slate-200 rounded-lg"
            >
              <Input
                label="Key"
                aria-label={`Competency ${index + 1} key`}
                placeholder="execution"
                value={c.key}
                onChange={(e) => {
                  setCompetency(index, { key: e.target.value });
                  setErrors((x) => ({ ...x, competencies: undefined }));
                }}
              />
              <Input
                label="Label"
                aria-label={`Competency ${index + 1} label`}
                placeholder="Execution"
                value={c.label}
                onChange={(e) => setCompetency(index, { label: e.target.value })}
              />
              <Input
                type="number"
                min={1}
                max={10}
                label="Weight"
                aria-label={`Competency ${index + 1} weight`}
                value={c.weight}
                onChange={(e) => setCompetency(index, { weight: e.target.value })}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-error-500 mb-0.5"
                aria-label={`Remove competency ${index + 1}`}
                // A cycle needs at least one; the server refuses an empty list.
                disabled={competencies.length === 1}
                onClick={() => setCompetencies((list) => list.filter((_, i) => i !== index))}
              >
                <Trash2 size={13} />
              </Button>
            </div>
          ))}

          {errors.competencies && (
            <span role="alert" className="text-xs text-error-500 font-medium">
              {errors.competencies}
            </span>
          )}

          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => setCompetencies((list) => [...list, emptyCompetency()])}
          >
            <Plus size={14} className="mr-1.5" />
            Add competency
          </Button>
        </div>

        <p className="text-[11px] text-slate-500 leading-relaxed">
          The key identifies a competency in every rating filed under this cycle, so it cannot be
          changed later — use lower-case letters, digits and underscores. Weight is recorded for
          your own reference; nothing is scored from it.
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

/**
 * The calibration snapshot.
 *
 * A distribution strip over the manager ratings, then every employee side by
 * side. The `gap` column is the self-minus-manager difference — the number
 * calibration exists to discuss, and one the reference does not compute.
 */
function CalibrationModal({ cycle, onClose }) {
  const [snapshot, setSnapshot] = useState(null);
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    if (!cycle) return;
    setSnapshot(null);
    setFailure(null);
    cyclesApi
      .calibration(cycle.id)
      .then(setSnapshot)
      .catch((err) => setFailure(err?.message ?? "That snapshot could not be loaded."));
  }, [cycle]);

  if (!cycle) return null;

  const bands = [];
  for (let b = RATING_MIN; b <= RATING_MAX; b += 1) bands.push(b);

  return (
    <Modal isOpen onClose={onClose} title={`Calibration — ${cycle.name}`} size="xl">
      {failure ? (
        <p role="alert" className="text-sm text-error-500 font-medium">
          {failure}
        </p>
      ) : snapshot === null ? (
        <div className="flex items-center justify-center py-10">
          <LoadingSpinner size={24} />
        </div>
      ) : snapshot.responses.length === 0 ? (
        <p className="text-sm text-slate-500">No reviews have been submitted in this cycle yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <section>
            <h4 className="text-xs font-bold uppercase tracking-wide text-slate-600">
              Manager rating distribution
            </h4>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {snapshot.rated} of {snapshot.responses.length} employee(s) have a manager rating.
              A band counts everyone who reached it — 3.5 sits in band 3.
            </p>
            <div className="mt-2 grid grid-cols-5 gap-2">
              {bands.map((b) => (
                <div
                  key={b}
                  className="flex flex-col items-center gap-1 p-2.5 bg-slate-50 border border-slate-200 rounded-lg"
                >
                  <span className="text-2xl font-black text-slate-900 tabular-nums">
                    {snapshot.distribution[b] ?? 0}
                  </span>
                  <Badge variant={b >= 4 ? "success" : b === 3 ? "primary" : "warning"}>
                    {b}/{RATING_MAX}
                  </Badge>
                </div>
              ))}
            </div>
          </section>

          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-500 border-b border-slate-200 bg-slate-50">
                  <th className="px-4 py-2">Employee</th>
                  <th className="px-4 py-2 w-[100px] text-right">Self</th>
                  <th className="px-4 py-2 w-[100px] text-right">Manager</th>
                  <th className="px-4 py-2 w-[100px] text-right">Peer avg</th>
                  <th className="px-4 py-2 w-[110px] text-right">Gap</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.responses.map((row) => (
                  <tr key={row.employeeId} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2.5 font-medium text-slate-900">{row.employeeName}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {formatRating(row.selfRating)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-semibold">
                      {formatRating(row.managerRating)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {formatRating(row.peerAverage)}
                    </td>
                    <td
                      className={
                        row.gap === null
                          ? "px-4 py-2.5 text-right text-slate-400"
                          : Math.abs(row.gap) >= 1
                            ? "px-4 py-2.5 text-right tabular-nums font-semibold text-warning-600"
                            : "px-4 py-2.5 text-right tabular-nums text-slate-600"
                      }
                      title={row.gap === null ? undefined : "Self rating minus manager rating"}
                    >
                      {row.gap === null ? "—" : row.gap > 0 ? `+${row.gap}` : row.gap}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-slate-500">
            Gap is the self rating minus the manager rating. A gap of a point or more, in either
            direction, is the conversation worth having.
          </p>
        </div>
      )}
    </Modal>
  );
}

export default CyclesTab;
