import Location from '../../models/Location.js';
import { recordAudit } from '../../utils/auditLog.js';

/**
 * Location master (Module M1).
 *
 * Master data only at this stage — nothing posts stock against a location until
 * Module M3 introduces balances. The dimension exists now so that enabling
 * multi-site later is data plus a transfer workflow, not a rewrite of every
 * balance, movement and report.
 */

const LOCATION_TYPES = ['Warehouse', 'Shop', 'Transit', 'Virtual'];

export const listLocations = async (req, res, next) => {
  try {
    // `?includeInactive=true` for the admin screen; everything else sees only
    // locations that can actually be posted to.
    const includeInactive = ['true', '1'].includes(String(req.query.includeInactive));
    const query = includeInactive ? {} : { active: true };

    const locations = await Location.find(query).sort({ isDefault: -1, code: 1 }).lean();
    res.status(200).json({ success: true, data: locations });
  } catch (error) {
    next(error);
  }
};

export const createLocation = async (req, res, next) => {
  try {
    const code = String(req.body.code || '').trim().toUpperCase();
    const name = String(req.body.name || '').trim();
    const type = req.body.type || 'Warehouse';

    if (!code || !name) {
      return res.status(400).json({ success: false, message: 'Code and name are required.' });
    }
    if (!LOCATION_TYPES.includes(type)) {
      return res.status(400).json({
        success: false,
        message: `Type must be one of: ${LOCATION_TYPES.join(', ')}.`,
      });
    }

    const clash = await Location.findOne({ code });
    if (clash) {
      return res.status(409).json({
        success: false,
        message: `Location code ${code} already exists.`,
      });
    }

    const location = await Location.create({
      code,
      name,
      type,
      address: req.body.address || null,
      // The first location created becomes the default if none exists yet.
      isDefault: (await Location.countDocuments()) === 0,
      active: true,
    });

    await recordAudit(req.user, 'Location Created', `Location ${code} (${name}) created.`, req, {
      meta: { code, name, type },
    });

    res.status(201).json({ success: true, data: location });
  } catch (error) {
    next(error);
  }
};

export const updateLocation = async (req, res, next) => {
  try {
    const location = await Location.findById(req.params.id);
    if (!location) {
      return res.status(404).json({ success: false, message: 'Location not found' });
    }

    const updates = {};
    if ('name' in req.body) updates.name = String(req.body.name).trim();
    if ('address' in req.body) updates.address = req.body.address || null;
    if ('type' in req.body) {
      if (!LOCATION_TYPES.includes(req.body.type)) {
        return res.status(400).json({
          success: false,
          message: `Type must be one of: ${LOCATION_TYPES.join(', ')}.`,
        });
      }
      updates.type = req.body.type;
    }

    if ('active' in req.body) {
      const active = Boolean(req.body.active);

      // BR-73 — a location holding stock cannot be deactivated. Balances are
      // per-location only from Module M3, so until then the only check that can
      // be made is the structural one: the default location must stay usable,
      // because every movement posted without an explicit location lands there.
      if (!active && location.isDefault) {
        return res.status(409).json({
          success: false,
          message:
            'The default location cannot be deactivated. Make another location the default first.',
        });
      }
      updates.active = active;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'No editable fields supplied.' });
    }

    const updated = await Location.findByIdAndUpdate(location._id, updates, {
      new: true,
      runValidators: true,
    });

    await recordAudit(req.user, 'Location Updated', `Location ${location.code} updated.`, req, {
      meta: { code: location.code, updates },
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

/**
 * Exactly one location carries `isDefault`. Promoting a new one demotes the old
 * one in the same operation, so there can never be zero or two defaults.
 */
export const setDefaultLocation = async (req, res, next) => {
  try {
    const location = await Location.findById(req.params.id);
    if (!location) {
      return res.status(404).json({ success: false, message: 'Location not found' });
    }
    if (!location.active) {
      return res.status(409).json({
        success: false,
        message: 'An inactive location cannot be made the default.',
      });
    }

    await Location.updateMany({ _id: { $ne: location._id } }, { $set: { isDefault: false } });
    location.isDefault = true;
    await location.save();

    await recordAudit(
      req.user,
      'Default Location Changed',
      `Default stock location set to ${location.code}.`,
      req,
      { meta: { code: location.code } },
    );

    res.status(200).json({ success: true, data: location });
  } catch (error) {
    next(error);
  }
};

export default { listLocations, createLocation, updateLocation, setDefaultLocation };
