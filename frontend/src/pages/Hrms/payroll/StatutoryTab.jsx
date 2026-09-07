import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { ErrorState } from "../../../components/hrms/ErrorState";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LoadingSpinner } from "../../../components/ui/LoadingSpinner";
import { Badge } from "../../../components/ui/Badge";
import { statutoryApi } from "../../../services/hrms";

/**
 * Statutory configuration — PF, ESI, PT, LWF and TDS (AD-12).
 *
 * ---------------------------------------------------------------------------
 * What this screen is FOR
 * ---------------------------------------------------------------------------
 * Making the rules payroll computes against VISIBLE. Every rate, ceiling, slab
 * and state rule is configuration, and the single most dangerous state for a
 * payroll system is one where nobody can see which numbers are in force.
 *
 * The empty state is therefore load-bearing rather than decorative: with no
 * configuration, payroll REFUSES to run — it does not quietly compute every
 * statutory line as zero — and this screen is where that is explained.
 *
 * Editing is done through the API. A form that lets an admin type tax slabs
 * into a browser is a bigger surface than this module has earned yet, and a
 * half-built one would be worse than none; the gap is stated in the report.
 */
export function StatutoryTab() {
  const [effective, setEffective] = useState(null);
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [current, list] = await Promise.all([statutoryApi.effective(), statutoryApi.list()]);
      setEffective(current);
      setVersions(list ?? []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[30vh]">
        <LoadingSpinner size={28} />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        variant={error.isForbidden ? "forbidden" : "error"}
        description={error.message}
        onRetry={load}
      />
    );
  }

  if (!effective) {
    return (
      <div className="flex flex-col gap-3">
        <div
          role="alert"
          className="flex gap-3 p-4 rounded-lg bg-warning-50 border border-warning-200"
        >
          <AlertTriangle className="w-5 h-5 text-warning-600 shrink-0 mt-0.5" />
          <div className="text-xs text-slate-700 leading-relaxed">
            <p className="font-semibold text-slate-900 mb-1">
              No statutory configuration is in force
            </p>
            <p>
              Payroll cannot run until one exists. Nothing here is assumed: PF rates, the ESI
              threshold, professional tax slabs, labour welfare fund rules and income tax slabs are
              all configuration, and running without them would compute every statutory deduction
              as zero.
            </p>
          </div>
        </div>
        <EmptyState
          title="Nothing configured yet"
          description="Create a statutory configuration through the API to enable payroll runs."
        />
      </div>
    );
  }

  const { config, coveredStates } = effective;

  return (
    <div className="flex flex-col gap-4">
      <section className="bg-white border border-slate-200 rounded-xl">
        <header className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-900">In force</h3>
          <span className="text-xs text-slate-500">
            From {effective.effectiveFrom}
            {effective.effectiveTo ? ` to ${effective.effectiveTo}` : " (open-ended)"}
          </span>
        </header>

        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Block title="Provident fund">
            <Row label="Employee rate" value={pct(config.pf.employeeRate)} />
            <Row label="Employer rate" value={pct(config.pf.employerRate)} />
            <Row label="Wage ceiling" value={`₹ ${config.pf.wageCeiling.toLocaleString("en-IN")}`} />
          </Block>

          <Block title="Employees' state insurance">
            <Row label="Employee rate" value={pct(config.esi.employeeRate)} />
            <Row label="Employer rate" value={pct(config.esi.employerRate)} />
            <Row
              label="Gross threshold"
              value={`₹ ${config.esi.grossThreshold.toLocaleString("en-IN")}`}
            />
          </Block>

          <Block title="Income tax">
            <Row label="Default regime" value={config.tds.regime} />
            <Row
              label="Standard deduction (new)"
              value={`₹ ${config.tds.new.standardDeduction.toLocaleString("en-IN")}`}
            />
            <Row label="Cess" value={pct(config.tds.cess)} />
          </Block>

          {/*
            The states each state-specific rule covers. A state absent here has
            no PT or no LWF — which is correct for several, and a configuration
            oversight for others. Only a human can tell which, so both are shown
            rather than one being inferred.
          */}
          <Block title="State-specific rules">
            <Row
              label="Professional tax"
              value={coveredStates?.pt?.length ? coveredStates.pt.join(", ") : "no states configured"}
            />
            <Row
              label="Labour welfare fund"
              value={coveredStates?.lwf?.length ? coveredStates.lwf.join(", ") : "no states configured"}
            />
          </Block>
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-xl">
        <h3 className="px-4 py-3 border-b border-slate-100 text-sm font-semibold text-slate-900">
          Version history
        </h3>
        <ul className="divide-y divide-slate-100">
          {versions.map((v) => (
            <li key={v.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
              <span className="text-xs text-slate-700">
                {v.effectiveFrom} → {v.effectiveTo ?? "open"}
                {v.note && <span className="block text-[11px] text-slate-400">{v.note}</span>}
              </span>
              {v.id === effective.id ? (
                <Badge variant="success">In force</Badge>
              ) : (
                <Badge variant="neutral">Superseded</Badge>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const pct = (rate) => `${(Number(rate) * 100).toFixed(2)}%`;

function Block({ title, children }) {
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <h4 className="px-3 py-2 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
        {title}
      </h4>
      <dl className="divide-y divide-slate-100">{children}</dl>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-1.5">
      <dt className="text-xs text-slate-600">{label}</dt>
      <dd className="text-xs font-semibold text-slate-900 tabular-nums">{value}</dd>
    </div>
  );
}

export default StatutoryTab;
