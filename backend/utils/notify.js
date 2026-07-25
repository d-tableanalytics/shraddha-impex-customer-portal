import Notification from '../models/Notification.js';
import User from '../models/User.js';
import { io } from '../server.js';

// Real-time notification helpers.
//
// Delivery is room-based: every connected socket is placed into a `user:<id>`
// room (and admins additionally into the `admins` room) at connection time — see
// server.js. Emitting to `user:<id>` therefore reaches only that user's own
// browser tabs, and admin fan-out reaches every logged-in admin.
//
// Each notification is also persisted so it shows up in the bell history / unread
// count on next load. These helpers never throw — a notification failure must not
// break the order/reservation flow that triggered it.

const room = (userId) => `user:${String(userId)}`;

// Persist + push a single notification to one user.
export const notifyUser = async (userId, { title, message, type = 'reservation' }) => {
  try {
    const notif = await Notification.create({ user: userId, title, message, type });
    const populatedNotif = await Notification.findById(notif._id).populate('user', 'user name company email role');
    
    // Emit to the target user's personal room
    io.to(room(userId)).emit('notification-received', populatedNotif);
    
    // If the recipient user is not an Admin, also emit to all admins so they see it in real-time
    if (populatedNotif.user && populatedNotif.user.role !== 'Admin') {
      io.to('admins').emit('notification-received', populatedNotif);
    }
    
    return notif;
  } catch (err) {
    console.error('[notifyUser error]', err);
    return null;
  }
};

// Persist + push a notification to every admin. Each admin gets their own copy so
// it appears in their personal bell history and unread count.
export const notifyAdmins = async ({ title, message, type = 'order' }) => {
  try {
    const admins = await User.find({ role: 'Admin' }).select('_id');
    if (!admins.length) return;
    const docs = admins.map((a) => ({ user: a._id, title, message, type }));
    const created = await Notification.insertMany(docs);
    
    for (const notif of created) {
      const populated = await Notification.findById(notif._id).populate('user', 'user name company email role');
      io.to(room(notif.user)).emit('notification-received', populated);
    }
  } catch (err) {
    console.error('[notifyAdmins error]', err);
  }
};
