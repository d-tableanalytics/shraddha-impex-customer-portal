import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export const protect = async (req, res, next) => {
  try {
    if (req.user) {
      if (req.user.status && req.user.status !== 'Active') {
        return res.status(401).json({ success: false, message: 'User account is inactive or suspended.' });
      }
      return next();
    }

    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies?.accessToken) {
      token = req.cookies.accessToken;
    }

    if (!token) {
      return res.status(401).json({ success: false, message: 'Not authorized to access this route.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    /*
     * Only an ACCESS token opens the API.
     *
     * Refresh tokens are signed with the refresh secret, which falls back to
     * JWT_SECRET when JWT_REFRESH_SECRET is unset (utils/tokens.js) - and it is
     * unset in both portals. So a refresh token used to verify here and work as
     * a 7-day access token, one that logout and a password change could revoke
     * at /auth/refresh but never here. Every token signAccessToken() issues
     * carries type 'access'; one with no type predates that stamp and has long
     * expired, so it is still accepted rather than signing anybody out.
     */
    if (decoded.type && decoded.type !== 'access') {
      return res.status(401).json({ success: false, message: 'Not authorized to access this route.' });
    }
    
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ success: false, message: 'The user belonging to this token no longer exists.' });
    }

    if (user.status !== 'Active') {
      return res.status(401).json({ success: false, message: 'User account is inactive or suspended.' });
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
};
