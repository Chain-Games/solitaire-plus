import { describe, expect, it } from 'vitest';
import { RULES, levelFor, xpForGame } from '../src/index.js';

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))] ?? 0;
};
import { botGame } from './util.js';

/**
 * Score magnitudes across many deals, for calibrating the scoring table
 * against Blockari's ranges. Run with SWEEP=1; skipped in the normal suite.
 * The bot is greedy and never plans, so it is a floor for a real player.
 */
describe.skipIf(!process.env.SWEEP)('score sweep', () => {
  it('1000 seeds at two paces', () => {
    for (const [label, minGapMs, maxGapMs, smart] of [
      ['greedy casual 1.5-4s', 1500, 4000, false],
      ['greedy quick 0.6-2s', 600, 2000, false],
      ['lookahead casual 1.5-4s', 1500, 4000, true],
    ] as const) {
      const totals: number[] = [];
      let clears = 0;
      let homeSum = 0;
      let bestStreakSum = 0;
      let clockBound = 0;
      const xps: number[] = [];
      const clearTimes: number[] = [];
      const clearTotals: number[] = [];
      for (let i = 0; i < 1000; i++) {
        const { state, moves } = botGame(`sweep-${i}`, `bot-${i}`, { minGapMs, maxGapMs, smart });
        const b = state.breakdown;
        if (!b) throw new Error('unfinished');
        totals.push(b.total);
        xps.push(xpForGame(b, { challenge: true, won: null, pot: 0 }).total);
        homeSum += b.cardsHome;
        bestStreakSum += b.bestStreak;
        if (b.endReason === 'cleared') {
          clears++;
          clearTimes.push(b.elapsedMs);
          clearTotals.push(b.total);
        }
        // Still playing when the clock ran out (last move in the final 10 s).
        const last = moves[moves.length - 1]?.tMs ?? 0;
        if (b.endReason !== 'cleared' && last > RULES.durationMs - 10_000) clockBound++;
      }
      totals.sort((a, b) => a - b);
      const q = (p: number) => totals[Math.floor(p * (totals.length - 1))] as number;
      const buckets = [0, 1000, 3000, 6000, 10000, Infinity];
      const hist = buckets.slice(0, -1).map((lo, i) => {
        const hi = buckets[i + 1] as number;
        return `${lo}-${hi}: ${totals.filter((t) => t >= lo && t < hi).length}`;
      });
      console.log(
        `${label}: p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)} max ${q(1)} (LV ${levelFor(q(0.5))} median)` +
          ` · clears ${clears / 10}% · avg home ${homeSum / 1000} · avg best streak ${bestStreakSum / 1000}` +
          `\n  ${hist.join(' · ')}` +
          `\n  clock-bound ${clockBound / 10}% · clear time ${pct(clearTimes, 0.5)}/${pct(clearTimes, 0.9)} ms (p50/p90)` +
          ` · clear totals ${pct(clearTotals, 0)}..${pct(clearTotals, 1)} (p50 ${pct(clearTotals, 0.5)})` +
          `\n  game XP p50 ${pct(xps, 0.5)} (challenge, no win)`,
      );
      expect(totals.length).toBe(1000);
    }
  }, 600_000);
});
