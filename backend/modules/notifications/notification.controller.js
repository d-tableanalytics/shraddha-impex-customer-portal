import Notification from '../../models/Notification.js';

export const getNotifications = async (req, res, next) => {
  try {
    const query = req.user.role === 'Admin' ? {} : { user: req.user._id };
    const notifications = await Notification.find(query)
      .populate('user', 'user name company email role')
      .sort({ createdAt: -1 })
      .limit(50);
    res.status(200).json({ success: true, data: notifications });
  } catch (error) {
    next(error);
  }
};

export const markAllRead = async (req, res, next) => {
  try {
    const query = req.user.role === 'Admin' ? { read: false } : { user: req.user._id, read: false };
    await Notification.updateMany(query, { read: true });
    res.status(200).json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    next(error);
  }
};

export const markOneRead = async (req, res, next) => {
  try {
    const query = req.user.role === 'Admin' ? { _id: req.params.id } : { _id: req.params.id, user: req.user._id };
    const notif = await Notification.findOneAndUpdate(
      query,
      { read: true },
      { new: true }
    ).populate('user', 'user name company email role');
    if (!notif) return res.status(404).json({ success: false, message: 'Notification not found' });
    res.status(200).json({ success: true, data: notif });
  } catch (error) {
    next(error);
  }
};
