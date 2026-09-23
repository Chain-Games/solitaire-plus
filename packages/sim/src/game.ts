import {
  COLUMN_SLOTS,
  INITIAL_UP_SLOTS,
  STOCK_SLOTS,
  dealFor,
  isRed,
  rankOf,
  suitOf,
  type Card,
} from './cards.js';
import type { EndReason, GameEvent, PileId, ScoreBreakdown, ScoreKind } from './events.js';
import { levelFor, levelThreshold } from './levels.js';
import { RULES } from './rules.js';

export type GameStatus = 'playing' | 'ended';

/** A tableau column: slots bottom to top; the first `down` are face down. */
export interface Column {
  readonly slots: readonly number[];
  readonly down: number;
}

/**
 * The part of the state an undo restores. Everything a move can change,
 * except the clock, the move counters and what has been seen (a move that
 * shows a card for the first time is a barrier and can never be undone).
 */
export interface Core {
  /** Face-down stock, bottom to top. */
  readonly stock: readonly number[];
  /** Face-up waste, bottom to top. Only the top is playable. */
  readonly waste: readonly number[];
  /** One per suit (C, D, H, S), bottom (ace) to top. */
  readonly foundations: readonly (readonly number[])[];
  readonly tableau: readonly Column[];
  readonly score: number;
  /** Cosmetic level: the highest levelFor(score) reached. 1 at start. */
  readonly level: number;
  readonly streak: number;
  readonly bestStreak: number;
  /** Game clock of the last scoring move; -1 before the first. */
  readonly lastScoreMs: number;
  readonly foundationPts: number;
  readonly revealPts: number;
  readonly tableauPts: number;
  readonly streakPts: number;
  readonly revealed: number;
}

/**
 * Complete game state. Immutable: every operation returns a new state plus the
 * events that explain the transition.
 *
 * `deal` maps a slot to its card. On the server it is complete. On a client in
 * a staked game it holds only the cards that have been shown (see mask.ts):
 * every rule that needs a card's identity only ever asks about face-up cards,
 * so a client can play with the rest unknown and learns each new face from
 * the server as the move that shows it is verified.
 */
export interface GameState extends Core {
  readonly deal: readonly (Card | null)[];
  /** Slots that have ever been face up. */
  readonly seen: readonly boolean[];
  /** Cores to restore, most recent last. Cleared by every barrier. */
  readonly undo: readonly Core[];
  readonly moves: number;
  readonly undos: number;
  readonly elapsedMs: number;
  readonly status: GameStatus;
  readonly breakdown: ScoreBreakdown | null;
}

export type TableauId = 't0' | 't1' | 't2' | 't3' | 't4' | 't5' | 't6';
export type FoundationId = 'f0' | 'f1' | 'f2' | 'f3';

export type Move =
  | { readonly t: 'mv'; readonly from: PileId; readonly to: PileId; readonly n: number }
  | { readonly t: 'draw' }
  | { readonly t: 'undo' }
  | { readonly t: 'auto' };

export interface Transition {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

export type MoveError =
  | 'game-over'
  | 'bad-move'
  | 'empty'
  | 'not-face-up'
  | 'unrevealed'
  | 'illegal'
  | 'nothing-to-undo'
  | 'no-autocomplete';

export type MoveResult = Transition | { readonly error: MoveError };

export function isError(r: MoveResult): r is { readonly error: MoveError } {
  return 'error' in r;
}

export const TABLEAU_IDS: readonly TableauId[] = ['t0', 't1', 't2', 't3', 't4', 't5', 't6'];
export const FOUNDATION_IDS: readonly FoundationId[] = ['f0', 'f1', 'f2', 'f3'];
export const PILE_IDS: readonly PileId[] = ['stock', 'waste', ...FOUNDATION_IDS, ...TABLEAU_IDS];

// ---------------------------------------------------------------------------
// Construction

/** A fresh game from a seed, with the whole deal known (the server; practice). */
export function createGame(seed: string): Transition {
  return createGameFromDeal(dealFor(seed));
}

/**
 * A fresh game from a deal that may be partly unknown. A client in a staked
 * game passes the masked opening deal (the seven up-cards).
 */
export function createGameFromDeal(deal: readonly (Card | null)[]): Transition {
  if (deal.length !== 52) throw new RangeError(`deal must have 52 slots, got ${deal.length}`);
  const seen = new Array<boolean>(52).fill(false);
  for (const s of INITIAL_UP_SLOTS) seen[s] = true;
  const state: GameState = {
    stock: STOCK_SLOTS.slice(),
    waste: [],
    foundations: [[], [], [], []],
    tableau: COLUMN_SLOTS.map((slots) => ({ slots: slots.slice(), down: slots.length - 1 })),
    score: 0,
    level: 1,
    streak: 0,
    bestStreak: 0,
    lastScoreMs: -1,
    foundationPts: 0,
    revealPts: 0,
    tableauPts: 0,
    streakPts: 0,
    revealed: 0,
    deal: deal.slice(),
    seen,
    undo: [],
    moves: 0,
    undos: 0,
    elapsedMs: 0,
    status: 'playing',
    breakdown: null,
  };
  return { state, events: [{ type: 'dealt' }] };
}

// ---------------------------------------------------------------------------
// Queries

export function isTableau(id: PileId): id is TableauId {
  return id[0] === 't';
}

export function isFoundation(id: PileId): id is FoundationId {
  return id[0] === 'f';
}

function pileIndex(id: PileId): number {
  return Number(id.slice(1));
}

/** The slots on a pile, bottom to top. */
export function pileSlots(state: Core, id: PileId): readonly number[] {
  if (id === 'stock') return state.stock;
  if (id === 'waste') return state.waste;
  if (isFoundation(id)) return state.foundations[pileIndex(id)] ?? [];
  return state.tableau[pileIndex(id)]?.slots ?? [];
}

/** How many cards on top of a pile are face up (and so can be picked up as a run). */
export function faceUpCount(state: Core, id: PileId): number {
  if (id === 'stock') return 0;
  if (isTableau(id)) {
    const col = state.tableau[pileIndex(id)];
    return col ? col.slots.length - col.down : 0;
  }
  return pileSlots(state, id).length;
}

/** The card in a slot, or null if this side has not been shown it. */
export function cardAt(state: GameState, slot: number): Card | null {
  return state.deal[slot] ?? null;
}

export function remainingMs(state: GameState): number {
  return Math.max(0, RULES.durationMs - state.elapsedMs);
}

export function cardsHome(state: Core): number {
  let n = 0;
  for (const f of state.foundations) n += f.length;
  return n;
}

export function canUndo(state: GameState): boolean {
  return state.status === 'playing' && state.undo.length > 0;
}

/** Autocomplete is offered when the stock and waste are empty and every tableau card is face up. */
export function canAutocomplete(state: GameState): boolean {
  if (state.status !== 'playing') return false;
  if (state.stock.length > 0 || state.waste.length > 0) return false;
  if (cardsHome(state) === 52) return false;
  return state.tableau.every((c) => c.down === 0);
}

/** Slots this side has seen but not been told the card of — what a client must ask the server for. */
export function unrevealedSlots(state: GameState): number[] {
  const out: number[] = [];
  for (let s = 0; s < 52; s++) if (state.seen[s] && state.deal[s] === null) out.push(s);
  return out;
}

type Check =
  { readonly ok: true; readonly slots: readonly number[] } | { readonly error: MoveError };

/** Whether a pile-to-pile move is legal, and the slots it would carry. */
function checkMove(state: GameState, from: PileId, to: PileId, n: number): Check {
  if (!PILE_IDS.includes(from) || !PILE_IDS.includes(to)) return { error: 'bad-move' };
  if (!Number.isInteger(n) || n < 1) return { error: 'bad-move' };
  if (from === 'stock' || to === 'stock' || to === 'waste' || from === to)
    return { error: 'bad-move' };
  if (isFoundation(from) && isFoundation(to)) return { error: 'bad-move' };
  const src = pileSlots(state, from);
  if (src.length === 0) return { error: 'empty' };
  if (!isTableau(from) && n !== 1) return { error: 'bad-move' };
  if (n > faceUpCount(state, from)) return { error: 'not-face-up' };
  const slots = src.slice(src.length - n);
  const cards: Card[] = [];
  for (const s of slots) {
    const c = state.deal[s];
    if (c === null || c === undefined) return { error: 'unrevealed' };
    cards.push(c);
  }
  // A run must itself be a descending, alternating-colour sequence.
  for (let i = 1; i < cards.length; i++) {
    const lo = cards[i] as Card;
    const hi = cards[i - 1] as Card;
    if (rankOf(hi) !== rankOf(lo) + 1 || isRed(hi) === isRed(lo)) return { error: 'illegal' };
  }
  const first = cards[0] as Card;
  if (isFoundation(to)) {
    if (n !== 1) return { error: 'illegal' };
    if (suitOf(first) !== pileIndex(to)) return { error: 'illegal' };
    if (rankOf(first) !== pileSlots(state, to).length + 1) return { error: 'illegal' };
    return { ok: true, slots };
  }
  const dst = pileSlots(state, to);
  const topSlot = dst[dst.length - 1];
  if (topSlot === undefined) {
    return rankOf(first) === 13 ? { ok: true, slots } : { error: 'illegal' };
  }
  const top = state.deal[topSlot];
  if (top === null || top === undefined) return { error: 'unrevealed' };
  if (rankOf(top) !== rankOf(first) + 1 || isRed(top) === isRed(first)) return { error: 'illegal' };
  return { ok: true, slots };
}

export function canMove(state: GameState, from: PileId, to: PileId, n: number): boolean {
  return state.status === 'playing' && 'ok' in checkMove(state, from, to, n);
}

/**
 * Where a tap on the card n-from-the-top of `from` sends it: its foundation if
 * legal (single cards only), otherwise the first legal tableau column, left to
 * right. Null if nowhere. The client logs the explicit move this returns.
 */
export function autoTarget(state: GameState, from: PileId, n: number): Move | null {
  if (state.status !== 'playing') return null;
  if (n === 1) {
    for (const f of FOUNDATION_IDS) {
      if (f !== from && !isFoundation(from) && canMove(state, from, f, 1))
        return { t: 'mv', from, to: f, n: 1 };
    }
  }
  for (const t of TABLEAU_IDS) {
    if (t !== from && canMove(state, from, t, n)) return { t: 'mv', from, to: t, n };
  }
  return null;
}

/** Every legal move right now, in a fixed order (bots, hints, tests). Excludes undo. */
export function legalMoves(state: GameState): Move[] {
  if (state.status !== 'playing') return [];
  const out: Move[] = [];
  if (canAutocomplete(state)) out.push({ t: 'auto' });
  const sources: PileId[] = ['waste', ...TABLEAU_IDS, ...FOUNDATION_IDS];
  for (const from of sources) {
    const up = faceUpCount(state, from);
    const maxN = isTableau(from) ? up : Math.min(1, up);
    for (let n = 1; n <= maxN; n++) {
      for (const to of [...FOUNDATION_IDS, ...TABLEAU_IDS] as PileId[]) {
        if (canMove(state, from, to, n)) out.push({ t: 'mv', from, to, n });
      }
    }
  }
  if (state.stock.length > 0 || state.waste.length > 0) out.push({ t: 'draw' });
  return out;
}

// ---------------------------------------------------------------------------
// Transitions

function coreOf(s: GameState): Core {
  return {
    stock: s.stock,
    waste: s.waste,
    foundations: s.foundations,
    tableau: s.tableau,
    score: s.score,
    level: s.level,
    streak: s.streak,
    bestStreak: s.bestStreak,
    lastScoreMs: s.lastScoreMs,
    foundationPts: s.foundationPts,
    revealPts: s.revealPts,
    tableauPts: s.tableauPts,
    streakPts: s.streakPts,
    revealed: s.revealed,
  };
}

function withPile(
  state: GameState,
  id: PileId,
  slots: readonly number[],
  down?: number,
): GameState {
  if (id === 'stock') return { ...state, stock: slots };
  if (id === 'waste') return { ...state, waste: slots };
  const i = pileIndex(id);
  if (isFoundation(id)) {
    const foundations = state.foundations.slice();
    foundations[i] = slots;
    return { ...state, foundations };
  }
  const tableau = state.tableau.slice();
  const col = tableau[i] as Column;
  tableau[i] = { slots, down: down ?? col.down };
  return { ...state, tableau };
}

/** Break the streak if its window has run out at the current game clock. */
function expireStreak(state: GameState, events: GameEvent[]): GameState {
  if (state.streak > 0 && state.elapsedMs - state.lastScoreMs > RULES.streakWindowMs) {
    events.push({ type: 'streakBroken', length: state.streak });
    return { ...state, streak: 0 };
  }
  return state;
}

function breakStreak(state: GameState, events: GameEvent[]): GameState {
  if (state.streak > 0) {
    events.push({ type: 'streakBroken', length: state.streak });
    return { ...state, streak: 0 };
  }
  return state;
}

function addScore(
  state: GameState,
  events: GameEvent[],
  kind: ScoreKind,
  points: number,
  pile: PileId,
): GameState {
  const score = state.score + points;
  events.push({ type: 'scored', kind, points, streak: state.streak, total: score, pile });
  const reached = levelFor(Math.max(0, score));
  let next: GameState = { ...state, score };
  if (reached > state.level) {
    events.push({
      type: 'levelUp',
      level: reached,
      from: state.level,
      atScore: score,
      nextThreshold: levelThreshold(reached + 1),
    });
    next = { ...next, level: reached };
  }
  return next;
}

/**
 * Apply one move at the current game clock. The caller ticks the clock to the
 * move's time first (replay() does).
 */
export function apply(state: GameState, move: Move): MoveResult {
  if (state.status !== 'playing') return { error: 'game-over' };
  switch (move.t) {
    case 'mv':
      return applyMove(state, move.from, move.to, move.n);
    case 'draw':
      return applyDraw(state);
    case 'undo':
      return applyUndo(state);
    case 'auto':
      return applyAuto(state);
    default:
      return { error: 'bad-move' };
  }
}

function applyMove(state: GameState, from: PileId, to: PileId, n: number): MoveResult {
  const check = checkMove(state, from, to, n);
  if ('error' in check) return check;
  const events: GameEvent[] = [];
  const snapshot = coreOf(state);

  const src = pileSlots(state, from);
  let next = withPile(state, from, src.slice(0, src.length - n));
  next = withPile(next, to, pileSlots(next, to).concat(check.slots));
  events.push({ type: 'moved', from, to, slots: check.slots, auto: false });

  // The move that exposes a face-down card turns it up.
  let flipped: number | null = null;
  if (isTableau(from)) {
    const col = next.tableau[pileIndex(from)] as Column;
    if (col.down > 0 && col.slots.length === col.down) {
      flipped = col.slots[col.down - 1] as number;
      next = withPile(next, from, col.slots, col.down - 1);
      const seen = next.seen.slice();
      seen[flipped] = true;
      next = { ...next, seen, revealed: next.revealed + 1 };
      events.push({ type: 'flipped', pile: from, slot: flipped, card: next.deal[flipped] ?? null });
    }
  }

  // Scoring. See docs/rules.md § Scoring.
  let points = 0;
  let kind: ScoreKind | null = null;
  const toFoundation = isFoundation(to) && !isFoundation(from);
  if (toFoundation) {
    points += RULES.foundationPoints;
    next = { ...next, foundationPts: next.foundationPts + RULES.foundationPoints };
    kind = 'foundation';
  }
  if (flipped !== null) {
    points += RULES.revealPoints;
    next = { ...next, revealPts: next.revealPts + RULES.revealPoints };
    kind ??= 'reveal';
  }
  if (from === 'waste' && isTableau(to)) {
    points += RULES.wastePoints;
    next = { ...next, tableauPts: next.tableauPts + RULES.wastePoints };
    kind ??= 'waste';
  }
  if (isFoundation(from)) {
    points += RULES.foundationReturnPoints;
    next = { ...next, foundationPts: next.foundationPts + RULES.foundationReturnPoints };
    kind = 'return';
  }

  if (!toFoundation && flipped === null) {
    next = breakStreak(next, events);
  } else {
    const t = next.elapsedMs;
    const within = next.streak > 0 && t - next.lastScoreMs <= RULES.streakWindowMs;
    const streak = within ? next.streak + 1 : 1;
    const step = RULES.streakStep * Math.min(streak - 1, RULES.streakCap - 1);
    points += step;
    next = {
      ...next,
      streak,
      bestStreak: Math.max(next.bestStreak, streak),
      lastScoreMs: t,
      streakPts: next.streakPts + step,
    };
  }

  if (kind !== null) next = addScore(next, events, kind, points, to);

  // A flip shows a card for the first time: a barrier nothing can undo past.
  const undo = flipped !== null ? [] : state.undo.concat([snapshot]);
  next = { ...next, undo, moves: next.moves + 1 };

  if (cardsHome(next) === 52) return end(next, 'cleared', events);
  return { state: next, events };
}

function applyDraw(state: GameState): MoveResult {
  const events: GameEvent[] = [];
  const snapshot = coreOf(state);
  let next: GameState = state;
  let barrier = false;
  if (state.stock.length > 0) {
    const k = Math.min(RULES.drawCount, state.stock.length);
    const cut = state.stock.length - k;
    const taken = state.stock.slice(cut).reverse();
    const seen = state.seen.slice();
    for (const s of taken) {
      if (!seen[s]) barrier = true;
      seen[s] = true;
    }
    next = { ...state, stock: state.stock.slice(0, cut), waste: state.waste.concat(taken), seen };
    events.push({ type: 'drew', slots: taken });
  } else if (state.waste.length > 0) {
    next = { ...state, stock: state.waste.slice().reverse(), waste: [] };
    events.push({ type: 'recycled', count: state.waste.length });
  } else {
    return { error: 'empty' };
  }
  next = breakStreak(next, events);
  next = { ...next, undo: barrier ? [] : state.undo.concat([snapshot]), moves: next.moves + 1 };
  return { state: next, events };
}

function applyUndo(state: GameState): MoveResult {
  const core = state.undo[state.undo.length - 1];
  if (core === undefined) return { error: 'nothing-to-undo' };
  const events: GameEvent[] = [];
  const undo = state.undo.slice(0, -1);
  let next: GameState = { ...state, ...core, undo, undos: state.undos + 1 };
  events.push({ type: 'undone', remaining: undo.length });
  next = expireStreak(next, events);
  return { state: next, events };
}

function applyAuto(state: GameState): MoveResult {
  if (!canAutocomplete(state)) return { error: 'no-autocomplete' };
  const events: GameEvent[] = [];
  let next: GameState = { ...state, undo: [], moves: state.moves + 1 };
  // Lowest rank first, ties left to right. With every card face up and the
  // stock empty, each column is a descending run, so the lowest card left is
  // always on top of its column and always playable: the loop cannot stall.
  while (cardsHome(next) < 52) {
    let best: { col: number; card: Card } | null = null;
    for (let i = 0; i < next.tableau.length; i++) {
      const col = next.tableau[i] as Column;
      const slot = col.slots[col.slots.length - 1];
      if (slot === undefined) continue;
      const c = next.deal[slot];
      if (c === null || c === undefined) return { error: 'unrevealed' };
      if (best === null || rankOf(c) < rankOf(best.card)) best = { col: i, card: c };
    }
    if (best === null) break;
    const from = TABLEAU_IDS[best.col] as TableauId;
    const to = FOUNDATION_IDS[suitOf(best.card)] as FoundationId;
    const col = next.tableau[best.col] as Column;
    const slot = col.slots[col.slots.length - 1] as number;
    next = withPile(next, from, col.slots.slice(0, -1));
    next = withPile(next, to, pileSlots(next, to).concat([slot]));
    next = { ...next, foundationPts: next.foundationPts + RULES.foundationPoints };
    events.push({ type: 'moved', from, to, slots: [slot], auto: true });
    next = addScore(next, events, 'auto', RULES.foundationPoints, to);
  }
  return end(next, 'cleared', events);
}

/** Advance the clock. Ends the game on reaching the duration. */
export function tick(state: GameState, dtMs: number): Transition {
  if (state.status !== 'playing') return { state, events: [] };
  if (!(dtMs >= 0)) throw new RangeError(`tick: dtMs must be >= 0, got ${dtMs}`);
  const events: GameEvent[] = [];
  const elapsedMs = Math.min(RULES.durationMs, state.elapsedMs + dtMs);
  const next = expireStreak({ ...state, elapsedMs }, events);
  if (elapsedMs >= RULES.durationMs) return end(next, 'timeout', events);
  return { state: next, events };
}

export function forfeit(state: GameState): Transition {
  if (state.status !== 'playing') return { state, events: [] };
  return end(state, 'forfeit', []);
}

/**
 * Tell the state what cards some slots hold (the server's answer to a move
 * that showed them). A slot already known must agree; that is a desync.
 */
export function reveal(
  state: GameState,
  reveals: readonly { readonly slot: number; readonly card: Card }[],
): GameState {
  if (reveals.length === 0) return state;
  const deal = state.deal.slice();
  for (const { slot, card } of reveals) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 51) throw new RangeError(`bad slot ${slot}`);
    if (!Number.isInteger(card) || card < 0 || card > 51) throw new RangeError(`bad card ${card}`);
    const known = deal[slot];
    if (known !== null && known !== undefined && known !== card) {
      throw new Error(`reveal: slot ${slot} is ${known}, told ${card}`);
    }
    deal[slot] = card;
  }
  return { ...state, deal };
}

function end(state: GameState, reason: EndReason, events: GameEvent[]): Transition {
  const cleared = reason === 'cleared';
  const elapsedMs = cleared ? state.elapsedMs : RULES.durationMs;
  const best = Math.min(state.bestStreak, RULES.streakCap);
  const streakBonus = Math.max(0, best - 1) * RULES.streakEndStep;
  const clearBonus = cleared ? RULES.clearBonus : 0;
  const timeBonus = cleared
    ? RULES.clearPerSecond * Math.floor((RULES.durationMs - state.elapsedMs) / 1000)
    : 0;
  const breakdown: ScoreBreakdown = {
    foundation: state.foundationPts,
    reveals: state.revealPts,
    tableau: state.tableauPts,
    streak: state.streakPts,
    base: state.score,
    streakBonus,
    clearBonus,
    timeBonus,
    // Never below 0: taking cards back off the foundations can drive the
    // in-play score negative, but a result is never a debt.
    total: Math.max(0, state.score + streakBonus + clearBonus + timeBonus),
    bestStreak: state.bestStreak,
    cardsHome: cardsHome(state),
    revealed: state.revealed,
    moves: state.moves,
    undos: state.undos,
    elapsedMs,
    endReason: reason,
    levelReached: state.level,
  };
  const next: GameState = { ...state, status: 'ended', breakdown, undo: [] };
  events.push({ type: 'ended', reason, breakdown });
  return { state: next, events };
}
