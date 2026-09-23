import { stateHash } from '@solitaire-plus/sim';
import { ApiError, api } from '../api/client.js';
import type { GameController } from './controller.js';

/** Plain moves are batched this long (the server's MOVE_BATCH_MS bound assumes it). */
const BATCH_MS = 250;
/** A reveal still unanswered after this long shows the "Reconnecting…" strip. */
const OFFLINE_AFTER_MS = 1500;

/**
 * Streams a staked game's moves to the server (docs/SPEC.md § 4).
 *
 * Plain moves are batched every 250 ms. A move that turns up a card goes at
 * once, and its reply carries the card (`controller.reveal`). A stale batch
 * (409 stale-move: it sat too long, offline) is re-stamped at the current
 * clock and resent. Network failures retry with backoff until they get
 * through; the clock keeps running regardless, and the server's deadline
 * sweep closes a game that never reconnects.
 */
export class MoveSync {
  private sent: number;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failed = 0;
  private pendingSince = 0;
  private closed = false;
  /** Shown while a reveal has gone unanswered for OFFLINE_AFTER_MS. */
  onOffline: ((offline: boolean) => void) | null = null;
  /** A server/client state mismatch: a bug, reported for telemetry. */
  onDesync: ((server: string, client: string) => void) | null = null;
  private offline = false;

  constructor(
    private readonly gameId: string,
    private readonly controller: GameController,
  ) {
    this.sent = controller.moves.length;
    controller.onMove = () => this.schedule();
    controller.onRevealNeeded = () => {
      this.pendingSince = performance.now();
      void this.flush();
    };
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, BATCH_MS);
  }

  private setOffline(on: boolean): void {
    if (on === this.offline) return;
    this.offline = on;
    this.onOffline?.(on);
  }

  async flush(): Promise<void> {
    if (this.inFlight || this.closed) return;
    const moves = this.controller.moves;
    if (this.sent >= moves.length) return;
    this.inFlight = true;
    const from = this.sent;
    const batch = moves.slice(from);
    try {
      const reply = await api.sendMoves(this.gameId, from, batch);
      this.sent = Math.max(this.sent, reply.count);
      this.failed = 0;
      this.setOffline(false);
      this.controller.reveal(reply.reveals);
      if (!this.controller.pending && reply.count === moves.length) {
        const mine = stateHash(this.controller.current);
        if (mine !== reply.stateHash) this.onDesync?.(reply.stateHash, mine);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'stale-move') {
        this.controller.restamp(from);
        this.inFlight = false;
        return this.flush();
      }
      this.failed++;
      if (this.controller.pending && performance.now() - this.pendingSince > OFFLINE_AFTER_MS)
        this.setOffline(true);
      const wait = Math.min(4000, 250 * 2 ** Math.min(4, this.failed));
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.flush();
      }, wait);
      if (this.controller.pending)
        setTimeout(() => {
          if (this.controller.pending) this.setOffline(true);
        }, OFFLINE_AFTER_MS);
    } finally {
      this.inFlight = false;
    }
    if (this.sent < this.controller.moves.length && this.failed === 0) {
      if (this.controller.pending) void this.flush();
      else this.schedule();
    }
  }

  /** Tell the server the game is over. Any unsent moves ride along. */
  async finish() {
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
    while (this.inFlight) await new Promise((r) => setTimeout(r, 50));
    for (let attempt = 0; ; attempt++) {
      const from = this.sent;
      try {
        const res = await api.finishGame(this.gameId, from, this.controller.moves.slice(from));
        this.sent = this.controller.moves.length;
        this.closed = true;
        return res.game;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'stale-move') {
          this.controller.restamp(from);
          continue;
        }
        if (attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
}
