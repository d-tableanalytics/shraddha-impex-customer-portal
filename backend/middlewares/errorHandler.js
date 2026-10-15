import { isTransientTransactionError } from '../utils/transaction.js';

export const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';

  // Mongoose Duplicate Key Error
  if (err.code === 11000) {
    statusCode = 400;
    message = `Duplicate field value entered.`;
  }

  // Mongoose Validation Error
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(err.errors).map(val => val.message).join(', ');
  }

  // JWT Errors
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token. Please log in again.';
  }

  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Your token has expired. Please log in again.';
  }

  // A transaction that still could not commit after its retries (see
  // utils/transaction.js) — another booking kept winning the same stock, or the
  // work outlived MongoDB's transaction time limit. Nothing was saved, and the
  // customer should be told that plainly rather than shown the database's own
  // wording ("Transaction with { txnNumber: 1 } has been aborted").
  if (isTransientTransactionError(err)) {
    statusCode = 409;
    message = 'This could not be completed, so nothing was saved. Please try again — '
      + 'if it was a very large upload, split it into smaller files.';
  } else if (statusCode === 500 && /^Mongo/.test(err.name || '')) {
    // Any other database failure: log it in full, say nothing internal.
    message = 'Something went wrong while saving. Please try again.';
  }

  // The ORIGINAL error goes to the log, whatever the client was told: the
  // "transaction aborted" reports could only be diagnosed by reproducing them,
  // because the reply was all that was ever logged.
  console.error(
    `[Error] ${statusCode} - ${message}`
    + (message !== err.message ? ` | original: ${err.codeName || err.name || ''} ${err.message}` : ''),
  );
  
  res.status(statusCode).json({
    success: false,
    message,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack
  });
};
