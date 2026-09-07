/**
 * Attendance HTTP layer.
 *
 * Thin, as every other HRMS controller is: validation in the `validate`
 * middleware, authorization in `requirePermission` and in the services,
 * business rules and audit in the services. What remains here is shaping the
 * response.
 *
 * ---------------------------------------------------------------------------
 * The envelope
 * ---------------------------------------------------------------------------
 * Every payload goes UNDER `data`, never spread beside it. The employee list
 * once shipped as `json({ success: true, ...result })`, the client unwrapped
 * one level and got a bare array, and the directory died on `rows.length`. A
 * paginated response here is therefore
 * `{ success: true, data: { data, total, page, pageSize } }` — the inner
 * `data` is the rows, and the outer one is the envelope. The reference returns
 * bare payloads with no envelope at all; that is not followed.
 */

import * as attendanceService from './attendance.service.js';
import * as correctionService from './correction.service.js';
import * as consentService from './consent.service.js';
import * as selfieService from './selfie.service.js';
import { FileAccessError } from '../storage/storage.service.js';
import { HrmsForbiddenError } from '../hrms.errors.js';

/** The audit context every write hands to its service. */
const contextOf = (req) => ({ user: req.user, req });

// ---------------------------------------------------------------------------
// Punches
// ---------------------------------------------------------------------------

/** POST /api/v1/hrms/attendance/clock-in */
export const clockIn = async (req, res, next) => {
  try {
    const data = await attendanceService.clockIn(req.hrmsActor, req.body, contextOf(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/attendance/clock-out */
export const clockOut = async (req, res, next) => {
  try {
    const data = await attendanceService.clockOut(req.hrmsActor, req.body, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/hrms/attendance/today
 *
 * `data: null` for someone who has not clocked in, not a 404. "You have not
 * started your day" is an answer, and the card that renders it needs a 200 to
 * distinguish it from a failed request.
 */
export const today = async (req, res, next) => {
  try {
    const data = await attendanceService.today(req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** GET /api/v1/hrms/attendance */
export const list = async (req, res, next) => {
  try {
    const data = await attendanceService.list(req.hrmsActor, req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/attendance/team-grid */
export const teamGrid = async (req, res, next) => {
  try {
    const data = await attendanceService.teamGrid(req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Selfies
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/hrms/attendance/selfie
 *
 * Returns an opaque object KEY, which the punch then quotes back. The bytes are
 * validated here; ownership of the key is re-checked at punch time, because
 * this endpoint and the punch are two separate requests and only the punch
 * knows which employee is claiming it.
 */
export const uploadSelfie = async (req, res, next) => {
  try {
    const actor = req.hrmsActor;
    if (!actor?.employeeId) {
      throw new HrmsForbiddenError('Your account has no employee record.');
    }
    const { key, size, contentType } = await selfieService.storeSelfie({
      employeeId: actor.employeeId,
      buffer: req.file?.buffer,
      mimeType: req.file?.mimetype,
    });
    res.status(201).json({ success: true, data: { key, size, contentType } });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/hrms/attendance/records/:id/selfie/:punch
 *
 * A 60-second presigned URL, issued only after the per-object permission check
 * in the storage service, and audited as `hrms.attendance.selfie.viewed`.
 *
 * This is what replaces the reference's `@Public() GET /attendance/selfie/:filename`.
 */
export const getSelfieUrl = async (req, res, next) => {
  try {
    const data = await selfieService.issueSelfieUrl({
      recordId: req.params.id,
      punch: req.params.punch,
      actor: req.hrmsActor,
      req,
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    if (error instanceof FileAccessError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/hrms/attendance/consent
 *
 * The caller's own consent state, with the notice text for each purpose. The
 * text ships with the state so the UI cannot display wording that differs from
 * the version being recorded against it.
 */
export const getConsent = async (req, res, next) => {
  try {
    const data = await consentService.consentStateFor(req.hrmsActor?.employeeId);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/hrms/attendance/consent
 *
 * Grant or withdraw, for one purpose. Always the CALLER's own consent — the
 * employee id comes from the actor and there is no route parameter for anyone
 * else's. Consent given on someone's behalf is not consent.
 */
export const setConsent = async (req, res, next) => {
  try {
    const result = await consentService.setConsent({
      employeeId: req.hrmsActor?.employeeId,
      purpose: req.body.purpose,
      granted: req.body.granted,
      req,
      user: req.user,
    });
    const state = await consentService.consentStateFor(req.hrmsActor?.employeeId);
    res.status(200).json({ success: true, data: { ...result, state } });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

/** POST /api/v1/hrms/attendance/corrections */
export const submitCorrection = async (req, res, next) => {
  try {
    const data = await correctionService.submitCorrection(
      req.hrmsActor,
      req.body,
      contextOf(req),
    );
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/attendance/corrections */
export const listCorrections = async (req, res, next) => {
  try {
    const data = await correctionService.listCorrections(req.hrmsActor, req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/hrms/attendance/corrections/:id/decide
 *
 * 200 with the updated correction rather than the reference's 204-with-no-body,
 * so the client gets the same envelope as every other endpoint and does not
 * have to refetch to learn what happened.
 */
export const decideCorrection = async (req, res, next) => {
  try {
    const data = await correctionService.decideCorrection(
      req.params.id,
      req.body,
      req.hrmsActor,
      contextOf(req),
    );
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export default {
  clockIn,
  clockOut,
  today,
  list,
  teamGrid,
  uploadSelfie,
  getSelfieUrl,
  getConsent,
  setConsent,
  submitCorrection,
  listCorrections,
  decideCorrection,
};
