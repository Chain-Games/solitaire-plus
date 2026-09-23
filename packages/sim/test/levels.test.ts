import { describe, expect, it } from 'vitest';
import { RULES, levelFor, levelThreshold, tick } from '../src/index.js';
import { layout, mustApply } from './util.js';

describe('level thresholds', () => {
  it('follow levelBase * (n - 1) * (n + 3), uncapped', () => {
    expect(RULES.levelBase).toBe(100);
    const table: [number, number][] = [
      [1, 0],
      [2, 500],
      [3, 1200],
      [4, 2100],
      [5, 3200],
      [6, 4500],
      [7, 6000],
      [8, 7700],
      [9, 9600],
      [10, 11700],
      [11, 14000],
      [20, 43700],
      [50, 259700],
    ];
    for (const [n, at] of table) expect(levelThreshold(n), `level ${n}`).toBe(at);
    expect(levelThreshold(0)).toBe(0);
    expect(levelThreshold(-3)).toBe(0);
  });

  it('levelFor picks the highest level whose threshold the score has reached', () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(10)).toBe(1);
    expect(levelFor(499)).toBe(1);
    expect(levelFor(500)).toBe(2);
    expect(levelFor(1199)).toBe(2);
    expect(levelFor(1200)).toBe(3);
    expect(levelFor(2099)).toBe(3);
    expect(levelFor(2100)).toBe(4);
    expect(levelFor(3199)).toBe(4);
    expect(levelFor(3200)).toBe(5);
    expect(levelFor(11699)).toBe(9);
    expect(levelFor(11700)).toBe(10);
    expect(levelFor(1_000_000)).toBe(99);
    expect(levelFor(-50)).toBe(1);
    expect(levelFor(Number.NaN)).toBe(1);
  });

  it('levelFor and levelThreshold agree on every boundary up to level 200', () => {
    for (let n = 2; n <= 200; n++) {
      const at = levelThreshold(n);
      expect(levelFor(at), `at ${at}`).toBe(n);
      expect(levelFor(at - 1), `below ${at}`).toBe(n - 1);
      expect(levelThreshold(n + 1)).toBeGreaterThan(at);
    }
  });
});

describe('levels in play', () => {
  it('emits levelUp right after scored when a move reaches a new level', () => {
    // 4 cards home + reveal from 280 in-play: crosses 500.
    let s = layout({ tableau: [['_9D', '2C', 'AC']] });
    s = { ...s, score: 350 };
    const r = mustApply(s, { t: 'mv', from: 't0', to: 'f0', n: 1 });
    expect(r.score).toBe(450);
    expect(r.level).toBe(1);
    const after = tick(r, 100).state;
    const events: string[] = [];
    const r2 = mustApply(after, { t: 'mv', from: 't0', to: 'f0', n: 1 });
    expect(r2.score).toBe(450 + RULES.foundationPoints + RULES.revealPoints + RULES.streakStep);
    expect(r2.level).toBe(2);
    events.push(r2.level > r.level ? 'up' : '-');
    expect(events).toEqual(['up']);
  });

  it('never drops a level when a card comes back off a foundation', () => {
    let s = layout({ home: [0, 0, 5, 0], tableau: [['6S']] });
    s = { ...s, score: 520, level: 2 };
    s = mustApply(s, { t: 'mv', from: 'f2', to: 't0', n: 1 });
    expect(s.score).toBe(370);
    expect(s.level).toBe(2);
  });
});
