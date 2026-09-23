import { describe, expect, it } from 'vitest';
import {
  RANKS,
  RULES,
  rankColorIndex,
  rankFor,
  xpForGame,
  xpForWin,
  xpLevelFor,
  xpThreshold,
  type ScoreBreakdown,
} from '../src/index.js';

/** A finished-game breakdown with sensible defaults, overridable per test. */
function breakdown(over: Partial<ScoreBreakdown> = {}): ScoreBreakdown {
  return {
    foundation: 1600,
    reveals: 700,
    tableau: 200,
    streak: 500,
    base: 3000,
    streakBonus: 0,
    clearBonus: 0,
    timeBonus: 0,
    total: 3000,
    bestStreak: 1,
    cardsHome: 16,
    revealed: 14,
    moves: 60,
    undos: 0,
    elapsedMs: 300_000,
    endReason: 'timeout',
    levelReached: 4,
    ...over,
  };
}

describe('XP thresholds', () => {
  it('follow xpBase * (n - 1) * (n + 3), uncapped', () => {
    expect(RULES.xpBase).toBe(150);
    const table: [number, number][] = [
      [1, 0],
      [2, 750],
      [3, 1800],
      [4, 3150],
      [5, 4800],
      [6, 6750],
      [7, 9000],
      [8, 11550],
      [9, 14400],
      [10, 17550],
      [11, 21000],
      [20, 65550],
      [50, 389550],
    ];
    for (const [n, at] of table) expect(xpThreshold(n), `level ${n}`).toBe(at);
    expect(xpThreshold(0)).toBe(0);
    expect(xpThreshold(-3)).toBe(0);
    expect(xpThreshold(Number.NaN)).toBe(0);
  });

  it('xpLevelFor picks the highest level whose threshold the total has reached', () => {
    expect(xpLevelFor(0)).toBe(1);
    expect(xpLevelFor(749)).toBe(1);
    expect(xpLevelFor(750)).toBe(2);
    expect(xpLevelFor(1799)).toBe(2);
    expect(xpLevelFor(1800)).toBe(3);
    expect(xpLevelFor(3149)).toBe(3);
    expect(xpLevelFor(3150)).toBe(4);
    expect(xpLevelFor(17549)).toBe(9);
    expect(xpLevelFor(17550)).toBe(10);
    expect(xpLevelFor(-50)).toBe(1);
    expect(xpLevelFor(Number.NaN)).toBe(1);
  });

  it('xpLevelFor and xpThreshold agree on every boundary up to level 300', () => {
    for (let n = 2; n <= 300; n++) {
      const at = xpThreshold(n);
      expect(xpLevelFor(at), `at ${at}`).toBe(n);
      expect(xpLevelFor(at - 1), `below ${at}`).toBe(n - 1);
      expect(xpThreshold(n + 1)).toBeGreaterThan(at);
    }
  });
});

describe('ranks', () => {
  it('is one title per five XP levels with tiers 1..5', () => {
    expect(RANKS).toEqual([
      'Pip',
      'Deal',
      'Run',
      'Stack',
      'Cascade',
      'Tableau',
      'Foundation',
      'Royal',
      'Klondike',
    ]);
    expect(rankFor(1)).toEqual({ index: 0, name: 'Pip', tier: 1 });
    expect(rankFor(5)).toEqual({ index: 0, name: 'Pip', tier: 5 });
    expect(rankFor(6)).toEqual({ index: 1, name: 'Deal', tier: 1 });
    expect(rankFor(10)).toEqual({ index: 1, name: 'Deal', tier: 5 });
    expect(rankFor(11)).toEqual({ index: 2, name: 'Run', tier: 1 });
    expect(rankFor(16)).toEqual({ index: 3, name: 'Stack', tier: 1 });
    expect(rankFor(21)).toEqual({ index: 4, name: 'Cascade', tier: 1 });
    expect(rankFor(26)).toEqual({ index: 5, name: 'Tableau', tier: 1 });
    expect(rankFor(31)).toEqual({ index: 6, name: 'Foundation', tier: 1 });
    expect(rankFor(36)).toEqual({ index: 7, name: 'Royal', tier: 1 });
    expect(rankFor(40)).toEqual({ index: 7, name: 'Royal', tier: 5 });
  });

  it('the last rank repeats with a roman numeral per further five levels', () => {
    expect(rankFor(41)).toEqual({ index: 8, name: 'Klondike', tier: 1 });
    expect(rankFor(45)).toEqual({ index: 8, name: 'Klondike', tier: 5 });
    expect(rankFor(46)).toEqual({ index: 8, name: 'Klondike II', tier: 1 });
    expect(rankFor(50)).toEqual({ index: 8, name: 'Klondike II', tier: 5 });
    expect(rankFor(51)).toEqual({ index: 8, name: 'Klondike III', tier: 1 });
    expect(rankFor(56)).toEqual({ index: 8, name: 'Klondike IV', tier: 1 });
    expect(rankFor(61)).toEqual({ index: 8, name: 'Klondike V', tier: 1 });
    expect(rankFor(86)).toEqual({ index: 8, name: 'Klondike X', tier: 1 });
    expect(rankFor(300)).toEqual({ index: 8, name: 'Klondike LII', tier: 5 });
  });

  it('treats junk levels as level 1 and maps colour slots to the index', () => {
    expect(rankFor(0)).toEqual(rankFor(1));
    expect(rankFor(-4)).toEqual(rankFor(1));
    expect(rankFor(Number.NaN)).toEqual(rankFor(1));
    expect(rankFor(7.9)).toEqual(rankFor(7));
    for (let i = 0; i < RANKS.length; i++) expect(rankColorIndex(i)).toBe(i);
  });
});

describe('xpForGame', () => {
  const solo = { challenge: false, won: null, pot: 0 };

  it('itemises a solo game', () => {
    const b = breakdown({ total: 3275, cardsHome: 8, levelReached: 4, bestStreak: 3 });
    const xp = xpForGame(b, solo);
    expect(xp.parts).toEqual({
      played: 50,
      score: 65, // floor(3275 / 50)
      cards: 80,
      levels: 75,
      streak: 0,
      challenge: 0,
      win: 0,
    });
    expect(xp.total).toBe(50 + 65 + 80 + 75);
  });

  it('pays the streak bonus from a best streak of 4', () => {
    expect(xpForGame(breakdown({ bestStreak: 3 }), solo).parts.streak).toBe(0);
    expect(xpForGame(breakdown({ bestStreak: 4 }), solo).parts.streak).toBe(40);
    expect(xpForGame(breakdown({ bestStreak: 9 }), solo).parts.streak).toBe(40);
  });

  it('a lost challenge earns the challenge part but no win part', () => {
    const b = breakdown({ total: 1000, cardsHome: 2, levelReached: 2 });
    const xp = xpForGame(b, { challenge: true, won: false, pot: 50 });
    expect(xp.parts).toEqual({
      played: 50,
      score: 20,
      cards: 20,
      levels: 25,
      streak: 0,
      challenge: 25,
      win: 0,
    });
    expect(xp.total).toBe(140);
    // Unknown outcome (the game just finished, opponent still playing): same as lost.
    expect(xpForGame(b, { challenge: true, won: null, pot: 50 })).toEqual(xp);
  });

  it('a won challenge with pot 200 adds 100 + floor(200 / 2)', () => {
    const b = breakdown({ total: 1000, cardsHome: 2, levelReached: 2 });
    const xp = xpForGame(b, { challenge: true, won: true, pot: 200 });
    expect(xp.parts.win).toBe(200);
    expect(xpForWin(200)).toBe(200);
    expect(xpForWin(0)).toBe(100);
    expect(xpForWin(25)).toBe(112);
    expect(xp.total).toBe(140 + 200);
  });

  it('a game with no moves earns nothing at all', () => {
    for (const endReason of ['forfeit', 'timeout'] as const) {
      const xp = xpForGame(
        breakdown({ moves: 0, total: 0, cardsHome: 0, levelReached: 1, endReason }),
        { challenge: true, won: true, pot: 200 },
      );
      expect(xp.total).toBe(0);
      expect(Object.values(xp.parts).every((v) => v === 0)).toBe(true);
    }
  });

  it('a forfeit pays for what was played, the same as a timeout', () => {
    const fields = { moves: 3, total: 530, cardsHome: 1, levelReached: 2 };
    const ctx = { challenge: true, won: null, pot: 50 };
    const quit = xpForGame(breakdown({ ...fields, endReason: 'forfeit' }), ctx);
    const timed = xpForGame(breakdown({ ...fields, endReason: 'timeout' }), ctx);
    expect(quit).toEqual(timed);
    expect(quit.parts).toEqual({
      played: 50,
      score: 10,
      cards: 10,
      levels: 25,
      streak: 0,
      challenge: 25,
      win: 0,
    });
  });

  it('the total is always the sum of the parts and the parts follow the rules constants', () => {
    const b = breakdown({ total: 12_345, cardsHome: 21, levelReached: 9, bestStreak: 5 });
    const xp = xpForGame(b, { challenge: true, won: true, pot: 100 });
    expect(xp.total).toBe(Object.values(xp.parts).reduce((a, v) => a + v, 0));
    expect(xp.parts.played).toBe(RULES.xpPlayed);
    expect(xp.parts.score).toBe(Math.floor(12_345 / RULES.xpPerScore));
    expect(xp.parts.cards).toBe(21 * RULES.xpPerCard);
    expect(xp.parts.levels).toBe(8 * RULES.xpPerLevel);
    expect(xp.parts.streak).toBe(RULES.xpStreakBonus);
    expect(xp.parts.challenge).toBe(RULES.xpChallenge);
    expect(xp.parts.win).toBe(RULES.xpWin + Math.floor(100 / RULES.xpPotDivisor));
  });

  it('is deterministic and never mutates its input', () => {
    const b = breakdown({ total: 4321, cardsHome: 11, levelReached: 5, bestStreak: 4 });
    const frozen = Object.freeze({ ...b });
    const ctx = { challenge: true, won: true, pot: 20 };
    const a = xpForGame(frozen, ctx);
    const c = xpForGame(frozen, ctx);
    expect(a).toEqual(c);
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
    expect(frozen).toEqual(b);
  });
});
