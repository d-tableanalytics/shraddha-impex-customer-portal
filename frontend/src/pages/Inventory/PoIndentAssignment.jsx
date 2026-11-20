import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import {
  ChevronDown, ChevronRight, FileText, PackageCheck, SearchX, Zap, AlertTriangle,
} from "lucide-react";
import { Card, CardContent } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { ConfirmationDialog } from "../../components/ui/ConfirmationDialog";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { SearchInput } from "../../components/ui/SearchInput";
import { SkeletonLoader } from "../../components/ui/SkeletonLoader";
import { inventoryApi } from "../../services/inventory";

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const errorOf = (err, fallback) => err?.response?.data?.message || err?.message || fallback;

/** As on the individual tab: lower-cased, any run of spaces read as one. */
const normalize = (v) => String(v).toLowerCase().replace(/\s+/g, " ");

/**
 * Group the waiting indents the screen already holds by the PO they go by.
 *
 * This reads the SAME queue the individual tab is drawn from — one fetch, two
 * views — so a PO here lists exactly the indents that tab shows under that PO
 * number, with the same free-stock figures. Nothing is re-fetched, and nothing
 * about the individual tab changes.
 *
 * `willAssign` per row is what "Assign all" would hand this indent if it ran
 * now: what it still waits for, or what is free of its SKU, whichever is less,
 * counting the SKU's free stock down row by row so two indents for one SKU are
 * never shown the same units twice. An indent whose booking was cancelled
 * (`wholeOnly`) takes all or nothing. The server decides for real; this is the
 * screen saying what it expects.
 *
 * Indents with no PO yet are not invented into a group — they are counted and
 * pointed back to the individual tab.
 *
 * @param {Array} skus  `data.skus` from the assignment queue.
 */
export const groupIndentsByPo = (skus = []) => {
  const byPo = new Map();
  let withoutPo = 0;

  for (const sku of skus) {
    for (const indent of sku.indents || []) {
      if (!indent.poNumber) { withoutPo += 1; continue; }
      if (!byPo.has(indent.poNumber)) byPo.set(indent.poNumber, []);
      byPo.get(indent.poNumber).push({
        ...indent, skuCode: sku.skuCode, brand: sku.brand, available: sku.available,
      });
    }
  }

  const groups = [...byPo.entries()].map(([poNumber, list]) => {
    // Oldest first across SKUs — the order the server assigns them in.
    const rows = [...list].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0)
      || String(a.skuCode).localeCompare(String(b.skuCode)));

    const free = new Map();
    for (const r of rows) if (!free.has(r.skuCode)) free.set(r.skuCode, Math.max(0, r.available || 0));
    const priced = rows.map((r) => {
      const left = free.get(r.skuCode) ?? 0;
      const want = r.wholeOnly ? (r.pending <= left ? r.pending : 0) : Math.min(r.pending, left);
      free.set(r.skuCode, left - want);
      return { ...r, willAssign: want };
    });

    return {
      poNumber,
      rows: priced,
      indentCount: priced.length,
      skuCount: new Set(priced.map((r) => r.skuCode)).size,
      pending: priced.reduce((n, r) => n + r.pending, 0),
      units: priced.reduce((n, r) => n + r.willAssign, 0),
      ready: priced.filter((r) => r.willAssign > 0).length,
      customers: [...new Set(priced.map((r) => r.customerName || r.customer).filter(Boolean))],
      companies: [...new Set(priced.map((r) => r.company).filter(Boolean))],
      date: priced[0]?.date || null,
    };
  });

  // POs with stock to hand out first, then the oldest indent, then by number.
  groups.sort((a, b) => (b.units > 0) - (a.units > 0)
    || new Date(a.date || 0) - new Date(b.date || 0)
    || String(a.poNumber).localeCompare(String(b.poNumber)));

  return { groups, withoutPo };
};

/** A PO is found by its own number or by anything on one of its indents. */
const poMatches = (po, term) => normalize(po.poNumber).includes(term)
  || po.rows.some((r) => [
    r.customerName, r.company, r.customer, r.skuCode, r.indentNumber, r.reservationId, r.bookingId,
  ].some((v) => v != null && normalize(v).includes(term)));

/**
 * PO-WISE INDENT STOCK ASSIGNMENT — the second tab.
 *
 * The individual tab answers "which indent gets these units?". This one
 * answers the other question the desk asks: a PO was raised for several lines,
 * the material has landed, settle the whole PO. Click a PO to see every indent
 * under it; "Assign all" assigns each of them in one click.
 *
 * Nothing new happens on assign: the server runs the same per-indent assign
 * the individual tab runs, one indent after another, oldest first, and says
 * what it could not do. This component only groups, explains and reports.
 */
export const PoIndentAssignment = ({ data, loading, loadError, onReload, onChanged, run, isBusy, anyBusy }) => {
  const [search, setSearch] = useState("");
  const [withStockOnly, setWithStockOnly] = useState(true);
  const [open, setOpen] = useState({});
  const [confirm, setConfirm] = useState(null);
  // The last PO-wise run, kept so a partly-served PO can say which indents it
  // could not serve and why, instead of a toast that disappears.
  const [lastRun, setLastRun] = useState(null);

  const term = normalize(search.trim());
  const { groups, withoutPo } = useMemo(() => groupIndentsByPo(data?.skus || []), [data]);

  const { visible, hiddenByStock } = useMemo(() => {
    const out = [];
    let hidden = 0;
    for (const po of groups) {
      if (term && !poMatches(po, term)) continue;
      // The PO that was just run stays on screen even with nothing left to
      // assign, so its report of what could not be assigned stays readable.
      if (withStockOnly && po.units === 0 && po.poNumber !== lastRun?.poNumber) { hidden += 1; continue; }
      out.push(po);
    }
    return { visible: out, hiddenByStock: hidden };
  }, [groups, term, withStockOnly, lastRun]);

  const toggle = (poNumber) => setOpen((s) => ({ ...s, [poNumber]: !s[poNumber] }));

  const assignAll = (po) => setConfirm({
    title: `Assign all indents under ${po.poNumber}?`,
    description: `${po.ready} of ${po.indentCount} indent(s) on this PO can take stock now — `
      + `${po.units} unit(s) across ${po.skuCount} SKU(s). Each one is assigned exactly as it would be `
      + `one at a time, oldest first, and its customer is told. `
      + (po.ready < po.indentCount
        ? `The other ${po.indentCount - po.ready} stay waiting; there is not enough free stock for them.`
        : "Nothing on this PO is left waiting."),
    onConfirm: () => run(`po:${po.poNumber}`, async () => {
      try {
        const res = await inventoryApi.assignPoIndents(po.poNumber);
        setLastRun(res);
        setOpen((s) => ({ ...s, [po.poNumber]: true }));
        if (res.assigned.length) {
          toast.success(`${po.poNumber}: ${res.units} unit(s) assigned to ${res.assigned.length} indent(s)`
            + (res.skipped.length ? `; ${res.skipped.length} left waiting.` : "."));
        } else {
          toast.error(`${po.poNumber}: nothing could be assigned. ${res.skipped[0]?.reason || ""}`);
        }
      } catch (err) {
        toast.error(errorOf(err, "Could not assign the indents on this PO."));
      }
      setConfirm(null);
      await onChanged();
    }),
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Search and filter — the individual tab's toolbar, over POs. */}
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SearchInput
            className="flex-1 min-w-64 max-w-lg"
            value={search}
            onChange={setSearch}
            placeholder="Search PO number, SKU, customer, company, indent or booking…"
            label="Search POs"
          />
          <label className="inline-flex cursor-pointer select-none items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100">
            <input
              type="checkbox"
              className="h-4 w-4 cursor-pointer accent-primary-600"
              checked={withStockOnly}
              onChange={(e) => setWithStockOnly(e.target.checked)}
            />
            Only POs with stock to assign
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500" role="status">
          {term && visible.length > 0 && (
            <span>
              <span className="font-bold text-slate-700">{visible.length}</span> PO{visible.length === 1 ? "" : "s"} match “{search.trim()}”
            </span>
          )}
          {term && hiddenByStock > 0 && (
            <button
              type="button"
              onClick={() => setWithStockOnly(false)}
              className="font-semibold text-primary-600 hover:text-primary-700 hover:underline"
            >
              {hiddenByStock} more PO{hiddenByStock === 1 ? "" : "s"} with no stock to assign also match. Show {hiddenByStock === 1 ? "it" : "them"}
            </button>
          )}
          {!term && withoutPo > 0 && (
            <span>
              {withoutPo} waiting indent{withoutPo === 1 ? " has" : "s have"} no PO yet — {withoutPo === 1 ? "it is" : "they are"} on the Individual tab.
            </span>
          )}
        </div>
      </div>

      {loading && data && <ProgressBar label="Refreshing…" />}

      {loading && !data ? (
        <div className="flex flex-col gap-4" aria-busy="true">
          {[0, 1].map((i) => (
            <Card key={i}><CardContent className="p-5 flex flex-col gap-3">
              <SkeletonLoader variant="text" className="w-40 h-5" />
              {[0, 1, 2].map((j) => <SkeletonLoader key={j} variant="text" className="w-full" />)}
            </CardContent></Card>
          ))}
        </div>
      ) : loadError ? (
        <Card><CardContent className="p-6 text-sm text-red-600 flex items-center justify-between gap-3">
          {loadError}
          <Button size="sm" variant="secondary" onClick={onReload}>Try again</Button>
        </CardContent></Card>
      ) : visible.length === 0 ? (
        <Card><CardContent className="p-10 text-center text-sm text-slate-500">
          {term ? (
            <>
              <SearchX size={28} className="mx-auto mb-2 text-slate-300" />
              <p>No PO matches “{search.trim()}”.</p>
              <p className="mt-1 text-xs text-slate-400">Search by PO number, SKU, customer name, company, indent or booking ID.</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {hiddenByStock > 0 && (
                  <Button size="sm" variant="secondary" onClick={() => setWithStockOnly(false)}>
                    Include POs with no stock ({hiddenByStock})
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={() => setSearch("")}>Clear search</Button>
              </div>
            </>
          ) : (
            <>
              <PackageCheck size={28} className="mx-auto mb-2 text-slate-300" />
              {withStockOnly
                ? "No PO has stock to assign right now."
                : "No waiting indent has a PO number yet."}
              {withoutPo > 0 && (
                <p className="mt-1 text-xs text-slate-400">
                  {withoutPo} waiting indent{withoutPo === 1 ? "" : "s"} without a PO {withoutPo === 1 ? "is" : "are"} on the Individual tab.
                </p>
              )}
            </>
          )}
        </CardContent></Card>
      ) : (
        visible.map((po) => {
          const expanded = Boolean(open[po.poNumber]);
          const result = lastRun?.poNumber === po.poNumber ? lastRun : null;
          return (
            <Card key={po.poNumber}>
              <CardContent className="p-0">
                {/* The PO row. Clicking it lists every indent under this PO. */}
                <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <button
                    type="button"
                    onClick={() => toggle(po.poNumber)}
                    aria-expanded={expanded}
                    className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-left"
                  >
                    {expanded
                      ? <ChevronDown size={16} className="text-slate-400" />
                      : <ChevronRight size={16} className="text-slate-400" />}
                    <FileText size={15} className="text-slate-400" />
                    <span className="whitespace-nowrap font-mono text-base font-black text-slate-800">{po.poNumber}</span>
                    <span className="text-sm font-semibold text-slate-700">
                      {po.customers.length ? po.customers.join(", ") : "—"}
                    </span>
                    {po.companies.length > 0 && (
                      <span className="text-xs text-slate-500">{po.companies.join(", ")}</span>
                    )}
                    <span className="text-xs text-slate-500">
                      {po.indentCount} indent{po.indentCount === 1 ? "" : "s"} · {po.skuCount} SKU{po.skuCount === 1 ? "" : "s"} · waiting for {po.pending}
                    </span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${po.units ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                      {po.units ? `${po.units} assignable now` : "nothing free"}
                    </span>
                  </button>
                  <Button
                    size="sm"
                    onClick={() => assignAll(po)}
                    disabled={!po.units || anyBusy}
                    loading={isBusy(`po:${po.poNumber}`)}
                    title={po.units
                      ? `Assign ${po.units} unit(s) to ${po.ready} indent(s) on this PO`
                      : "No free stock for any indent on this PO"}
                  >
                    <Zap size={14} className="mr-1.5" />
                    Assign all ({po.ready})
                  </Button>
                </div>

                {expanded && (
                  <div className="overflow-x-auto border-t border-slate-100">
                    <table className="w-full min-w-240 text-sm">
                      <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="px-5 py-2 text-left">SKU</th>
                          <th className="px-3 py-2 text-left">Customer Name</th>
                          <th className="px-3 py-2 text-left">Company Name</th>
                          <th className="px-3 py-2 text-left">Indent</th>
                          <th className="px-3 py-2 text-right">Requested</th>
                          <th className="px-3 py-2 text-right">Pending</th>
                          <th className="px-3 py-2 text-right">Free</th>
                          <th className="px-3 py-2 text-left">Indent date</th>
                          <th className="px-5 py-2 text-right">Will assign</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {po.rows.map((r) => (
                          <tr key={r.id}>
                            <td className="px-5 py-2.5 whitespace-nowrap font-mono text-xs font-bold text-slate-800">
                              {r.skuCode}
                              {r.brand && <span className="ml-1.5 text-[10px] font-bold uppercase text-slate-400">{r.brand}</span>}
                            </td>
                            <td className="px-3 py-2.5 font-semibold text-slate-800">
                              {r.customerName || <span className="font-normal text-slate-400" title="No customer name on this account">—</span>}
                            </td>
                            <td className="px-3 py-2.5 text-slate-600">
                              {r.company || <span className="text-slate-400" title="No company on this account">—</span>}
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap font-mono text-xs text-slate-600">
                              {r.indentNumber || r.reservationId}
                              {r.bookingId && <span className="block text-[10px] text-slate-400">{r.bookingId}</span>}
                            </td>
                            <td className="px-3 py-2.5 text-right text-slate-600">{r.requested}</td>
                            <td className="px-3 py-2.5 text-right font-bold text-amber-600">{r.pending}</td>
                            <td className="px-3 py-2.5 text-right text-slate-600">{r.available}</td>
                            <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">
                              {fmtDate(r.date)}
                              {r.scheduledDate && <span className="block text-[10px] text-slate-400">promised {fmtDate(r.scheduledDate)}</span>}
                              {r.supplyCheck?.status === "Awaiting decision" && (
                                <span
                                  className="mt-1 inline-block rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-800"
                                  title={r.supplyCheck.reason || undefined}
                                >
                                  MSIL: arrived late, awaiting decision
                                </span>
                              )}
                            </td>
                            <td className="px-5 py-2.5 text-right">
                              {r.willAssign > 0 ? (
                                <span className="font-bold text-emerald-700">{r.willAssign}</span>
                              ) : (
                                <span
                                  className="text-[11px] text-slate-500"
                                  title={r.wholeOnly
                                    ? "Its booking was cancelled, so it can only be taken whole"
                                    : "No free stock for this SKU"}
                                >
                                  {r.wholeOnly ? `whole only (${r.pending})` : "nothing free"}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* What the last run on this PO could not do, and why. */}
                {result?.skipped?.length > 0 && (
                  <div className="border-t border-slate-100 bg-amber-50/50 px-5 py-3">
                    <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-amber-800">
                      <AlertTriangle size={13} />
                      {result.assigned.length
                        ? `${result.assigned.length} indent(s) assigned; ${result.skipped.length} left waiting`
                        : `Nothing was assigned on this PO (${result.skipped.length} indent(s) left waiting)`}
                    </p>
                    <ul className="flex flex-col gap-1 text-xs text-slate-600">
                      {result.skipped.map((s) => (
                        <li key={`${s.indentId}:${s.skuCode}`}>
                          <span className="font-mono text-slate-700">{s.indent}</span> — {s.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}

      <ConfirmationDialog
        isOpen={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm?.onConfirm()}
        title={confirm?.title}
        description={confirm?.description}
        confirmText="Assign all"
        loading={anyBusy}
      />
    </div>
  );
};

export default PoIndentAssignment;
