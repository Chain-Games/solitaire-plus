import { describe, expect, it } from 'vitest';
import { RULES, ReplayError, replay, stateHash, xpForGame } from '../src/index.js';
import { botGame } from './util.js';

describe('replay', () => {
  it('reproduces a bot game exactly', () => {
    const { moves, state } = botGame('replay-1', 'bot-1');
    expect(moves.length).toBeGreaterThan(20);
    const r = replay('replay-1', moves);
    expect(r.status).toBe('ended');
    expect(stateHash(r)).toBe(stateHash(state));
  });

  it('golden game', () => {
    // A seeded bot game pinned end to end: deal, rules, scoring, clock.
    // Changing these is a migration.
    const { moves, state } = botGame('golden', 'golden-bot');
    const r = replay('golden', moves);
    expect(stateHash(r)).toBe(stateHash(state));
    expect(moves.length).toMatchInlineSnapshot(`64`);
    expect(stateHash(r)).toMatchInlineSnapshot(`"afdda79e"`);
    expect(r.breakdown?.total).toMatchInlineSnapshot(`1400`);
  });

  it('a solved game replays to a clear', () => {
    let found: string | null = null;
    for (let i = 0; i < 400 && found === null; i++) {
      const { state } = botGame(`clear-${i}`, 'bot', { minGapMs: 300, maxGapMs: 1500 });
      if (state.breakdown?.endReason === 'cleared') found = `clear-${i}`;
    }
    expect(found).not.toBeNull();
    const seed = found as string;
    const { moves } = botGame(seed, 'bot', { minGapMs: 300, maxGapMs: 1500 });
    const r = replay(seed, moves);
    expect(r.breakdown?.endReason).toBe('cleared');
    expect(r.breakdown?.cardsHome).toBe(52);
    expect(r.breakdown?.elapsedMs).toBeLessThan(RULES.durationMs);
    expect(seed).toMatchInlineSnapshot(`"clear-5"`);
  });

  it('runs the clock out when moves stop early', () => {
    const s = replay('replay-2', []);
    expect(s.status).toBe('ended');
    expect(s.breakdown?.endReason).toBe('timeout');
    expect(s.breakdown?.elapsedMs).toBe(RULES.durationMs);
    expect(xpForGame(s.breakdown!, { challenge: true, won: null, pot: 0 }).total).toBe(0);
  });

  it('rejects moves out of order, after the clock, or illegal', () => {
    expect(() =>
      replay('r', [
        { t: 'draw', tMs: 500 },
        { t: 'draw', tMs: 400 },
      ]),
    ).toThrow(ReplayError);
    expect(() => replay('r', [{ t: 'draw', tMs: RULES.durationMs }])).toThrow(ReplayError);
    expect(() => replay('r', [{ t: 'mv', from: 't0', to: 'f0', n: 2, tMs: 10 }])).toThrow(/move 0/);
    expect(() => replay('r', [{ t: 'undo', tMs: 10 }])).toThrow(/nothing-to-undo/);
  });
});
