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
import cron from 'node-cron';

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
    if (role === 'Admin') socket.join('admins');
  }

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

// Start Application
const startServer = async () => {
  await connectDatabase();

  // Seed the default RBAC roles if the collection is empty.
  await seedDefaultRoles();

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
  });
  
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