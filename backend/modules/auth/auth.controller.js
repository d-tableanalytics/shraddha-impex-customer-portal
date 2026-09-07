import User from '../../models/User.js';
import ArchivedUser from '../../models/ArchivedUser.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import {
  resolveUserPermissions,
  grantsForUser,
  menuFor,
} from '../../utils/roleResolver.js';

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
  });
};

export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide email and password' });
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      // A suspended account is deleted from `users` and kept in the archive.
      // Say so plainly rather than "not registered", which reads as a typo.
      const archived = await ArchivedUser.findOne({ email: String(email).toLowerCase() });
      if (archived) {
        return res.status(403).json({
          success: false,
          message: 'Your account has been suspended. Please contact your administrator.',
        });
      }
      return res.status(401).json({ success: false, message: 'User is not registered. Please contact your administrator.' });
    }

    // Support both legacy bcrypt hashes and new plaintext passwords
    const isMatch = (user.password === password) || (await bcrypt.compare(password, user.password).catch(() => false));
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Inactive accounts are blocked here, before a token is ever issued — the
    // protect middleware would reject them anyway, but only after the client
    // had stored a useless token.
    if (user.status !== 'Active') {
      return res.status(403).json({
        success: false,
        message: 'Your account is inactive. Please contact your administrator.',
      });
    }

    const token = generateToken(user._id);
    user.lastLogin = Date.now();
    await user.save({ validateBeforeSave: false });

    res.status(200).json({
      success: true,
      data: {
        _id: user._id,
        name: user.user || user.email,
        email: user.email,
        role: user.role,
        token
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * The signed-in account, and what it is allowed to do.
 *
 * The permission payload is attached HERE, on the call the app already makes on
 * every load, rather than behind a second request. The sidebar cannot be drawn
 * until it is known, so a separate fetch would mean either a flash of the wrong
 * menu or a second spinner on every page load.
 *
 * Three shapes, because three different consumers need three different things:
 *
 *   permissions - the flat keys, for hasPermission() checks inside screens
 *   grants      - the same access as matrix cells, for "can I edit this?"
 *   menu        - the modules and sub-modules to render, already filtered
 *
 * The menu is built on the SERVER so that the sidebar is a rendering of the
 * user's real access rather than a second opinion about it. A frontend that
 * decides for itself which links to show is a frontend that can disagree with
 * the server, and every such disagreement is either a dead link or a leak.
 */
export const getMe = async (req, res, next) => {
  try {
    // .lean() so the permission fields can be attached without fighting a
    // Mongoose document, and -password so the account's credential stops being
    // sent to the browser on every page load. Nothing on the client reads it.
    const user = await User.findById(req.user.id).select('-password').lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.status(200).json({
      success: true,
      data: {
        ...user,
        permissions: resolveUserPermissions(user),
        grants: grantsForUser(user),
        menu: menuFor(user),
      },
    });
  } catch (error) {
    next(error);
  }
};

// Self-service profile update. A user may change their own display name, photo
// and notification preferences — but not their email, company, role or category
// (those remain admin-controlled via user management).
export const updateMe = async (req, res, next) => {
  try {
    const { user: name, avatar, preferences } = req.body;
    const updates = {};
    if (name !== undefined) updates.user = name;
    if (avatar !== undefined) updates.avatar = avatar;
    if (preferences && typeof preferences === 'object') {
      if ('emailNotifications' in preferences) updates['preferences.emailNotifications'] = !!preferences.emailNotifications;
      if ('pushNotifications' in preferences) updates['preferences.pushNotifications'] = !!preferences.pushNotifications;
    }

    const updated = await User.findByIdAndUpdate(req.user.id, updates, {
      new: true,
      runValidators: true,
    }).select('-password').lean();

    // The same permission payload getMe returns. The client stores this
    // response AS the current user, so omitting it would blank the sidebar the
    // moment somebody changed their avatar.
    res.status(200).json({
      success: true,
      data: {
        ...updated,
        permissions: resolveUserPermissions(updated),
        grants: grantsForUser(updated),
        menu: menuFor(updated),
      },
    });
  } catch (error) {
    next(error);
  }
};

// Change own password. Verifies the current password (supporting both legacy
// bcrypt hashes and the plaintext scheme used elsewhere), then stores the new one.
export const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current and new password are required.' });
    }
    if (String(newPassword).length < 5) {
      return res.status(400).json({ success: false, message: 'New password must be at least 5 characters.' });
    }

    const user = await User.findById(req.user.id).select('+password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const isMatch = (user.password === currentPassword) || (await bcrypt.compare(currentPassword, user.password).catch(() => false));
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }

    // Stored plaintext to remain consistent with the current auth scheme.
    user.password = newPassword;
    await user.save({ validateBeforeSave: false });

    res.status(200).json({ success: true, message: 'Password updated successfully.' });
  } catch (error) {
    next(error);
  }
};



