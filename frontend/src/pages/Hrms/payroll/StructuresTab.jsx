import { useCallback, useEffect, useState } from "react";
import { Calculator } from "lucide-react";

import { ErrorState } from "../../../components/hrms/ErrorState";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LoadingSpinner } from "../../../components/ui/LoadingSpinner";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Modal } from "../../../components/ui/Modal";
import { Input } from "../../../components/ui/Input";
import { salaryStructuresApi, salaryComponentsApi } from "../../../services/hrms";
import { formatMoney } from "../../../services/hrms/payroll";

const TYPE_TONES = {
  earning: "success",
  reimbursement: "primary",
  deduction: "warning",
  employer_contribution: "neutral",
};

const TYPE_LABELS = {
  earning: "Earning",
  reimbursement: "Reimbursement",
  deduction: "Deduction",
  employer_contribution: "Employer",
};

/**
 * Salary structures and the component catalogue behind them.
 *
 * The reference's Structures tab. Building a structure is a multi-step editor
 * there; here the tab shows the structures, their ordered components, and — the
 * part that matters most — the PREVIEW, which runs the real engine server-side
 * so what an admin sees while designing is what payroll will produce.
 *
 * Creating and editing structures is done through the API; this screen reads
 * them and previews them. That is an honest gap rather than a half-built
 * editor, and it is stated in the module's report.
 */
export function StructuresTab() {
  const [structures, setStructures] = useState([]);
  const [components, setComponents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [previewing, setPreviewing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, c] = await Promise.all([salaryStructuresApi.list(), salaryComponentsApi.list()]);
      setStructures(s ?? []);
      setComponents(c ?? []);
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

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-slate-900">Salary structures</h3>

        {structures.length === 0 ? (
          <EmptyState
            title="No salary structures yet"
            description="A structure is the ordered set of components an employee's pay is built from."
          />
        ) : (
          structures.map((structure) => (
            <article
              key={structure.id}
              className="bg-white border border-slate-200 rounded-xl overflow-hidden"
            >
              <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100">
                <div className="min-w-0">
                  <h4 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                    {structure.name}
                    {structure.isDefault && <Badge variant="primary">Default</Badge>}
                  </h4>
                  <p className="text-[11px] text-slate-500">
                    {structure.components.length} component
                    {structure.components.length === 1 ? "" : "s"}
                  </p>
                </div>
                <Button size="xs" variant="secondary" onClick={() => setPreviewing(structure)}>
                  <Calculator size={12} className="mr-1" />
                  Preview
                </Button>
              </header>

              <ul className="divide-y divide-slate-100">
                {structure.components.map((sc) => (
                  <li
                    key={sc.componentId}
                    className="flex items-center justify-between gap-3 px-4 py-2"
                  >
                    <span className="text-xs text-slate-700 min-w-0">
                      <span className="font-mono text-[11px] text-slate-500 mr-2">
                        {sc.component.code}
                      </span>
                      {sc.component.name}
                    </span>
                    <Badge variant={TYPE_TONES[sc.component.type] ?? "neutral"}>
                      {TYPE_LABELS[sc.component.type] ?? sc.component.type}
                    </Badge>
                  </li>
                ))}
              </ul>
            </article>
          ))
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Component catalogue</h3>
        {components.length === 0 ? (
          <EmptyState title="No components yet" description="Components are the building blocks of a structure." />
        ) : (
          <ul className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
            {components.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2">
                <span className="text-xs text-slate-700">
                  <span className="font-mono text-[11px] text-slate-500 mr-2">{c.code}</span>
                  {c.name}
                </span>
                <span className="flex items-center gap-1.5">
                  {c.statutoryLink && (
                    <Badge variant="neutral">{c.statutoryLink.toUpperCase()}</Badge>
                  )}
                  <Badge variant={TYPE_TONES[c.type] ?? "neutral"}>
                    {TYPE_LABELS[c.type] ?? c.type}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <PreviewDialog structure={previewing} onClose={() => setPreviewing(null)} />
    </div>
  );
}

/**
 * What a CTC yields under a structure.
 *
 * Computed on the SERVER by the same engine payroll uses, so a preview cannot
 * disagree with the payslip. A preview built from a second, browser-side
 * implementation is a preview that can lie.
 */
function PreviewDialog({ structure, onClose }) {
  const [ctc, setCtc] = useState("900000");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    setResult(null);
    setFailure(null);
  }, [structure]);

  const run = async (event) => {
    event.preventDefault();
    setLoading(true);
    setFailure(null);
    try {
      setResult(await salaryStructuresApi.preview(structure.id, { ctc }));
    } catch (err) {
      // The commonest failure is "no statutory configuration is effective",
      // which is a real blocker the admin has to fix, not a UI hiccup.
      setFailure(err?.message ?? "The preview could not be computed.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  if (!structure) return null;

  return (
    <Modal isOpen onClose={onClose} title={`Preview — ${structure.name}`} size="lg">
      <form onSubmit={run} className="flex items-end gap-3 mb-4">
        <Input
          label="Annual CTC"
          aria-label="Annual CTC"
          value={ctc}
          onChange={(e) => setCtc(e.target.value)}
          className="max-w-[200px]"
        />
        <Button type="submit" variant="primary" loading={loading}>
          Compute
        </Button>
      </form>

      {failure && (
        <p role="alert" className="text-xs text-error-500 font-medium mb-3">
          {failure}
        </p>
      )}

      {result && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-3">
            {[
              ["Monthly gross", result.monthlyGross],
              ["Deductions", result.monthlyDeductions],
              ["Monthly net", result.monthlyNet],
            ].map(([label, value], index) => (
              <div key={label} className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
                <p
                  className={`text-base font-bold tabular-nums ${
                    index === 2 ? "text-success-600" : "text-slate-900"
                  }`}
                >
                  ₹ {formatMoney(value)}
                </p>
              </div>
            ))}
          </div>

          <table className="w-full border border-slate-200 rounded-lg overflow-hidden">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Component
                </th>
                <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Monthly
                </th>
                <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Annual
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.lines.map((line) => (
                <tr key={line.componentCode}>
                  <td className="px-3 py-1.5 text-xs text-slate-700">
                    {line.componentName}
                    <Badge variant={TYPE_TONES[line.type] ?? "neutral"} className="ml-2">
                      {TYPE_LABELS[line.type] ?? line.type}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums">
                    ₹ {formatMoney(line.monthly)}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums text-slate-500">
                    ₹ {formatMoney(line.annual)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

export default StructuresTab;
