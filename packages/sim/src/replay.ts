import type { PileId } from './events.js';
import { PILE_IDS, apply, createGame, isError, tick, type GameState, type Move } from './game.js';
import { RULES } from './rules.js';

/**
 * A move as recorded by a client and verified by the server: what was done
 * and at what point on the game clock.
 */
export type TimedMove =
  | {
      readonly t: 'mv';
      readonly from: PileId;
      readonly to: PileId;
      readonly n: number;
      readonly tMs: number;
    }
  | { readonly t: 'draw'; readonly tMs: number }
  | { readonly t: 'undo'; readonly tMs: number }
  | { readonly t: 'auto'; readonly tMs: number };

export class ReplayError extends Error {
  constructor(
    readonly index: number,
    readonly reason: string,
  ) {
    super(`replay: move ${index}: ${reason}`);
    this.name = 'ReplayError';
  }
}

/** Strip the clock off a timed move. */
export function moveOf(m: TimedMove): Move {
  switch (m.t) {
    case 'mv':
      return { t: 'mv', from: m.from, to: m.to, n: m.n };
    case 'draw':
      return { t: 'draw' };
    case 'undo':
      return { t: 'undo' };
    case 'auto':
      return { t: 'auto' };
  }
}

/** Shape check for a move from the wire. Legality is apply()'s job. */
export function isTimedMove(x: unknown): x is TimedMove {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  if (typeof m.tMs !== 'number' || !Number.isInteger(m.tMs) || m.tMs < 0) return false;
  if (m.t === 'draw' || m.t === 'undo' || m.t === 'auto') return true;
  return (
    m.t === 'mv' &&
    typeof m.from === 'string' &&
    typeof m.to === 'string' &&
    PILE_IDS.includes(m.from as PileId) &&
    PILE_IDS.includes(m.to as PileId) &&
    typeof m.n === 'number' &&
    Number.isInteger(m.n) &&
    m.n >= 1 &&
    m.n <= 13
  );
}

/**
 * Apply timed moves to a state, ticking the clock to each move's time first.
 * Throws ReplayError on the first move that is out of order or illegal.
 */
export function replayFrom(initial: GameState, moves: readonly TimedMove[]): GameState {
  let state = initial;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (m === undefined || !isTimedMove(m)) throw new ReplayError(i, 'malformed');
    if (m.tMs < state.elapsedMs) throw new ReplayError(i, 'clock went backwards');
    if (m.tMs >= RULES.durationMs) throw new ReplayError(i, 'after the clock ran out');
    if (state.status !== 'playing') throw new ReplayError(i, 'game already over');
    state = tick(state, m.tMs - state.elapsedMs).state;
    const result = apply(state, moveOf(m));
    if (isError(result)) throw new ReplayError(i, result.error);
    state = result.state;
  }
  return state;
}

/**
 * Rebuild a game from its seed and move list. This is what the server runs to
 * score a game; the client's own score is never trusted.
 *
 * With `finish` (the default) a game the moves did not end is run out to the
 * clock, so the result is always a finished state.
 */
export function replay(seed: string, moves: readonly TimedMove[], finish = true): GameState {
  let state = replayFrom(createGame(seed).state, moves);
  if (finish && state.status === 'playing') {
    state = tick(state, RULES.durationMs - state.elapsedMs).state;
  }
  return state;
}
