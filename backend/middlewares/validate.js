/**
 * Zod request validation (AD-6).
 *
 * Zod is load-bearing here, not a convenience. AD-2 stores ~20 schema-less
 * `Mixed` fields, and AD-6 declined TypeScript - so validation at the boundary
 * is the only thing constraining what reaches the database. A route without it
 * accepts whatever it is sent.
 *
 * Replaces the request body/query/params with the PARSED result, so downstream
 * code reads coerced, defaulted, trimmed values rather than raw strings. That
 * matters for query strings especially: `?page=2` arrives as text and must be a
 * number by the time a service sees it.
 */

import { formatZodIssues } from '../shared/validation/common.js';

const TARGETS = ['body', 'query', 'params'];

/**
 * Validate one or more parts of the request.
 *
 *   router.post('/x', validate({ body: createThingSchema }), handler)
 *   router.get('/x',  validate({ query: paginationQuery }), handler)
 *
 * @param {object} schemas  `{ body?, query?, params? }`
 */
export function validate(schemas = {}) {
  const targets = TARGETS.filter((t) => schemas[t]);
  if (targets.length === 0) {
    throw new TypeError('validate() needs at least one of body, query or params');
  }

  return (req, res, next) => {
    const errors = [];

    for (const target of targets) {
      const result = schemas[target].safeParse(req[target]);
      if (!result.success) {
        errors.push(
          ...formatZodIssues(result.error).map((issue) => ({ ...issue, in: target })),
        );
        continue;
      }

      // Express 5 makes req.query a getter, so assigning to it throws. Define
      // the parsed value instead, which works on both 4 and 5.
      Object.defineProperty(req, target, {
        value: result.data,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed.',
        errors,
      });
    }

    return next();
  };
}

export default validate;
