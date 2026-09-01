/**
 * Dashboard widget registry — the extension point later modules plug into.
 *
 * The reference builds its dashboard as one 589-line page that imports every
 * widget directly, so adding one means editing the dashboard, and the dashboard
 * ends up importing attendance, leave, engage and payroll. Here a module
 * registers its own widget and the dashboard stays a layout.
 *
 * A widget declares WHERE it belongs and WHO may see it. Visibility is the
 * canonical permission check, never a role-name comparison, so a widget cannot
 * disagree with the module it came from.
 *
 * Phase 1 registers none. That is why the dashboard shows an honest empty
 * state rather than invented numbers.
 */

/** Vertical bands, matching the reference's two-layer dashboard. */
export const WIDGET_ZONES = Object.freeze({
  /** Full-width band at the top: clock-in card, pending actions. */
  PRIMARY: "primary",
  /** The KPI tile row. */
  METRICS: "metrics",
  /** The main grid: announcements, holidays, celebrations, charts. */
  CONTENT: "content",
  /** Narrow right-hand column on wide screens. */
  ASIDE: "aside",
});

export const WIDGET_ZONE_ORDER = Object.freeze([
  WIDGET_ZONES.PRIMARY,
  WIDGET_ZONES.METRICS,
  WIDGET_ZONES.CONTENT,
  WIDGET_ZONES.ASIDE,
]);

/** @type {Map<string, object>} */
const widgets = new Map();

/**
 * Register a dashboard widget.
 *
 * @param {object}   widget
 * @param {string}   widget.id        unique; registering twice replaces
 * @param {string}   widget.zone      one of WIDGET_ZONES
 * @param {Function} widget.Component rendered inside a DashboardWidget card
 * @param {string}   widget.module    the HRMS module it belongs to; the widget
 *                                    disappears when that module is not built
 * @param {Array}    [widget.requires] ANY-OF permission specs
 * @param {number}   [widget.order=100]
 * @param {number}   [widget.span=1]  grid columns to occupy in CONTENT
 */
export function registerDashboardWidget(widget) {
  if (!widget?.id) throw new TypeError("registerDashboardWidget: id is required");
  if (!WIDGET_ZONE_ORDER.includes(widget.zone)) {
    throw new TypeError(`registerDashboardWidget: unknown zone "${widget.zone}"`);
  }
  if (typeof widget.Component !== "function") {
    throw new TypeError("registerDashboardWidget: Component must be a function");
  }
  if (!widget.module) throw new TypeError("registerDashboardWidget: module is required");

  widgets.set(widget.id, { order: 100, span: 1, requires: [], ...widget });
}

/** Test seam. */
export function __resetDashboardWidgets() {
  widgets.clear();
}

export const registeredWidgetIds = () => [...widgets.keys()];

/**
 * Widgets for a zone that this actor can both reach and use.
 *
 * Both checks matter: `usesModule` keeps a widget from a half-built module off
 * the page, and `requires` keeps a payroll KPI away from someone who may see
 * the payroll module but not its org-wide figures.
 */
export function widgetsForZone(zone, { can, usesModule }) {
  return [...widgets.values()]
    .filter((w) => w.zone === zone)
    .filter((w) => usesModule(w.module))
    .filter((w) => w.requires.length === 0 || w.requires.some((r) => can(r.module, r.action, r.scope)))
    .sort((a, b) => a.order - b.order);
}
