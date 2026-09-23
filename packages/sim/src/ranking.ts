/**
 * Head-to-head result. Pure function of two finished games plus when each was
 * submitted, so the server and the client's history screen agree.
 *
 * Order of comparison:
 *   1. higher total score
 *   2. shorter game clock — a cleared game's clock is its clear time; a
 *      timeout or a forfeit counts the full duration (ScoreBreakdown.elapsedMs)
 *   3. earlier submission (wall clock, decided by the server)
 */

export interface RankedEntry {
  readonly score: number;
  readonly elapsedMs: number;
  /** Server wall-clock finish time, ms since epoch. */
  readonly finishedAt: number;
}

export type Outcome = 'a' | 'b';

export function compareEntries(a: RankedEntry, b: RankedEntry): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
  return a.finishedAt - b.finishedAt;
}

/** Which entry wins. Ties are impossible unless both entries are identical, in which case 'a'. */
export function winner(a: RankedEntry, b: RankedEntry): Outcome {
  return compareEntries(a, b) <= 0 ? 'a' : 'b';
}

export type Margin =
  | { readonly by: 'score'; readonly amount: number }
  | { readonly by: 'time'; readonly amountMs: number }
  | { readonly by: 'submission' };

/** What separated the winner from the loser, for result copy. */
export function margin(win: RankedEntry, lose: RankedEntry): Margin {
  if (win.score !== lose.score) return { by: 'score', amount: win.score - lose.score };
  if (win.elapsedMs !== lose.elapsedMs)
    return { by: 'time', amountMs: lose.elapsedMs - win.elapsedMs };
  return { by: 'submission' };
}
