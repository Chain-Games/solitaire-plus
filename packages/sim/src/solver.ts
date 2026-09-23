import { COLUMN_SLOTS, isRed, rankOf, suitOf, type Card } from './cards.js';
import type { PileId } from './events.js';
import type { Move } from './game.js';

/**
 * A bounded, deterministic Klondike solver for this game's rules: draw-1,
 * unlimited recycles, foundation-to-tableau allowed, auto-flip. It sees the
 * whole deal, so only the server calls it (to fill the solvable deal pools).
 *
 * Search: depth-first, with ordered moves and a transposition table.
 *
 * - The talon. With draw-1 and unlimited recycles, draws and recycles never
 *   change the order of the stock + waste; they only move a pointer through
 *   it. So the solver treats stock + waste as one list in draw order, and any
 *   card in it is playable in one step (the draws, and a recycle if needed,
 *   are written out when the solution is emitted). The pointer does not
 *   matter to solvability, so the position key leaves it out.
 * - The key. The talon is exactly the cards on neither the tableau nor the
 *   foundations, so the key is the foundation heights plus the seven columns
 *   (face-down count and cards), sorted so column order does not matter.
 * - Safe auto-play. A card goes home, with no branching, when nothing could
 *   ever need it on the tableau: an ace or a two, or a card whose two
 *   opposite-colour (rank - 1)s are already home.
 * - Move order. Tableau to foundation; tableau runs that turn a card up
 *   (deepest hidden pile first); talon to foundation; talon to tableau;
 *   a run that empties a column; partial runs; foundation to tableau.
 * - Pruning. A whole column never moves to an empty column (a king shuffled
 *   from empty to empty), and a run or card moves to the first empty column
 *   only (they are all alike under the key). A column with nothing face down
 *   is emptied only if a king is waiting for the space (in the talon, or
 *   heading a run on face-down cards). A partial run moves only if the card
 *   it uncovers can then go home, or can take the moved card's twin (same
 *   rank and colour) from the talon or another column. A card comes back off
 *   a foundation only if auto-play would not send it straight home, and
 *   never a king. Undoing the previous move lands on a position already in
 *   the table, so it is cut there.
 * - Ending. Once the talon is empty and every tableau card is face up, the
 *   deal is won: each column is a descending run, so the lowest card left is
 *   always on top of its column and always next on its foundation.
 *
 * Verdicts: 'solved' carries a move list that replays through `apply` from
 * `createGameFromDeal(deal)` to all 52 home. 'unsolvable' means the pruned
 * search space was exhausted (the pruning keeps every line a player needs in
 * practice, but it is not a proof over every legal move). 'unknown' means the
 * node budget ran out. The server treats both of the last two as a reject.
 */

export type SolveVerdict = 'solved' | 'unsolvable' | 'unknown';

export interface SolveResult {
  readonly verdict: SolveVerdict;
  /** Positions expanded. */
  readonly nodes: number;
  /** Present only when solved: sim moves, from the deal to all 52 home. */
  readonly solution?: Move[];
}

export interface SolveOptions {
  /** The node budget. At the limit the verdict is 'unknown'. */
  readonly maxNodes: number;
}

/**
 * The default budget. Measured on 300 random seeds (solver.test.ts, "solver
 * sweep", two seed sets): 78-79% solved and 1-3% proven unsolvable at 50k
 * nodes, the worst attempts (the unknowns) ~100-150 ms on the dev box; 250k
 * nodes resolves ~4 points more for ~5x the worst case.
 */
export const SOLVER_MAX_NODES = 50_000;

// Internal pile numbers: 0..6 tableau, 7..10 foundations (by suit), 11 talon.
const FOUND = 7;
const TALON = 11;

// Per-card lookups for the hot loops.
const RANK = Uint8Array.from({ length: 52 }, (_, x) => rankOf(x));
const SUIT = Uint8Array.from({ length: 52 }, (_, x) => suitOf(x));
const RED = Uint8Array.from({ length: 52 }, (_, x) => (isRed(x) ? 1 : 0));

/** Tableau features are (card * 53 + under) * 2 + up; foundation heights follow. */
const FOUND_FEATURE = 52 * 53 * 2;

/** Fixed pseudo-random words for the key (mulberry32 from a constant: deterministic). */
const ZOBRIST: Uint32Array = (() => {
  const n = (FOUND_FEATURE + 4 * 14) * 2;
  const out = new Uint32Array(n);
  let a = 0x9e3779b9;
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = (t ^ (t >>> 14)) >>> 0;
  }
  return out;
})();

/** One step the solver took, enough to write out the sim moves later. */
interface Step {
  readonly from: number;
  readonly to: number;
  readonly n: number;
  /** The card moved (the head of a run). */
  readonly card: Card;
}

/** What undoing a step needs. */
interface Applied {
  readonly step: Step;
  readonly flipped: boolean;
  /** Talon moves: where the card was, and the pointer before. */
  readonly talonIndex: number;
  readonly talonP: number;
}

class Position {
  readonly cols: Card[][] = [];
  readonly down: number[] = [];
  readonly found: number[] = [0, 0, 0, 0];
  /** Stock + waste in draw order; the first `p` are on the waste. */
  readonly talon: Card[] = [];
  p = 0;

  constructor(deal: readonly Card[]) {
    for (const slots of COLUMN_SLOTS) {
      this.cols.push(slots.map((s) => deal[s]!));
      this.down.push(slots.length - 1);
    }
    for (let s = 51; s >= 28; s--) this.talon.push(deal[s]!);
  }

  /**
   * The position key, into k1/k2: a 64-bit Zobrist-style hash, independent of column
   * order. Each tableau card contributes (card, the card under it or the
   * column base, face up or down); that set pins down every column as a
   * chain, whatever column it is in. Plus the foundation heights. The talon
   * is implied (every other card).
   */
  k1 = 0;
  k2 = 0;

  key(): void {
    let h1 = 0;
    let h2 = 0;
    for (let c = 0; c < 7; c++) {
      const col = this.cols[c]!;
      const d = this.down[c]!;
      let under = 52;
      for (let i = 0; i < col.length; i++) {
        const x = col[i]!;
        const f = ((x * 53 + under) << 1) | (i < d ? 0 : 1);
        h1 ^= ZOBRIST[f << 1]!;
        h2 ^= ZOBRIST[(f << 1) | 1]!;
        under = x;
      }
    }
    for (let s = 0; s < 4; s++) {
      const f = FOUND_FEATURE + s * 14 + this.found[s]!;
      h1 ^= ZOBRIST[f << 1]!;
      h2 ^= ZOBRIST[(f << 1) | 1]!;
    }
    this.k1 = h1;
    this.k2 = h2;
  }

  /** Can card x go home now? */
  homeable(x: Card): boolean {
    return this.found[SUIT[x]!] === RANK[x]! - 1;
  }

  /** Home now, and nothing could ever need it on the tableau. */
  safeHome(x: Card): boolean {
    if (!this.homeable(x)) return false;
    const r = RANK[x]!;
    if (r <= 2) return true;
    const f = this.found;
    return RED[x] === 1 ? f[0]! >= r - 1 && f[3]! >= r - 1 : f[1]! >= r - 1 && f[2]! >= r - 1;
  }

  /** Can x go on column c? */
  fits(x: Card, c: number): boolean {
    const col = this.cols[c]!;
    if (col.length === 0) return RANK[x]! === 13;
    const top = col[col.length - 1]!;
    return RANK[top]! === RANK[x]! + 1 && RED[top] !== RED[x];
  }

  apply(step: Step): Applied {
    const { from, to, n, card } = step;
    let flipped = false;
    let talonIndex = -1;
    const talonP = this.p;
    let run: Card[] | null = null;
    if (from === TALON) {
      talonIndex = this.talon.indexOf(card);
      this.talon.splice(talonIndex, 1);
      this.p = talonIndex;
    } else if (from >= FOUND) {
      this.found[from - FOUND]!--;
    } else {
      const col = this.cols[from]!;
      run = col.splice(col.length - n, n);
      const d = this.down[from]!;
      if (d > 0 && col.length === d) {
        this.down[from] = d - 1;
        flipped = true;
      }
    }
    if (to >= FOUND) this.found[to - FOUND]!++;
    else if (run) for (const x of run) this.cols[to]!.push(x);
    else this.cols[to]!.push(card);
    return { step, flipped, talonIndex, talonP };
  }

  undo(a: Applied): void {
    const { from, to, n, card } = a.step;
    let run: Card[] = [card];
    if (to >= FOUND) {
      this.found[to - FOUND]!--;
    } else {
      const dst = this.cols[to]!;
      run = dst.splice(dst.length - n, n);
    }
    if (from === TALON) {
      this.talon.splice(a.talonIndex, 0, card);
      this.p = a.talonP;
    } else if (from >= FOUND) {
      this.found[from - FOUND]!++;
    } else {
      if (a.flipped) this.down[from]!++;
      for (const x of run) this.cols[from]!.push(x);
    }
  }

  /** The talon is empty and every tableau card is face up. */
  won(): boolean {
    if (this.talon.length > 0) return false;
    for (let c = 0; c < 7; c++) if (this.down[c]! > 0) return false;
    return true;
  }

  /** Is card x in play: in the talon, or face up on the tableau outside columns a and b? */
  reachable(x: Card, a: number, b: number): boolean {
    if (this.talon.includes(x)) return true;
    for (let c = 0; c < 7; c++) {
      if (c === a || c === b) continue;
      const col = this.cols[c]!;
      for (let i = this.down[c]!; i < col.length; i++) if (col[i] === x) return true;
    }
    return false;
  }
}

/** Every safe home move, applied, until there are none. */
function autoPlay(pos: Position, out: Applied[]): void {
  for (let again = true; again;) {
    again = false;
    for (let suit = 0; suit < 4; suit++) {
      const h = pos.found[suit]!;
      if (h === 13) continue;
      const x = suit * 13 + h; // the next card this foundation takes
      if (!pos.safeHome(x)) continue;
      let from = -1;
      for (let c = 0; c < 7 && from < 0; c++) {
        const col = pos.cols[c]!;
        if (col[col.length - 1] === x) from = c;
      }
      if (from < 0 && pos.talon.includes(x)) from = TALON;
      if (from >= 0) {
        out.push(pos.apply({ from, to: FOUND + suit, n: 1, card: x }));
        again = true;
      }
    }
  }
}

/** The candidate steps from a position, best first. */
function steps(pos: Position): Step[] {
  const toHome: Step[] = [];
  const flips: { s: Step; d: number }[] = [];
  const talonHome: Step[] = [];
  const talonTab: Step[] = [];
  const empties: Step[] = [];
  const partial: Step[] = [];
  const back: Step[] = [];
  let firstEmpty = -1;
  for (let c = 0; c < 7; c++) {
    if (pos.cols[c]!.length === 0) {
      firstEmpty = c;
      break;
    }
  }

  // Emptying a column only helps if a king is waiting for it: in the talon,
  // or heading a run that sits on face-down cards.
  let kingWaiting = false;
  for (const x of pos.talon) if (RANK[x] === 13) kingWaiting = true;
  for (let c = 0; c < 7 && !kingWaiting; c++) {
    const d = pos.down[c]!;
    if (d > 0 && RANK[pos.cols[c]![d]!] === 13) kingWaiting = true;
  }

  for (let a = 0; a < 7; a++) {
    const col = pos.cols[a]!;
    if (col.length === 0) continue;
    const d = pos.down[a]!;
    const top = col[col.length - 1]!;
    if (pos.homeable(top)) toHome.push({ from: a, to: FOUND + SUIT[top]!, n: 1, card: top });
    for (let i = d; i < col.length; i++) {
      const head = col[i]!;
      const n = col.length - i;
      const king = RANK[head]! === 13;
      for (let b = 0; b < 7; b++) {
        if (b === a) continue;
        const dst = pos.cols[b]!;
        if (dst.length === 0) {
          if (!king || b !== firstEmpty || i === 0) continue; // whole column to empty: pointless
        } else if (!pos.fits(head, b)) continue;
        const step: Step = { from: a, to: b, n, card: head };
        if (i === d) {
          if (d > 0) flips.push({ s: step, d });
          else if (kingWaiting) empties.push(step);
        } else {
          // A partial run: only to uncover a card that goes home, or that takes
          // the moved card's twin from somewhere else.
          const under = col[i - 1]!;
          if (pos.homeable(under) || pos.reachable(twinOf(head), a, b)) partial.push(step);
        }
      }
    }
  }

  // Which columns each card would fit on: a bit per column.
  const fitsOn = new Uint8Array(52);
  for (let b = 0; b < 7; b++) {
    const col = pos.cols[b]!;
    const t = col[col.length - 1];
    if (t === undefined) continue;
    const r = RANK[t]!;
    if (r === 1) continue;
    const [s1, s2] = RED[t] === 1 ? [0, 3] : [1, 2];
    fitsOn[s1 * 13 + r - 2]! |= 1 << b;
    fitsOn[s2 * 13 + r - 2]! |= 1 << b;
  }
  for (const x of pos.talon) {
    if (pos.homeable(x)) talonHome.push({ from: TALON, to: FOUND + SUIT[x]!, n: 1, card: x });
    const mask = RANK[x] === 13 && firstEmpty >= 0 ? fitsOn[x]! | (1 << firstEmpty) : fitsOn[x]!;
    for (let b = 0; b < 7; b++) {
      if (mask & (1 << b)) talonTab.push({ from: TALON, to: b, n: 1, card: x });
    }
  }

  for (let s = 0; s < 4; s++) {
    const h = pos.found[s]!;
    if (h === 0 || h === 13) continue;
    const x = s * 13 + h - 1;
    // Would auto-play send it straight back? Check as if it were not home.
    pos.found[s]!--;
    const safe = pos.safeHome(x);
    pos.found[s]!++;
    if (safe) continue;
    for (let b = 0; b < 7; b++) {
      if (pos.cols[b]!.length > 0 && pos.fits(x, b))
        back.push({ from: FOUND + s, to: b, n: 1, card: x });
    }
  }

  flips.sort((u, v) => v.d - u.d);
  const out = toHome;
  for (const f of flips) out.push(f.s);
  for (const list of [talonHome, talonTab, empties, partial, back])
    for (const m of list) out.push(m);
  return out;
}

/** The card of the same rank and colour, other suit: C<->S, D<->H. */
function twinOf(x: Card): Card {
  const s = SUIT[x]!;
  const other = s === 0 ? 3 : s === 3 ? 0 : s === 1 ? 2 : 1;
  return other * 13 + (x % 13);
}

interface Frame {
  readonly via: readonly Applied[];
  readonly moves: readonly Step[];
  i: number;
}

/**
 * The transposition table: an open-addressed set of 64-bit keys, sized once
 * for the node budget (it never holds more than maxNodes keys).
 */
class KeySet {
  private readonly a: Int32Array;
  private readonly b: Int32Array;
  private readonly used: Uint8Array;
  private readonly mask: number;

  constructor(maxKeys: number) {
    let cap = 1024;
    while (cap < maxKeys * 2) cap *= 2;
    this.a = new Int32Array(cap);
    this.b = new Int32Array(cap);
    this.used = new Uint8Array(cap);
    this.mask = cap - 1;
  }

  private slot(k1: number, k2: number): number {
    let i = (k1 ^ Math.imul(k2, 0x9e3779b1)) & this.mask;
    while (this.used[i] === 1 && (this.a[i] !== k1 || this.b[i] !== k2)) i = (i + 1) & this.mask;
    return i;
  }

  has(k1: number, k2: number): boolean {
    return this.used[this.slot(k1, k2)] === 1;
  }

  /** Add a key; false if it was already there. */
  add(k1: number, k2: number): boolean {
    const i = this.slot(k1, k2);
    if (this.used[i] === 1) return false;
    this.used[i] = 1;
    this.a[i] = k1;
    this.b[i] = k2;
    return true;
  }
}

/**
 * Solve a full deal (slot -> card, as dealFor returns). Pure and
 * deterministic: the same deal and budget always give the same result.
 */
export function solve(deal: readonly Card[], opts: SolveOptions): SolveResult {
  if (deal.length !== 52) throw new RangeError(`deal must have 52 slots, got ${deal.length}`);
  const pos = new Position(deal);
  const seen = new KeySet(Math.max(1, opts.maxNodes) + 1);
  const rootAuto: Applied[] = [];
  autoPlay(pos, rootAuto);
  if (pos.won()) return { verdict: 'solved', nodes: 1, solution: emit(deal, pos, [rootAuto]) };
  pos.key();
  seen.add(pos.k1, pos.k2);
  let nodes = 1;
  const stack: Frame[] = [{ via: rootAuto, moves: steps(pos), i: 0 }];

  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.i >= top.moves.length) {
      stack.pop();
      if (stack.length > 0) for (let k = top.via.length - 1; k >= 0; k--) pos.undo(top.via[k]!);
      continue;
    }
    const step = top.moves[top.i++]!;
    const via: Applied[] = [pos.apply(step)];
    autoPlay(pos, via);
    if (pos.won()) {
      return {
        verdict: 'solved',
        nodes,
        solution: emit(deal, pos, [...stack.map((f) => f.via), via]),
      };
    }
    pos.key();
    if (nodes >= opts.maxNodes) {
      // Out of budget: unknown, unless this position was already seen (then
      // it adds nothing, and the search goes on through what is left).
      if (!seen.has(pos.k1, pos.k2)) return { verdict: 'unknown', nodes };
    }
    if (!seen.add(pos.k1, pos.k2)) {
      for (let k = via.length - 1; k >= 0; k--) pos.undo(via[k]!);
      continue;
    }
    nodes++;
    stack.push({ via, moves: steps(pos), i: 0 });
  }
  return { verdict: 'unsolvable', nodes };
}

const TAB_IDS: readonly PileId[] = ['t0', 't1', 't2', 't3', 't4', 't5', 't6'];
const FOUND_IDS: readonly PileId[] = ['f0', 'f1', 'f2', 'f3'];

function pileId(p: number): PileId {
  return p < FOUND ? TAB_IDS[p]! : FOUND_IDS[p - FOUND]!;
}

/**
 * Write out the sim moves for a path of steps, then finish a won position
 * (talon empty, all face up) by sending the lowest card home each time.
 */
function emit(deal: readonly Card[], end: Position, path: readonly (readonly Applied[])[]): Move[] {
  const out: Move[] = [];
  const talon: Card[] = [];
  for (let s = 51; s >= 28; s--) talon.push(deal[s]!);
  let p = 0;
  for (const group of path) {
    for (const a of group) {
      const { from, to, n, card } = a.step;
      if (from === TALON) {
        const i = talon.indexOf(card);
        if (i + 1 >= p) {
          for (let k = p; k < i + 1; k++) out.push({ t: 'draw' });
        } else {
          for (let k = p; k < talon.length; k++) out.push({ t: 'draw' });
          out.push({ t: 'draw' }); // recycle
          for (let k = 0; k < i + 1; k++) out.push({ t: 'draw' });
        }
        talon.splice(i, 1);
        p = i;
        out.push({ t: 'mv', from: 'waste', to: pileId(to), n: 1 });
      } else {
        out.push({ t: 'mv', from: pileId(from), to: pileId(to), n });
      }
    }
  }
  // The finish: each column is a descending run; the lowest card is on top.
  const cols = end.cols.map((c) => c.slice());
  for (;;) {
    let best = -1;
    for (let c = 0; c < 7; c++) {
      const col = cols[c]!;
      if (col.length === 0) continue;
      const x = col[col.length - 1]!;
      if (best < 0 || RANK[x]! < RANK[cols[best]![cols[best]!.length - 1]!]!) best = c;
    }
    if (best < 0) break;
    const x = cols[best]!.pop()!;
    out.push({ t: 'mv', from: pileId(best), to: pileId(FOUND + SUIT[x]!), n: 1 });
  }
  return out;
}
