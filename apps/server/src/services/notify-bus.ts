import type { Notification } from '../db/schema.js';

/**
 * Fan-out of committed notification rows to the live streams of the user
 * they belong to. This is the ONE seam a multi-instance deploy has to
 * replace: with several API containers a settlement on one must reach a
 * stream held open by another, which the in-memory bus below cannot do —
 * swap it for a Redis pub/sub implementation (`PUBLISH notify:<userId>`
 * on `publish`, one `SUBSCRIBE` per open stream on `subscribe`) and nothing
 * else changes. The rows themselves are in Postgres either way; the bus
 * only says "there is a new one".
 */
export interface NotifyBus {
  publish(userId: string, row: Notification): void;
  subscribe(userId: string, listener: (row: Notification) => void): () => void;
  /** Open subscriptions for a user (the stream cap counts these). */
  count(userId: string): number;
}

export class MemoryNotifyBus implements NotifyBus {
  private readonly subs = new Map<string, Set<(row: Notification) => void>>();

  publish(userId: string, row: Notification): void {
    const set = this.subs.get(userId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(row);
      } catch {
        // a dead stream is its own problem; the next one still gets the row
      }
    }
  }

  subscribe(userId: string, listener: (row: Notification) => void): () => void {
    let set = this.subs.get(userId);
    if (!set) {
      set = new Set();
      this.subs.set(userId, set);
    }
    set.add(listener);
    return () => {
      const s = this.subs.get(userId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.subs.delete(userId);
    };
  }

  count(userId: string): number {
    return this.subs.get(userId)?.size ?? 0;
  }
}
