/**
 * Every tunable number in the game, in one place.
 *
 * docs/rules.md is the human-readable statement of these rules. If you change
 * a number here, change it there in the same commit. Changing drawCount or the
 * deal order changes what every stored seed means — that is a migration.
 */
export const RULES = {
  /** Cards turned from the stock per draw (fewer if fewer remain). */
  drawCount: 1,

  /** Tableau columns. Column n (0-based) is dealt n + 1 cards, the last face up. */
  columns: 7,

  /** Game length. The clock counts down from this and the game ends at 0. */
  durationMs: 300_000,

  /** A card reaching a foundation (by hand or by autocomplete). */
  foundationPoints: 100,
  /** A face-down tableau card turned face up. */
  revealPoints: 50,
  /** The top waste card played onto the tableau. */
  wastePoints: 25,
  /** A card taken back off a foundation onto the tableau. Must exceed foundationPoints. */
  foundationReturnPoints: -150,

  /**
   * Streak: back-to-back scoring moves (a card to a foundation, or a move
   * that reveals a face-down card), each within streakWindowMs of game time
   * of the previous one. The 2nd is "2X STREAK" and adds streakStep, the 3rd
   * 2 * streakStep ... the step stops growing at streakCap. Any move that
   * scores neither (a draw, a recycle, a plain tableau move, a waste play, a
   * foundation return) breaks it, and so does the window running out. At game
   * end the best streak pays (min(best, streakCap) - 1) * streakEndStep.
   */
  streakWindowMs: 6_000,
  streakStep: 25,
  streakCap: 5,
  streakEndStep: 100,

  /** All 52 home before the clock: clearBonus + clearPerSecond per whole second left. */
  clearBonus: 2_000,
  clearPerSecond: 10,

  /**
   * Levels: cosmetic milestones on the in-play score. Level n (n >= 2) starts
   * at levelBase * (n - 1) * (n + 3): 500, 1200, 2100, 3200, 4500, 6000 ...
   * uncapped. See levels.ts. Identical to Blockari.
   */
  levelBase: 100,

  /**
   * XP: the account-level progression, Blockari's shape and constants (see
   * xp.ts and docs/rules.md § XP). Only Blockari's per-line part becomes a
   * per-card-home part.
   */
  xpBase: 150,
  xpRankSpan: 5,
  xpPlayed: 50,
  xpPerScore: 50,
  /** XP per card on the foundations at the end of the game. */
  xpPerCard: 10,
  xpPerLevel: 25,
  xpStreakMin: 4,
  xpStreakBonus: 40,
  xpChallenge: 25,
  xpWin: 100,
  xpPotDivisor: 2,
} as const;

export type Rules = typeof RULES;
