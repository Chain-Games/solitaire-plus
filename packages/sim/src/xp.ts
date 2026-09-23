import type { ScoreBreakdown } from './events.js';
import { RULES } from './rules.js';

/**
 * XP is the account-level progression: a lifetime total that only ever grows,
 * an XP level derived from it and a rank title over the levels. It pays
 * nothing, ranks nothing in a challenge and changes nothing about the deck or
 * the clock. The server computes every award from its own replay of a
 * finished game; the client never sends an XP number.
 *
 *   xpThreshold(n) = xpBase * (n - 1) * (n + 3)   for n >= 2
 *
 * so with xpBase = 150 the thresholds run 750, 1800, 3150, 4800, 6750, 9000,
 * 11550, 14400, 17550 ... uncapped. Level 1 starts at 0.
 */

/** Lifetime XP at which XP level n begins. 0 for level 1 (and anything below it). */
export function xpThreshold(n: number): number {
  if (!(n >= 2)) return 0;
  return RULES.xpBase * (n - 1) * (n + 3);
}

/** The highest XP level whose threshold the XP total has reached; 1 at 0. */
export function xpLevelFor(xp: number): number {
  if (!(xp >= xpThreshold(2))) return 1;
  // Closed form of (n - 1)(n + 3) <= xp / xpBase, then settle on the integer
  // boundaries exactly so no floating-point edge can be off by one.
  let n = Math.max(1, Math.floor(Math.sqrt(4 + xp / RULES.xpBase) - 1));
  while (xpThreshold(n + 1) <= xp) n++;
  while (n > 1 && xpThreshold(n) > xp) n--;
  return n;
}

/**
 * Rank titles, one per xpRankSpan XP levels. The last one repeats with a numeral.
 * Themed per game (owner's decision 2026-09-16: "a different game gets different
 * names") over the same curve, span, tiers and colour order as Blockari.
 */
export const RANKS = [
  'Pip',
  'Deal',
  'Run',
  'Stack',
  'Cascade',
  'Tableau',
  'Foundation',
  'Royal',
  'Klondike',
] as const;

export interface Rank {
  /** Index into RANKS, capped at the last rank. The UI maps it to a palette. */
  readonly index: number;
  /** RANKS[index]; the last rank gains a roman numeral per further span ("Klondike II"). */
  readonly name: string;
  /** 1..xpRankSpan within the rank. */
  readonly tier: number;
}

const ROMAN: readonly [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

function roman(n: number): string {
  let out = '';
  let rest = n;
  for (const [value, glyph] of ROMAN)
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  return out;
}

/** The rank an XP level carries. Levels below 1 are treated as 1. */
export function rankFor(level: number): Rank {
  const lv = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
  const span = RULES.xpRankSpan;
  const step = Math.floor((lv - 1) / span);
  const last = RANKS.length - 1;
  const index = Math.min(step, last);
  const base = RANKS[index] ?? RANKS[0];
  const beyond = step - last; // 0 on the first pass through the last rank
  const name = index === last && beyond > 0 ? `${base} ${roman(beyond + 1)}` : base;
  return { index, name, tier: ((lv - 1) % span) + 1 };
}

/** The palette slot for a rank index. Identity for now; the UI owns the colours. */
export function rankColorIndex(index: number): number {
  return index;
}

export interface XpContext {
  /** True when the game was one side of a challenge. */
  readonly challenge: boolean;
  /** True/false once the challenge has settled; null while unknown (no win part). */
  readonly won: boolean | null;
  /** The challenge pot (2 x entry fee, before rake). 0 for solo games. */
  readonly pot: number;
}

export interface XpParts {
  readonly played: number;
  readonly score: number;
  readonly cards: number;
  readonly levels: number;
  readonly streak: number;
  readonly challenge: number;
  readonly win: number;
}

export interface XpAward {
  readonly total: number;
  readonly parts: XpParts;
}

export const ZERO_XP_PARTS: XpParts = {
  played: 0,
  score: 0,
  cards: 0,
  levels: 0,
  streak: 0,
  challenge: 0,
  win: 0,
};

function sum(parts: XpParts): number {
  return (
    parts.played +
    parts.score +
    parts.cards +
    parts.levels +
    parts.streak +
    parts.challenge +
    parts.win
  );
}

/** The win part of a settled challenge: xpWin + floor(pot / xpPotDivisor). */
export function xpForWin(pot: number): number {
  const p = Number.isFinite(pot) ? Math.max(0, pot) : 0;
  return RULES.xpWin + Math.floor(p / RULES.xpPotDivisor);
}

/**
 * XP a finished game earns, itemised. A pure function of the game's
 * ScoreBreakdown plus what is known about its challenge.
 *
 *   played     xpPlayed, for finishing with at least one move
 *   score      floor(total / xpPerScore)
 *   cards      xpPerCard per card on the foundations at the end
 *   levels     xpPerLevel per in-game level above 1
 *   streak     xpStreakBonus if the best streak reached xpStreakMin
 *   challenge  xpChallenge for a challenge game, win or lose
 *   win        xpForWin(pot) when ctx.won is true
 *
 * A game with no moves (never started, or abandoned before the first move)
 * earns nothing. There is no forfeit rule: the server scores a quit as a
 * timeout, so a game pays for what was played, however it ended.
 */
export function xpForGame(breakdown: ScoreBreakdown, ctx: XpContext): XpAward {
  if (!(breakdown.moves >= 1)) return { total: 0, parts: ZERO_XP_PARTS };
  const parts: XpParts = {
    played: RULES.xpPlayed,
    score: Math.floor(Math.max(0, breakdown.total) / RULES.xpPerScore),
    cards: RULES.xpPerCard * Math.max(0, breakdown.cardsHome),
    levels: RULES.xpPerLevel * Math.max(0, breakdown.levelReached - 1),
    streak: breakdown.bestStreak >= RULES.xpStreakMin ? RULES.xpStreakBonus : 0,
    challenge: ctx.challenge ? RULES.xpChallenge : 0,
    win: ctx.won === true ? xpForWin(ctx.pot) : 0,
  };
  return { total: sum(parts), parts };
}
