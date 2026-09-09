import dotenv from 'dotenv';
import http from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import app from './app.js';
import User from './models/User.js';
import { connectDatabase } from './config/database.js';
import { runReservationExpiryChecks } from './modules/reservations/reservationExpiryJob.js';
import { runPoSettlement } from './modules/orders/poExpiryJob.js';
import { seedDefaultRoles } from './config/seedRoles.js';
import { seedInventoryDefaults } from './config/seedInventory.js';
import { seedAlertRules } from './config/seedAlertRules.js';
import { subscribeAlerts } from './modules/inventory/alert.subscriber.js';
import { onEvent, EVENTS } from './utils/eventBus.js';
import { sweepUploads } from './middlewares/importUpload.js';
import { bootstrapHrms } from './modules/hrms/hrms.bootstrap.js';
import { runHrmsRetentionSweep } from './modules/hrms/retention/retention.sweep.js';
import { runWeeklyInventoryReport } from './modules/inventory/inventoryReport.job.js';
import { readInventoryReportConfig, describeInventoryReportConfig } from './config/inventoryReport.js';
import { runWeeklyHistoryReport } from './modules/orders/historyReport.job.js';
import { readHistoryReportConfig, describeHistoryReportConfig } from './config/historyReport.js';
import cron from 'node-cron';

import { isSuperAdmin } from './middlewares/rbac.js';
dotenv.config();

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

const allowedOrigins = process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : ['http://localhost:5173'];
export const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Authenticate the socket handshake (same JWT as the REST API) so notifications
// can be delivered to the right person. A client without a valid token still
// connects, but joins no rooms and therefore receives nothing — it stays silent
// rather than seeing everyone's notifications.
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('role status');
    if (user && user.status === 'Active') {
      socket.data.userId = String(user._id);
      socket.data.role = user.role;
    }
  } catch {
    // Invalid/expired token → connect as anonymous (no rooms).
  }
  next();
});

io.on('connection', (socket) => {
  const { userId, role } = socket.data || {};
  console.log(`[Socket] Client connected: ${socket.id}${userId ? ` (user ${userId})` : ' (anonymous)'}`);

  // Personal room for own notifications; admins additionally get the firehose.
  if (userId) {
    socket.join(`user:${userId}`);
    // The firehose is for unrestricted accounts. Asked of the permission set
    // rather than the role string so 'Super Admin' and any custom full-access
    // role join it too.
    if (isSuperAdmin({ role })) socket.join('admins');
  }

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

/**
 * Alert → socket bridge (Module M8).
 *
 * The alert engine writes notifications and announces them on the event bus; it
 * does not know sockets exist. This is the ONLY place the two meet, and it lives
 * here because `io` is created here.
 *
 * That direction is deliberate. The audit found `utils/notify.js` importing `io`
 * from this file, which drags HTTP startup into every module that touches a
 * notification and makes those modules untestable without booting a server. The
 * bus inverts it: modules depend on a leaf that depends on nothing.
 */
onEvent(EVENTS.NOTIFICATION_CREATED, ({ notifications, title, message, severity, alertId }) => {
  for (const n of notifications || []) {
    io.to(`user:${n.user}`).emit('inventory:alert', {
      id: n.id, alertId, severity, title, message, at: new Date().toISOString(),
    });
  }
});

// Start Application
const startServer = async () => {
  await connectDatabase();

  // Seed the default RBAC roles if the collection is empty.
  await seedDefaultRoles();

  // Seed the IMS master data (default stock location, global inventory
  // configuration). Idempotent — only fires when the collections are empty.
  await seedInventoryDefaults();

  // Seed one alert rule per declared type. Idempotent per type, so a newly
  // added type is seeded on the next boot without touching tuned rules.
  await seedAlertRules();

  // Bind the alert engine to the event bus. Until this runs, the projection
  // modules still emit — nobody is listening, so nothing is alerted. Deliberate:
  // a script or migration importing a service gets no alerts as a side effect.
  subscribeAlerts();

  // Clear import uploads left behind by requests that died mid-flight. The
  // service deletes each file once its rows are staged, so anything still on
  // disk is debris — and debris nobody reads accumulates until the disk fills.
  await sweepUploads();

  // Register the HRMS retention handlers and file access rules. Explicit and
  // central, so what is armed in a running system is answerable by reading
  // modules/hrms/hrms.bootstrap.js — and so importing an HRMS service from a
  // script does not arm a background behaviour as a side effect.
  bootstrapHrms();

  // Initial check on boot
  await runReservationExpiryChecks();
  // Settle the stock held by confirmed bookings: consume it where a PO was
  // raised, release it where the 7-day PO deadline has passed.
  await runPoSettlement();

  // Daily cron scheduler (runs at 00:00 every day)
  cron.schedule('0 0 * * *', () => {
    console.log('[Cron] Running daily reservation expiry checks...');
    runReservationExpiryChecks();
    runPoSettlement();
    sweepUploads();
    // AD-16: the application policy is authoritative for retention; the S3
    // lifecycle rule sits behind it at a longer window as a backstop only.
    runHrmsRetentionSweep().catch((err) =>
      console.error('[Cron] HRMS retention sweep failed:', err.message),
    );
  });

  /**
   * Weekly inventory health report.
   *
   * Its own schedule rather than a passenger on the daily job: the whole point
   * is that the day and time are configurable, and folding it into a fixed
   * midnight sweep would make "send it on Monday at 08:00" impossible to
   * express. Read once here so a bad cron expression or a missing support
   * address is reported at boot, next to everything else that failed to start,
   * rather than at 08:00 on a Monday inside a detached job.
   *
   * The job NEVER throws at this callback — see the note at the top of
   * inventoryReport.job.js. An unhandled rejection here would take the portal
   * down over a spreadsheet.
   */
  const reportConfig = readInventoryReportConfig();
  describeInventoryReportConfig(reportConfig);
  if (reportConfig.usable) {
    cron.schedule(
      reportConfig.schedule,
      () => {
        console.log('[Cron] Running the weekly inventory health report...');
        runWeeklyInventoryReport({ trigger: 'schedule' });
      },
      { timezone: reportConfig.timezone },
    );
  }

  /**
   * Weekly Booking & Indent History report.
   *
   * A second, independent schedule rather than a passenger on the inventory
   * one: different audience question, different window, and a configuration an
   * operator can move without touching the other. Each job claims its own
   * period in ReportRun, so neither can send twice and neither can block the
   * other.
   *
   * Like the inventory report, this callback never throws — see the note at the
   * top of historyReport.job.js.
   */
  const historyConfig = readHistoryReportConfig();
  describeHistoryReportConfig(historyConfig);
  if (historyConfig.usable) {
    cron.schedule(
      historyConfig.schedule,
      () => {
        console.log('[Cron] Running the weekly booking & indent history report...');
        runWeeklyHistoryReport({ trigger: 'schedule' });
      },
      { timezone: historyConfig.timezone },
    );
  }
  
  server.listen(PORT, () => {
    console.log(`[Server] ERP Backend running on port ${PORT}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
  });
};
// Process Error Handling
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[Process] Unhandled Rejection:', err);
  server.close(() => {
    process.exit(1);
  });
});

startServer();