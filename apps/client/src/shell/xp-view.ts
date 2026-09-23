import {
  RANKS,
  RULES,
  ZERO_XP_PARTS,
  rankFor,
  xpForGame,
  xpLevelFor,
  xpThreshold,
  type Rank,
  type ScoreBreakdown,
} from '@solitaire-plus/sim';
import type { UserProfile, XpGained, XpProgress } from '../api/client.js';

/**
 * Presentation helpers for the account XP system (the rules live in
 * @solitaire-plus/sim; the server sends every number). Plus the `?xpDemo=1`
 * fixture — off by default — that the capture harness uses to preview a
 * mid-rank profile and a rank-up ceremony without grinding 750 XP first.
 */

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'] as const;

/** "III" for tier 3 (tiers run 1–5; Klondike's further passes are in the name). */
export function tierLabel(tier: number): string {
  return ROMAN[tier] ?? String(tier);
}

/** "Run III" — the rank name with its tier ("Klondike II · III" past the ladder). */
export function rankLabel(rank: Rank): string {
  const sep = rank.name.includes(' ') ? ' · ' : ' ';
  return `${rank.name}${sep}${tierLabel(rank.tier)}`;
}

/** Progress inside a level, 0..1, from the surrounding thresholds. */
export function xpProgress(xp: number, prev: number, next: number): number {
  if (next <= prev) return 1;
  return Math.max(0, Math.min(1, (xp - prev) / (next - prev)));
}

/** Full progress fields for an XP total (what the server sends for a user). */
export function progressFor(xp: number): XpProgress {
  const xpLevel = xpLevelFor(xp);
  return {
    xp,
    xpLevel,
    rank: rankFor(xpLevel),
    prevThreshold: xpThreshold(xpLevel),
    nextThreshold: xpThreshold(xpLevel + 1),
  };
}

/** The rank at an index, at its top tier: the rank a crossing left behind. */
export function rankAtIndex(index: number, tier = RULES.xpRankSpan): Rank {
  const i = Math.max(0, Math.min(RANKS.length - 1, index));
  return rankFor(i * RULES.xpRankSpan + Math.max(1, Math.min(RULES.xpRankSpan, tier)));
}

/**
 * The account as it stood just BEFORE crossing into rank `to`: the old
 * rank's top tier, its last level, the bar held full on that span ("21,000 /
 * 21,000 · 0 to Run I"). What every surface reads until the reveal.
 */
export function progressBefore(to: number): {
  rank: Rank;
  level: number;
  xp: number;
  prev: number;
  next: number;
} {
  const crossLevel = Math.max(2, to * RULES.xpRankSpan + 1);
  return {
    rank: rankAtIndex(to - 1),
    level: crossLevel - 1,
    xp: xpThreshold(crossLevel),
    prev: xpThreshold(crossLevel - 1),
    next: xpThreshold(crossLevel),
  };
}

/** The last rank: wears the shimmer. */
export function isLegend(rank: Rank): boolean {
  return rank.index >= RANKS.length - 1;
}

/* --------------------------------------------------------------------------
   Demo fixture (?xpDemo=1) — never on without the flag
   -------------------------------------------------------------------------- */

const DEMO_FLAG = 'xpDemo';
let demoCached: boolean | null = null;

/** `?xpDemo=1` on the URL (read once per load). */
export function xpDemo(): boolean {
  if (demoCached === null) {
    try {
      demoCached = new URLSearchParams(location.search).get(DEMO_FLAG) === '1';
    } catch {
      demoCached = false;
    }
  }
  return demoCached;
}

/** Demo: the signed-in user carries the fixture's progress too, so every surface agrees with the hero. */
export function demoUser<T extends { username: string }>(u: T): T & XpProgress {
  const d = demoProfile(u.username);
  return {
    ...u,
    xp: d.xp,
    xpLevel: d.xpLevel,
    rank: d.rank,
    prevThreshold: d.prevThreshold,
    nextThreshold: d.nextThreshold,
  };
}

/** Demo profile: a mid-rank account (Run II, 26,300 / 28,800 XP; `&xpLevel=n` picks another level) with fixed lifetime counts — the same numbers in every frame. */
export function demoProfile(username: string): UserProfile {
  let level = 12;
  try {
    const v = Number(new URLSearchParams(location.search).get('xpLevel'));
    if (v >= 1) level = Math.floor(v);
  } catch {
    /* default */
  }
  return {
    ...progressFor(
      xpThreshold(level) + Math.round((xpThreshold(level + 1) - xpThreshold(level)) * 0.38),
    ),
    username,
    isGuest: username.startsWith('guest_'),
    createdAt: '2026-03-04T12:00:00.000Z',
    gamesPlayed: 174,
    challengesWon: 67,
    challengesPlayed: 83,
    bestScore: 7886,
    bestLevel: 8,
    ...DEMO_MONEY,
  };
}

/** A mid-rank ledger: more won than lost, a believable return on the stake. */
const DEMO_MONEY = (() => {
  const chainStaked = 2210;
  const chainWon = 930;
  const chainLost = 560;
  const chainPnl = chainWon - chainLost;
  return {
    chainStaked,
    chainWon,
    chainLost,
    chainPnl,
    chainPnlPct: Math.round((chainWon / chainStaked) * 1000) / 10,
  };
})();

/**
 * Demo XP for a finished game: the sim's own parts for the breakdown (as a
 * challenge game, plus a streak so the itemisation has every line), and the
 * account placed so the count crosses into a new RANK (Deal V → Run I)
 * about a third of the way through — the ceremony every time.
 */
export function demoGained(b: ScoreBreakdown): XpGained {
  const award = xpForGame(
    { ...b, endReason: 'timeout', moves: Math.max(1, b.moves), bestStreak: 4 },
    { challenge: true, won: null, pot: 0 },
  );
  const parts = award.total > 0 ? award.parts : { ...ZERO_XP_PARTS, played: 50 };
  const total = Math.max(1, award.total);
  // `&xpCross=late` places the crossing in the count's last few points — the
  // small-margin rank-up that once froze the beat on its hold.
  let at = 0.35;
  try {
    if (new URLSearchParams(location.search).get('xpCross') === 'late') at = 0.97;
  } catch {
    /* default */
  }
  const xpBefore = xpThreshold(11) - Math.max(1, Math.round(total * at));
  const xpAfter = xpBefore + total;
  const levelBefore = xpLevelFor(xpBefore);
  const levelAfter = xpLevelFor(xpAfter);
  return {
    total,
    parts,
    xpBefore,
    xpAfter,
    levelBefore,
    levelAfter,
    rankBefore: rankFor(levelBefore),
    rankAfter: rankFor(levelAfter),
  };
}
