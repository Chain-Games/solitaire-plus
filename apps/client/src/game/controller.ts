import {
  RULES,
  apply,
  autoTarget,
  canMove,
  createGameFromDeal,
  forfeit,
  isError,
  moveOf,
  remainingMs,
  replayFrom,
  reveal,
  tick,
  unrevealedSlots,
  type Card,
  type GameEvent,
  type GameState,
  type Move,
  type MoveError,
  type PileId,
  type TimedMove,
} from '@solitaire-plus/sim';

/**
 * What the controller tells its subscribers: every sim event, plus three of
 * its own —
 *   revealed   the server told us the cards in these slots (flip them face up)
 *   pending    a card-showing move is waiting on the server (input is held)
 *   resync     the state was rebuilt (a stale batch was re-stamped): snap to it
 */
export type ControllerEvent =
  | GameEvent
  | { readonly type: 'revealed'; readonly slots: readonly number[] }
  | { readonly type: 'pending'; readonly on: boolean }
  | { readonly type: 'resync' };

export type Listener = (event: ControllerEvent, state: GameState) => void;

export interface ControllerOptions {
  /**
   * The deal as this side knows it: the whole deal for practice, the
   * server's masked deal for a staked game (docs/SPEC.md § 4).
   */
  deal: readonly (Card | null)[];
  /** Practice may pause; challenge games run on the wall clock, always. */
  pausable: boolean;
  /** Restore a game in progress: moves already made and how far the clock had run. */
  resume?: { moves: readonly TimedMove[]; elapsedMs: number } | undefined;
}

/** Why a move was not made: the sim's reason, or `pending` while a reveal is in flight. */
export type MoveRefusal = MoveError | 'pending' | 'not-started';

/**
 * Owns the sim state for one game and the real-time clock that drives it.
 *
 * The clock is wall time from `start()`, not accumulated frame deltas, so a
 * hidden tab or a stalled frame never stretches a game. Everything the
 * renderer and audio need arrives as events through `subscribe`.
 *
 * Hidden cards: a move that turns up a card this side has not been told
 * holds input (`pending`) until `reveal()` brings the card. Nothing is ever
 * played on top of an unconfirmed reveal, so the move log stays strictly
 * ordered and a re-stamp (`restamp`) is always valid. MoveSync drives both.
 */
export class GameController {
  private state: GameState;
  private readonly initial: GameState;
  private listeners = new Set<Listener>();
  private startedAtMs: number | null = null;
  private pausedAtMs: number | null = null;
  private clockOffsetMs = 0;
  readonly moves: TimedMove[] = [];
  readonly pausable: boolean;
  /** Called when a move needs the server to show its cards (MoveSync flushes at once). */
  onRevealNeeded: (() => void) | null = null;
  /** Called after every move, for the batched sync. */
  onMove: (() => void) | null = null;
  /** Tooling only: scales wall time into game time (capture harness runs slow renderers). */
  debugTimeScale = 1;
  /** Tooling only: when set, the game clock is this many ms and moves only via debugAdvance(). */
  debugManualMs: number | null = null;

  constructor(opts: ControllerOptions) {
    this.pausable = opts.pausable;
    this.initial = createGameFromDeal(opts.deal).state;
    let state = this.initial;
    if (opts.resume) {
      for (const m of opts.resume.moves) {
        state = tick(state, Math.max(0, m.tMs - state.elapsedMs)).state;
        const r = apply(state, moveOf(m));
        if (isError(r)) break;
        state = r.state;
        this.moves.push(m);
      }
      state = tick(state, Math.max(0, opts.resume.elapsedMs - state.elapsedMs)).state;
      this.clockOffsetMs = state.elapsedMs;
    }
    this.state = state;
  }

  debugAdvance(ms: number): void {
    if (this.debugManualMs === null) this.debugManualMs = 0;
    this.debugManualMs += ms;
  }

  get current(): GameState {
    return this.state;
  }

  get started(): boolean {
    return this.startedAtMs !== null;
  }

  get paused(): boolean {
    return this.pausedAtMs !== null;
  }

  /** A card-showing move is waiting on the server; input is held. */
  get pending(): boolean {
    return unrevealedSlots(this.state).length > 0;
  }

  get remainingMs(): number {
    return remainingMs(this.state);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Replays the deal to a late subscriber so it can build its scene. */
  emitInitial(fn: Listener): void {
    fn({ type: 'dealt' }, this.state);
  }

  start(now = performance.now()): void {
    if (this.startedAtMs !== null) return;
    this.startedAtMs = now;
  }

  pause(now = performance.now()): void {
    if (!this.pausable || this.startedAtMs === null || this.pausedAtMs !== null) return;
    this.pausedAtMs = now;
  }

  resume(now = performance.now()): void {
    if (this.pausedAtMs === null || this.startedAtMs === null) return;
    this.startedAtMs += now - this.pausedAtMs;
    this.pausedAtMs = null;
  }

  /** Game-clock ms right now. */
  clock(now = performance.now()): number {
    if (this.debugManualMs !== null) {
      return this.startedAtMs === null
        ? this.clockOffsetMs
        : Math.min(RULES.durationMs, this.clockOffsetMs + this.debugManualMs);
    }
    if (this.startedAtMs === null) return this.clockOffsetMs;
    const ref = this.pausedAtMs ?? now;
    return Math.min(
      RULES.durationMs,
      this.clockOffsetMs + (ref - this.startedAtMs) * this.debugTimeScale,
    );
  }

  /** Call once per frame. Advances the sim clock to wall time and emits any end event. */
  update(now = performance.now()): void {
    if (this.state.status !== 'playing' || this.startedAtMs === null || this.pausedAtMs !== null)
      return;
    const dt = this.clock(now) - this.state.elapsedMs;
    if (dt <= 0) return;
    this.emit(tick(this.state, dt));
  }

  canMove(from: PileId, to: PileId, n: number): boolean {
    return !this.pending && canMove(this.state, from, to, n);
  }

  /** Where a tap on the card `n` from the top of `from` would send it (null: nowhere). */
  tapTarget(from: PileId, n: number): Move | null {
    if (this.pending) return null;
    return autoTarget(this.state, from, n);
  }

  /** Make a move now. Null on success, or why not. */
  move(move: Move, now = performance.now()): MoveRefusal | null {
    if (this.startedAtMs === null || this.pausedAtMs !== null) return 'not-started';
    if (this.pending) return 'pending';
    this.update(now);
    if (this.state.status !== 'playing') return 'game-over';
    const r = apply(this.state, move);
    if (isError(r)) return r.error;
    this.moves.push({ ...move, tMs: Math.floor(this.state.elapsedMs) } as TimedMove);
    this.emit(r);
    if (this.pending) {
      this.emitOne({ type: 'pending', on: true });
      this.onRevealNeeded?.();
    } else {
      this.onMove?.();
    }
    return null;
  }

  /** The server told us what the cards in some slots are. */
  reveal(reveals: readonly { readonly slot: number; readonly card: Card }[]): void {
    const wasPending = this.pending;
    const fresh = reveals.filter((r) => this.state.deal[r.slot] === null);
    if (fresh.length === 0) return;
    this.state = reveal(this.state, fresh);
    this.emitOne({ type: 'revealed', slots: fresh.map((r) => r.slot) });
    if (wasPending && !this.pending) {
      this.emitOne({ type: 'pending', on: false });
      this.onMove?.();
    }
  }

  /**
   * The server refused the unsent tail from `from` as stale (it sat too long
   * offline): stamp it at the current clock and rebuild the state from the
   * start. May cost a streak; intended (docs/SPEC.md § 4.5).
   */
  restamp(from: number, now = performance.now()): void {
    const t = Math.floor(this.clock(now));
    for (let i = from; i < this.moves.length; i++) {
      const m = this.moves[i];
      if (m) this.moves[i] = { ...m, tMs: Math.max(m.tMs, t) } as TimedMove;
    }
    let state = replayFrom(this.initial, this.moves);
    // Keep what we have been told.
    state = reveal(
      state,
      this.state.deal.flatMap((c, slot) => (c === null ? [] : [{ slot, card: c }])),
    );
    this.state = tick(state, Math.max(0, t - state.elapsedMs)).state;
    this.emitOne({ type: 'resync' });
  }

  forfeit(): void {
    this.emit(forfeit(this.state));
  }

  private emit(t: { state: GameState; events: readonly GameEvent[] }): void {
    this.state = t.state;
    for (const e of t.events) this.emitOne(e);
  }

  private emitOne(e: ControllerEvent): void {
    for (const fn of this.listeners) fn(e, this.state);
  }
}
