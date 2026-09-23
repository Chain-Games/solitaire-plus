import type { Db, Tx } from './index.js';
import type { Notification } from './schema.js';

/**
 * After-commit outbox for notification rows.
 *
 * A notification is written INSIDE the transaction that settles, takes or
 * expires the challenge (so it can never exist without the change it
 * reports, and never be lost when that change is), but nothing may be sent
 * from inside it: a push-service round trip would hold the challenge's row
 * locks, and a transaction that rolls back must tell nobody. So the insert
 * path queues the row on its transaction with `enqueue`, and `installOutbox`
 * wraps `db.transaction` so the queue reaches the db's listeners once the
 * commit has returned — and is dropped on a rollback. Listeners run
 * detached: a slow push service never delays the settlement's response.
 */

export type OutboxListener = (row: Notification) => void;

const QUEUES = new WeakMap<object, Notification[]>();
const LISTENERS = new WeakMap<object, Set<OutboxListener>>();

/** Queue a freshly inserted row for delivery after `tx` commits. */
export function enqueue(tx: Tx, row: Notification): void {
  const q = QUEUES.get(tx);
  if (!q) throw new Error('outbox: this transaction was not opened through db.transaction');
  q.push(row);
}

/** Hear every committed notification row written through this db. */
export function onCommitted(db: Db, listener: OutboxListener): () => void {
  let set = LISTENERS.get(db);
  if (!set) {
    set = new Set();
    LISTENERS.set(db, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}

/** Wrap `db.transaction` once, at `createDb`. Idempotent. */
export function installOutbox(db: Db): void {
  if (LISTENERS.has(db)) return;
  LISTENERS.set(db, new Set());
  const original = db.transaction.bind(db);
  type Transaction = Db['transaction'];
  const wrapped: Transaction = async (fn, config) => {
    const queue: Notification[] = [];
    const result = await original(async (tx) => {
      QUEUES.set(tx, queue);
      return fn(tx);
    }, config);
    // Committed. Deliver detached; a listener's failure is its own to log.
    if (queue.length > 0) {
      const listeners = LISTENERS.get(db);
      if (listeners)
        for (const row of queue)
          for (const listener of listeners)
            queueMicrotask(() => {
              try {
                listener(row);
              } catch {
                // never the caller's problem
              }
            });
    }
    return result;
  };
  db.transaction = wrapped;
}
