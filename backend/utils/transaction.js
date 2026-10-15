import mongoose from 'mongoose';
import { isTransactionUnsupported } from './mongoSession.js';
import { collectLedger } from './ledgerDeferral.js';
import { recordStockMovement } from './dualWrite.js';

/**
 * Running work in a MongoDB transaction, the one way every stock-moving
 * workflow should.
 *
 * Replaces three hand-written copies of start / commit / abort / fall back
 * (booking confirmation, desk edits, and now cancellation, PO raising and
 * expiry), which differed in what they did with the two failures that matter:
 *
 * 1. TRANSIENT ERRORS ARE RETRIED, A FEW TIMES. Two bookings for the same SKU
 *    write the same product document; MongoDB lets one commit and aborts the
 *    other with a WriteConflict labelled TransientTransactionError. That error
 *    means "run it again", and the work is safe to re-run because nothing of
 *    the aborted attempt was kept. It used to go straight back to the customer.
 *
 * 2. LEDGER POSTINGS WAIT FOR THE COMMIT. The stock ledger posts in its own
 *    transaction, which survived a rollback and held this one open while it
 *    did. They are queued during the work (see utils/ledgerDeferral.js), posted
 *    after a successful commit, and dropped on abort.
 *
 * Standalone MongoDB (no replica set, e.g. a local or test server) has no
 * transactions: the work then runs once without a session, as before.
 *
 * `work(session)` must do every read and write of the unit through `session`,
 * and must not have side effects outside the database (mail, sockets): it can
 * run more than once. Do those after this resolves.
 */

// Enough for a burst of bookings on one SKU to go through one after another;
// each loser waits a little longer than the last (capped), so worst case is a
// few seconds, not a failure.
const MAX_ATTEMPTS = 8;
const COMMIT_ATTEMPTS = 3;
// MongoDB aborts any transaction open longer than 60 s. An attempt that ran for
// a good part of that and then found itself aborted hit the time limit, not a
// competing writer; running it again would only hit the limit again.
const TIME_LIMITED_AFTER_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hasLabel = (err, label) => Boolean(
  err?.hasErrorLabel?.(label) || err?.errorLabels?.includes?.(label) || err?.errorLabelSet?.has?.(label),
);

/** "Run the whole transaction again": write conflicts, lock timeouts, aborts. */
export const isTransientTransactionError = (err) => Boolean(err) && (
  hasLabel(err, 'TransientTransactionError')
  || err.codeName === 'WriteConflict' || err.code === 112
  || err.codeName === 'NoSuchTransaction' || err.code === 251
  || err.codeName === 'LockTimeout' || err.code === 24
);

const commitWithRetry = async (session) => {
  for (let attempt = 1; ; attempt++) {
    try {
      await session.commitTransaction();
      return;
    } catch (err) {
      // The commit may or may not have applied; committing again is safe and
      // is how the driver documentation says to find out.
      if (hasLabel(err, 'UnknownTransactionCommitResult') && attempt < COMMIT_ATTEMPTS) continue;
      throw err;
    }
  }
};

/** Post queued ledger entries. Never throws — the ledger is a shadow record. */
const flush = async (queue) => {
  for (const input of queue) await recordStockMovement(input);
};

/**
 * @param {(session: import('mongoose').ClientSession|null) => Promise<any>} work
 * @param {object} [options]
 * @param {string} [options.label]  Names the workflow in logs.
 * @returns {Promise<any>} whatever `work` resolved to.
 */
export const runInTransaction = async (work, { label = 'transaction' } = {}) => {
  for (let attempt = 1; ; attempt++) {
    const session = await mongoose.startSession();
    const startedAt = Date.now();
    try {
      let outcome;
      try {
        session.startTransaction();
        outcome = await collectLedger(() => work(session));
        await commitWithRetry(session);
      } catch (err) {
        if (session.inTransaction()) await session.abortTransaction().catch(() => {});

        if (isTransactionUnsupported(err)) {
          // Nothing was committed, so running once without a session is safe.
          console.warn(`[${label}] Transactions unsupported — running without one.`);
          outcome = await collectLedger(() => work(null));
        } else if (
          isTransientTransactionError(err)
          && attempt < MAX_ATTEMPTS
          && Date.now() - startedAt < TIME_LIMITED_AFTER_MS
        ) {
          // Back off a little, with jitter, so two retrying writers do not
          // collide again on the same beat.
          console.warn(`[${label}] ${err.codeName || err.message} — retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS}).`);
          await sleep(Math.min(800, 20 * 2 ** attempt) + Math.floor(Math.random() * 100));
          continue;
        } else {
          throw err;
        }
      }
      await flush(outcome.queue);
      return outcome.value;
    } finally {
      await session.endSession();
    }
  }
};

export default { runInTransaction, isTransientTransactionError };
