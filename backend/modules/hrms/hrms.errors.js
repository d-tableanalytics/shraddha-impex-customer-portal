/**
 * HRMS error types.
 *
 * The portal's `errorHandler` returns 500 for anything without a `statusCode`,
 * so an expected condition - "that department does not exist" - would surface
 * as a server fault. These carry the status and a stable `code`, letting the
 * HTTP layer respond correctly without string-matching a message.
 *
 * `code` is what a client should branch on. `message` is for a human and may be
 * reworded at any time.
 */

export class HrmsError extends Error {
  constructor(message, { statusCode = 400, code = 'HRMS_ERROR', details = null } = {}) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  toResponse() {
    return {
      success: false,
      message: this.message,
      code: this.code,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export class HrmsNotFoundError extends HrmsError {
  constructor(what = 'Resource', { code = 'HRMS_NOT_FOUND', details = null } = {}) {
    super(`${what} not found.`, { statusCode: 404, code, details });
  }
}

export class HrmsValidationError extends HrmsError {
  constructor(message, details = null) {
    super(message, { statusCode: 400, code: 'HRMS_VALIDATION_FAILED', details });
  }
}

export class HrmsConflictError extends HrmsError {
  constructor(message, { code = 'HRMS_CONFLICT', details = null } = {}) {
    super(message, { statusCode: 409, code, details });
  }
}

export class HrmsForbiddenError extends HrmsError {
  constructor(message = 'Forbidden.', { code = 'HRMS_FORBIDDEN' } = {}) {
    super(message, { statusCode: 403, code });
  }
}

/**
 * A dependency that a later phase provides has not been wired up yet.
 *
 * 503, not 500: the request was valid and the server is healthy - the capability
 * simply is not installed. Phase 1 has several of these by design (the Employee
 * Master is Phase 2+), and AD-11 requires that an unresolvable dependency
 * "fail clearly and safely" rather than return an empty result that reads as
 * "no employees" when it means "employees do not exist yet".
 */
export class HrmsNotImplementedError extends HrmsError {
  constructor(capability, hint) {
    super(
      `${capability} is not available yet.${hint ? ` ${hint}` : ''}`,
      { statusCode: 503, code: 'HRMS_NOT_IMPLEMENTED' },
    );
    this.capability = capability;
  }
}

/**
 * Express handler that converts an HrmsError into its response.
 *
 * Mounted on the HRMS router only, ahead of the app-wide handler, so portal
 * error handling is untouched.
 */
export function hrmsErrorHandler(err, req, res, next) {
  if (err instanceof HrmsError) {
    return res.status(err.statusCode).json(err.toResponse());
  }
  return next(err);
}

export default {
  HrmsError,
  HrmsNotFoundError,
  HrmsValidationError,
  HrmsConflictError,
  HrmsForbiddenError,
  HrmsNotImplementedError,
  hrmsErrorHandler,
};
