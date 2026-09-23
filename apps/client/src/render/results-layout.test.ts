import { describe, expect, it } from 'vitest';
import { computeLayout } from './layout.js';
import {
  PANEL_TOP_MARGIN_PX,
  RESULTS_METRICS,
  TRAY_CLEARANCE_PX,
  endReasonCopy,
  outcomeCopy,
  resultsFit,
  resultsPanelRect,
  rowsStart,
  type FitInput,
} from './results-layout.js';

/** The docked tray's height on a phone: the XP beat, the buttons and the Home link (measured on 390x844, 2026-09-17). */
const TRAY_XP = 311;
/** The same with a rank-up pending: the ceremony's slot is reserved from the first frame (+138: the ceremony reserves 128 px). */
const TRAY_RANKUP = 449;
/** The rank-up tray on a short phone (<= 700 px tall), where the Home link yields its row (measured on 375x667). */
const TRAY_RANKUP_SHORT = 409;
/** Solo: buttons and the Home link only. */
const TRAY_PLAIN = 190;

/** COLOUR LINES (at 0), PIECES PLACED, CLOCK USED — least important first. */
const COLLAPSIBLE = [2, 4, 5] as const;

function input(width: number, height: number, trayH: number, hero: 'plain' | 'outcome'): FitInput {
  const L = computeLayout(width, height, true);
  const P = resultsPanelRect(L);
  return {
    viewportH: height,
    safeTop: 0,
    safeBottom: 0,
    panelY: P.y,
    plateH: P.h,
    B: L.boardSize,
    trayH,
    overlap: P.r,
    hero,
    rows: 7,
    collapsible: COLLAPSIBLE,
  };
}

/** The tray's bottom edge for a fit: the panel's bottom plus the tray past its overlap. */
function trayBottom(i: FitInput, f: ReturnType<typeof resultsFit>): number {
  return i.panelY + f.shift + f.panelH + i.trayH - i.overlap;
}

describe('resultsFit', () => {
  it('leaves a solo result on a tall phone at its natural layout', () => {
    const i = input(390, 844, TRAY_PLAIN, 'plain');
    const f = resultsFit(i);
    expect(f.stage).toBe('natural');
    expect(f.shift).toBe(0);
    expect(f.hidden).toEqual([]);
    expect(f.k).toBe(1);
    expect(f.panelH).toBeGreaterThanOrEqual(i.plateH);
    expect(f.fits).toBe(true);
  });

  it('shifts an outcome with the XP beat up on 390x844 and keeps every row', () => {
    const i = input(390, 844, TRAY_XP, 'outcome');
    const f = resultsFit(i);
    expect(['shift', 'panel']).toContain(f.stage);
    expect(f.shift).toBeLessThan(0);
    expect(f.shift).toBeGreaterThanOrEqual(-(i.panelY - PANEL_TOP_MARGIN_PX));
    expect(f.hidden).toEqual([]);
    expect(f.pitch).toBeCloseTo(RESULTS_METRICS.rowPitch * i.B, 6);
    expect(f.fits).toBe(true);
    expect(trayBottom(i, f)).toBeLessThanOrEqual(844 - TRAY_CLEARANCE_PX + 0.5);
  });

  it('with a rank-up pending on 390x844 shifts to the safe top and tightens the pitch a little, every row kept', () => {
    const i = input(390, 844, TRAY_RANKUP, 'outcome');
    const f = resultsFit(i);
    expect(['shift', 'panel', 'pitch']).toContain(f.stage);
    expect(f.shift).toBe(-(i.panelY - PANEL_TOP_MARGIN_PX));
    expect(f.hidden).toEqual([]);
    expect(f.pitch).toBeGreaterThanOrEqual(RESULTS_METRICS.rowPitchMin * i.B - 1e-6);
    expect(f.k).toBe(1);
    expect(f.fits).toBe(true);
    expect(trayBottom(i, f)).toBeLessThanOrEqual(844 - TRAY_CLEARANCE_PX + 0.5);
  });

  it('a taller tray on 390x844 (rank-up + an error strip) collapses rows in order before touching the hero', () => {
    const i = input(390, 844, TRAY_RANKUP + 60, 'outcome');
    const f = resultsFit(i);
    expect(f.stage).toBe('collapse');
    expect(f.shift).toBe(-(i.panelY - PANEL_TOP_MARGIN_PX));
    expect(f.pitch).toBeGreaterThanOrEqual(RESULTS_METRICS.rowPitchMin * i.B - 1e-6);
    expect(f.pitch).toBeLessThanOrEqual(RESULTS_METRICS.rowPitch * i.B + 1e-6);
    // Never the score, the stake or LEVEL REACHED: only the collapsible rows, in order.
    expect(f.hidden.length).toBeGreaterThan(0);
    expect(f.hidden).toEqual(COLLAPSIBLE.slice(0, f.hidden.length));
    expect(f.k).toBe(1);
    expect(f.vs).toBe(true);
    expect(f.fits).toBe(true);
    expect(trayBottom(i, f)).toBeLessThanOrEqual(844 - TRAY_CLEARANCE_PX + 0.5);
    // A taller one still collapses more rows (in the same order) before the hero tightens.
    const g = resultsFit({ ...i, trayH: TRAY_RANKUP + 110 });
    expect(['collapse', 'hero']).toContain(g.stage);
    expect(g.hidden.length).toBeGreaterThan(f.hidden.length);
    expect(g.hidden).toEqual(COLLAPSIBLE.slice(0, g.hidden.length));
    expect(g.fits).toBe(true);
  });

  it('on 375x667 with a rank-up pending collapses the three rows and the eyebrow, keeping the hero spacing and the VS line', () => {
    const i = input(375, 667, TRAY_RANKUP_SHORT, 'outcome');
    const f = resultsFit(i);
    expect(f.stage).toBe('collapse');
    expect(f.hidden).toEqual([...COLLAPSIBLE]);
    expect(f.eyebrow).toBe(false);
    expect(f.pitch).toBeGreaterThanOrEqual(RESULTS_METRICS.rowPitchMin * i.B - 1e-6);
    expect(f.k).toBe(1);
    expect(f.vs).toBe(true);
    expect(f.fits).toBe(true);
    expect(trayBottom(i, f)).toBeLessThanOrEqual(667 - TRAY_CLEARANCE_PX + 0.5);
    // The panel starts at the safe top's margin.
    expect(i.panelY + f.shift).toBeCloseTo(PANEL_TOP_MARGIN_PX, 6);
  });

  it('on 375x667 without a rank-up keeps the hero at full spacing', () => {
    const i = input(375, 667, TRAY_XP, 'outcome');
    const f = resultsFit(i);
    expect(f.k).toBe(1);
    expect(f.vs).toBe(true);
    expect(f.fits).toBe(true);
    expect(trayBottom(i, f)).toBeLessThanOrEqual(667 - TRAY_CLEARANCE_PX + 0.5);
  });

  it('respects the safe-area insets on both ends', () => {
    const base = input(390, 844, TRAY_RANKUP, 'outcome');
    const i = { ...base, safeTop: 47, safeBottom: 34 };
    const f = resultsFit(i);
    expect(i.panelY + f.shift).toBeGreaterThanOrEqual(47 + PANEL_TOP_MARGIN_PX - 1e-6);
    expect(f.fits).toBe(true);
    expect(trayBottom(i, f)).toBeLessThanOrEqual(844 - 34 - TRAY_CLEARANCE_PX + 0.5);
  });

  it('gives up the eyebrow before the third row, then the hero spacing, then the VS line', () => {
    // Scan the tray's height up from the shifted fit: the stages come in this order and each still fits.
    const base = input(375, 667, TRAY_XP, 'outcome');
    const seen: string[] = [];
    let f = resultsFit(base);
    for (let trayH = TRAY_XP; f.fits; trayH += 4) {
      f = resultsFit({ ...base, trayH });
      if (seen[seen.length - 1] !== f.stage) seen.push(f.stage);
      if (f.stage === 'eyebrow') {
        expect(f.hidden).toEqual(COLLAPSIBLE.slice(0, 2));
        expect(f.eyebrow).toBe(false);
        expect(f.k).toBe(1);
      }
      if (f.stage === 'hero') {
        expect(f.hidden).toEqual([...COLLAPSIBLE]);
        expect(f.eyebrow).toBe(false);
        expect(f.k).toBeLessThan(1);
        expect(f.vs).toBe(true);
      }
      if (f.stage === 'vs') {
        expect(f.vs).toBe(false);
        expect(f.k).toBe(RESULTS_METRICS.heroMin);
      }
    }
    expect(seen).toEqual(['pitch', 'collapse', 'eyebrow', 'collapse', 'hero', 'vs', 'overflow']);
  });

  it('a plain hero has no eyebrow to drop', () => {
    const base = input(375, 667, TRAY_PLAIN, 'plain');
    for (let trayH = TRAY_PLAIN; trayH < 700; trayH += 8) {
      const f = resultsFit({ ...base, trayH });
      expect(f.eyebrow).toBe(true);
      expect(f.stage).not.toBe('eyebrow');
    }
  });

  it('reports overflow honestly when nothing can fit, with everything at its minimum', () => {
    const i = input(375, 480, TRAY_RANKUP, 'outcome');
    const f = resultsFit(i);
    expect(f.stage).toBe('overflow');
    expect(f.fits).toBe(false);
    expect(f.hidden).toEqual([...COLLAPSIBLE]);
    expect(f.k).toBe(RESULTS_METRICS.heroMin);
    expect(f.vs).toBe(false);
    expect(f.eyebrow).toBe(false);
  });

  it('a plain hero never drops a VS line it does not have', () => {
    const i = input(375, 480, TRAY_RANKUP, 'plain');
    const f = resultsFit(i);
    expect(f.vs).toBe(true);
    expect(rowsStart('plain', 1, true)).toBe(RESULTS_METRICS.plain.rows);
    expect(rowsStart('outcome', 1, false)).toBeCloseTo(
      RESULTS_METRICS.outcome.rows - RESULTS_METRICS.vsDrop,
      9,
    );
  });
});

describe('outcomeCopy', () => {
  it('builds the win: YOU WON / +20 $CHAIN / 8,470 vs 5,120 · LV 8 vs LV 4', () => {
    const c = outcomeCopy({
      won: true,
      chain: 20,
      myScore: 8470,
      theirScore: 5120,
      myLevel: 8,
      theirLevel: 4,
    });
    expect(c.title).toBe('YOU WON');
    expect(c.stake).toBe('+20 $CHAIN');
    expect(c.vs).toBe('8,470 vs 5,120 · LV 8 vs LV 4');
  });

  it('builds the loss: YOU LOST / −10 $CHAIN (a real minus)', () => {
    const c = outcomeCopy({ won: false, chain: 10, myScore: 5120, theirScore: 8470 });
    expect(c.title).toBe('YOU LOST');
    expect(c.stake).toBe('−10 $CHAIN');
    expect(c.vs).toBe('5,120 vs 8,470');
  });

  it('has no stake line when nothing was staked', () => {
    expect(outcomeCopy({ won: true, chain: 0, myScore: 1, theirScore: 0 }).stake).toBe('');
  });

  it('names the end reason', () => {
    expect(endReasonCopy('timeout')).toBe("TIME'S UP");
    expect(endReasonCopy('stuck')).toBe('OUT OF MOVES');
    expect(endReasonCopy('forfeit')).toBe('FORFEITED');
    expect(endReasonCopy('forfeit', 'RUN OVER')).toBe('RUN OVER');
  });
});
