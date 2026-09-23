import type { Move } from '@solitaire-plus/sim';

/**
 * The tutorial's game: a seed and the moves played on it, in order, with
 * the captions that narrate them. Found offline by searching seeds for a
 * deck whose first eleven pieces allow the whole arc (script.test.ts
 * replays it through the sim and asserts every beat lands):
 *
 *   0–1  two plain placements               "that is the whole move"
 *   2–3  a column fills and clears          "fill a row or a column"
 *   4–6  three placements prime two rows (a silent beat: the line stays up)
 *   7    the fourth clears both rows        "two lines at once"

 *   8    the next placement clears again   → 2X STREAK
 *   9    and again                          → 3X STREAK
 *   10   a placement that clears nothing   → the streak is gone
 *
 * Nothing about the rules lives here: the sim scores it, the playfield
 * draws it. Changing the seed means re-running the search.
 */
export const TUTORIAL_SEED = 'bd9ae61df73f28bfe50fedb8356103e7';

export type ScriptMove = Move;

export const TUTORIAL_MOVES: readonly ScriptMove[] = [
  { slot: 1, row: 0, col: 0 },
  { slot: 2, row: 3, col: 1 },
  { slot: 0, row: 8, col: 1 },
  { slot: 2, row: 5, col: 2 },
  { slot: 0, row: 1, col: 3 },
  { slot: 1, row: 0, col: 9 },
  { slot: 2, row: 1, col: 6 },
  { slot: 0, row: 2, col: 0 },
  { slot: 1, row: 0, col: 2 },
  { slot: 1, row: 0, col: 4 },
  { slot: 2, row: 2, col: 3 },
];

export interface Beat {
  /** The one line on screen for the beat; null keeps the last one up (a silent, priming beat). */
  caption: string | null;
  /** How many of TUTORIAL_MOVES play under it (the last one is the beat's payoff). */
  moves: number;
  /** Seconds the caption stays after the table has gone quiet. */
  hold: number;
  /** What the beat's last move must do, for the replay test (and the reader). */
  expect: 'place' | 'clear-1' | 'clear-2' | 'streak-2' | 'streak-3' | 'streak-broken' | 'none';
}

export const TUTORIAL_BEATS: readonly Beat[] = [
  {
    caption: 'Drag a piece onto the board. That is the whole move.',
    moves: 2,
    hold: 0.6,
    expect: 'place',
  },
  { caption: 'Fill a row or a column and it clears.', moves: 2, hold: 2.0, expect: 'clear-1' },
  // Three priming placements under the same line: two rows fill up.
  { caption: null, moves: 3, hold: 0, expect: 'place' },
  { caption: 'Two lines at once pays double.', moves: 1, hold: 2.0, expect: 'clear-2' },
  {
    caption: 'Clear again right away and the streak climbs. 2×.',
    moves: 1,
    hold: 2.2,
    expect: 'streak-2',
  },
  { caption: 'Keep it going. 3× — each step pays more.', moves: 1, hold: 2.8, expect: 'streak-3' },
  {
    caption: 'Place without clearing and the streak is gone.',
    moves: 1,
    hold: 1.8,
    expect: 'streak-broken',
  },
  {
    caption: 'Run out of room and the game ends — or the clock does.',
    moves: 0,
    hold: 2.0,
    expect: 'none',
  },
  {
    caption: 'In a challenge, your opponent gets the same pieces. Best score wins.',
    moves: 0,
    hold: 2.6,
    expect: 'none',
  },
];
