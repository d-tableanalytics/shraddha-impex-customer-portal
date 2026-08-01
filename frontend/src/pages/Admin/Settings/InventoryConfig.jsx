import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Save, Loader2, MapPin, Plus, Star, History, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';

import { Card, CardContent } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Modal } from '../../../components/ui/Modal';
import { PageHeader } from '../../../components/common/PageHeader';
import { useInventoryConfigStore } from '../../../store/inventoryStore';
import { useUserStore } from '../../../store/userStore';
import { canConfigureInventory } from '../../../utils/permissions';

/**
 * Inventory Configuration — IMS Module M1, blueprint screen S10.
 *
 * Thresholds, the Max Level formula version, operational limits, reason codes
 * and locations. Every save writes a NEW configuration version rather than
 * mutating the current one, so the change history below is the audit trail.
 *
 * The values configured here are consumed by Module M4 (health) and M7
 * (adjustments and counts). They are set up now because the thresholds must
 * exist and be auditable before anything reads them.
 */

const LOCATION_TYPES = ['Warehouse', 'Shop', 'Transit', 'Virtual'];

const Section = ({ title, description, children }) => (
  <Card>
    <CardContent className="p-6 flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-bold text-slate-800">{title}</h3>
        {description && (
          <p className="text-xs text-slate-500 mt-1 leading-relaxed max-w-2xl">{description}</p>
        )}
      </div>
      {children}
    </CardContent>
  </Card>
);

export const InventoryConfig = () => {
  const { user } = useUserStore();
  const {
    config, history, locations, loading, saving, error,
    fetchAll, fetchHistory, saveConfig,
    createLocation, updateLocation, setDefaultLocation,
  } = useInventoryConfigStore();

  const [form, setForm] = useState(null);
  const [showLocationModal, setShowLocationModal] = useState(false);
  const [newLocation, setNewLocation] = useState({ code: '', name: '', type: 'Warehouse' });
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    fetchAll();
    fetchHistory();
  }, [fetchAll, fetchHistory]);

  useEffect(() => {
    if (!config) return;
    setForm({
      critical: config.thresholds?.critical ?? 33,
      low: config.thresholds?.low ?? 66,
      healthy: config.thresholds?.healthy ?? 100,
      formulaVersion: config.formulaVersion || 'v1',
      adjustmentApprovalThreshold: config.adjustmentApprovalThreshold ?? 100,
      backdatingWindowDays: config.backdatingWindowDays ?? 30,
      deadStockDays: config.deadStockDays ?? 180,
      changeNote: '',
    });
  }, [config]);

  if (user && !canConfigureInventory(user)) return <Navigate to="/" replace />;

  if (loading || !form) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="animate-spin text-slate-400" size={32} />
      </div>
    );
  }

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const formulaChanged = form.formulaVersion !== config?.formulaVersion;
  const thresholdsValid =
    Number(form.critical) > 0 &&
    Number(form.critical) < Number(form.low) &&
    Number(form.low) < Number(form.healthy);

  const handleSave = async () => {
    if (!thresholdsValid) {
      toast.error('Thresholds must increase: 0 < critical < low < healthy.');
      return;
    }

    const payload = {
      thresholds: {
        critical: Number(form.critical),
        low: Number(form.low),
        healthy: Number(form.healthy),
      },
      adjustmentApprovalThreshold: Number(form.adjustmentApprovalThreshold),
      backdatingWindowDays: Number(form.backdatingWindowDays),
      deadStockDays: Number(form.deadStockDays),
      changeNote: form.changeNote || null,
    };

    // The two formulas differ by 3x on the current data, so the server refuses
    // the change unless the client explicitly confirms it.
    if (formulaChanged) {
      payload.formulaVersion = form.formulaVersion;
      payload.confirmFormulaChange = true;
    }

    const res = await saveConfig(payload);
    if (res.success) toast.success('Inventory configuration saved.');
    else toast.error(res.error);
  };

  const handleCreateLocation = async () => {
    if (!newLocation.code.trim() || !newLocation.name.trim()) {
      toast.error('Code and name are required.');
      return;
    }
    const res = await createLocation(newLocation);
    if (res.success) {
      toast.success(`Location ${newLocation.code.toUpperCase()} created.`);
      setShowLocationModal(false);
      setNewLocation({ code: '', name: '', type: 'Warehouse' });
    } else {
      toast.error(res.error);
    }
  };

  const toggleLocationActive = async (loc) => {
    const res = await updateLocation(loc._id, { active: !loc.active });
    if (res.success) toast.success(`${loc.code} ${loc.active ? 'deactivated' : 'reactivated'}.`);
    else toast.error(res.error);
  };

  const promoteLocation = async (loc) => {
    const res = await setDefaultLocation(loc._id);
    if (res.success) toast.success(`${loc.code} is now the default location.`);
    else toast.error(res.error);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Inventory Configuration"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowHistory(true)}>
              <History size={15} className="mr-2" />
              Change History
            </Button>
            <Button size="sm" onClick={handleSave} loading={saving} disabled={!thresholdsValid}>
              {!saving && <Save size={15} className="mr-2" />}
              Save Changes
            </Button>
          </div>
        }
      />

      {error && (
        <div className="px-4 py-3 rounded-lg bg-error-50 border border-error-200 text-sm text-error-700 font-medium">
          {error}
        </div>
      )}

      <Section
        title="Stock Health Thresholds"
        description="Percentage boundaries used to classify a SKU once stock health is calculated. Seeded to match the spreadsheet the business uses today. Each band runs up to and including its boundary."
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Input
            label="Critical at or below (%)" type="number" min="1"
            value={form.critical} onChange={set('critical')}
            helperText="Reorder point"
          />
          <Input
            label="Low at or below (%)" type="number" min="1"
            value={form.low} onChange={set('low')}
            helperText="Watch — plan a purchase"
          />
          <Input
            label="Healthy at or below (%)" type="number" min="1"
            value={form.healthy} onChange={set('healthy')}
            helperText="Above this is overstock"
          />
        </div>

        {!thresholdsValid && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-error-50 border border-error-200">
            <AlertTriangle size={16} className="text-error-600 shrink-0 mt-0.5" />
            <p className="text-xs text-error-700 leading-relaxed">
              Thresholds must increase strictly: <strong>0 &lt; critical &lt; low &lt; healthy</strong>.
              Out-of-order values make the band classification ambiguous.
            </p>
          </div>
        )}
      </Section>

      <Section
        title="Max Level Formula"
        description="How the stock target is derived from daily consumption, lead time and the safety factor. Version 1 reproduces the current spreadsheet exactly. Version 2 is the conventional additive form and produces roughly three times the target on today's data."
      >
        <div className="flex flex-col gap-3">
          {[
            { value: 'v1', label: 'Version 1 — Consumption × Lead Time × Safety Factor', hint: 'Matches the existing spreadsheet' },
            { value: 'v2', label: 'Version 2 — Consumption × Lead Time × (1 + Safety Factor)', hint: 'Conventional safety-stock model' },
          ].map((opt) => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 p-3.5 rounded-lg border cursor-pointer transition-colors ${
                form.formulaVersion === opt.value
                  ? 'border-primary-400 bg-primary-50/50'
                  : 'border-slate-200 hover:bg-slate-50'
              }`}
            >
              <input
                type="radio" name="formulaVersion" value={opt.value}
                checked={form.formulaVersion === opt.value}
                onChange={set('formulaVersion')}
                className="mt-0.5 w-4 h-4 text-primary-600 border-slate-300 focus:ring-primary-500"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-800">{opt.label}</span>
                <span className="block text-xs text-slate-500 mt-0.5">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>

        {formulaChanged && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-warning-50 border border-warning-200">
            <AlertTriangle size={16} className="text-warning-600 shrink-0 mt-0.5" />
            <p className="text-xs text-warning-800 leading-relaxed">
              Changing the formula re-values the stock target for <strong>every SKU</strong> and
              will move every health figure. Saving records the change against your account.
            </p>
          </div>
        )}
      </Section>

      <Section
        title="Operational Limits"
        description="Applied by the stock adjustment and count workflows when those modules ship."
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Input
            label="Adjustment approval above (units)" type="number" min="0"
            value={form.adjustmentApprovalThreshold} onChange={set('adjustmentApprovalThreshold')}
            helperText="Larger corrections need a second person"
          />
          <Input
            label="Backdating window (days)" type="number" min="0"
            value={form.backdatingWindowDays} onChange={set('backdatingWindowDays')}
            helperText="Older entries require approval"
          />
          <Input
            label="Dead stock after (days)" type="number" min="0"
            value={form.deadStockDays} onChange={set('deadStockDays')}
            helperText="No issue movement for this long"
          />
        </div>

        <Input
          label="Change note (optional)"
          value={form.changeNote} onChange={set('changeNote')}
          placeholder="Why is this changing? Recorded in the history."
        />
      </Section>

      <Section
        title="Reason Codes"
        description="Categorised reasons for stock adjustments and count variances. A code already used on a movement is deactivated rather than deleted, so historical records stay readable."
      >
        <div className="overflow-x-auto -mx-6 px-6">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200">
              <tr>
                <th className="py-2.5 pr-4 font-bold text-slate-600 uppercase text-[11px]">Code</th>
                <th className="py-2.5 pr-4 font-bold text-slate-600 uppercase text-[11px]">Label</th>
                <th className="py-2.5 pr-4 font-bold text-slate-600 uppercase text-[11px]">Group</th>
                <th className="py-2.5 pr-4 font-bold text-slate-600 uppercase text-[11px]">Direction</th>
                <th className="py-2.5 font-bold text-slate-600 uppercase text-[11px]">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(config?.reasonCodes || []).map((r) => (
                <tr key={r.code}>
                  <td className="py-2.5 pr-4 font-mono text-xs font-bold text-slate-800">{r.code}</td>
                  <td className="py-2.5 pr-4 text-slate-700">{r.label}</td>
                  <td className="py-2.5 pr-4 text-slate-500">{r.group}</td>
                  <td className="py-2.5 pr-4 text-slate-500">{r.direction}</td>
                  <td className="py-2.5">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-bold ${
                      r.active ? 'bg-success-50 text-success-700' : 'bg-slate-100 text-slate-500'
                    }`}>
                      {r.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))}
              {(config?.reasonCodes || []).length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-500">
                    No reason codes configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Stock Locations"
        description="Where stock is held. The system runs on a single default location until multi-site is enabled; every movement posted without an explicit location lands on the default."
      >
        <div className="flex flex-col gap-2">
          {locations.length === 0 && (
            <div className="p-6 text-center rounded-lg border border-dashed border-slate-200">
              <p className="text-sm font-semibold text-slate-600">No locations configured</p>
              <p className="text-xs text-slate-500 mt-1">
                A default location is normally created on first start. Add one to continue.
              </p>
            </div>
          )}
          {locations.map((loc) => (
            <div
              key={loc._id}
              className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 bg-white"
            >
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                loc.active ? 'bg-primary-50 text-primary-600' : 'bg-slate-100 text-slate-400'
              }`}>
                <MapPin size={17} />
              </div>

              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-slate-800 truncate">
                  {loc.name}
                  <span className="ml-2 font-mono text-[11px] font-semibold text-slate-400">
                    {loc.code}
                  </span>
                </p>
                <p className="text-[11px] text-slate-500 font-medium">{loc.type}</p>
              </div>

              {loc.isDefault && (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold bg-primary-50 text-primary-700 shrink-0">
                  <Star size={11} /> Default
                </span>
              )}
              {!loc.active && (
                <span className="inline-flex px-2 py-1 rounded text-[11px] font-bold bg-slate-100 text-slate-500 shrink-0">
                  Inactive
                </span>
              )}

              <div className="flex items-center gap-1.5 shrink-0">
                {!loc.isDefault && loc.active && (
                  <Button size="sm" variant="ghost" onClick={() => promoteLocation(loc)}>
                    Make default
                  </Button>
                )}
                {!loc.isDefault && (
                  <Button size="sm" variant="outline" onClick={() => toggleLocationActive(loc)}>
                    {loc.active ? 'Deactivate' : 'Reactivate'}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div>
          <Button variant="outline" size="sm" onClick={() => setShowLocationModal(true)}>
            <Plus size={15} className="mr-2" />
            Add Location
          </Button>
        </div>
      </Section>

      <Modal
        isOpen={showLocationModal}
        onClose={() => setShowLocationModal(false)}
        title="Add Stock Location"
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Code"
            value={newLocation.code}
            onChange={(e) => setNewLocation((l) => ({ ...l, code: e.target.value }))}
            placeholder="MANESAR"
            helperText="Short identifier used on movements and imports"
          />
          <Input
            label="Name"
            value={newLocation.name}
            onChange={(e) => setNewLocation((l) => ({ ...l, name: e.target.value }))}
            placeholder="Manesar Warehouse"
          />
          <div className="w-full flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-700">Type</label>
            <select
              value={newLocation.type}
              onChange={(e) => setNewLocation((l) => ({ ...l, type: e.target.value }))}
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            >
              {LOCATION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setShowLocationModal(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleCreateLocation}>Create Location</Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={showHistory} onClose={() => setShowHistory(false)} title="Configuration History" size="lg">
        <div className="flex flex-col gap-3">
          {history.length === 0 && (
            <p className="text-sm text-slate-500 text-center py-6">No changes recorded yet.</p>
          )}
          {history.map((h) => (
            <div key={h._id} className="p-3 rounded-lg border border-slate-200">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-sm font-bold text-slate-800">
                  {new Date(h.effectiveFrom).toLocaleString('en-IN')}
                </p>
                <span className={`text-[11px] font-bold px-2 py-0.5 rounded ${
                  h.supersededAt ? 'bg-slate-100 text-slate-500' : 'bg-success-50 text-success-700'
                }`}>
                  {h.supersededAt ? 'Superseded' : 'Live'}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Bands {h.thresholds?.critical}/{h.thresholds?.low}/{h.thresholds?.healthy} ·
                Formula {h.formulaVersion} ·
                {' '}by {h.createdBy?.user || h.createdBy?.email || 'system'}
              </p>
              {h.changeNote && (
                <p className="text-xs text-slate-600 mt-1.5 italic">{h.changeNote}</p>
              )}
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
};

export default InventoryConfig;
