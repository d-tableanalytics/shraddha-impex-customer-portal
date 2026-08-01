import { io } from 'socket.io-client';
import toast from 'react-hot-toast';
import { useNotificationStore } from '../store/notificationStore';

const rawApiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const SOCKET_URL = rawApiUrl.replace(/\/+$/, '');

let socket;

const authToken = () => ({ token: localStorage.getItem('token') || null });

export const initSocket = () => {
  if (socket) return socket;

  // The token is sent in the handshake so the server can place this client into
  // its personal `user:<id>` room (and `admins` room for admins).
  socket = io(SOCKET_URL, { auth: authToken() });

  socket.on('connect', () => {
    console.log('[socket] connected to real-time notification server');
  });

  socket.on('disconnect', () => {
    console.log('[socket] disconnected');
  });

  // The single source of truth for real-time alerts. Every persisted server-side
  // notification (order placed/booked/confirmed, backorder, status change,
  // expiry reminders...) is pushed here for exactly the user(s) it targets.
  socket.on('notification-received', (notif) => {
    if (!notif) return;
    useNotificationStore.getState().addNotification(notif);
    toast(notif.title || notif.message, { icon: '🔔' });
  });

  return socket;
};

// Re-run the handshake with the current token after login/logout so the server
// moves this socket into (or out of) the right rooms.
export const refreshSocketAuth = () => {
  if (!socket) return initSocket();
  socket.auth = authToken();
  socket.disconnect().connect();
  return socket;
};

export const getSocket = () => socket;

/**
 * Subscribe to stock changes posted anywhere in the system.
 *
 * Screens that show a stock figure use this so a correction made by someone
 * else does not leave them displaying a number that is now wrong. Returns an
 * unsubscribe function for the effect's cleanup — without it, remounting the
 * page would stack duplicate handlers and refetch once per mount.
 */
export const onStockUpdated = (handler) => {
  const s = socket || initSocket();
  s.on('inventory:stock-updated', handler);
  return () => s.off('inventory:stock-updated', handler);
};
