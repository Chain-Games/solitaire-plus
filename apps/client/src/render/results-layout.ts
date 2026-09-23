import type { Layout } from './layout.js';
import { formatScore } from '../share/layout.js';

/**
 * The results panel's vertical layout as pure numbers, so the scene and the
 * shell agree and it can be unit-tested without a renderer:
 *
 *   - `RESULTS_METRICS`: where each line of the panel sits, in fractions of
 *     the board size (the layout's unit), for the plain hero (title, score,
 *     best line, rows) and the OUTCOME hero (eyebrow, banner, score, stake,
 *     vs, rows);
 *   - `resultsFit()`: the compression order when the panel plus the shell's
 *     docked tray would not fit the viewport — shift up, tighten the rows'
 *     pitch, collapse the least important rows, tighten the hero's spacing,
 *     drop the VS line — never the score, the outcome, the stake line, LEVEL
 *     REACHED or the tray;
 *   - `outcomeCopy()`: the outcome hero's strings.
 */

/** Breakdown rows sit this fraction of the board size in from the board's edges. */
export const ROW_INSET = 0.14;

/**
 * The results panel's rectangle in canvas CSS px for a layout: the plate plus
 * 16 px, under the pushed-in table transform (scale 0.98/0.92 about the
 * centre, +10 px). The shell docks its button tray to this edge, so the two
 * must agree; the scene draws the panel from the same numbers (its height
 * may grow for the content or shrink under `resultsFit`).
 */
export function resultsPanelRect(L: Layout): {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  /** Breakdown column inset from the panel's edge (labels start, values end here). */
  inset: number;
} {
  const cx = L.boardX + L.boardSize / 2;
  const pad = L.gap * 3 + 16;
  const x0 = cx + (L.boardX - pad - cx) * 0.98;
  const x1 = cx + (L.boardX + L.boardSize + pad - cx) * 0.98;
  const cyB = L.boardY + L.boardSize / 2;
  const y0 = cyB + 10 + (L.boardY - pad - cyB) * 0.92;
  const y1 = cyB + 10 + (L.boardY + L.boardSize + pad - cyB) * 0.92;
  return {
    x: x0,
    y: y0,
    w: x1 - x0,
    h: y1 - y0,
    r: L.cell * 0.4,
    inset: L.boardX + L.boardSize * ROW_INSET - x0,
  };
}

/** Vertical metrics of the results panel, as fractions of the board size. */
export const RESULTS_METRICS = {
  /** Plain results (solo, a forfeit, a creator waiting): title, rule, score, best line, rows. */
  plain: { title: 0.12, score: 0.26, best: 0.365, rows: 0.44 },
  /** Outcome results: the end reason as an eyebrow, the banner, score, stake line, vs line, rows. */
  outcome: { eyebrow: 0.07, banner: 0.165, score: 0.31, stake: 0.43, vs: 0.505, rows: 0.575 },
  /** Breakdown rows' pitch, natural and the tightest they go. */
  rowPitch: 0.075,
  rowPitchMin: 0.055,
  /** From the last row's centre to the panel's bottom edge. */
  bottom: 0.065,
  /** The hero block's spacing may tighten to this factor before the VS line goes. */
  heroMin: 0.8,
  /** Dropping the VS line shortens the outcome hero by this (the stake's descent keeps clear of the first row). */
  vsDrop: 0.05,
  /** Dropping the eyebrow lifts the outcome hero (banner, score, stake, vs, rows) by this. */
  eyebrowDrop: 0.06,
} as const;

/** The docked tray keeps this much clearance above the safe-area inset, and the panel this much under the safe top. */
export const TRAY_CLEARANCE_PX = 12;
export const PANEL_TOP_MARGIN_PX = 12;

export type HeroKind = 'plain' | 'outcome';

export interface FitInput {
  /** Viewport height in CSS px, and the safe-area insets. */
  viewportH: number;
  safeTop: number;
  safeBottom: number;
  /** The panel's natural (unshifted) top and its plate-derived height (`resultsPanelRect`). */
  panelY: number;
  plateH: number;
  /** Board size: the layout's unit. */
  B: number;
  /** The docked tray's full height; it overlaps the panel's bottom edge by `overlap` (the panel's radius). */
  trayH: number;
  overlap: number;
  hero: HeroKind;
  /** Breakdown rows in use, and the indices that may collapse, least important first. */
  rows: number;
  collapsible: readonly number[];
}

export type FitStage =
  'natural' | 'shift' | 'panel' | 'pitch' | 'collapse' | 'eyebrow' | 'hero' | 'vs' | 'overflow';

export interface Fit {
  /** Vertical shift of the whole ceremony (<= 0). */
  shift: number;
  /** Row pitch in px. */
  pitch: number;
  /** Row indices collapsed (hidden), in collapse order. */
  hidden: readonly number[];
  /** Hero spacing factor (1 = natural, down to `heroMin`). */
  k: number;
  /** Whether the outcome hero keeps its VS line, and its eyebrow (the end reason). */
  vs: boolean;
  eyebrow: boolean;
  /** The panel's height in px after the fit. */
  panelH: number;
  /** Where the first row's centre sits below the panel's top, in px. */
  rowsY: number;
  /** Whether the tray's bottom clears the safe area. */
  fits: boolean;
  /** The last compression stage that was needed. */
  stage: FitStage;
}

/** Where the rows start below the panel's top, in board units, for a hero at spacing `k`. */
export function rowsStart(hero: HeroKind, k: number, vs: boolean, eyebrow = true): number {
  const m = RESULTS_METRICS;
  if (hero === 'plain') return m.plain.rows * k;
  return m.outcome.rows * k - (vs ? 0 : m.vsDrop) - (eyebrow ? 0 : m.eyebrowDrop);
}

/** The panel's content height in px: hero, the rows shown at `pitch`, the bottom pad. */
function contentH(
  i: FitInput,
  pitch: number,
  shown: number,
  k: number,
  vs: boolean,
  eyebrow = true,
): number {
  return (
    rowsStart(i.hero, k, vs, eyebrow) * i.B +
    Math.max(0, shown - 1) * pitch +
    RESULTS_METRICS.bottom * i.B
  );
}

/**
 * The compression order. Each stage is tried only when the one before it
 * still overflows; the result is the first that fits, or everything minimal
 * with `fits: false`.
 */
export function resultsFit(i: FitInput): Fit {
  const m = RESULTS_METRICS;
  const P = m.rowPitch * i.B;
  const Pmin = m.rowPitchMin * i.B;
  // The panel's bottom edge may reach this far down.
  const limit = i.viewportH - i.safeBottom - TRAY_CLEARANCE_PX - (i.trayH - i.overlap);
  const maxShift = Math.max(0, i.panelY - i.safeTop - PANEL_TOP_MARGIN_PX);
  const make = (
    stage: FitStage,
    shift: number,
    pitch: number,
    hidden: readonly number[],
    k: number,
    vs: boolean,
    eyebrow: boolean,
  ): Fit => {
    const shown = i.rows - hidden.length;
    const content = contentH(i, pitch, shown, k, vs, eyebrow);
    // Natural and shifted fits keep the plate's panel; a compressed one is the content's.
    const panelH = stage === 'natural' || stage === 'shift' ? Math.max(i.plateH, content) : content;
    return {
      shift,
      pitch,
      hidden,
      k,
      vs,
      eyebrow,
      panelH,
      rowsY: rowsStart(i.hero, k, vs, eyebrow) * i.B,
      fits: i.panelY + shift + panelH <= limit + 0.5,
      stage,
    };
  };

  // Natural: the plate's panel (or the content, if taller), no shift.
  const naturalH = Math.max(i.plateH, contentH(i, P, i.rows, 1, true));
  if (i.panelY + naturalH <= limit) return make('natural', 0, P, [], 1, true, true);
  // Shift the ceremony and the tray up together (whole px, so the clearance
  // never rounds under), never past the safe top.
  const shift = -Math.min(maxShift, Math.ceil(i.panelY + naturalH - limit));
  if (i.panelY + shift + naturalH <= limit) return make('shift', shift, P, [], 1, true, true);
  // The panel gives up the plate's spare below the rows.
  const fullShift = -maxShift;
  const top = i.panelY + fullShift;
  const avail = limit - top;
  if (contentH(i, P, i.rows, 1, true) <= avail)
    return make('panel', fullShift, P, [], 1, true, true);
  // Tighten the rows' pitch toward the minimum.
  const pitchFor = (shown: number, k: number, vs: boolean, eyebrow: boolean): number =>
    shown > 1
      ? (avail - rowsStart(i.hero, k, vs, eyebrow) * i.B - m.bottom * i.B) / (shown - 1)
      : Number.POSITIVE_INFINITY;
  let need = pitchFor(i.rows, 1, true, true);
  if (need >= Pmin) return make('pitch', fullShift, Math.min(P, need), [], 1, true, true);
  // Collapse the least important rows, one at a time (the pitch relaxes back
  // toward natural); the outcome hero gives up its eyebrow before the third
  // row goes — at a 12 px panel top it only shares the chrome's row.
  const hidden: number[] = [];
  let eyebrow = true;
  for (const idx of i.collapsible) {
    if (hidden.length === 2 && eyebrow && i.hero === 'outcome') {
      eyebrow = false;
      need = pitchFor(i.rows - hidden.length, 1, true, false);
      if (need >= Pmin)
        return make('eyebrow', fullShift, Math.min(P, need), [...hidden], 1, true, false);
    }
    hidden.push(idx);
    need = pitchFor(i.rows - hidden.length, 1, true, eyebrow);
    if (need >= Pmin)
      return make('collapse', fullShift, Math.min(P, need), [...hidden], 1, true, eyebrow);
  }
  if (eyebrow && i.hero === 'outcome') {
    eyebrow = false;
    need = pitchFor(i.rows - hidden.length, 1, true, false);
    if (need >= Pmin)
      return make('eyebrow', fullShift, Math.min(P, need), [...hidden], 1, true, false);
  }
  const shown = i.rows - hidden.length;
  // Tighten the hero's spacing, in steps, down to its floor.
  for (let k = 0.95; k >= m.heroMin - 1e-9; k -= 0.05) {
    if (pitchFor(shown, k, true, eyebrow) >= Pmin)
      return make('hero', fullShift, Pmin, [...hidden], k, true, eyebrow);
  }
  // The outcome hero drops its VS line last.
  if (i.hero === 'outcome' && pitchFor(shown, m.heroMin, false, eyebrow) >= Pmin)
    return make('vs', fullShift, Pmin, [...hidden], m.heroMin, false, eyebrow);
  const vs = i.hero !== 'outcome';
  return make('overflow', fullShift, Pmin, [...hidden], m.heroMin, vs, eyebrow);
}

// ---------------------------------------------------------------------------
// Outcome copy

/** A settled challenge as the results scene needs it (the shell maps the API's ChallengeView to this). */
export interface ResultsOutcome {
  won: boolean;
  /** $CHAIN won (the payout) or lost (the stake); 0 for a challenge with nothing staked. */
  chain: number;
  myScore: number;
  theirScore: number;
  /** In-match levels reached, when both are known. */
  myLevel?: number | undefined;
  theirLevel?: number | undefined;
}

export interface OutcomeCopy {
  /** "YOU WON" / "YOU LOST". */
  title: string;
  /** "+20 $CHAIN" / "−10 $CHAIN" (a real minus sign); empty with nothing staked. */
  stake: string;
  /** "8,470 vs 5,120 · LV 8 vs LV 4"; the levels only when both are known. */
  vs: string;
}

export function outcomeCopy(o: ResultsOutcome): OutcomeCopy {
  const title = o.won ? 'YOU WON' : 'YOU LOST';
  const stake = o.chain > 0 ? `${o.won ? '+' : '−'}${formatScore(o.chain)} $CHAIN` : '';
  const levels =
    o.myLevel !== undefined && o.theirLevel !== undefined
      ? ` · LV ${o.myLevel} vs LV ${o.theirLevel}`
      : '';
  const vs = `${formatScore(o.myScore)} vs ${formatScore(o.theirScore)}${levels}`;
  return { title, stake, vs };
}

/** The end reason as the panel's headline (plain) or eyebrow (outcome). */
export function endReasonCopy(
  endReason: 'timeout' | 'stuck' | 'forfeit' | string,
  forfeitTitle?: string,
): string {
  return endReason === 'stuck'
    ? 'OUT OF MOVES'
    : endReason === 'forfeit'
      ? (forfeitTitle ?? 'FORFEITED')
      : "TIME'S UP";
}
