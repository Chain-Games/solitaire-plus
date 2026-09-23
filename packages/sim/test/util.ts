import {
  RULES,
  Rng,
  apply,
  canAutocomplete,
  createGame,
  createGameFromDeal,
  faceUpCount,
  isError,
  isFoundation,
  isTableau,
  legalMoves,
  pileSlots,
  tick,
  card,
  type Card,
  type Column,
  type GameState,
  type Move,
  type Suit,
  type TimedMove,
} from '../src/index.js';

/** Parse "AS", "10H", "KC" into a card. */
export function c(key: string): Card {
  const suit = 'CDHS'.indexOf(key.slice(-1)) as Suit;
  const r = key.slice(0, -1);
  const rank = r === 'A' ? 1 : r === 'J' ? 11 : r === 'Q' ? 12 : r === 'K' ? 13 : Number(r);
  if (suit < 0 || !(rank >= 1 && rank <= 13)) throw new Error(`bad card ${key}`);
  return card(suit, rank);
}

export interface Layout {
  /** Columns bottom to top; a leading "_" marks a face-down card, e.g. "_5H". */
  tableau?: string[][];
  waste?: string[];
  /** Bottom to top. */
  stock?: string[];
  /** Per suit C, D, H, S: how many cards are home (A..n). */
  home?: [number, number, number, number];
}

/**
 * A state laid out by hand. Every card is placed in its own slot; slots are
 * numbered in the order cards appear here, so these states are only for
 * rules tests, never for hashing against a real deal. Cards not mentioned
 * are left out entirely (the layout need not hold 52).
 */
export function layout(spec: Layout): GameState {
  const deal: (Card | null)[] = new Array<Card | null>(52).fill(null);
  const seen = new Array<boolean>(52).fill(false);
  let slot = 0;
  const put = (key: string | Card, up: boolean): number => {
    const s = slot++;
    deal[s] = typeof key === 'number' ? key : c(key.replace('_', ''));
    seen[s] = up;
    return s;
  };
  const foundations: number[][] = [[], [], [], []];
  (spec.home ?? [0, 0, 0, 0]).forEach((n, suit) => {
    for (let r = 1; r <= n; r++)
      (foundations[suit] as number[]).push(put(card(suit as Suit, r), true));
  });
  const tableau: Column[] = [];
  for (let i = 0; i < 7; i++) {
    const col = spec.tableau?.[i] ?? [];
    const slots = col.map((k) => put(k, !k.startsWith('_')));
    tableau.push({ slots, down: col.filter((k) => k.startsWith('_')).length });
  }
  const waste = (spec.waste ?? []).map((k) => put(k, true));
  const stock = (spec.stock ?? []).map((k) => put(k, false));
  const base = createGameFromDeal(deal).state;
  return { ...base, deal, seen, tableau, waste, stock, foundations };
}

export function mustApply(state: GameState, move: Move): GameState {
  const r = apply(state, move);
  if (isError(r)) throw new Error(`${JSON.stringify(move)}: ${r.error}`);
  return r.state;
}

/**
 * A greedy bot: autocomplete, then anything to a foundation, then a move that
 * turns a card up, then waste to tableau, then draw. It avoids moves that just
 * shuffle a run between columns and gives up after a full stock cycle with no
 * progress. Deterministic for a given (seed, botSeed).
 */
export function botGame(
  seed: string,
  botSeed: string,
  opts: { minGapMs?: number; maxGapMs?: number } = {},
): { moves: TimedMove[]; state: GameState } {
  const rng = new Rng(botSeed);
  const minGap = opts.minGapMs ?? 400;
  const spread = (opts.maxGapMs ?? 2400) - minGap;
  let state = createGame(seed).state;
  const moves: TimedMove[] = [];
  let idleDraws = 0;
  let t = 0;
  while (state.status === 'playing') {
    const move = pick(state);
    if (move === null || idleDraws > state.stock.length + state.waste.length + 2) break;
    t += minGap + rng.int(spread + 1);
    if (t >= RULES.durationMs) break;
    state = tick(state, t - state.elapsedMs).state;
    if (state.status !== 'playing') break;
    const r = apply(state, move);
    if (isError(r)) throw new Error(`bot move ${JSON.stringify(move)}: ${r.error}`);
    idleDraws = move.t === 'draw' ? idleDraws + 1 : 0;
    state = r.state;
    moves.push({ ...move, tMs: t } as TimedMove);
  }
  if (state.status === 'playing') state = tick(state, RULES.durationMs - state.elapsedMs).state;
  return { moves, state };
}

function pick(state: GameState): Move | null {
  if (canAutocomplete(state)) return { t: 'auto' };
  const all = legalMoves(state).filter((m) => m.t === 'mv');
  const mv = all as Extract<Move, { t: 'mv' }>[];
  const toF = mv.find((m) => isFoundation(m.to) && !isFoundation(m.from));
  if (toF) return toF;
  // A tableau move that empties down to a face-down card (turns it up).
  const flips = mv.find((m) => {
    if (!isTableau(m.from) || !isTableau(m.to)) return false;
    const n = pileSlots(state, m.from).length;
    return m.n === faceUpCount(state, m.from) && n > m.n;
  });
  if (flips) return flips;
  const wasteMove = mv.find((m) => m.from === 'waste' && isTableau(m.to));
  if (wasteMove) return wasteMove;
  if (state.stock.length > 0 || state.waste.length > 0) return { t: 'draw' };
  return null;
}
