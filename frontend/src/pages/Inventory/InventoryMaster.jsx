import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Boxes, Search, AlertCircle, X, Save, Loader2, Layers, PackagePlus, Upload } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';

import { Card, CardContent } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Pagination } from '../../components/ui/Pagination';
import { TableSkeleton } from '../../components/ui/TableSkeleton';
import { PageHeader } from '../../components/common/PageHeader';
import { BulkPlanningEditor } from '../../components/inventory/BulkPlanningEditor';
import { UpdateStockModal } from '../../components/inventory/UpdateStockModal';
import { ExportButton } from '../../components/inventory/ExportButton';
import { SkuLookupModal } from '../../components/inventory/SkuLookupModal';
import { inventoryApi } from '../../services/inventory';
import { useInventoryStore } from '../../store/inventoryStore';
import { useUserStore } from '../../store/userStore';
import { allowedBrands } from '../../utils/brandAccess';
import { canUseInventoryMaster, canEditPlanning, canAdjustStock } from '../../utils/permissions';
import { onStockUpdated } from '../../services/socketService';

/**
 * Inventory Master — IMS Module M1, blueprint screen S1 (basic).
 *
 * Deliberately shows NO health band, Max Level or Available % — those are
 * derived values owned by Module M4, and a half-computed band would be worse
 * than none. What it does show is `hasPlanningInputs`, because roughly 90% of
 * the catalogue is missing the lead time or consumption figures the health
 * calculation will need, and that data-cleanup worklist is the most actionable
 * thing available before M4 lands.
 *
 * Left for later modules: stock movements, adjustments, counts, export.
 */

const SORT_OPTIONS = [
  { value: 'sku-asc', label: 'SKU (A–Z)' },
  { value: 'sku-desc', label: 'SKU (Z–A)' },
  { value: 'stock-desc', label: 'Stock (high to low)' },
  { value: 'stock-asc', label: 'Stock (low to high)' },
  { value: 'updated-desc', label: 'Recently updated' },
];

const STATUS_STYLES = {
  Active: 'bg-success-50 text-success-700',
  Inactive: 'bg-slate-100 text-slate-600',
  Discontinued: 'bg-error-50 text-error-600',
};

const SEASONS = ['Low', 'Normal', 'Peak'];

/** Read-only balance tile. Values come from the legacy product fields until M3. */
const Balance = ({ label, value, accent }) => (
  <div className="flex flex-col bg-slate-50/70 p-3 rounded-lg border border-slate-100">
    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>
    <span className={`text-base font-black ${accent || 'text-slate-800'}`}>{value}</span>
  </div>
);

/**
 * Detail + planning editor. Balance fields are shown but never editable — they
 * move only through the stock ledger (BR-03), and the server rejects them here
 * regardless of what the UI offers.
 */
const DetailPanel = ({ item, onClose, canEdit, onSave, saving }) => {
  const [form, setForm] = useState(null);

  useEffect(() => {
    if (!item) { setForm(null); return; }
    setForm({
      description: item.description || '',
      uom: item.uom || 'PCS',
      leadTime: item.planning.leadTime ?? 0,
      safetyFactor: item.planning.safetyFactor ?? 0,
      moq: item.moq ?? 0,
      currentSeason: item.planning.currentSeason || 'Normal',
      dacLow: item.planning.dailyAvgConsumption.low ?? 0,
      dacNormal: item.planning.dailyAvgConsumption.normal ?? 0,
      dacPeak: item.planning.dailyAvgConsumption.peak ?? 0,
      status: item.status,
      boxNo: item.boxNo || '',
      vendorName: item.vendorName || '',
    });
  }, [item]);

  if (!item || !form) return null;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSave = () => {
    onSave({
      description: form.description || null,
      uom: form.uom,
      leadTime: Number(form.leadTime),
      safetyFactor: Number(form.safetyFactor),
      moq: Number(form.moq),
      currentSeason: form.currentSeason,
      dailyAvgConsumption: {
        low: Number(form.dacLow),
        normal: Number(form.dacNormal),
        peak: Number(form.dacPeak),
      },
      status: form.status,
      boxNo: form.boxNo || null,
      vendorName: form.vendorName || null,
    });
  };

  return (
    <motion.aside
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'spring', stiffness: 320, damping: 34 }}
      className="fixed right-0 top-0 h-full w-full max-w-xl bg-white border-l border-slate-200 shadow-enterprise-lg z-50 flex flex-col"
    >
      <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
            {item.brand}
          </p>
          <h3 className="text-lg font-black text-slate-900 truncate">{item.skuCode}</h3>
          {item.msilCode && (
            <p className="text-xs font-semibold text-slate-500">MSIL {item.msilCode}</p>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors shrink-0"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
        <div>
          <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">
            Balances
          </h4>
          <div className="grid grid-cols-2 gap-3">
            <Balance label="On Hand" value={item.balances.onHand} />
            <Balance label="Reserved" value={item.balances.reserved} />
            <Balance label="Available" value={item.balances.available} accent="text-primary-700" />
            <Balance label="In Transit" value={item.balances.inTransit} />
          </div>
          <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
            Read-only. Balances change only through stock movements, which arrive
            with the stock ledger module.
          </p>
        </div>

        <div>
          <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">
            Planning inputs
          </h4>
          {!item.hasPlanningInputs && (
            <div className="flex items-start gap-2 mb-4 p-3 rounded-lg bg-warning-50 border border-warning-200">
              <AlertCircle size={16} className="text-warning-600 shrink-0 mt-0.5" />
              <p className="text-xs text-warning-800 leading-relaxed">
                This SKU is missing a lead time or a daily consumption figure for its
                current season, so no stock target can be calculated for it yet.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Lead Time (days)" type="number" min="0"
              value={form.leadTime} onChange={set('leadTime')} disabled={!canEdit}
            />
            <Input
              label="Safety Factor" type="number" min="0" step="0.01"
              value={form.safetyFactor} onChange={set('safetyFactor')} disabled={!canEdit}
            />

            <div className="w-full flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-slate-700 select-none">
                Current Season
              </label>
              <select
                value={form.currentSeason} onChange={set('currentSeason')} disabled={!canEdit}
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:bg-slate-50 disabled:text-slate-500"
              >
                {SEASONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <Input label="MOQ" type="number" min="0" value={form.moq} onChange={set('moq')} disabled={!canEdit} />

            <Input
              label="Daily Avg (Low)" type="number" min="0" step="0.0001"
              value={form.dacLow} onChange={set('dacLow')} disabled={!canEdit}
            />
            <Input
              label="Daily Avg (Normal)" type="number" min="0" step="0.0001"
              value={form.dacNormal} onChange={set('dacNormal')} disabled={!canEdit}
            />
            <Input
              label="Daily Avg (Peak)" type="number" min="0" step="0.0001"
              value={form.dacPeak} onChange={set('dacPeak')} disabled={!canEdit}
            />
            <Input label="Unit of Measure" value={form.uom} onChange={set('uom')} disabled={!canEdit} />
          </div>
        </div>

        <div>
          <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">
            Identity
          </h4>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Input
                label="Description" value={form.description} onChange={set('description')}
                disabled={!canEdit} placeholder="Optional — falls back to the SKU code"
              />
            </div>
            <Input label="Box No" value={form.boxNo} onChange={set('boxNo')} disabled={!canEdit} />
            <Input label="Vendor" value={form.vendorName} onChange={set('vendorName')} disabled={!canEdit} />

            <div className="w-full flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-slate-700 select-none">Status</label>
              <select
                value={form.status} onChange={set('status')} disabled={!canEdit}
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:bg-slate-50 disabled:text-slate-500"
              >
                {['Active', 'Inactive', 'Discontinued'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
            A SKU still holding or owing stock cannot be deactivated.
          </p>
        </div>
      </div>

      {canEdit && (
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/50 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={handleSave} loading={saving}>
            {!saving && <Save size={15} className="mr-2" />}
            Save Changes
          </Button>
        </div>
      )}
    </motion.aside>
  );
};

export const InventoryMaster = () => {
  const { user } = useUserStore();
  const {
    items, total, catalogueTotal, loading, error,
    filters, setFilters, fetchItems,
    selected, detailLoading, openItem, closeItem, savePlanning,
  } = useInventoryStore();

  const [searchTerm, setSearchTerm] = useState('');

  // True from the first keystroke, not only once the request is in flight.
  // The search box waits 300ms before firing, and during that pause the old
  // rows sat there looking like the filter had been ignored. This spans the
  // debounce window and the request as one continuous "working" state.
  const filtering = loading || searchTerm !== filters.search;
  const [saving, setSaving] = useState(false);

  // Bulk selection. Held as SKU codes rather than row indexes so a selection
  // survives a re-sort or a refetch — the identity of a row is its SKU, not its
  // position in the current page.
  const [picked, setPicked] = useState(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);

  // The SKU whose stock is being adjusted, or null. Held as {skuCode, brand}
  // because the adjustment endpoint is brand-scoped and the same SKU code can
  // exist under more than one brand.
  const [adjusting, setAdjusting] = useState(null);
  const [lookupOpen, setLookupOpen] = useState(false);

  const togglePick = (skuCode) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(skuCode)) next.delete(skuCode); else next.add(skuCode);
    return next;
  });

  const pageSkus = items.map((i) => i.skuCode);
  const allOnPagePicked = pageSkus.length > 0 && pageSkus.every((s) => picked.has(s));

  // The header checkbox selects EVERY SKU matching the current filter, not just
  // the rows on screen — the filter is what the user has already told us they
  // mean. It fetches the matching codes rather than assuming the page is all
  // there is, so a selection of 8,000 is real rather than a promise the bulk
  // editor would have to make good on later.
  //
  // The count is stated in the toolbar before any action is possible, and the
  // server refuses a filter matching more than 10,000.
  const [selectingAll, setSelectingAll] = useState(false);

  const toggleAllMatching = async () => {
    if (picked.size > 0) { setPicked(new Set()); return; }
    setSelectingAll(true);
    try {
      const { skuCodes } = await inventoryApi.listItemCodes({
        search: filters.search, brand: filters.brand,
        status: filters.status,
      });
      setPicked(new Set(skuCodes));
      if (skuCodes.length) toast.success(`${skuCodes.length.toLocaleString()} SKU(s) selected.`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not select every matching SKU.');
    } finally {
      setSelectingAll(false);
    }
  };

  // One fetch on mount, then one per settled search term.
  //
  // Previously a mount effect called fetchItems() while a separate debounce
  // effect also fired setFilters({search: ''}) 300ms later — so every visit
  // cost two identical list requests. The debounce now skips its first run and
  // the mount effect owns the initial load.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const timer = setTimeout(() => setFilters({ search: searchTerm }), 300);
    return () => clearTimeout(timer);
    // setFilters is a stable store action; searchTerm is the only real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  // A stock correction posted by anyone — this tab or another user's — refreshes
  // the list, so an on-hand figure on screen is never one someone has already
  // superseded.
  useEffect(() => onStockUpdated(() => fetchItems()), [fetchItems]);

  // The route is also guarded server-side on every request; this only avoids
  // rendering a screen the user could not populate.
  if (user && !canUseInventoryMaster(user)) return <Navigate to="/" replace />;

  const canEdit = canEditPlanning(user);
  const canAdjust = canAdjustStock(user);
  const brands = allowedBrands(user);
  const missingInputs = items.filter((i) => !i.hasPlanningInputs).length;

  const handleSave = async (updates) => {
    setSaving(true);
    const res = await savePlanning(selected.skuCode, updates);
    setSaving(false);
    if (res.success) toast.success(`${selected.skuCode} updated.`);
    else toast.error(res.error);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Inventory Master"
        actions={(
          <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setLookupOpen(true)}>
            <Upload size={15} className="mr-2" />Import
          </Button>
          <ExportButton
            exportType="inventory-master"
            filters={{
              search: filters.search, brand: filters.brand,
              status: filters.status,
            }}
            selected={[...picked]}
          />
          </div>
        )}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardContent className="p-5 flex items-center gap-4">
            <div className="w-11 h-11 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 shrink-0">
              <Boxes size={22} />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Total SKUs</p>
              <h3 className="text-2xl font-bold text-slate-900">{catalogueTotal.toLocaleString()}</h3>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 flex items-center gap-4">
            <div className="w-11 h-11 rounded-full bg-primary-50 flex items-center justify-center text-primary-600 shrink-0">
              <Search size={22} />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Matching Filter</p>
              <h3 className="text-2xl font-bold text-slate-900">{total.toLocaleString()}</h3>
            </div>
          </CardContent>
        </Card>

        {/* The launch worklist: SKUs that cannot be planned until someone fills
            in their lead time or consumption figures. */}
        <Card>
          <CardContent className="p-5 flex items-center gap-4">
            <div className="w-11 h-11 rounded-full bg-warning-50 flex items-center justify-center text-warning-600 shrink-0">
              <AlertCircle size={22} />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                Missing Planning Data
              </p>
              <h3 className="text-2xl font-bold text-slate-900">
                {missingInputs}
                <span className="text-sm font-semibold text-slate-400"> / {items.length} shown</span>
              </h3>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="p-4 border-b border-slate-200 bg-slate-50 flex flex-col lg:flex-row justify-between items-center gap-4 rounded-t-xl">
            <div className="relative w-full lg:w-80">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <input
                type="text"
                placeholder="Search by SKU or MSIL code..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 text-sm font-medium text-slate-800"
              />
            </div>

            <div className="flex flex-wrap gap-2 w-full lg:w-auto">
              {brands.length > 1 && (
                <select
                  value={filters.brand}
                  onChange={(e) => setFilters({ brand: e.target.value })}
                  className="px-3 py-1.5 border border-slate-300 rounded-md text-sm font-medium text-slate-700 bg-white outline-none focus:ring-1 focus:ring-primary-500 cursor-pointer"
                >
                  <option value="">All Brands</option>
                  {brands.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              )}

              <select
                value={filters.status}
                onChange={(e) => setFilters({ status: e.target.value })}
                className="px-3 py-1.5 border border-slate-300 rounded-md text-sm font-medium text-slate-700 bg-white outline-none focus:ring-1 focus:ring-primary-500 cursor-pointer"
              >
                <option value="">All Statuses</option>
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
                <option value="Discontinued">Discontinued</option>
              </select>

              <select
                value={filters.sort}
                onChange={(e) => setFilters({ sort: e.target.value })}
                className="px-3 py-1.5 border border-slate-300 rounded-md text-sm font-medium text-slate-700 bg-white outline-none focus:ring-1 focus:ring-primary-500 cursor-pointer"
              >
                {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          {error && (
            <div className="px-6 py-3 bg-error-50 border-b border-error-200 text-sm text-error-700 font-medium">
              {error}
            </div>
          )}

          {/* Bulk action bar. Appears only with a selection, and states the count
              plainly so the size of what is about to change is never a surprise. */}
          {canEdit && picked.size > 0 && (
            <div className="flex flex-wrap items-center gap-3 px-6 py-3 bg-primary-50 border-y border-primary-100">
              <Layers size={16} className="text-primary-700 shrink-0" />
              <span className="text-sm font-bold text-primary-900">
                {picked.size.toLocaleString()} SKU{picked.size === 1 ? '' : 's'} selected
              </span>
              <span className="text-[11px] text-primary-700/70">
                {picked.size > items.length
                  ? 'Everything matching the current filter, across all pages.'
                  : 'Selection is by SKU, so it survives sorting and paging.'}
              </span>
              {/* `sm` rather than `xs`: these two commit or discard a change
                  across thousands of rows, so they get a comfortable target
                  rather than the compact sizing used for pagers. */}
              <div className="ml-auto flex items-center gap-2.5">
                <Button size="sm" variant="secondary" onClick={() => setPicked(new Set())}>
                  Clear
                </Button>
                <Button size="sm" onClick={() => setBulkOpen(true)}>
                  Edit selected
                </Button>
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  {canEdit && (
                    <th className="pl-6 pr-2 py-4 w-10">
                      <input
                        type="checkbox"
                        className="w-4 h-4 accent-primary-600 cursor-pointer"
                        aria-label="Select every SKU matching the current filter"
                        checked={picked.size > 0}
                        ref={(el) => { if (el) el.indeterminate = picked.size > 0 && !allOnPagePicked; }}
                        disabled={selectingAll}
                        onChange={toggleAllMatching}
                      />
                    </th>
                  )}
                  <th className="px-6 py-4 font-bold text-slate-600 uppercase text-xs">SKU</th>
                  <th className="px-6 py-4 font-bold text-slate-600 uppercase text-xs">MSIL</th>
                  <th className="px-6 py-4 font-bold text-slate-600 uppercase text-xs">Brand / Category</th>
                  <th className="px-6 py-4 font-bold text-slate-600 uppercase text-xs text-right">On Hand</th>
                  <th className="px-6 py-4 font-bold text-slate-600 uppercase text-xs text-right">Reserved</th>
                  <th className="px-6 py-4 font-bold text-slate-600 uppercase text-xs text-right">Available</th>
                  <th className="px-6 py-4 font-bold text-slate-600 uppercase text-xs text-center">Planning</th>
                  <th className="px-6 py-4 font-bold text-slate-600 uppercase text-xs">Status</th>
                  {canAdjust && <th className="px-6 py-4 w-px" aria-label="Actions" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtering && (
                  <TableSkeleton
                    rows={items.length || 10}
                    columns={8 + (canEdit ? 1 : 0) + (canAdjust ? 1 : 0)}
                  />
                )}

                {!filtering && items.map((item) => (
                  <tr
                    key={item.id}
                    onClick={() => openItem(item.skuCode)}
                    className={`transition-colors cursor-pointer ${
                      picked.has(item.skuCode) ? 'bg-primary-50/60' : 'hover:bg-slate-50'
                    }`}
                  >
                    {canEdit && (
                      <td className="pl-6 pr-2 py-4" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${item.skuCode}`}
                          className="w-4 h-4 accent-primary-600 cursor-pointer"
                          checked={picked.has(item.skuCode)}
                          onChange={() => togglePick(item.skuCode)}
                        />
                      </td>
                    )}
                    <td className="px-6 py-4 font-bold text-slate-900">
                      {item.skuCode}
                      {item.description && (
                        <span className="block text-[11px] font-medium text-slate-400 truncate max-w-56">
                          {item.description}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 font-semibold text-slate-600">{item.msilCode || '—'}</td>
                    <td className="px-6 py-4">
                      <span className="font-bold text-slate-700 text-xs block">{item.brand}</span>
                      <span className="text-[11px] text-slate-500 font-medium">
                        {item.category.join(', ') || '—'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right font-semibold text-slate-800 tabular-nums">
                      {item.balances.onHand.toLocaleString()}
                    </td>
                    <td className="px-6 py-4 text-right font-semibold text-slate-500 tabular-nums">
                      {item.balances.reserved.toLocaleString()}
                    </td>
                    <td className="px-6 py-4 text-right font-bold text-primary-700 tabular-nums">
                      {item.balances.available.toLocaleString()}
                    </td>
                    <td className="px-6 py-4 text-center">
                      {item.hasPlanningInputs ? (
                        <span className="inline-flex px-2 py-1 rounded-md text-[11px] font-bold bg-success-50 text-success-700">
                          Ready
                        </span>
                      ) : (
                        <span
                          className="inline-flex px-2 py-1 rounded-md text-[11px] font-bold bg-warning-50 text-warning-700"
                          title="Missing lead time or daily consumption for the current season"
                        >
                          Incomplete
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex px-2 py-1 rounded-md text-[11px] font-bold ${STATUS_STYLES[item.status] || STATUS_STYLES.Inactive}`}>
                        {item.status}
                      </span>
                    </td>
                    {/* stopPropagation, or the row's own click opens the detail
                        panel behind the dialog. */}
                    {canAdjust && (
                      <td className="px-6 py-4 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => setAdjusting({ skuCode: item.skuCode, brand: item.brand })}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold
                                     text-slate-600 border border-slate-200 bg-white hover:bg-primary-50
                                     hover:text-primary-700 hover:border-primary-300 transition-colors"
                        >
                          <PackagePlus size={13} />
                          Update stock
                        </button>
                      </td>
                    )}
                  </tr>
                ))}

                {!filtering && items.length === 0 && (
                  <tr>
                    <td
                      colSpan={8 + (canEdit ? 1 : 0) + (canAdjust ? 1 : 0)}
                      className="px-6 py-12 text-center text-slate-500 font-medium"
                    >
                      No products match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {total > 0 && (
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50/60 rounded-b-xl">
              <Pagination
                page={filters.page}
                pageSize={filters.limit}
                totalItems={total}
                onPageChange={(page) => setFilters({ page })}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* The drawer opens on the loading state too, not just once the response
          lands — otherwise a row click produced no feedback at all until the
          request returned. */}
      <AnimatePresence>
        {(selected || detailLoading) && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={closeItem}
              className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-40"
            />
            {selected ? (
              <DetailPanel
                item={selected}
                onClose={closeItem}
                canEdit={canEdit}
                onSave={handleSave}
                saving={saving}
              />
            ) : (
              <motion.aside
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ type: 'spring', stiffness: 320, damping: 34 }}
                className="fixed right-0 top-0 h-full w-full max-w-xl bg-white border-l border-slate-200 shadow-enterprise-lg z-50 flex items-center justify-center"
              >
                <div className="flex flex-col items-center gap-3 text-slate-400">
                  <Loader2 className="animate-spin" size={28} />
                  <p className="text-sm font-semibold">Loading product…</p>
                </div>
              </motion.aside>
            )}
          </>
        )}
      </AnimatePresence>

      <BulkPlanningEditor
        open={bulkOpen}
        skuCodes={[...picked]}
        onClose={() => setBulkOpen(false)}
        // The list is refetched but the SELECTION IS KEPT, so a partial result
        // can be inspected against the rows it applied to. Clearing here would
        // throw away the context the warning panel is describing.
        onDone={() => fetchItems()}
      />

      <SkuLookupModal open={lookupOpen} onClose={() => setLookupOpen(false)} />

      <UpdateStockModal
        open={Boolean(adjusting)}
        skuCode={adjusting?.skuCode}
        brand={adjusting?.brand}
        onClose={() => setAdjusting(null)}
        onDone={() => fetchItems()}
      />
    </div>
  );
};

export default InventoryMaster;
