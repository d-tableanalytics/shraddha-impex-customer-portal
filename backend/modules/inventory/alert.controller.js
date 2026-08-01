import InventoryAlert, {
  ALERT_TYPES, ALERT_TYPE_NAMES, ALERT_CATEGORIES, SEVERITIES, ALERT_STATUSES,
  ALERT_TRANSITIONS,
} from '../../models/InventoryAlert.js';
import AlertRule from '../../models/AlertRule.js';
import Notification from '../../models/Notification.js';
import { allowedBrands, canAccessBrand } from '../../utils/brandAccess.js';
import { recordAudit } from '../../utils/auditLog.js';
import { transitionAlert } from './alert.service.js';

/**
 * Alert endpoints (IMS Module M8).
 *
 * Read-only over the alert store plus three lifecycle actions. NOTHING here
 * evaluates a condition or raises an alert — alerts are raised by the
 * subscriber, in response to events the projection modules emit. An HTTP route
 * that could create an alert would let a caller assert a stock condition that
 * no projection ever observed.
 */

// Express parses the query string with `qs` in extended mode, so
// `?status[$ne]=Closed` arrives as an object. Non-strings are dropped rather
// than coerced, so an operator can never reach a filter.
const asString = (value) => {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
};
const asInt = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
};

/**
 * An alert about a specific brand is visible when that brand is; a brand-less
 * alert (config, snapshot, projection) is visible to anyone who can see
 * inventory, because it describes the system rather than any one brand's stock.
 */
const visibilityFilter = (brands) => ({ $or: [{ brand: null }, { brand: { $in: brands } }] });

const handle = (error, res, next) => {
  if (error?.status) {
    return res.status(error.status).json({ success: false, message: error.message, code: error.code });
  }
  return next(error);
};

// ─── Alerts ──────────────────────────────────────────────────────────────────

export const listAlerts = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    if (brands.length === 0) {
      return res.status(200).json({
        success: true, data: [], pagination: { total: 0, page: 1, pages: 1, limit: 0 },
        counts: { byStatus: {}, bySeverity: {}, byCategory: {} },
      });
    }

    const filter = visibilityFilter(brands);

    const status = asString(req.query.status);
    if (status) {
      if (!ALERT_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: `Status must be one of: ${ALERT_STATUSES.join(', ')}.` });
      }
      filter.status = status;
    }

    const severity = asString(req.query.severity);
    if (severity) {
      if (!SEVERITIES.includes(severity)) {
        return res.status(400).json({ success: false, message: `Severity must be one of: ${SEVERITIES.join(', ')}.` });
      }
      filter.severity = severity;
    }

    const category = asString(req.query.category);
    if (category) {
      if (!ALERT_CATEGORIES.includes(category)) {
        return res.status(400).json({ success: false, message: `Category must be one of: ${ALERT_CATEGORIES.join(', ')}.` });
      }
      filter.category = category;
    }

    const alertType = asString(req.query.alertType);
    if (alertType) {
      if (!ALERT_TYPE_NAMES.includes(alertType)) {
        return res.status(400).json({ success: false, message: `Unknown alert type "${alertType}".` });
      }
      filter.alertType = alertType;
    }

    const brand = asString(req.query.brand);
    if (brand) {
      if (!canAccessBrand(req.user, brand)) {
        return res.status(403).json({ success: false, message: 'Access to this brand is restricted for your account.' });
      }
      filter.brand = brand;
    }

    const skuCode = asString(req.query.skuCode);
    if (skuCode) filter.skuCode = skuCode.toUpperCase();

    // The default view is "what needs attention", not "everything ever raised".
    if (asString(req.query.activeOnly) !== 'false' && !status) {
      filter.status = { $in: ['Open', 'Acknowledged'] };
    }

    const limit = asInt(req.query.limit, 25, 1, 200);
    const page = asInt(req.query.page, 1, 1, 10_000);

    // Most severe first, then most recent — an operator opening this screen
    // should see the Critical row without having to sort.
    //
    // Ranked and paged INSIDE MongoDB. Severity is a labelled scale, not a
    // lexical one ("Critical" sorts after "Info" alphabetically, which is
    // backwards), so a $switch supplies the rank. Sorting in JS would mean
    // fetching every matching alert on every page request — fine at ten rows,
    // ruinous once a catalogue-wide health pass has raised a few thousand.
    const severityRank = {
      $switch: {
        branches: SEVERITIES.map((s, i) => ({ case: { $eq: ['$severity', s] }, then: i })),
        default: 99,
      },
    };

    const [rows, total, statusCounts, severityCounts, categoryCounts] = await Promise.all([
      InventoryAlert.aggregate([
        { $match: filter },
        { $addFields: { _rank: severityRank } },
        { $sort: { _rank: 1, lastSeenAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        { $project: { _rank: 0 } },
      ]).then((docs) => InventoryAlert.populate(docs, {
        path: 'acknowledgedBy resolvedBy closedBy', select: 'user email',
      })),
      InventoryAlert.countDocuments(filter),
      // Tab counts describe the visible scope, not the current filter — a user
      // filtering to Critical still needs to see that 12 others exist.
      InventoryAlert.aggregate([{ $match: visibilityFilter(brands) }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      InventoryAlert.aggregate([
        { $match: { ...visibilityFilter(brands), status: { $in: ['Open', 'Acknowledged'] } } },
        { $group: { _id: '$severity', n: { $sum: 1 } } },
      ]),
      InventoryAlert.aggregate([
        { $match: { ...visibilityFilter(brands), status: { $in: ['Open', 'Acknowledged'] } } },
        { $group: { _id: '$category', n: { $sum: 1 } } },
      ]),
    ]);

    const toMap = (agg, keys) => {
      const out = Object.fromEntries(keys.map((k) => [k, 0]));
      for (const r of agg) out[r._id] = r.n;
      return out;
    };

    res.status(200).json({
      success: true,
      data: rows.map((a) => ({ ...a, label: ALERT_TYPES[a.alertType]?.label ?? a.alertType })),
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
      counts: {
        byStatus: toMap(statusCounts, ALERT_STATUSES),
        bySeverity: toMap(severityCounts, SEVERITIES),
        byCategory: toMap(categoryCounts, ALERT_CATEGORIES),
      },
    });
  } catch (error) { next(error); }
};

export const getAlert = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    const alert = await InventoryAlert.findOne({ alertId: req.params.alertId })
      .populate('acknowledgedBy resolvedBy closedBy', 'user email')
      .lean();

    // 404 rather than 403, so alert ids cannot be probed for existence.
    if (!alert || (alert.brand && !brands.includes(alert.brand))) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }

    res.status(200).json({
      success: true,
      data: {
        ...alert,
        label: ALERT_TYPES[alert.alertType]?.label ?? alert.alertType,
        // What the alert may do next, so the UI does not have to encode the
        // state machine a second time and drift from it.
        allowedTransitions: ALERT_TRANSITIONS[alert.status] ?? [],
      },
    });
  } catch (error) { next(error); }
};

// ─── Lifecycle ───────────────────────────────────────────────────────────────

const lifecycle = (to) => async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    const existing = await InventoryAlert.findOne({ alertId: req.params.alertId }, 'brand').lean();
    if (!existing || (existing.brand && !brands.includes(existing.brand))) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }

    const note = asString(req.body?.note) ?? null;
    if (to === 'Resolved' && !note) {
      return res.status(400).json({
        success: false,
        message: 'Resolving an alert needs a note explaining what was done about it.',
      });
    }

    const alert = await transitionAlert({ alertId: req.params.alertId, to, note, actor: req.user, req });
    res.status(200).json({ success: true, data: alert });
  } catch (error) { handle(error, res, next); }
};

export const acknowledge = lifecycle('Acknowledged');
export const resolve = lifecycle('Resolved');
export const close = lifecycle('Closed');

// ─── Rules ───────────────────────────────────────────────────────────────────

export const listRules = async (req, res, next) => {
  try {
    const stored = await AlertRule.find({}).populate('updatedBy', 'user email').lean();
    const byType = new Map(stored.map((r) => [r.alertType, r]));

    // Every declared type is returned, configured or not, so the screen shows
    // the full set of things the system can alert on rather than only the rows
    // someone happened to save.
    const data = ALERT_TYPE_NAMES.map((alertType) => {
      const spec = ALERT_TYPES[alertType];
      const rule = byType.get(alertType);
      return {
        alertType,
        label: spec.label,
        category: spec.category,
        defaultSeverity: spec.severity,
        configured: Boolean(rule),
        enabled: rule?.enabled ?? true,
        severity: rule?.severity || spec.severity,
        delivery: rule?.delivery || 'digest',
        cooldownHours: rule?.cooldownHours ?? 24,
        notifyRoles: rule?.notifyRoles?.length ? rule.notifyRoles : ['Admin', 'Inventory Manager'],
        description: rule?.description ?? null,
        updatedBy: rule?.updatedBy ?? null,
        updatedAt: rule?.updatedAt ?? null,
      };
    });

    res.status(200).json({ success: true, data, categories: ALERT_CATEGORIES, severities: SEVERITIES });
  } catch (error) { next(error); }
};

export const updateRule = async (req, res, next) => {
  try {
    const alertType = asString(req.params.alertType);
    if (!ALERT_TYPE_NAMES.includes(alertType)) {
      return res.status(400).json({
        success: false,
        message: `Unknown alert type "${alertType}". Alert types are a closed set defined by the blueprint.`,
      });
    }

    const update = {};
    const errors = [];

    if ('enabled' in req.body) {
      if (typeof req.body.enabled !== 'boolean') errors.push('enabled must be true or false.');
      else update.enabled = req.body.enabled;
    }

    if ('severity' in req.body) {
      const severity = req.body.severity;
      // Null means "use the type's declared default" — an explicit way back to
      // the default without deleting the rule.
      if (severity === null) update.severity = null;
      else if (!SEVERITIES.includes(severity)) errors.push(`severity must be one of: ${SEVERITIES.join(', ')}, or null.`);
      else update.severity = severity;
    }

    if ('delivery' in req.body) {
      if (!['immediate', 'digest', 'silent'].includes(req.body.delivery)) {
        errors.push('delivery must be immediate, digest or silent.');
      } else update.delivery = req.body.delivery;
    }

    if ('cooldownHours' in req.body) {
      const n = Number(req.body.cooldownHours);
      if (!Number.isFinite(n) || n < 1) errors.push('cooldownHours must be a number of at least 1.');
      else update.cooldownHours = Math.trunc(n);
    }

    if ('notifyRoles' in req.body) {
      if (!Array.isArray(req.body.notifyRoles)) errors.push('notifyRoles must be an array.');
      else update.notifyRoles = req.body.notifyRoles.filter((r) => typeof r === 'string').map((r) => r.trim()).filter(Boolean);
    }

    if ('description' in req.body) {
      update.description = asString(req.body.description) ?? null;
    }

    if (errors.length) {
      return res.status(400).json({ success: false, message: errors.join(' '), errors });
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update.' });
    }

    const before = await AlertRule.findOne({ alertType }).lean();
    update.updatedBy = req.user?._id || null;

    const rule = await AlertRule.findOneAndUpdate(
      { alertType },
      { $set: update, $setOnInsert: { alertType } },
      { new: true, upsert: true, runValidators: true },
    ).lean();

    await recordAudit(req.user, 'Alert Rule Updated',
      `Alert rule "${ALERT_TYPES[alertType].label}" updated.`,
      req, { meta: { alertType, before: before || null, after: rule } });

    res.status(200).json({ success: true, data: rule });
  } catch (error) { next(error); }
};

// ─── Notification feed ───────────────────────────────────────────────────────

/**
 * The signed-in user's inventory notifications.
 *
 * Reads the EXISTING notifications collection rather than a parallel alert
 * feed — a second store would mean users seeing half their notifications in one
 * bell and half in another.
 */
export const listNotifications = async (req, res, next) => {
  try {
    const limit = asInt(req.query.limit, 20, 1, 100);
    const unreadOnly = asString(req.query.unreadOnly) === 'true';

    const filter = { user: req.user._id, type: 'inventory' };
    if (unreadOnly) filter.read = false;

    const [rows, unread] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      Notification.countDocuments({ user: req.user._id, type: 'inventory', read: false }),
    ]);

    res.status(200).json({ success: true, data: rows, unread });
  } catch (error) { next(error); }
};

export const markNotificationsRead = async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.filter((id) => typeof id === 'string')
      : null;

    // Scoped to the caller's own notifications either way, so passing another
    // user's id marks nothing.
    const filter = { user: req.user._id, type: 'inventory', read: false };
    if (ids?.length) filter._id = { $in: ids };

    const result = await Notification.updateMany(filter, { $set: { read: true } });
    res.status(200).json({ success: true, updated: result.modifiedCount });
  } catch (error) { next(error); }
};

// ─── Statistics ──────────────────────────────────────────────────────────────

/**
 * Alert statistics for the dashboard widget.
 *
 * Counts alerts. It does NOT count SKUs, quantities or bands — those come from
 * the health projection via the dashboard service, and duplicating them here
 * would give two screens two ways of disagreeing about the same number.
 */
export const getStatistics = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    if (brands.length === 0) {
      return res.status(200).json({ success: true, data: { open: 0, acknowledged: 0, critical: 0, byCategory: {}, byType: [], recent: [] } });
    }

    const scope = visibilityFilter(brands);
    const activeScope = { ...scope, status: { $in: ['Open', 'Acknowledged'] } };

    const [byStatus, byCategory, byType, recent] = await Promise.all([
      InventoryAlert.aggregate([{ $match: scope }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      InventoryAlert.aggregate([{ $match: activeScope }, { $group: { _id: '$category', n: { $sum: 1 } } }]),
      InventoryAlert.aggregate([
        { $match: activeScope },
        { $group: { _id: '$alertType', n: { $sum: 1 }, occurrences: { $sum: '$occurrences' } } },
        { $sort: { n: -1 } },
      ]),
      InventoryAlert.find(activeScope).sort({ lastSeenAt: -1 }).limit(5)
        .select('alertId alertType severity title skuCode brand lastSeenAt occurrences status').lean(),
    ]);

    const statusMap = Object.fromEntries(byStatus.map((r) => [r._id, r.n]));
    const criticalCount = await InventoryAlert.countDocuments({ ...activeScope, severity: 'Critical' });

    res.status(200).json({
      success: true,
      data: {
        open: statusMap.Open ?? 0,
        acknowledged: statusMap.Acknowledged ?? 0,
        resolved: statusMap.Resolved ?? 0,
        closed: statusMap.Closed ?? 0,
        critical: criticalCount,
        // Every category is present, at zero if nothing is active, so the
        // widget renders a stable set of tiles rather than shifting layout as
        // conditions come and go.
        byCategory: {
          ...Object.fromEntries(ALERT_CATEGORIES.map((c) => [c, 0])),
          ...Object.fromEntries(byCategory.map((r) => [r._id, r.n])),
        },
        byType: byType.map((r) => ({
          alertType: r._id,
          label: ALERT_TYPES[r._id]?.label ?? r._id,
          severity: ALERT_TYPES[r._id]?.severity ?? 'Info',
          count: r.n,
          occurrences: r.occurrences,
        })),
        recent: recent.map((a) => ({ ...a, label: ALERT_TYPES[a.alertType]?.label ?? a.alertType })),
      },
    });
  } catch (error) { next(error); }
};

/** The closed catalogue of alert types, for filter dropdowns. */
export const listAlertTypes = async (_req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      data: ALERT_TYPE_NAMES.map((t) => ({ alertType: t, ...ALERT_TYPES[t] })),
      categories: ALERT_CATEGORIES,
      severities: SEVERITIES,
      statuses: ALERT_STATUSES,
    });
  } catch (error) { next(error); }
};

export default {
  listAlerts, getAlert, acknowledge, resolve, close,
  listRules, updateRule, listNotifications, markNotificationsRead,
  getStatistics, listAlertTypes,
};
