/**
 * Settings HTTP handlers.
 *
 * Express 4 does not forward a rejected promise from an async handler, so every
 * one of these catches and calls `next(error)` — the house pattern, and the
 * only thing that turns an `HrmsValidationError` into a 400 rather than an
 * unhandled rejection.
 */

import * as settings from './settings.service.js';

const ok = (res, data) => res.status(200).json({ success: true, data });

/** GET /api/v1/hrms/settings/company */
export const getCompany = async (req, res, next) => {
  try {
    return ok(res, await settings.getCompanySettings());
  } catch (error) {
    return next(error);
  }
};

/** PATCH /api/v1/hrms/settings/company */
export const updateCompany = async (req, res, next) => {
  try {
    return ok(res, await settings.updateCompanySettings(req.body, req.hrmsActor, req));
  } catch (error) {
    return next(error);
  }
};

/** POST /api/v1/hrms/settings/company/logo — multipart, field `logo`. */
export const uploadLogo = async (req, res, next) => {
  try {
    return ok(res, await settings.replaceLogo(req.file, req.hrmsActor, req));
  } catch (error) {
    return next(error);
  }
};

/** GET /api/v1/hrms/settings/roles */
export const getRoles = async (req, res, next) => {
  try {
    return ok(res, await settings.getRoleMatrix());
  } catch (error) {
    return next(error);
  }
};

/** GET /api/v1/hrms/settings/sso */
export const listSso = async (req, res, next) => {
  try {
    return ok(res, await settings.listSsoConfigs());
  } catch (error) {
    return next(error);
  }
};

/** PUT /api/v1/hrms/settings/sso */
export const upsertSso = async (req, res, next) => {
  try {
    return ok(res, await settings.upsertSsoConfig(req.body, req.hrmsActor, req));
  } catch (error) {
    return next(error);
  }
};

/** GET /api/v1/hrms/settings/integrations */
export const listIntegrations = async (req, res, next) => {
  try {
    return ok(res, await settings.listIntegrations());
  } catch (error) {
    return next(error);
  }
};

/** PUT /api/v1/hrms/settings/integrations */
export const upsertIntegration = async (req, res, next) => {
  try {
    return ok(res, await settings.upsertIntegrationConfig(req.body, req.hrmsActor, req));
  } catch (error) {
    return next(error);
  }
};

export default {
  getCompany,
  updateCompany,
  uploadLogo,
  getRoles,
  listSso,
  upsertSso,
  listIntegrations,
  upsertIntegration,
};
