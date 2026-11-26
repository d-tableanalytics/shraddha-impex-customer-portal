import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Holding stock-ledger postings back until a transaction commits.
 *
 * recordStockMovement() posts to the ledger in its OWN transaction, on its own
 * session. Called from inside a booking transaction, that meant two problems:
 *
 *   - the posting survived when the booking rolled back, so the ledger claimed
 *     movements that never happened (a rolled-back bulk upload left a batch per
 *     row behind);
 *   - each posting is several round trips, all spent while the booking
 *     transaction stayed open. A long bulk upload outlived MongoDB's 60-second
 *     transaction limit and failed with "Transaction with { txnNumber: N } has
 *     been aborted."
 *
 * Inside collectLedger(), recordStockMovement() queues the posting instead.
 * The caller posts the queue once the transaction has committed, and drops it
 * if the transaction aborts. See runInTransaction() in utils/transaction.js.
 *
 * A leaf module (no imports) so dualWrite.js and transaction.js can both use it
 * without an import cycle.
 */
const store = new AsyncLocalStorage();

/**
 * Run `fn` with ledger postings queued. Resolves to { value, queue }.
 *
 * `session` is the transaction the work is running in, carried here so
 * recordStockMovement can write its OUTBOX row through the same session — the
 * row and the stock mutation then commit or roll back together, which is the
 * whole guarantee the outbox provides. Passing it through the store rather
 * than through every call site keeps the twelve stock call sites untouched.
 */
export const collectLedger = async (fn, session = null) => {
  const queue = [];
  const value = await store.run({ queue, session }, fn);
  return { value, queue };
};

/** The active queue, or null when postings should go straight through. */
export const activeLedgerQueue = () => store.getStore()?.queue ?? null;

/** The transaction the current work is running in, if any. */
export const activeLedgerSession = () => store.getStore()?.session ?? null;

/**
 * Whether ledger postings are awaited before the caller's request returns.
 *
 *   'async' (default)  the caller does not wait for history to be written
 *   'sync'             postings complete before the call returns
 *
 * Lives in this leaf module so dualWrite.js and transaction.js read the same
 * answer without importing each other. Read on every call rather than captured
 * at import, so a test can set it after the module graph is loaded.
 *
 * NOTHING ELSE IS DEFERRED BY THIS. Stock figures, availability, bookings and
 * reservations are written by the workflow itself and are already committed.
 * Only the ledger — history, and the projection derived from it — is affected.
 */
export const ledgerPostingMode = () => (process.env.IMS_LEDGER_POSTING === 'sync' ? 'sync' : 'async');

export default { collectLedger, activeLedgerQueue, activeLedgerSession };
