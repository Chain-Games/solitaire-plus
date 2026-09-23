import type { Db } from '../db/index.js';
import { onCommitted } from '../db/outbox.js';
import type { Notification } from '../db/schema.js';
import type { NotifyBus } from './notify-bus.js';
import type { PushSender } from './push.js';

/**
 * Delivery of committed notification rows: the live bus (open SSE streams)
 * first, then Web Push, detached. Built once per app; `idle()` lets a test
 * wait for the sends it kicked off.
 */
export class Notifier {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly stop: () => void;

  constructor(
    db: Db,
    readonly bus: NotifyBus,
    private readonly push: PushSender | null,
  ) {
    this.stop = onCommitted(db, (row) => this.deliver(row));
  }

  deliver(row: Notification): void {
    this.bus.publish(row.userId, row);
    if (!this.push) return;
    const p = this.push.send(row).catch(() => undefined);
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  /** Resolves once every push send started so far has finished (tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  close(): void {
    this.stop();
  }
}
