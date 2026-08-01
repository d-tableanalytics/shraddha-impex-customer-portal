/**
 * MongoDB session helpers.
 *
 * `isTransactionUnsupported` existed as two separate inline copies — a named
 * function in the reservations controller and an anonymous expression in the
 * sales controller — which is exactly the duplication that lets error handling
 * drift. One definition means a new error shape is recognised everywhere at once.
 */

/**
 * True when an error means "this deployment has no transaction support",
 * i.e. a standalone mongod rather than a replica set or mongos.
 *
 * This is deliberately narrow. It must NOT swallow a genuine write failure,
 * because callers respond to it by re-running the operation without a session —
 * safe only when nothing was committed, which is the case for this specific
 * error and not for others.
 */
export const isTransactionUnsupported = (err) => {
  if (!err) return false;
  const msg = err.message || '';
  return (
    err.code === 20 || // IllegalOperation
    err.codeName === 'IllegalOperation' ||
    /Transaction numbers are only allowed on a replica set member or mongos/i.test(msg) ||
    /Transactions are not supported/i.test(msg)
  );
};

/**
 * True when a write failed because it violated a unique index.
 *
 * The ledger relies on this: two concurrent postings carrying the same
 * idempotency key race to insert the batch, one wins, and the loser must
 * recognise the collision and return the winner's batch rather than surfacing
 * a server error.
 */
export const isDuplicateKeyError = (err) =>
  Boolean(err) && (err.code === 11000 || err.codeName === 'DuplicateKey');

export default { isTransactionUnsupported, isDuplicateKeyError };
