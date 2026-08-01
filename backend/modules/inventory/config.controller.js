import InventoryConfig from '../../models/InventoryConfig.js';
import { recordAudit } from '../../utils/auditLog.js';
import { rebuildHealth } from './health.service.js';
import { liveConfig, resolveConfig } from './config.service.js';
import { emitEvent, EVENTS } from '../../utils/eventBus.js';

/**
 * Inventory configuration (Module M1).
 *
 * Configuration is append-only and effective-dated. A "change" writes a NEW
 * document and stamps the previous one `supersededAt`, because a threshold
 * change silently reclassifies thousands of SKUs and moves every dashboard
 * number — "why did Critical jump from 97 to 400 last Tuesday" has to be
 * answerable (BR-41, BR-74).
 *
 * Scope resolution is most-specific-first: sku → category → brand → global. Only
 * the global scope is exposed in the M1 UI, because tuning category thresholds
 * before the ledger has any history would be guesswork. The chain is built now
 * because retrofitting it later means re-projecting every SKU.
 */

const SCOPES = ['global', 'brand', 'category', 'sku'];
const REASON_GROUPS = ['Count', 'Loss', 'Found', 'Correction', 'Non-Sale Issue'];
const DIRECTIONS = ['Positive', 'Negative', 'Both'];

/**
 * Coerce a query-string value to a plain string, or undefined.
 *
 * Express parses the query string with `qs` in extended mode, so
 * `?scopeValue[$ne]=x` arrives as an OBJECT and would inject a Mongo operator
 * if assigned straight into a filter. Arrays and objects are rejected rather
 * than coerced.
 */
const asString = (value) => {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
};

/**
 * Validated {scope, scopeValue} pair from a request, or an error message.
 * Shared by both read endpoints so they cannot drift — an earlier version
 * validated `scope` on getConfig but not on getConfigHistory.
 */
const readScope = (source) => {
  const scope = asString(source.scope) || 'global';
  if (!SCOPES.includes(scope)) {
    return { error: `Scope must be one of: ${SCOPES.join(', ')}.` };
  }
  // The global scope is keyed on a null scopeValue; anything supplied for it is
  // ignored rather than trusted.
  const scopeValue = scope === 'global' ? null : (asString(source.scopeValue) ?? null);
  return { scope, scopeValue };
};


// Configuration resolution lives in config.service.js — a leaf module both
// this controller and the Health Engine depend on, so neither depends on the
// other. Re-exported here so existing importers keep resolving.
export { resolveConfig };

/**
 * GET /api/v1/inventory/config
 * Current live configuration. `?scope=` and `?scopeValue=` read a specific
 * scope; omitted, it returns the global default.
 */
export const getConfig = async (req, res, next) => {
  try {
    const { scope, scopeValue, error } = readScope(req.query);
    if (error) return res.status(400).json({ success: false, message: error });

    const config = await liveConfig(scope, scopeValue);
    if (!config) {
      return res.status(404).json({
        success: false,
        message: `No configuration found for scope "${scope}".`,
      });
    }

    res.status(200).json({ success: true, data: config });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/inventory/config/history
 * Every version of a scope's configuration, newest first — the answer to "who
 * changed the thresholds and when".
 */
export const getConfigHistory = async (req, res, next) => {
  try {
    const { scope, scopeValue, error } = readScope(req.query);
    if (error) return res.status(400).json({ success: false, message: error });

    const history = await InventoryConfig.find({ scope, scopeValue })
      .sort({ effectiveFrom: -1 })
      .limit(50)
      .populate('createdBy', 'user email')
      .lean();

    res.status(200).json({ success: true, data: history });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/v1/inventory/config
 * Writes a new configuration version and supersedes the previous one.
 */
export const updateConfig = async (req, res, next) => {
  try {
    // The body is JSON so it cannot smuggle qs-shaped operators, but it is
    // validated through the same helper so the read and write paths agree on
    // what a scope is.
    const { scope, scopeValue, error: scopeError } = readScope(req.body);
    if (scopeError) return res.status(400).json({ success: false, message: scopeError });

    if (scope !== 'global' && !scopeValue) {
      return res.status(400).json({
        success: false,
        message: 'A scope value is required for brand, category and SKU scopes.',
      });
    }

    const current = await liveConfig(scope, scopeValue);
    const errors = [];

    // Start from the current values so a partial update does not silently reset
    // the settings it did not mention.
    const base = current || {};
    const next = {
      scope,
      scopeValue,
      thresholds: { ...(base.thresholds || { critical: 33, low: 66, healthy: 100 }) },
      formulaVersion: base.formulaVersion || 'v1',
      adjustmentApprovalThreshold: base.adjustmentApprovalThreshold ?? 100,
      backdatingWindowDays: base.backdatingWindowDays ?? 30,
      deadStockDays: base.deadStockDays ?? 180,
      reasonCodes: base.reasonCodes || [],
    };

    if (req.body.thresholds && typeof req.body.thresholds === 'object') {
      for (const key of ['critical', 'low', 'healthy']) {
        if (!(key in req.body.thresholds)) continue;
        const value = Number(req.body.thresholds[key]);
        if (!Number.isFinite(value)) {
          errors.push(`Threshold "${key}" must be a number.`);
          continue;
        }
        next.thresholds[key] = value;
      }

      // BR-40 — strictly ordered, or the band classification becomes ambiguous
      // and SKUs land in whichever branch is evaluated first.
      const { critical, low, healthy } = next.thresholds;
      if (!(critical > 0 && critical < low && low < healthy)) {
        errors.push(
          `Thresholds must satisfy 0 < critical < low < healthy ` +
          `(received ${critical}, ${low}, ${healthy}).`,
        );
      }
    }

    if ('formulaVersion' in req.body) {
      if (!['v1', 'v2'].includes(req.body.formulaVersion)) {
        errors.push('Formula version must be v1 or v2.');
      } else if (req.body.formulaVersion !== next.formulaVersion) {
        // BR-42 — the two formulas differ by 3x on the current data, so this is
        // never an incidental edit. The client must say it means it.
        if (req.body.confirmFormulaChange !== true) {
          errors.push(
            'Changing the Max Level formula re-values every SKU. ' +
            'Resend with confirmFormulaChange: true to proceed.',
          );
        } else {
          next.formulaVersion = req.body.formulaVersion;
        }
      }
    }

    for (const key of ['adjustmentApprovalThreshold', 'backdatingWindowDays', 'deadStockDays']) {
      if (!(key in req.body)) continue;
      const value = Number(req.body[key]);
      if (!Number.isFinite(value) || value < 0) {
        errors.push(`${key} must be a number greater than or equal to zero.`);
        continue;
      }
      next[key] = value;
    }

    if ('reasonCodes' in req.body) {
      if (!Array.isArray(req.body.reasonCodes)) {
        errors.push('reasonCodes must be an array.');
      } else {
        const seen = new Set();
        const parsed = [];
        for (const raw of req.body.reasonCodes) {
          const code = String(raw?.code || '').trim().toUpperCase();
          if (!code) { errors.push('Every reason code needs a code.'); continue; }
          if (seen.has(code)) { errors.push(`Duplicate reason code ${code}.`); continue; }
          seen.add(code);
          if (!REASON_GROUPS.includes(raw.group)) {
            errors.push(`Reason ${code}: group must be one of ${REASON_GROUPS.join(', ')}.`);
            continue;
          }
          if (raw.direction && !DIRECTIONS.includes(raw.direction)) {
            errors.push(`Reason ${code}: direction must be one of ${DIRECTIONS.join(', ')}.`);
            continue;
          }
          parsed.push({
            code,
            label: String(raw.label || code).trim(),
            group: raw.group,
            direction: raw.direction || 'Both',
            active: raw.active !== false,
          });
        }

        // BR-24 — a reason code already stamped on historical movements must stay
        // resolvable. Dropping one from the list deactivates it instead.
        const incoming = new Set(parsed.map((r) => r.code));
        for (const existing of next.reasonCodes) {
          if (!incoming.has(existing.code)) {
            parsed.push({ ...existing, active: false });
          }
        }
        next.reasonCodes = parsed;
      }
    }

    if (errors.length) {
      return res.status(400).json({ success: false, message: errors.join(' '), errors });
    }

    const now = new Date();
    const created = await InventoryConfig.create({
      ...next,
      effectiveFrom: now,
      createdBy: req.user?._id || null,
      changeNote: req.body.changeNote || null,
    });

    // Supersede the previous version only after the new one is safely written,
    // so a failure here can never leave a scope with no live configuration.
    if (current?._id) {
      await InventoryConfig.updateOne({ _id: current._id }, { $set: { supersededAt: now } });
    }

    await recordAudit(
      req.user,
      'Inventory Config Updated',
      `Inventory configuration updated for scope "${scope}"${scopeValue ? ` (${scopeValue})` : ''}.`,
      req,
      { meta: { scope, scopeValue, before: current || null, after: next } },
    );

    // A formula change is materially different from a threshold tweak: it moves
    // every SKU's target, so it is announced separately and at a higher
    // severity. Both are announced, never pushed — the alert engine decides
    // whether anyone hears about it.
    emitEvent(EVENTS.CONFIG_UPDATED, {
      scope,
      scopeValue: scopeValue || null,
      configId: String(created._id),
      formulaVersion: created.formulaVersion,
      formulaChanged: Boolean(current) && current.formulaVersion !== created.formulaVersion,
      previousFormulaVersion: current?.formulaVersion ?? null,
      changeNote: req.body.changeNote || null,
      updatedBy: req.user?.name || 'System',
    });

    // HEALTH TRIGGER 3 of 3 — BR-41/BR-42. A threshold or formula change
    // silently reclassifies every SKU in scope, so the projection is rebuilt
    // for that scope.
    //
    // Deliberately NOT awaited: a global rebuild covers ~8,600 SKUs and the
    // configuration write is already committed and audited. Blocking the
    // response on it would time out the request for no benefit, and a failure
    // here is recoverable by running the rebuild endpoint.
    const healthScope = scope === 'brand' ? { brand: scopeValue } : {};
    rebuildHealth(healthScope, { actor: req.user, req }).catch((err) =>
      console.error(`[HealthEngine] Post-config rebuild failed: ${err.message}`));

    res.status(200).json({ success: true, data: created });
  } catch (error) {
    next(error);
  }
};

export default { getConfig, getConfigHistory, updateConfig, resolveConfig };
