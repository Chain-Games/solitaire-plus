import { RULES } from './rules.js';

/**
 * Levels are a cosmetic progression over the in-play score: a milestone the
 * HUD celebrates, a number to compare on the results screen. They pay nothing,
 * change nothing about the deck or the clock, and play no part in ranking.
 *
 *   levelThreshold(n) = levelBase * (n - 1) * (n + 3)   for n >= 2
 *
 * so with levelBase = 100 the thresholds run 500, 1200, 2100, 3200, 4500,
 * 6000, 7700, 9600, 11700 ... uncapped. Level 1 starts at 0.
 */

/** Score at which level n begins. 0 for level 1 (and anything below it). */
export function levelThreshold(n: number): number {
  if (!(n >= 2)) return 0;
  return RULES.levelBase * (n - 1) * (n + 3);
}

/** The highest level whose threshold the score has reached; 1 at 0. */
export function levelFor(score: number): number {
  if (!(score >= levelThreshold(2))) return 1;
  // Closed form of (n - 1)(n + 3) <= score / levelBase, then settle on the
  // integer boundaries exactly so no floating-point edge can be off by one.
  let n = Math.max(1, Math.floor(Math.sqrt(4 + score / RULES.levelBase) - 1));
  while (levelThreshold(n + 1) <= score) n++;
  while (n > 1 && levelThreshold(n) > score) n--;
  return n;
}
