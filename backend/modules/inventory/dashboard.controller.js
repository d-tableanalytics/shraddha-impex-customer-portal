import { allowedBrands, canAccessBrand } from '../../utils/brandAccess.js';
import { buildDashboard } from './dashboard.service.js';

/**
 * Inventory Dashboard endpoint (IMS Module M5).
 *
 * ONE composed payload rather than a widget-per-request fan-out. The audit
 * found the existing business dashboard firing ~15 uncached queries per page
 * load; this returns everything in a single response backed by four concurrent
 * aggregations, and caches the result briefly.
 */

// Express parses the query string with `qs` in extended mode, so
// `?brand[$ne]=Koken` arrives as an object. Non-strings are dropped rather than
// coerced, so an operator can never reach a filter.
const asString = (value) => {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
};

const asDate = (value) => {
  const raw = asString(value);
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

// ─── Cache ───────────────────────────────────────────────────────────────────
/**
 * Short-lived in-process cache.
 *
 * Band counts move slowly and no decision turns on 60-second freshness, so a
 * brief cache removes most of the load from a screen people leave open.
 *
 * THE KEY INCLUDES THE CALLER'S BRAND SCOPE. Keying on the query filters alone
 * would serve a Koken-only user a payload built for an admin — a cache is one
 * of the easiest places to undo an authorisation rule, so the scope is part of
 * the identity of the entry, not an afterthought.
 */
const TTL_MS = Number(process.env.IMS_DASHBOARD_TTL_MS) || 60_000;
const cache = new Map();

const cacheKey = (brands, filters) =>
  JSON.stringify({ brands: [...brands].sort(), ...filters });

const readCache = (key) => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.payload;
};

const writeCache = (key, payload) => {
  // Bounded so a wide filter space cannot grow the map without limit. The
  // oldest entry goes first; at this size and TTL, exact LRU buys nothing.
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), payload });
};

/** Drop every cached payload. Exported for the projection-rebuild paths. */
export const invalidateDashboardCache = () => cache.clear();

/**
 * GET /api/v1/inventory/dashboard
 *
 * Query: brand, category, locationCode, from, to, refresh
 */
export const getDashboard = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    if (brands.length === 0) {
      // No brand access matches nothing rather than everything — the same
      // deliberate choice the shared brand helper makes.
      return res.status(200).json({
        success: true,
        data: {
          asAt: new Date(),
          kpis: {
            totalSkus: 0, projectedSkus: 0, healthy: 0, low: 0, critical: 0,
            outOfStock: 0, overstock: 0, unknown: 0, planningCompletionPercent: null,
          },
          summary: { onHand: 0, reserved: 0, available: 0, incoming: 0, outgoing: 0, balanceRows: 0, locationCount: 0, inboundTracked: false },
          healthDistribution: { byCount: [], byVolume: [] },
          coverageDistribution: [],
          planning: { plannable: 0, unplannable: 0, total: 0, completionPercent: null, gaps: [] },
          topCritical: [], topOverstock: [],
          activity: { movements: [], totalMovements: 0, earliestMovement: null },
          freshness: { healthComputedOldest: null, healthComputedNewest: null },
          filters: {},
        },
        cached: false,
      });
    }

    const brand = asString(req.query.brand);
    if (brand && !canAccessBrand(req.user, brand)) {
      return res.status(403).json({
        success: false,
        message: 'Access to this brand is restricted for your account.',
      });
    }

    const category = asString(req.query.category);
    const locationCode = asString(req.query.locationCode)?.toUpperCase();

    // The date range applies to the activity feed only — health and balances
    // are current-state projections with no time dimension to filter on.
    const from = asDate(req.query.from);
    const to = asDate(req.query.to);
    if (from === null || to === null) {
      return res.status(400).json({ success: false, message: 'from/to must be valid dates.' });
    }
    if (from && to && to.getTime() < from.getTime()) {
      return res.status(400).json({ success: false, message: '"to" cannot be earlier than "from".' });
    }

    const filters = {
      brand: brand ?? null,
      category: category ?? null,
      locationCode: locationCode ?? null,
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
    };

    const key = cacheKey(brands, filters);
    if (!['true', '1'].includes(String(req.query.refresh))) {
      const cached = readCache(key);
      if (cached) {
        return res.status(200).json({ success: true, data: cached, cached: true });
      }
    }

    const data = await buildDashboard({
      brands,
      brand: brand ?? null,
      category: category ?? null,
      locationCode: locationCode ?? null,
      // Inclusive of the whole "to" day, which is what picking a date means.
      from: from ?? null,
      to: to ? new Date(to.getTime() + 86_399_999) : null,
    });

    writeCache(key, data);
    res.status(200).json({ success: true, data, cached: false });
  } catch (error) {
    next(error);
  }
};

export default { getDashboard, invalidateDashboardCache };
