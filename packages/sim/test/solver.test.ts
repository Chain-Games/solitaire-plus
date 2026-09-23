import { describe, expect, it } from 'vitest';
import {
  COLUMN_SLOTS,
  INITIAL_UP_SLOTS,
  SOLVER_MAX_NODES,
  apply,
  cardsHome,
  createGameFromDeal,
  dealFor,
  isError,
  solve,
  type Card,
  type Move,
} from '../src/index.js';
import { c } from './util.js';

/** Replay a solution through the sim from the deal; returns the final state. */
function play(deal: readonly Card[], moves: readonly Move[]) {
  let state = createGameFromDeal(deal).state;
  moves.forEach((m, i) => {
    const r = apply(state, m);
    if (isError(r)) throw new Error(`move ${i} ${JSON.stringify(m)}: ${r.error}`);
    state = r.state;
  });
  return state;
}

const PINNED = Array.from({ length: 20 }, (_, i) => `solver-${i}`);

describe('solver', () => {
  it('verdicts on 20 pinned seeds (golden)', () => {
    const verdicts = PINNED.map((seed) => {
      const r = solve(dealFor(seed), { maxNodes: SOLVER_MAX_NODES });
      return `${seed} ${r.verdict} ${r.nodes}`;
    });
    // Changing the solver's search or the deal order changes these; so does
    // changing SOLVER_MAX_NODES.
    expect(verdicts).toMatchInlineSnapshot(`
      [
        "solver-0 solved 39",
        "solver-1 unknown 50000",
        "solver-2 solved 45",
        "solver-3 solved 38",
        "solver-4 unknown 50000",
        "solver-5 solved 20069",
        "solver-6 solved 2475",
        "solver-7 solved 12584",
        "solver-8 solved 47",
        "solver-9 unknown 50000",
        "solver-10 unknown 50000",
        "solver-11 solved 38",
        "solver-12 solved 48",
        "solver-13 solved 53",
        "solver-14 solved 33",
        "solver-15 solved 47",
        "solver-16 solved 34",
        "solver-17 solved 400",
        "solver-18 solved 37",
        "solver-19 solved 32",
      ]
    `);
  });

  it('every solved solution replays through apply to all 52 home', () => {
    let solved = 0;
    for (const seed of PINNED) {
      const deal = dealFor(seed);
      const r = solve(deal, { maxNodes: SOLVER_MAX_NODES });
      if (r.verdict !== 'solved') {
        expect(r.solution).toBeUndefined();
        continue;
      }
      solved++;
      const end = play(deal, r.solution!);
      expect(cardsHome(end)).toBe(52);
      expect(end.status).toBe('ended');
      expect(end.breakdown?.endReason).toBe('cleared');
    }
    expect(solved).toBeGreaterThanOrEqual(12);
  });

  it('is deterministic: the same deal and budget give the same result', () => {
    for (const seed of ['solver-det-1', 'solver-det-2', 'solver-3']) {
      const a = solve(dealFor(seed), { maxNodes: 20_000 });
      const b = solve(dealFor(seed), { maxNodes: 20_000 });
      expect(b).toEqual(a);
    }
  });

  it('runs out of budget as unknown, never a wrong verdict', () => {
    // A seed the default budget solves, but not in one node.
    const seed = PINNED.find(
      (s) => solve(dealFor(s), { maxNodes: SOLVER_MAX_NODES }).nodes > 10,
    ) as string;
    expect(seed).toBeDefined();
    const r = solve(dealFor(seed), { maxNodes: 2 });
    expect(r.verdict).toBe('unknown');
    expect(r.nodes).toBeLessThanOrEqual(2);
    expect(r.solution).toBeUndefined();
  });

  it('a constructed dead deal is never solved', () => {
    // Every face-up card is red, the four aces and every black 2-4 are face
    // down, and the stock holds no ace and no black card that fits a red top.
    // Nothing can ever move.
    const up = ['2D', '2H', '3D', '3H', '4D', '4H', '5D'].map(c);
    const buried = ['AC', 'AD', 'AH', 'AS', '2C', '2S', '3C', '3S', '4C', '4S'].map(c);
    const rest: Card[] = [];
    for (let x = 0; x < 52; x++) if (!up.includes(x) && !buried.includes(x)) rest.push(x);
    // 21 face-down slots: the 10 buried cards, then 11 more from the rest.
    const down = [...buried, ...rest.splice(0, 11)];
    const deal = new Array<Card>(52);
    INITIAL_UP_SLOTS.forEach((slot, i) => (deal[slot] = up[i]!));
    let k = 0;
    for (const col of COLUMN_SLOTS) for (const slot of col.slice(0, -1)) deal[slot] = down[k++]!;
    for (let slot = 28; slot < 52; slot++) deal[slot] = rest[slot - 28]!;
    expect(new Set(deal).size).toBe(52);

    const r = solve(deal, { maxNodes: SOLVER_MAX_NODES });
    expect(r.verdict).not.toBe('solved');
    expect(r.verdict).toBe('unsolvable');
    expect(r.solution).toBeUndefined();
  });

  it('rejects a deal of the wrong size', () => {
    expect(() => solve([1, 2, 3], { maxNodes: 10 })).toThrow(RangeError);
  });
});

/**
 * The budget measurement behind SOLVER_MAX_NODES: 300 random seeds at the
 * default and at 250k nodes. Run with SOLVER_SWEEP=1; skipped in the normal
 * suite (it takes a minute and its timings depend on the box).
 */
describe.skipIf(!process.env.SOLVER_SWEEP)('solver sweep', () => {
  const pct = (xs: number[], p: number) =>
    [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))] ?? 0;
  for (const maxNodes of [SOLVER_MAX_NODES, 250_000]) {
    it(`300 seeds at ${maxNodes} nodes`, () => {
      const count = { solved: 0, unsolvable: 0, unknown: 0 };
      const ms: number[] = [];
      const nodes: number[] = [];
      for (let i = 0; i < 300; i++) {
        const deal = dealFor(`sweep-${i}`);
        const t = performance.now();
        const r = solve(deal, { maxNodes });
        ms.push(performance.now() - t);
        nodes.push(r.nodes);
        count[r.verdict]++;
        if (r.solution) expect(cardsHome(play(deal, r.solution))).toBe(52);
      }
      console.log(
        `maxNodes ${maxNodes}: solved ${count.solved}, unsolvable ${count.unsolvable}, unknown ${count.unknown};`,
        `ms p50 ${pct(ms, 0.5).toFixed(1)} p95 ${pct(ms, 0.95).toFixed(1)} max ${Math.max(...ms).toFixed(0)};`,
        `nodes p50 ${pct(nodes, 0.5)} p95 ${pct(nodes, 0.95)}`,
      );
    });
  }
});
