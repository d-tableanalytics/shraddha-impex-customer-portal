import { useEffect, useRef, useState } from "react";
import { RotateCcw, PackageSearch, ChevronRight, Info } from "lucide-react";

import { Unauthorized } from "../../components/common/Unauthorized";
import { Card, CardContent } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Pagination } from "../../components/ui/Pagination";
import { TableSkeleton } from "../../components/ui/TableSkeleton";
import { SearchInput } from "../../components/ui/SearchInput";
import { DateField } from "../../components/ui/DateField";
import { PageHeader } from "../../components/common/PageHeader";
import { useActivityStore } from "../../store/activityStore";
import { useUserStore } from "../../store/userStore";
import { hasPermission, PERMISSIONS } from "../../utils/permissions";
import {
  directionStyle, balanceLabel, balanceNote, quantityText, fmtQty, fmtDateTime,
} from "../../utils/stockActivity";

/**
 * SKU Activity Log.
 *
 * "What happened to this item, when, by how much, and who did it" — answered
 * without the reader needing to know what a movement class is.
 *
 * The screen renders sentences the SERVER wrote (activity.service.js). It does
 * not compose its own from a type code and the sign of a number, because the
 * Stock Ledger reads the same sentences and two renderers would eventually
 * disagree about what a RESERVE means.
 *
 * Opens on the cross-SKU feed so it is never a blank box with a search field.
 * Choosing a SKU narrows to that item's own history and adds its stock summary.
 */

const inputCls =
  "w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none " +
  "focus:border-primary-500 focus:ring-1 focus:ring-primary-500";

const Field = ({ label, children }) => (
  <div className="flex flex-col gap-1.5">
    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">{label}</label>
    {children}
  </div>
);

/** The transaction label — Stock In, Stock Out, Booking, Indent, Adjustment. */
const ActivityChip = ({ record }) => {
  const style = directionStyle(record.direction);
  const Icon = style.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-bold whitespace-nowrap ${style.chip}`}
    >
      <Icon size={12} aria-hidden="true" />
      {record.label}
    </span>
  );
};

/**
 * The quantity, said twice: as a number, and as a sentence.
 *
 * The sign is governed by `balanceKind`, NOT by whether the row is a ledger
 * movement — see `isSigned` in utils/stockActivity.js. A booking and an indent
 * both show a plain count, because neither moved any stock; only a receipt or
 * an issue gets a + or a −.
 */
const QuantityCell = ({ record }) => {
  const style = directionStyle(record.direction);
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className={`font-bold tabular-nums ${style.text}`}>
        {quantityText(record.quantity, record.balanceKind)}
      </span>
      <span className="text-[11px] text-slate-500 text-right leading-tight">
        {record.description}
      </span>
    </div>
  );
};

/**
 * Before and after, labelled by what they COUNT.
 *
 * An allocation movement's pair is the booked count, not stock on hand, so the
 * caption says "Booked" and the tooltip says why. This is the single change
 * that stops a confirmed booking reading as a delivery.
 */
const BalanceCell = ({ record }) => {
  if (!record.affectsStock || record.previousStock === null) {
    return (
      <span className="text-slate-400 text-xs" title="This transaction did not change any stock figure.">
        No stock change
      </span>
    );
  }
  const kind = balanceLabel(record.balanceKind);
  return (
    <div className="flex flex-col gap-0.5" title={balanceNote(record.balanceKind) || undefined}>
      <span className="tabular-nums text-slate-700 text-sm">
        <span className="text-slate-400">{fmtQty(record.previousStock)}</span>
        <span className="mx-1.5 text-slate-300">→</span>
        <span className="font-bold text-slate-900">{fmtQty(record.updatedStock)}</span>
      </span>
      <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
        {kind}
        {record.balanceKind === "booked" && " (stock unchanged)"}
      </span>
    </div>
  );
};

/** Opening / In / Out / Closing — the four numbers that have to add up. */
const SummaryBand = ({ summary, item }) => {
  if (!summary) return null;
  const tiles = [
    { label: "Opening Stock", value: summary.openingStock, tone: "text-slate-900" },
    { label: "Stock In", value: summary.stockIn, tone: "text-success-700", prefix: "+" },
    { label: "Stock Out", value: summary.stockOut, tone: "text-error-600", prefix: "−" },
    { label: "Closing Stock", value: summary.closingStock, tone: "text-slate-900" },
  ];
  return (
    <Card>
      <CardContent className="p-0">
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-slate-100">
          {tiles.map((t) => (
            <div key={t.label} className="px-5 py-4">
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">{t.label}</p>
              <p className={`text-2xl font-black tabular-nums mt-1 ${t.tone}`}>
                {t.prefix && t.value !== 0 ? t.prefix : ""}
                {fmtQty(t.value)}
              </p>
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/60 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-slate-600 rounded-b-xl">
          <span>
            <span className="font-bold text-slate-700">{fmtQty(summary.openingStock)}</span>
            {" + "}
            <span className="font-bold text-success-700">{fmtQty(summary.stockIn)}</span>
            {" − "}
            <span className="font-bold text-error-600">{fmtQty(summary.stockOut)}</span>
            {" = "}
            <span className="font-bold text-slate-900">{fmtQty(summary.closingStock)}</span>
          </span>
          <span>
            Currently set aside for bookings:{" "}
            <span className="font-bold text-warning-700 tabular-nums">{fmtQty(summary.reserved)}</span>
          </span>
          {summary.available !== null && summary.available !== undefined && (
            <span>
              Available to sell:{" "}
              <span className="font-bold text-slate-800 tabular-nums">{fmtQty(summary.available)}</span>
            </span>
          )}
          {/* Says plainly where the numbers came from, so "0 in, 0 out" on a
              stocked item does not read as a broken page. */}
          {summary.derivedFromBalance && (
            <span className="inline-flex items-center gap-1 text-slate-500">
              <Info size={12} aria-hidden="true" />
              No transactions in this period — showing the current balance
              {item?.skuCode ? ` for ${item.skuCode}` : ""}.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export const SkuActivityLog = () => {
  const { user } = useUserStore();
  const {
    skuCode, item, records, summary, total, pages, loading, error,
    showAll, setShowAll, activityTypes, skuOptions, skuSearchLoading,
    filters, setFilters, resetFilters, selectSku, fetch, fetchActivityTypes, searchSkus,
  } = useActivityStore();

  const [skuTerm, setSkuTerm] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  // One fetch on mount; the SKU search is its own debounced request and must
  // not fire on the first render as well.
  const firstRender = useRef(true);
  useEffect(() => {
    fetch();
    fetchActivityTypes();
    searchSkus("");
  }, [fetch, fetchActivityTypes, searchSkus]);

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    const timer = setTimeout(() => searchSkus(skuTerm), 300);
    return () => clearTimeout(timer);
    // searchSkus is a stable store action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skuTerm]);

  // Declared above the permission guard: `user` is null on the first render, so
  // the guard does not fire and these hooks run. Returning early once the user
  // loads without the permission would leave React seeing fewer hooks than last
  // render, which throws instead of redirecting.
  if (user && !hasPermission(user, PERMISSIONS.VIEW_STOCK_LEDGER)) {
    return <Unauthorized />;
  }

  const choose = (code) => {
    selectSku(code);
    setPickerOpen(false);
    setSkuTerm("");
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Activity Log"
        subtitle={
          skuCode
            ? `Everything that has happened to ${skuCode}${item?.productName ? ` — ${item.productName}` : ""}`
            : "Recent stock activity across every item you can see"
        }
        actions={(
          <div className="flex items-center gap-2">
            {skuCode && (
              <Button variant="outline" size="sm" onClick={() => choose("")}>
                All items
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => { setSkuTerm(""); resetFilters(); }}>
              <RotateCcw size={15} className="mr-2" />
              Reset
            </Button>
          </div>
        )}
      />

      {/* ── SKU picker ─────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4 flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Field label="Item">
              <SearchInput
                value={skuTerm}
                onChange={(v) => { setSkuTerm(v); setPickerOpen(true); }}
                placeholder={skuCode || "Search a SKU code"}
                label="Search for a SKU"
                busy={skuSearchLoading}
              />
            </Field>

            <Field label="Activity">
              <select
                value={filters.activityType}
                onChange={(e) => setFilters({ activityType: e.target.value })}
                className={inputCls}
              >
                <option value="">All activity</option>
                {/* Types share labels (RECEIPT and TRANSFER_IN are both "Stock
                    In"), so the option text names the type, not just the chip. */}
                {activityTypes.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                    {t.movementType && t.movementType !== t.type ? ` — ${t.movementType.toLowerCase().replace(/_/g, " ")}` : ""}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="From">
              <DateField
                value={filters.from}
                onChange={(v) => setFilters({ from: v })}
                max={filters.to || undefined}
                placeholder="Start date"
              />
            </Field>

            <Field label="To">
              <DateField
                value={filters.to}
                onChange={(v) => setFilters({ to: v })}
                min={filters.from || undefined}
                placeholder="End date"
              />
            </Field>
          </div>

          {pickerOpen && skuOptions.length > 0 && (
            <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-72 overflow-y-auto">
              {skuOptions.map((o) => (
                <button
                  key={`${o.brand}-${o.skuCode}`}
                  type="button"
                  onClick={() => choose(o.skuCode)}
                  className="w-full flex items-center justify-between gap-4 px-4 py-2.5 text-left hover:bg-slate-50 transition-colors"
                >
                  <span className="min-w-0">
                    <span className="font-bold text-slate-900">{o.skuCode}</span>
                    {o.productName && (
                      <span className="block text-xs text-slate-500 truncate">{o.productName}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-4 shrink-0 text-xs text-slate-500">
                    <span className="tabular-nums">{fmtQty(o.onHand)} on hand</span>
                    <span className="tabular-nums">{o.movementCount} records</span>
                    <ChevronRight size={14} className="text-slate-300" />
                  </span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {skuCode && <SummaryBand summary={summary} item={item} />}

      {error && (
        <div className="px-4 py-3 rounded-lg bg-error-50 border border-error-200 text-sm text-error-600 font-medium">
          {error}
        </div>
      )}

      {/* ── The log ────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-slate-100 bg-slate-50/60">
            <span className="text-sm font-bold text-slate-700">
              {showAll ? "Complete history" : "Latest 20 activities"}
            </span>
            <span className="text-xs text-slate-500">
              {total.toLocaleString("en-IN")} record{total === 1 ? "" : "s"} in total
            </span>
            {/* The brief asks for the latest 20 by default AND the ability to
                see everything. One toggle, one request — not two screens. */}
            {total > 20 && (
              <Button
                size="sm"
                variant={showAll ? "secondary" : "outline"}
                className="ml-auto"
                onClick={() => setShowAll(!showAll)}
              >
                {showAll ? "Show latest 20" : "View complete history"}
              </Button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Date &amp; Time</th>
                  {!skuCode && (
                    <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Item</th>
                  )}
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Activity</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">What happened</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Quantity</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Before → After</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Reference</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Done by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && (
                  <TableSkeleton
                    rows={records.length || 8}
                    columns={skuCode ? 7 : 8}
                    cellClass="px-5 py-4"
                  />
                )}

                {!loading && records.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50 transition-colors align-top">
                    <td className="px-5 py-4 whitespace-nowrap">
                      <span className="text-slate-700 font-semibold">{fmtDateTime(r.at)}</span>
                      {r.backdated && (
                        <span
                          className="block text-[10px] font-bold text-warning-700"
                          title={`Recorded ${fmtDateTime(r.postedAt)}`}
                        >
                          backdated
                        </span>
                      )}
                    </td>
                    {!skuCode && (
                      <td className="px-5 py-4">
                        <button
                          type="button"
                          onClick={() => choose(r.skuCode)}
                          className="font-bold text-primary-700 hover:underline text-left"
                          title="Open this item's full activity"
                        >
                          {r.skuCode}
                        </button>
                        <span className="block text-[11px] text-slate-500 max-w-48 truncate">
                          {r.productName || r.brand}
                        </span>
                      </td>
                    )}
                    <td className="px-5 py-4"><ActivityChip record={r} /></td>
                    <td className="px-5 py-4">
                      <span className="text-slate-800 font-semibold">
                        {r.action || r.description}
                      </span>
                      {/* An indent row records its RAISING, which happened
                          whatever became of the indent afterwards. Where it is
                          no longer open, say so rather than leaving the row
                          reading as if it were still outstanding. */}
                      {r.status && r.open === false && (
                        <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200">
                          {r.status}
                        </span>
                      )}
                      {r.remarks && (
                        <span className="block text-[11px] text-slate-500 max-w-64">{r.remarks}</span>
                      )}
                      {!r.remarks && r.reasonCode && (
                        <span className="block text-[11px] text-slate-400 font-semibold uppercase">
                          {r.reasonCode.replace(/_/g, " ")}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4"><QuantityCell record={r} /></td>
                    <td className="px-5 py-4"><BalanceCell record={r} /></td>
                    <td className="px-5 py-4">
                      {r.referenceNumber ? (
                        <>
                          <span className="text-[11px] font-bold text-slate-500 uppercase">
                            {r.referenceLabel}
                          </span>
                          <span className="block font-mono text-[11px] text-slate-700">
                            {r.referenceNumber}
                          </span>
                        </>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-5 py-4 text-xs">
                      {r.actor?.type === "system" ? (
                        <span className="font-bold text-slate-500 uppercase">System</span>
                      ) : (
                        <span className="text-slate-700 font-medium">{r.actor?.name || "—"}</span>
                      )}
                    </td>
                  </tr>
                ))}

                {!loading && records.length === 0 && !error && (
                  <tr>
                    <td colSpan={skuCode ? 7 : 8} className="px-6 py-14 text-center">
                      <PackageSearch size={28} className="mx-auto text-slate-300 mb-3" />
                      <p className="text-slate-600 font-semibold">
                        {skuCode ? `No activity recorded for ${skuCode}` : "No activity yet"}
                      </p>
                      <p className="text-slate-500 text-xs mt-1 max-w-md mx-auto">
                        Stock receipts, issues, adjustments, bookings and indents appear here the
                        moment they happen.
                      </p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Paging belongs to the complete history. The latest-20 view is a
              fixed window by definition, so offering page 2 of it would be a
              contradiction. */}
          {showAll && total > 0 && pages > 1 && (
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50/60 rounded-b-xl">
              <Pagination
                page={filters.page}
                pageSize={50}
                totalItems={total}
                onPageChange={(page) => setFilters({ page })}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default SkuActivityLog;
