import {
  RULES,
  createGame,
  forfeit,
  isError,
  place,
  remainingMs,
  tick,
  type GameEvent,
  type GameState,
  type PlaceError,
  type TimedMove,
} from '@solitaire-plus/sim';

export type Listener = (event: GameEvent, state: GameState) => void;

export interface ControllerOptions {
  seed: string;
  /** Solo games may pause; challenge games run on the wall clock, always. */
  pausable: boolean;
  /** Restore a game in progress: moves already made and how far the clock had run. */
  resume?: { moves: readonly TimedMove[]; elapsedMs: number } | undefined;
}

/**
 * Owns the sim state for one game and the real-time clock that drives it.
 *
 * The clock is wall time from `start()`, not accumulated frame deltas, so a
 * hidden tab or a stalled frame never stretches a game. Everything the
 * renderer and audio need arrives as events through `subscribe`.
 */
export class GameController {
  private state: GameState;
  private listeners = new Set<Listener>();
  private startedAtMs: number | null = null;
  private pausedAtMs: number | null = null;
  private clockOffsetMs = 0;
  readonly moves: TimedMove[] = [];
  readonly pausable: boolean;
  /** Tooling only: scales wall time into game time (capture harness runs slow renderers). */
  debugTimeScale = 1;
  /**
   * Tooling only: when set, the game clock is this many ms and moves only via
   * debugAdvance(). The shot harness uses it so a frame is exactly 1/fps and
   * nothing about the recording depends on wall time.
   */
  debugManualMs: number | null = null;

  debugAdvance(ms: number): void {
    if (this.debugManualMs === null) this.debugManualMs = 0;
    this.debugManualMs += ms;
  }

  constructor(opts: ControllerOptions) {
    this.pausable = opts.pausable;
    let state = createGame(opts.seed).state;
    if (opts.resume) {
      let clock = 0;
      for (const m of opts.resume.moves) {
        state = tick(state, m.tMs - clock).state;
        clock = m.tMs;
        const r = place(state, m);
        if (isError(r)) break;
        state = r.state;
        this.moves.push(m);
      }
      state = tick(state, Math.max(0, opts.resume.elapsedMs - clock)).state;
      this.clockOffsetMs = state.elapsedMs;
    }
    this.state = state;
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

  get remainingMs(): number {
    return remainingMs(this.state);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Replays the initial deal to a late subscriber so it can build its scene. */
  emitInitial(fn: Listener): void {
    fn({ type: 'handDealt', hand: this.state.hand, deckIndex: this.state.deckIndex }, this.state);
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
    const target = this.clock(now);
    const dt = target - this.state.elapsedMs;
    if (dt <= 0) return;
    this.apply(tick(this.state, dt));
  }

  canPlace(slot: number, row: number, col: number): boolean {
    const r = place(this.state, { slot, row, col });
    return !isError(r);
  }

  /** Lines a placement would complete, for the drop preview. Empty when illegal. */
  previewLines(
    slot: number,
    row: number,
    col: number,
  ): { rows: readonly number[]; cols: readonly number[] } {
    const r = place(this.state, { slot, row, col });
    if (isError(r)) return { rows: [], cols: [] };
    for (const e of r.events) if (e.type === 'linesCleared') return { rows: e.rows, cols: e.cols };
    return { rows: [], cols: [] };
  }

  place(slot: number, row: number, col: number, now = performance.now()): PlaceError | null {
    if (this.startedAtMs === null || this.pausedAtMs !== null) return 'game-over';
    // Sync the clock first so the move's timestamp and the sim agree.
    this.update(now);
    if (this.state.status !== 'playing') return 'game-over';
    const tMs = Math.floor(this.state.elapsedMs);
    const r = place(this.state, { slot, row, col });
    if (isError(r)) return r.error;
    this.moves.push({ slot, row, col, tMs });
    this.apply(r);
    return null;
  }

  forfeit(): void {
    this.apply(forfeit(this.state));
  }

  private apply(t: { state: GameState; events: readonly GameEvent[] }): void {
    this.state = t.state;
    for (const e of t.events) {
      for (const fn of this.listeners) fn(e, this.state);
    }
  }
}
