import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Shuffle, Zap, Search, ArrowRightLeft, PackageCheck, RefreshCw } from "lucide-react";
import { PageHeader } from "../../components/common/PageHeader";
import { Card, CardContent } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { ConfirmationDialog } from "../../components/ui/ConfirmationDialog";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { SkeletonLoader } from "../../components/ui/SkeletonLoader";
import { inventoryApi } from "../../services/inventory";
import { useUserStore } from "../../store/userStore";
import { useBusyAction } from "../../hooks/useBusyAction";
import { hasPermission, PERMISSIONS } from "../../utils/permissions";

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const errorOf = (err, fallback) => err?.response?.data?.message || err?.message || fallback;

/**
 * INDENT STOCK ASSIGNMENT — which customer indent arriving stock goes to.
 *
 * In MANUAL mode (Inventory setting) arriving stock waits here instead of going
 * to the oldest indent by itself. Per SKU the user can run the same FIFO
 * auto-assign, give units to a chosen indent (partial allowed), or move an
 * allocation from one customer's indent to another's before a PO is raised.
 *
 * Admin, Sales and the Import Team (`assign_indent_stock`). The rules — never
 * more than is free, never more than an indent waits for, never twice — are the
 * server's; this screen states them and shows its answer.
 */
export const IndentAssignment = () => {
  const { user } = useUserStore();
  const canConfigure = hasPermission(user, PERMISSIONS.CONFIGURE_INVENTORY);
  const { run, isBusy, anyBusy } = useBusyAction();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [search, setSearch] = useState("");
  const [withStockOnly, setWithStockOnly] = useState(true);
  // Quantity typed per indent / per allocation move, and the move target.
  const [qty, setQty] = useState({});
  const [moveTo, setMoveTo] = useState({});
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await inventoryApi.indentAssignmentQueue());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorOf(err, "Could not load the indents waiting for stock."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const skus = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.skus || []).filter((s) => (!withStockOnly || s.available > 0 || s.reassignable.length > 0)
      && (!term || s.skuCode.toLowerCase().includes(term)
        || s.indents.some((i) => `${i.customer} ${i.indentNumber}`.toLowerCase().includes(term))));
  }, [data, search, withStockOnly]);

  const manual = data?.mode === "manual";

  const toggleMode = () => run("mode", async () => {
    const next = manual ? "auto" : "manual";
    await inventoryApi.setIndentAssignmentMode(next);
    toast.success(next === "manual"
      ? "Arriving stock will now be held here for assignment."
      : "Arriving stock will now be assigned automatically, oldest indent first.");
    await load();
  }, { error: "Could not change the setting." });

  const autoAssign = (sku) => run(`auto:${sku.skuCode}`, async () => {
    try {
      const res = await inventoryApi.autoAssignIndents([sku.skuCode]);
      toast.success(res.booked
        ? `${sku.skuCode}: stock assigned to ${res.booked} indent line(s), oldest first.`
        : `${sku.skuCode}: nothing could be assigned (no free stock covers the oldest indent).`);
    } catch (err) {
      toast.error(errorOf(err, "Auto-assign failed."));
    }
    await load();
  });

  const assign = (sku, indent) => {
    const q = indent.wholeOnly ? indent.pending : Number(qty[indent.id] ?? Math.min(indent.pending, sku.available));
    return run(`assign:${indent.id}`, async () => {
      try {
        const res = await inventoryApi.assignToIndent(indent.id, q);
        toast.success(`${q} unit(s) of ${sku.skuCode} assigned to ${indent.customer} (${res.orderId}).`);
        setQty((s) => ({ ...s, [indent.id]: undefined }));
      } catch (err) {
        toast.error(errorOf(err, "Assignment failed."));
      }
      await load();
    });
  };

  const reassign = (sku, alloc) => {
    const key = `${alloc.lineId}:${alloc.seq}`;
    const target = sku.indents.find((i) => i.id === moveTo[key]);
    if (!target) return toast.error("Choose the indent to move it to.");
    const q = Number(qty[key] ?? Math.min(alloc.quantity, target.pending));
    setConfirm({
      title: `Move ${q} unit(s) of ${sku.skuCode}?`,
      description: `From ${alloc.customer} (${alloc.orderId}) to ${target.customer} (${target.indentNumber || target.bookingId}). `
        + `${alloc.customer}'s indent will wait for these units again. Both customers are notified.`,
      onConfirm: () => run(`move:${key}`, async () => {
        try {
          const res = await inventoryApi.reassignAllocation({
            orderId: alloc.orderId, lineId: alloc.lineId, seq: alloc.seq, toIndentId: target.id, quantity: q,
          });
          toast.success(`${res.quantity} unit(s) moved to ${target.customer} (${res.to}).`);
        } catch (err) {
          toast.error(errorOf(err, "Could not move the allocation."));
        }
        setConfirm(null);
        await load();
      }),
    });
    return undefined;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Indent Stock Assignment"
        subtitle="Choose which customer indent arriving stock goes to"
        actions={(
          <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={`mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        )}
      />

      {/* What arriving stock does right now, and the switch for whoever may change it. */}
      <Card className={manual ? "border-amber-200" : "border-slate-200"}>
        <CardContent className="p-4 flex flex-wrap items-center gap-4 justify-between">
          <div className="flex items-start gap-3">
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${manual ? "bg-amber-50" : "bg-emerald-50"}`}>
              {manual ? <Shuffle size={18} className="text-amber-600" /> : <Zap size={18} className="text-emerald-600" />}
            </div>
            <div>
              <p className="text-sm font-bold text-slate-800">
                {data ? (manual ? "Arriving stock is held for assignment" : "Arriving stock is assigned automatically") : "…"}
              </p>
              <p className="text-xs text-slate-500">
                {manual
                  ? "New stock waits here until someone runs Auto-assign or gives it to a specific indent."
                  : "New stock goes to waiting indents straight away, oldest first. You can still move allocations here."}
              </p>
            </div>
          </div>
          {canConfigure && data && (
            <Button size="sm" variant="secondary" onClick={toggleMode} loading={isBusy("mode")}>
              {manual ? "Switch to automatic (FIFO)" : "Hold arriving stock for assignment"}
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-56 max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search SKU, customer or indent…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:border-primary-500"
          />
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={withStockOnly} onChange={(e) => setWithStockOnly(e.target.checked)} />
          Only SKUs with stock to assign or move
        </label>
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
          <Button size="sm" variant="secondary" onClick={load}>Try again</Button>
        </CardContent></Card>
      ) : skus.length === 0 ? (
        <Card><CardContent className="p-10 text-center text-sm text-slate-500">
          <PackageCheck size={28} className="mx-auto mb-2 text-slate-300" />
          {withStockOnly ? "No waiting indent has stock to assign right now." : "No indents are waiting for stock."}
        </CardContent></Card>
      ) : (
        skus.map((sku) => (
          <Card key={sku.skuCode}>
            <CardContent className="p-0">
              <div className="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-base font-black text-slate-800">{sku.skuCode}</span>
                  {sku.brand && <span className="text-[10px] font-bold uppercase text-slate-400">{sku.brand}</span>}
                  <span className={`text-xs font-bold rounded-full px-2.5 py-1 ${sku.available ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                    {sku.available} free
                  </span>
                  <span className="text-xs text-slate-500">
                    {sku.indents.length} indent{sku.indents.length === 1 ? "" : "s"} waiting for {sku.indents.reduce((n, i) => n + i.pending, 0)}
                  </span>
                </div>
                <Button
                  size="sm"
                  onClick={() => autoAssign(sku)}
                  disabled={!sku.available || anyBusy}
                  loading={isBusy(`auto:${sku.skuCode}`)}
                  title="Give the free stock to the oldest indents first"
                >
                  <Zap size={14} className="mr-1.5" /> Auto-assign (FIFO)
                </Button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-200 text-sm">
                  <thead className="text-[10px] font-bold uppercase tracking-wide text-slate-500 bg-slate-50">
                    <tr>
                      <th className="px-5 py-2 text-left">Customer</th>
                      <th className="px-3 py-2 text-left">Indent</th>
                      <th className="px-3 py-2 text-right">Requested</th>
                      <th className="px-3 py-2 text-right">Pending</th>
                      <th className="px-3 py-2 text-left">Indent date</th>
                      <th className="px-5 py-2 text-right">Assign</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {sku.indents.map((i, idx) => {
                      const max = Math.min(i.pending, sku.available);
                      const value = i.wholeOnly ? i.pending : (qty[i.id] ?? max);
                      const tooMuch = Number(value) > sku.available;
                      return (
                        <tr key={i.id}>
                          <td className="px-5 py-2.5 font-semibold text-slate-800">
                            {i.customer}
                            {idx === 0 && <span className="ml-2 text-[9px] font-bold uppercase text-primary-600">next in FIFO</span>}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-xs text-slate-600">
                            {i.indentNumber || i.reservationId}
                            {i.bookingId && <span className="block text-[10px] text-slate-400">{i.bookingId}</span>}
                          </td>
                          <td className="px-3 py-2.5 text-right text-slate-600">{i.requested}</td>
                          <td className="px-3 py-2.5 text-right font-bold text-amber-600">{i.pending}</td>
                          <td className="px-3 py-2.5 text-slate-600 whitespace-nowrap">
                            {fmtDate(i.date)}
                            {i.scheduledDate && <span className="block text-[10px] text-slate-400">promised {fmtDate(i.scheduledDate)}</span>}
                          </td>
                          <td className="px-5 py-2.5">
                            <div className="flex items-center justify-end gap-2">
                              {i.wholeOnly ? (
                                <span className="text-[11px] text-slate-500" title="Its booking was cancelled, so it becomes a booking of its own">
                                  whole only ({i.pending})
                                </span>
                              ) : (
                                <input
                                  type="number"
                                  min={1}
                                  max={max || undefined}
                                  value={value}
                                  disabled={!sku.available}
                                  onChange={(e) => setQty((s) => ({ ...s, [i.id]: e.target.value }))}
                                  className={`w-20 text-right border rounded-lg px-2 py-1 text-sm outline-none ${tooMuch ? "border-red-400" : "border-slate-300 focus:border-primary-500"}`}
                                  aria-label={`Quantity for ${i.customer}`}
                                />
                              )}
                              <Button
                                size="xs"
                                variant="secondary"
                                onClick={() => assign(sku, i)}
                                disabled={!sku.available || tooMuch || Number(value) < 1 || (i.wholeOnly && i.pending > sku.available) || (anyBusy && !isBusy(`assign:${i.id}`))}
                                loading={isBusy(`assign:${i.id}`)}
                              >
                                Assign
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {sku.reassignable.length > 0 && (
                <div className="px-5 py-4 border-t border-slate-100 bg-slate-50/50">
                  <p className="text-xs font-bold text-slate-600 mb-2 flex items-center gap-1.5">
                    <ArrowRightLeft size={13} /> Allocated, can still be moved (no PO raised yet)
                  </p>
                  <div className="flex flex-col gap-2">
                    {sku.reassignable.map((a) => {
                      const key = `${a.lineId}:${a.seq}`;
                      const targets = sku.indents.filter((i) => !i.wholeOnly && i.indentNumber !== a.indentNumber);
                      return (
                        <div key={key} className="flex flex-wrap items-center gap-3 text-sm bg-white border border-slate-200 rounded-lg px-3 py-2">
                          <span className="font-semibold text-slate-800">{a.customer}</span>
                          <span className="font-mono text-xs text-slate-500">{a.orderId} · allocation {a.seq}</span>
                          <span className="font-bold text-emerald-700">{a.quantity} pcs</span>
                          <span className="text-slate-400">→</span>
                          <select
                            value={moveTo[key] || ""}
                            onChange={(e) => setMoveTo((s) => ({ ...s, [key]: e.target.value }))}
                            className="text-sm border border-slate-300 rounded-lg px-2 py-1 bg-white"
                            aria-label="Move to indent"
                          >
                            <option value="">Move to…</option>
                            {targets.map((i) => (
                              <option key={i.id} value={i.id}>{i.customer} — {i.indentNumber || i.reservationId} (waits {i.pending})</option>
                            ))}
                          </select>
                          <input
                            type="number"
                            min={1}
                            max={a.quantity}
                            value={qty[key] ?? a.quantity}
                            onChange={(e) => setQty((s) => ({ ...s, [key]: e.target.value }))}
                            className="w-16 text-right border border-slate-300 rounded-lg px-2 py-1 text-sm"
                            aria-label="Quantity to move"
                          />
                          <Button
                            size="xs"
                            variant="secondary"
                            onClick={() => reassign(sku, a)}
                            disabled={!moveTo[key] || anyBusy}
                            loading={isBusy(`move:${key}`)}
                          >
                            Move
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))
      )}

      <ConfirmationDialog
        isOpen={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm?.onConfirm()}
        title={confirm?.title}
        description={confirm?.description}
        confirmText="Move"
        loading={anyBusy}
      />
    </div>
  );
};

export default IndentAssignment;
