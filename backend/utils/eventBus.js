import { EventEmitter } from 'events';

/**
 * In-process domain event bus (IMS Module M8).
 *
 * Exists to keep the Alert Engine a SUBSCRIBER rather than a callee. Modules
 * announce what happened; the alert engine decides whether that is worth
 * telling anyone about. Without this, M4 and M7 would have to import M8
 * directly, and M8 imports M4 to read health — a cycle.
 *
 * It also avoids repeating the fault the audit found in `utils/notify.js`,
 * which imports the Socket.IO instance from `server.js` and so drags HTTP
 * startup into every module that touches a notification. This file is a LEAF:
 * it imports nothing but Node's own EventEmitter, so anything may depend on it
 * and it depends on nothing.
 *
 * DELIVERY IS FIRE-AND-FORGET AND NEVER THROWS. A subscriber that fails must
 * not fail the stock operation that emitted the event — an alert is a
 * side-effect of business activity, never a precondition for it.
 */
const bus = new EventEmitter();

// Several subscribers per event is normal (alerts, sockets, future webhooks);
// the default ceiling of 10 would warn spuriously as the system grows.
bus.setMaxListeners(50);

export const EVENTS = {
  // Module M4 — health recomputed for a set of SKUs.
  HEALTH_PROJECTED: 'health.projected',
  // Module M7 — count workflow transitions.
  COUNT_SUBMITTED: 'count.submitted',
  COUNT_APPROVED: 'count.approved',
  COUNT_POSTED: 'count.posted',
  COUNT_REJECTED: 'count.rejected',
  OVERSOLD_RAISED: 'oversold.raised',
  // Module M6 — snapshot outcomes.
  SNAPSHOT_COMPLETED: 'snapshot.completed',
  SNAPSHOT_FAILED: 'snapshot.failed',
  // Module M1 — configuration versioned.
  CONFIG_UPDATED: 'config.updated',
  // Module M3/M4 — a projection could not be updated.
  PROJECTION_FAILED: 'projection.failed',
  // Module M4 — a full projection rebuild finished.
  PROJECTION_REBUILT: 'projection.rebuilt',
  // Emitted BY the alert engine, consumed by the socket bridge in server.js.
  NOTIFICATION_CREATED: 'notification.created',
};

/**
 * Announce an event. Synchronous listeners run inline; a throwing listener is
 * caught and logged so it cannot propagate back into the caller.
 */
export const emitEvent = (name, payload = {}) => {
  try {
    bus.emit(name, payload);
  } catch (error) {
    console.error(`[EventBus] Listener for "${name}" threw:`, error.message);
  }
};

/**
 * Subscribe. The handler is wrapped so an async rejection is logged rather than
 * surfacing as an unhandled rejection and taking the process down.
 */
export const onEvent = (name, handler) => {
  bus.on(name, (payload) => {
    try {
      const result = handler(payload);
      if (result?.catch) {
        result.catch((error) =>
          console.error(`[EventBus] Async handler for "${name}" failed:`, error.message));
      }
    } catch (error) {
      console.error(`[EventBus] Handler for "${name}" failed:`, error.message);
    }
  });
};

/** Listener counts, for diagnostics and tests. */
export const listenerCounts = () =>
  Object.fromEntries(Object.values(EVENTS).map((e) => [e, bus.listenerCount(e)]));

/** Test helper — drop every subscriber. */
export const resetBus = () => bus.removeAllListeners();

export default { EVENTS, emitEvent, onEvent, listenerCounts, resetBus };
