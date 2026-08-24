/**
 * Booking lifecycle status changes — the single path every status update takes.
 *
 * A booking is several Order documents sharing one orderId, so "changing the
 * status" is four things that have to happen together and exactly once:
 *
 *   1. move every line of the booking to the new stage
 *   2. write ONE timeline event recording the transition
 *   3. email the customer ONCE
 *   4. record against that event whether the email actually went
 *
 * Doing this in a controller meant it was done per line item: a five-SKU
 * booking sent five identical emails, and a double-clicked button sent two
 * more. Both are prevented here, and prevented in the database rather than by
 * checking first and hoping — see the dedupeKey on BookingStatusEvent.
 *
 * ORDERING. The rows are updated first and the update is itself the guard:
 * `status: { $ne: newStatus }` means a repeat of the same transition modifies
 * nothing, and nothing modified means nothing announced. The email is sent
 * after the write has committed, so a booking is never announced as dispatched
 * when the save failed.
 *
 * FAILURE. Nothing in steps 2–4 can fail the request. A status change the admin
 * made and can see on screen must not be rolled back because a mail server was
 * down; instead the failure is written to the timeline event and pushed to the
 * admin bell, which is what makes it actionable rather than merely logged.
 */

import Order from '../../models/Order.js';
import User from '../../models/User.js';
import BookingStatusEvent from '../../models/BookingStatusEvent.js';
import { io } from '../../server.js';
import { notifyUser, notifyAdmins } from '../../utils/notify.js';
import { recordAudit } from '../../utils/auditLog.js';
import { sendBookingStatusMail } from '../../utils/bookingStatusMail.js';
import { buildBookingJourney, journeyTablesHtml } from '../../utils/bookingJourney.js';
import {
  bookingStatusOf, stageOf, stageLabel, isNotifiableStage, normalizeStatus,
} from '../../utils/bookingLifecycle.js';

/** The customer fields the email body and the log need. Never the password. */
const CUSTOMER_FIELDS = 'email user company customerCategory preferences bookingCcEmails role';

const lineSummary = (rows = []) =>
  rows.map((r) => ({
    skuCode: r.skuCode,
    msilCode: r.msilCode || null,
    quantity: r.confirmedQty ?? r.requestedQty ?? 0,
  }));

/**
 * Write the timeline event for a transition.
 *
 * Returns null when the event already exists — a concurrent request recorded
 * this exact transition first, so this one must not also email. That is the
 * duplicate guard doing its job, not an error, and it is deliberately silent.
 */
const recordEvent = async ({ orderId, rows, status, previousStatus, actor, remarks, changedAt }) => {
  // How many times this booking has already been in this status. A first move
  // to Dispatched is occurrence 0; a booking sent back a stage and dispatched
  // again is occurrence 1, and is therefore announced again — correctly.
  const occurrence = await BookingStatusEvent.countDocuments({ orderId, status });

  try {
    return await BookingStatusEvent.create({
      orderId,
      user: rows[0]?.user || null,
      status,
      previousStatus,
      changedAt,
      changedBy: actor?._id || null,
      changedByName: actor?.user || actor?.company || actor?.email || 'System',
      changedByRole: actor?.role || 'System',
      remarks: remarks || null,
      lineItemCount: rows.length,
      dedupeKey: `${orderId}|${status}|${occurrence}`,
      notification: {
        state: isNotifiableStage(status) ? 'pending' : 'not_applicable',
        reason: isNotifiableStage(status)
          ? null
          : `"${status}" is not one of the four lifecycle stages, so no status email is sent.`,
      },
    });
  } catch (err) {
    if (err?.code === 11000) {
      console.warn(
        `[Booking Status] ${orderId} → ${status}: a duplicate transition was suppressed. `
        + 'The customer has already been notified of this change.',
      );
      return null;
    }
    // Any other write failure loses the timeline row but must not lose the
    // status change, which is already committed.
    console.error(`[Booking Status] failed to record timeline event for ${orderId}:`, err.message);
    return null;
  }
};

/**
 * Send the status email and stamp the outcome onto the timeline event.
 *
 * Awaited by the caller rather than fired and forgotten: the whole point of the
 * notification log is to be able to say whether the mail went, and a promise
 * nobody waits on cannot report that. The wait is a second or two on an
 * already-saved status change.
 */
const notifyCustomer = async ({ event, orderId, status, previousStatus, rows, changedAt }) => {
  if (!event || !isNotifiableStage(status)) return event?.notification?.toObject?.() || null;

  const customer = rows[0]?.user
    ? await User.findById(rows[0].user).select(CUSTOMER_FIELDS).lean()
    : null;

  // The shared three-table journey. Best-effort: a status mail without the
  // journey (falling back to the simple lines table) beats no status mail.
  let journeyHtml = null;
  try {
    const journey = await buildBookingJourney({ orderId, rows });
    if (journey) journeyHtml = journeyTablesHtml(journey, { audience: 'customer' });
  } catch (e) {
    console.error(`[Booking Status] ${orderId}: journey build failed, using lines table:`, e.message);
  }

  const result = await sendBookingStatusMail({
    customer,
    orderId,
    status,
    previousStatus,
    changedAt,
    poNumber: rows[0]?.poNumber,
    lines: lineSummary(rows),
    journeyHtml,
  });

  const notification = {
    state: result.state,
    recipient: result.recipient || null,
    cc: result.cc || [],
    subject: result.subject || null,
    attempts: (event.notification?.attempts || 0) + 1,
    lastAttemptAt: new Date(),
    sentAt: result.state === 'sent' ? new Date() : event.notification?.sentAt || null,
    error: result.error || null,
    reason: result.reason || null,
  };

  await BookingStatusEvent.updateOne({ _id: event._id }, { $set: { notification } })
    .catch((e) => console.error('[Booking Status] could not log notification outcome:', e.message));

  // An email that did not reach the customer is an admin's problem the moment
  // it happens, not something to be discovered later in a log file.
  if (result.state === 'failed' || result.state === 'skipped') {
    // The reason strings already end in a full stop; trim it so the sentence
    // that follows does not read "…for this account.. Resend it".
    const why = String(result.error || result.reason || 'reason unknown').replace(/\.\s*$/, '');
    notifyAdmins({
      title: 'Booking status email not delivered',
      message: `${orderId} moved to "${stageLabel(status)}" but the customer was not emailed — `
        + `${why}. Resend it from the booking's timeline.`,
      type: 'order',
    });
  }

  return notification;
};

/**
 * Move a whole booking to a new lifecycle stage.
 *
 * @param {object}  args
 * @param {string}  args.orderId  Booking id (BO-/SO-YYYY-######).
 * @param {string}  args.status   Target status; must be an Order status value.
 * @param {string} [args.remarks] Note stored on the lines and the timeline.
 * @param {object} [args.actor]   The admin making the change. Null for jobs.
 * @param {object} [args.req]     Express request, for the audit trail.
 * @returns {{ok, code?, message?, changed, previousStatus, status, event?, notification?}}
 */
export const applyBookingStatus = async ({ orderId, status, remarks, actor = null, req = null }) => {
  const allowed = Order.schema.path('status').enumValues;
  if (!status || !allowed.includes(status)) {
    return { ok: false, code: 400, message: `Invalid status. Allowed: ${allowed.join(', ')}` };
  }

  const rows = await Order.find({ orderId });
  if (!rows.length) {
    return { ok: false, code: 404, message: 'Booking not found.' };
  }

  const previousStatus = bookingStatusOf(rows);

  // The customer is emailed when the status ACTUALLY changes, and only then.
  // Checked before the write so a no-op update never even touches the rows.
  if (normalizeStatus(previousStatus) === normalizeStatus(status)) {
    return {
      ok: true,
      changed: false,
      previousStatus,
      status,
      message: `Booking ${orderId} is already at "${stageLabel(status)}".`,
    };
  }

  const changedAt = new Date();
  const set = { status, statusTimestamp: changedAt };
  if (remarks) set.remarks = remarks;

  // `$ne` makes the write itself the guard: two requests racing on the same
  // transition cannot both modify the same row, so only one can go on to email.
  const result = await Order.updateMany({ orderId, status: { $ne: status } }, { $set: set });
  if (!result.modifiedCount) {
    return {
      ok: true,
      changed: false,
      previousStatus,
      status,
      message: `Booking ${orderId} is already at "${stageLabel(status)}".`,
    };
  }

  const event = await recordEvent({
    orderId, rows, status, previousStatus, actor, remarks, changedAt,
  });

  // No event means another request got there first and has already emailed.
  if (!event) {
    return { ok: true, changed: false, duplicate: true, previousStatus, status };
  }

  const stage = stageOf(status);
  io.emit('order-updated', { orderId, status });
  io.emit('booking-status-changed', { orderId, status, previousStatus, changedAt });

  if (rows[0]?.user) {
    notifyUser(rows[0].user, {
      title: `Booking ${stageLabel(status)}`,
      message: `Your booking ${orderId} ${stage?.notification || `is now "${status}"`}.`,
      type: 'order',
    });
  }

  await recordAudit(
    actor,
    'Booking Status Updated',
    `Booking ${orderId} moved from "${stageLabel(previousStatus)}" to "${stageLabel(status)}" `
      + `across ${result.modifiedCount} line item(s).`,
    req,
    { meta: { orderId, previousStatus, status, lineItems: result.modifiedCount } },
  );

  const notification = await notifyCustomer({
    event, orderId, status, previousStatus, rows, changedAt,
  });

  return {
    ok: true,
    changed: true,
    previousStatus,
    status,
    changedAt,
    lineItemsUpdated: result.modifiedCount,
    event: { ...event.toObject(), notification },
    notification,
  };
};

/**
 * Record a status change that some other flow has already written to the rows.
 *
 * Cancellation is the case: it releases stock and sets 'Cancelled' itself, and
 * has its own customer notification. It still belongs on the timeline — a
 * booking's history with the cancellation missing is not a history — so this
 * adds the event without sending a lifecycle email.
 */
export const recordExternalStatusChange = async ({
  orderId, status, previousStatus, rows, actor = null, remarks = null, changedAt = new Date(),
}) => {
  const lines = rows?.length ? rows : await Order.find({ orderId });
  if (!lines.length) return null;
  return recordEvent({ orderId, rows: lines, status, previousStatus, actor, remarks, changedAt });
};

/**
 * Every status change for a booking, oldest first.
 *
 * The first entry — the booking being received — is SYNTHESISED from the order
 * rows rather than written when the booking is created. Three separate flows
 * create bookings (a direct order, a confirmed selection list, and an indent
 * auto-booking), each already sends its own confirmation email, and each would
 * have needed the same genesis row bolted on. Deriving it instead means one
 * definition, no second "Booking Received" mail on top of the confirmation the
 * customer already got, and — the part that matters most — a complete timeline
 * for every booking that existed BEFORE this feature, which have no recorded
 * events at all and would otherwise show a blank history.
 *
 * It is only added when nothing recorded precedes it, so a booking whose real
 * first transition was captured is never given a duplicate opening entry.
 *
 * @param {string} orderId
 * @param {object[]} [rows] The booking's Order documents, if already loaded.
 */
export const getBookingTimeline = async (orderId, rows = null) => {
  const [events, lines] = await Promise.all([
    BookingStatusEvent.find({ orderId }).sort({ changedAt: 1 }).lean(),
    rows || Order.find({ orderId }).lean(),
  ]);

  if (!lines.length) return events;

  const placedAt = lines.reduce(
    (earliest, r) => {
      const t = r.orderTimestamp || r.date || r.createdAt;
      return t && (!earliest || new Date(t) < new Date(earliest)) ? t : earliest;
    },
    null,
  ) || lines[0].createdAt;

  const hasGenesis = events.some((e) => e.status === 'PO Received' || e.previousStatus === null);
  if (hasGenesis) return events;

  return [
    {
      _id: `${orderId}-received`,
      orderId,
      user: lines[0].user,
      status: 'PO Received',
      previousStatus: null,
      changedAt: placedAt,
      changedByName: 'System',
      changedByRole: 'System',
      remarks: null,
      lineItemCount: lines.length,
      derived: true,
      notification: {
        state: 'not_applicable',
        // Said plainly so an admin reading the log does not chase a mail that
        // was never owed: the booking confirmation is what covers this stage.
        reason: 'Covered by the booking confirmation email sent when the booking was placed.',
        attempts: 0,
      },
    },
    ...events,
  ];
};

/**
 * Send a status email again for one timeline event.
 *
 * The admin's remedy when the notification log shows a failure. It rebuilds the
 * original mail from the event rather than from the booking's CURRENT status,
 * so resending a failed "Ready for Dispatch" sends that mail even if the
 * booking has since been dispatched — the customer is owed the message that was
 * lost, not a different one.
 */
export const resendStatusMail = async ({ eventId, actor = null, req = null }) => {
  const event = await BookingStatusEvent.findById(eventId);
  if (!event) return { ok: false, code: 404, message: 'Status update not found.' };

  if (!isNotifiableStage(event.status)) {
    return {
      ok: false,
      code: 400,
      message: `"${event.status}" is not a lifecycle stage, so it has no customer email.`,
    };
  }
  if (event.notification?.state === 'sent') {
    return {
      ok: false,
      code: 409,
      message: 'This update was already emailed successfully. Resending would duplicate it.',
    };
  }

  const rows = await Order.find({ orderId: event.orderId });
  if (!rows.length) return { ok: false, code: 404, message: 'Booking not found.' };

  const notification = await notifyCustomer({
    event,
    orderId: event.orderId,
    status: event.status,
    previousStatus: event.previousStatus,
    rows,
    changedAt: event.changedAt,
  });

  await recordAudit(
    actor,
    'Booking Status Email Resent',
    `Resent the "${stageLabel(event.status)}" notification for booking ${event.orderId} — `
      + `attempt ${notification?.attempts}: ${notification?.state}.`,
    req,
    { meta: { orderId: event.orderId, eventId: String(event._id), state: notification?.state } },
  );

  return { ok: true, notification, sent: notification?.state === 'sent' };
};

export default {
  applyBookingStatus,
  recordExternalStatusChange,
  getBookingTimeline,
  resendStatusMail,
};
