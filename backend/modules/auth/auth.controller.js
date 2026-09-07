import User from '../../models/User.js';
import ArchivedUser from '../../models/ArchivedUser.js';
import {
  hashPassword,
  verifyPassword,
  upgradePasswordHash,
  validatePasswordStrength,
} from '../../utils/password.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashRefreshToken,
  refreshHashMatches,
  refreshCookieOptions,
  clearRefreshCookieOptions,
  REFRESH_COOKIE_NAME,
  accessTokenExpiresInMs,
} from '../../utils/tokens.js';
import { recordAudit } from '../../utils/auditLog.js';
import { AUDIT_ACTIONS } from '../../shared/constants/hrms.js';
// The portal's authorization payload for /auth/me. `jwt` and `bcrypt` are NOT
// imported alongside these any more: token signing moved to utils/tokens.js and
// password hashing to utils/password.js, and importing the primitives here
// again would be a second way to do both.
import {
  resolveUserPermissions,
  grantsForUser,
  menuFor,
} from '../../utils/roleResolver.js';
import { isHrmsRoleKey } from '../../shared/permissions/constants.js';

/**
 * Issue a fresh token pair and persist the refresh hash.
 *
 * The access token goes in the response body, exactly where the existing
 * frontend already looks for it. The refresh token goes ONLY into an httpOnly
 * cookie, so it is never reachable from JavaScript.
 */
async function issueSession(res, user) {
  const accessToken = signAccessToken(user._id);
  const { token: refreshToken } = signRefreshToken(user._id);

  await User.updateOne(
    { _id: user._id },
    { $set: { refreshTokenHash: hashRefreshToken(refreshToken) } },
  );

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  return accessToken;
}

export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide email and password' });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() }).select('+password');
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

    // Accepts a bcrypt hash, or a legacy plaintext value which is then upgraded.
    // See utils/password.js for why the plaintext path still exists.
    const { ok, needsRehash } = await verifyPassword(password, user.password);
    if (!ok) {
      await recordAudit({ _id: user._id }, AUDIT_ACTIONS.AUTH_LOGIN_FAILED, 'Invalid credentials', req);
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

    // Silent migration off plaintext. Failure here must not fail the login:
    // the credentials were correct, and the next sign-in will try again.
    if (needsRehash) {
      await upgradePasswordHash(User, user._id, password).catch((err) =>
        console.error('[Auth] password rehash failed:', err.message),
      );
    }

    const token = await issueSession(res, user);

    await User.updateOne({ _id: user._id }, { $set: { lastLogin: new Date() } });
    await recordAudit({ _id: user._id }, AUDIT_ACTIONS.AUTH_LOGIN, 'Signed in', req);

    res.status(200).json({
      success: true,
      data: {
        _id: user._id,
        name: user.user || user.email,
        email: user.email,
        role: user.role,
        // Unchanged key and position: the existing frontend reads data.token.
        token,
        // Additive, so a client can refresh before expiry rather than after a 401.
        expiresInMs: accessTokenExpiresInMs(),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /auth/refresh
 *
 * Exchanges the httpOnly refresh cookie for a new access token, rotating the
 * refresh token in the process.
 *
 * Reuse detection: a syntactically valid refresh token whose hash does not
 * match the stored one means an older token was replayed - so every session for
 * that account is revoked, not just this request refused.
 */
export const refresh = async (req, res, next) => {
  try {
    const presented = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!presented) {
      return res.status(401).json({ success: false, message: 'No refresh token.' });
    }

    const payload = verifyRefreshToken(presented);
    if (!payload) {
      res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
      return res.status(401).json({ success: false, message: 'Invalid refresh token.' });
    }

    const user = await User.findById(payload.id).select('+refreshTokenHash');
    if (!user || !user.refreshTokenHash) {
      res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
      return res.status(401).json({ success: false, message: 'Session revoked.' });
    }

    if (!refreshHashMatches(hashRefreshToken(presented), user.refreshTokenHash)) {
      // Replay. Treat the account as compromised and drop every live session.
      await User.updateOne({ _id: user._id }, { $set: { refreshTokenHash: null } });
      res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
      await recordAudit(
        { _id: user._id },
        AUDIT_ACTIONS.AUTH_REFRESH_REUSE_DETECTED,
        'Refresh token reuse detected; all sessions revoked',
        req,
      );
      return res.status(401).json({ success: false, message: 'Refresh token reuse detected.' });
    }

    if (user.status !== 'Active') {
      await User.updateOne({ _id: user._id }, { $set: { refreshTokenHash: null } });
      res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
      return res.status(403).json({ success: false, message: 'Your account is inactive.' });
    }

    const token = await issueSession(res, user);
    await recordAudit({ _id: user._id }, AUDIT_ACTIONS.AUTH_REFRESH, 'Access token refreshed', req);

    res.status(200).json({
      success: true,
      data: { token, expiresInMs: accessTokenExpiresInMs() },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /auth/logout
 *
 * Real revocation: clears the stored refresh hash so the cookie cannot be
 * exchanged again, and clears the cookie itself. Previously logout was
 * `localStorage.removeItem` on the client and the token stayed valid.
 *
 * Deliberately tolerant of an unauthenticated caller - logging out must always
 * succeed from the user's point of view.
 */
export const logout = async (req, res, next) => {
  try {
    const presented = req.cookies?.[REFRESH_COOKIE_NAME];
    const userId = req.user?._id ?? verifyRefreshToken(presented ?? '')?.id ?? null;

    if (userId) {
      await User.updateOne({ _id: userId }, { $set: { refreshTokenHash: null } });
      await recordAudit({ _id: userId }, AUDIT_ACTIONS.AUTH_LOGOUT, 'Signed out', req);
    }

    res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
    res.status(200).json({ success: true, message: 'Logged out.' });
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
        /**
         * Whether this account has HRMS access at all, and which HRMS roles it
         * holds. NOT the HRMS actor: that needs the Employee record behind the
         * login - the department and manager chain every scope check reads -
         * and `/hrms/me` is where it is assembled and where it stays. Putting a
         * second copy here would be a second source of truth for the same
         * question, and the two would eventually disagree.
         *
         * What this IS for: the shell can tell, without a request that is
         * guaranteed to 403, whether to fetch the actor at all. Derived from
         * `roles[]` by the same predicate the server uses, so it cannot drift.
         */
        hrms: {
          roleKeys: (user.roles ?? []).filter(isHrmsRoleKey),
          hasAccess: (user.roles ?? []).some(isHrmsRoleKey),
        },
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

/**
 * Change own password.
 *
 * The new password is ALWAYS stored as a bcrypt hash. This used to write
 * plaintext "to remain consistent with the current auth scheme" — that is what
 * AD-10 ends, since the same login now reaches salary and bank details.
 *
 * Changing the password revokes other sessions: a password change is what
 * someone does when they believe their account is compromised, so leaving old
 * refresh tokens alive would defeat the point.
 */
export const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current and new password are required.' });
    }

    const strength = validatePasswordStrength(newPassword);
    if (!strength.ok) {
      return res.status(400).json({ success: false, message: strength.message });
    }

    const user = await User.findById(req.user.id).select('+password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { ok } = await verifyPassword(currentPassword, user.password);
    if (!ok) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }

    await User.updateOne(
      { _id: user._id },
      { $set: { password: await hashPassword(newPassword), refreshTokenHash: null } },
    );

    res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
    await recordAudit({ _id: user._id }, AUDIT_ACTIONS.AUTH_PASSWORD_CHANGED, 'Password changed; other sessions revoked', req);

    res.status(200).json({ success: true, message: 'Password updated successfully.' });
  } catch (error) {
    next(error);
  }
};
