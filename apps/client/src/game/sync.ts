import type { TimedMove } from '@solitaire-plus/sim';
import { api } from '../api/client.js';

/**
 * Streams moves to the server as they happen so an abandoned tab still leaves
 * a scoreable record. Batches within a short window, retries on failure, and
 * never sends the same index twice out of order.
 */
export class MoveSync {
  private sentCount = 0;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failed = 0;
  onError: ((err: unknown) => void) | null = null;

  private moves: readonly TimedMove[];

  constructor(
    private readonly gameId: string,
    moves: readonly TimedMove[],
    initialSent = 0,
  ) {
    this.moves = moves;
    this.sentCount = initialSent;
  }

  /** Point at the controller's live move array (it is appended in place). */
  bind(moves: readonly TimedMove[]): void {
    this.moves = moves;
  }

  /** Call after every placement. */
  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 250);
  }

  async flush(): Promise<void> {
    if (this.inFlight) return;
    if (this.sentCount >= this.moves.length) return;
    this.inFlight = true;
    const from = this.sentCount;
    const batch = this.moves.slice(from);
    try {
      const { count } = await api.sendMoves(this.gameId, from, batch);
      this.sentCount = Math.max(this.sentCount, count);
      this.failed = 0;
    } catch (err) {
      this.failed++;
      this.onError?.(err);
      if (this.failed < 5) setTimeout(() => void this.flush(), 1000 * this.failed);
    } finally {
      this.inFlight = false;
      if (this.sentCount < this.moves.length && this.failed === 0) this.schedule();
    }
  }

  /** Tell the server the game is over. Any unsent moves ride along. */
  async finish() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Wait for an in-flight batch so indices stay ordered.
    while (this.inFlight) await new Promise((r) => setTimeout(r, 50));
    const from = this.sentCount;
    const res = await api.finishGame(this.gameId, from, this.moves.slice(from));
    this.sentCount = this.moves.length;
    return res.game;
  }
}
