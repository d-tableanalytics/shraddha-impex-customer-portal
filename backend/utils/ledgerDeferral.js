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

/** Run `fn` with ledger postings queued. Resolves to { value, queue }. */
export const collectLedger = async (fn) => {
  const queue = [];
  const value = await store.run({ queue }, fn);
  return { value, queue };
};

/** The active queue, or null when postings should go straight through. */
export const activeLedgerQueue = () => store.getStore()?.queue ?? null;

export default { collectLedger, activeLedgerQueue };
