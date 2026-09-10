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
  REFRESH_GRACE_MS,
  MAX_REFRESH_SESSIONS,
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

/** The device label stored against a session, so a person can recognise it. */
const agentOf = (req) => String(req?.headers?.['user-agent'] ?? '').slice(0, 255) || null;

/**
 * Open a NEW session and issue its token pair.
 *
 * Used by sign-in only. A refresh does not come through here — it rotates the
 * session it was presented with (see `rotateSession`), because creating a new
 * row on every refresh would fill the array with one entry per quarter hour.
 *
 * The access token goes in the response body, exactly where the existing
 * frontend already looks for it. The refresh token goes ONLY into an httpOnly
 * cookie, so it is never reachable from JavaScript.
 *
 * WHAT CHANGED: this used to `$set` a single account-wide `refreshTokenHash`,
 * so signing in anywhere silently invalidated everywhere else. It now PUSHES a
 * session, leaving other devices alone.
 */
async function issueSession(res, user, req) {
  const accessToken = signAccessToken(user._id);
  const { token: refreshToken, jti } = signRefreshToken(user._id);
  const now = new Date();

  const session = {
    hash: hashRefreshToken(refreshToken),
    prevHash: null,
    rotatedAt: now,
    jti,
    createdAt: now,
    lastUsedAt: now,
    userAgent: agentOf(req),
  };

  // $push with $slice keeps the newest MAX_REFRESH_SESSIONS and drops the rest,
  // so the array cannot grow without bound. $sort by lastUsedAt first means the
  // entry evicted is the least recently used — the device the person is least
  // likely to still be sitting in front of.
  await User.updateOne(
    { _id: user._id },
    {
      $push: {
        refreshSessions: {
          $each: [session],
          $sort: { lastUsedAt: 1 },
          $slice: -MAX_REFRESH_SESSIONS,
        },
      },
    },
  );

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  return accessToken;
}

/**
 * Rotate ONE session and issue its next token pair.
 *
 * The write is a COMPARE-AND-SWAP: the filter names the exact session by its
 * current hash, so if a racing request rotated it a millisecond ago this update
 * matches nothing and we can tell the difference between "I rotated it" and "it
 * moved under me". `$elemMatch` is required — a positional `$` needs the array
 * element to be identified in the FILTER, and matching two fields of the same
 * element any other way can match across different elements.
 *
 * Returns the new access token, or null if the swap lost its race.
 */
async function rotateSession(res, user, currentHash, req) {
  const { token: refreshToken, jti } = signRefreshToken(user._id);
  const now = new Date();

  const result = await User.updateOne(
    { _id: user._id, refreshSessions: { $elemMatch: { hash: currentHash } } },
    {
      $set: {
        'refreshSessions.$.hash': hashRefreshToken(refreshToken),
        // The token just superseded stays acceptable for REFRESH_GRACE_MS, so a
        // second tab that set off before this rotation landed is served rather
        // than treated as an attacker.
        'refreshSessions.$.prevHash': currentHash,
        'refreshSessions.$.rotatedAt': now,
        'refreshSessions.$.lastUsedAt': now,
        'refreshSessions.$.jti': jti,
        'refreshSessions.$.userAgent': agentOf(req),
      },
    },
  );

  if (result.matchedCount === 0) return null;

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  return signAccessToken(user._id);
}

/**
 * Adopt a session issued under the OLD single-hash model.
 *
 * Without this, deploying this change would sign out everyone holding a valid
 * cookie — the array is empty for every existing account, so their next refresh
 * would find no session and 401. Instead the legacy hash is matched once,
 * converted into a session row, and cleared.
 *
 * Returns the adopted session's hash, or null if the presented token is not the
 * legacy one.
 */
async function adoptLegacySession(user, presentedHash, req) {
  if (!user.refreshTokenHash) return null;
  if (!refreshHashMatches(presentedHash, user.refreshTokenHash)) return null;

  const now = new Date();
  await User.updateOne(
    { _id: user._id, refreshTokenHash: user.refreshTokenHash },
    {
      $set: { refreshTokenHash: null },
      $push: {
        refreshSessions: {
          hash: presentedHash,
          prevHash: null,
          rotatedAt: now,
          jti: null,
          createdAt: now,
          lastUsedAt: now,
          userAgent: agentOf(req),
        },
      },
    },
  );
  return presentedHash;
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

    const token = await issueSession(res, user, req);

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

    const user = await User.findById(payload.id).select('+refreshTokenHash +refreshSessions');
    if (!user) {
      res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
      return res.status(401).json({ success: false, message: 'Session revoked.' });
    }

    const presentedHash = hashRefreshToken(presented);
    const sessions = user.refreshSessions ?? [];

    /*
     * Which SESSION is this, and is the token its current one?
     *
     * `refreshHashMatches` is the constant-time comparison; it is called here,
     * in the controller, exactly as before.
     */
    let session = sessions.find((s) => refreshHashMatches(presentedHash, s.hash));
    let onGrace = false;

    if (!session) {
      // Not a current token. Is it the one THIS session held moments ago?
      //
      // Two tabs share one cookie and one access token, so they expire together
      // and both post here. The first rotates; the second is still carrying what
      // is now `prevHash`. Inside the grace window that is a race, not a replay —
      // and calling it a replay is precisely what was signing people out.
      const raced = sessions.find(
        (s) =>
          s.prevHash &&
          refreshHashMatches(presentedHash, s.prevHash) &&
          s.rotatedAt &&
          Date.now() - new Date(s.rotatedAt).getTime() <= REFRESH_GRACE_MS,
      );
      if (raced) {
        session = raced;
        onGrace = true;
      }
    }

    if (!session) {
      /*
       * A genuine replay, or a session that was revoked while this tab slept.
       *
       * Adopt-or-refuse. First give a cookie issued under the OLD single-hash
       * model a chance: this deploy must not sign out everyone holding one.
       */
      const adopted = await adoptLegacySession(user, presentedHash, req);
      if (adopted) {
        session = { hash: adopted, prevHash: null, rotatedAt: new Date() };
      } else {
        /*
         * WHAT DELIBERATELY NO LONGER HAPPENS HERE.
         *
         * This branch used to `$set: { refreshTokenHash: null }` — revoking
         * EVERY session the account had, on any mismatch. That is the correct
         * response to a confirmed theft and a catastrophic one to a race, and
         * the production audit trail showed it firing on 28% of all refresh
         * attempts against real staff doing nothing unusual.
         *
         * The blast radius is now the one session that presented the token, and
         * that session is already gone (that is why nothing matched). So the
         * honest response is to refuse THIS request and leave the account's
         * other devices signed in. The event is still audited, so a real attack
         * is still visible — it just no longer takes the business offline.
         */
        res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
        await recordAudit(
          { _id: user._id },
          AUDIT_ACTIONS.AUTH_REFRESH_REUSE_DETECTED,
          'Refresh token did not match any live session; this session refused (other devices unaffected)',
          req,
        );
        return res.status(401).json({ success: false, message: 'Session expired. Please sign in again.' });
      }
    }

    if (user.status !== 'Active') {
      // An inactive account loses everything — that IS an account-wide decision.
      await User.updateOne(
        { _id: user._id },
        { $set: { refreshTokenHash: null, refreshSessions: [] } },
      );
      res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
      return res.status(403).json({ success: false, message: 'Your account is inactive.' });
    }

    let token;
    if (onGrace) {
      /*
       * The racing tab. It gets a working access token and NOTHING ELSE:
       *
       *   - no rotation, or the two tabs would rotate each other in a loop
       *   - no Set-Cookie, because the winning tab's cookie is the live one and
       *     overwriting it with a token minted here would invalidate the winner
       *   - no clearCookie, which is what the old code did and is how a losing
       *     race used to delete the credential the winner had just been issued
       */
      token = signAccessToken(user._id);
    } else {
      token = await rotateSession(res, user, session.hash, req);
      if (!token) {
        // The compare-and-swap lost: another request rotated this same session
        // between our read and our write. Its cookie is the live one; ours is
        // already stale. Serve an access token rather than manufacturing a
        // conflict — the outcome is identical to arriving a moment later and
        // taking the grace branch.
        token = signAccessToken(user._id);
      }
    }

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
      /*
       * Sign out THIS device only.
       *
       * This used to null the account-wide hash, so signing out of the office
       * desktop also signed you out on your phone — which nobody expects from a
       * button labelled "Sign out", and which the previous doc comment did not
       * mention. With one row per session the right scope is expressible: pull
       * the row whose hash matches the cookie being surrendered.
       *
       * `prevHash` is matched too, so signing out immediately after a background
       * refresh still finds the row rather than silently leaving it live.
       *
       * A caller with no usable cookie (already expired, or never had one) falls
       * through having removed nothing, which is correct — logging out must
       * always succeed from the user's point of view, and there is nothing here
       * to identify a session by.
       */
      const presentedHash = presented ? hashRefreshToken(presented) : null;
      if (presentedHash) {
        await User.updateOne(
          { _id: userId },
          { $pull: { refreshSessions: { $or: [{ hash: presentedHash }, { prevHash: presentedHash }] } } },
        );
      }
      // Legacy single-hash holders have no row to pull; clear the old field so
      // the surrendered cookie cannot be adopted back into a session later.
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

    /*
     * Changing your password revokes every OTHER session and keeps this one.
     *
     * The old code nulled the single account-wide hash and cleared the caller's
     * cookie, so changing your own password signed you out and dumped you back
     * on the login screen — with a single shared string there was no way to
     * express "everyone but me". Per-session rows make it a $pull.
     *
     * The security property is unchanged and is the one that matters: an
     * attacker holding a stolen refresh token is evicted the moment the real
     * owner changes their password.
     */
    const presented = req.cookies?.[REFRESH_COOKIE_NAME];
    const keepHash = presented ? hashRefreshToken(presented) : null;

    // Built as one object rather than a conditional spread: spreading a second
    // `$set` would REPLACE the first and silently drop the password itself.
    const update = {
      $set: { password: await hashPassword(newPassword), refreshTokenHash: null },
    };
    if (keepHash) {
      // Every session except the one making the change. Both fields are matched
      // so a session that rotated moments ago is still recognised as "mine".
      update.$pull = {
        refreshSessions: { hash: { $ne: keepHash }, prevHash: { $ne: keepHash } },
      };
    } else {
      // No usable cookie to identify the caller, so nothing can be spared.
      update.$set.refreshSessions = [];
    }

    await User.updateOne({ _id: user._id }, update);

    // The caller's own cookie is deliberately NOT cleared when it was kept.
    if (!keepHash) res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
    await recordAudit({ _id: user._id }, AUDIT_ACTIONS.AUTH_PASSWORD_CHANGED, 'Password changed; other sessions revoked', req);

    res.status(200).json({ success: true, message: 'Password updated successfully.' });
  } catch (error) {
    next(error);
  }
};
