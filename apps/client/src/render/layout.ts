/**
 * Blockari's grid and hand counts, kept as the layout's units: the HUD, the
 * effects and the results panel are sized in board cells, and the HUD row is
 * measured against Blockari's for parity (≤ 4 px). The Klondike table fills
 * the board square AND the hand band below it (table-layout.ts).
 */
const BOARD_COLS = 10;
const HAND_SLOTS = 3;

/**
 * Responsive layout. One vertical stack — HUD, board, hand — sized from the
 * viewport so the board is as large as possible while the hand stays
 * reachable with a thumb. All values in CSS pixels.
 */
export interface Layout {
  width: number;
  height: number;
  cell: number;
  /** Gap between cells. */
  gap: number;
  boardX: number;
  boardY: number;
  boardSize: number;
  hudY: number;
  hudHeight: number;
  handY: number;
  handHeight: number;
  /** Cell size used to draw pieces in the hand (smaller than the board's). */
  handCell: number;
  /** Centre x of each hand slot. */
  handSlotX: number[];
  /** Width of one hand slot tray. */
  handSlotW: number;
  /** Vertical offset applied to a dragged piece so the finger doesn't hide it. */
  dragLift: number;
  compact: boolean;
}

/**
 * Room the stack leaves for the tutorial's narration (tutorial/Guide.tsx):
 * `top` is a band between the HUD and the board (portrait: the caption and
 * its button sit there), `bottom` is kept clear under the hand (landscape:
 * the caption row at the foot). Both 0 in play.
 */
export interface LayoutInset {
  top: number;
  bottom: number;
}

export const NO_INSET: LayoutInset = { top: 0, bottom: 0 };

export function computeLayout(
  width: number,
  height: number,
  coarsePointer: boolean,
  inset: LayoutInset = NO_INSET,
): Layout {
  const compact = width < 600;
  const pad = compact ? 16 : 24;
  const chromeStrip = compact ? 56 : 0;
  const insetTop = Math.max(0, inset.top);
  const insetBottom = Math.max(0, inset.bottom);
  // Compact: the level pill docks under the score digits (12 + 40 of digits
  // + 10 + the ~25 px pill = 87, so its bottom clears the plate's rim band,
  // 12 px up from the board at gap 4, by ≥ 10 px), so the HUD takes its
  // height; the board is width-bound on a phone and the extra comes out of
  // the spare below the hand. The mode pill sits beside it on the same
  // centre line (playfield.ts placeModePill).
  // Desktop: the streak pill's ring reaches ~76 px into the band and the
  // plate's rim starts 18 px above the board (gap × 3 at 640), so 88 px put
  // the ring on the rim; 112 keeps ~18 px of sky between them (measured at
  // 1808×1050: ring bottom 128, clock bar 132, rim 146).
  const hudHeight = compact ? 110 : 112;
  const handHeight = compact ? Math.max(128, Math.min(180, height * 0.21)) : 200;
  const availW = width - pad * 2;
  const availH = height - chromeStrip - hudHeight - handHeight - pad * 2 - insetTop - insetBottom;
  const boardSize = Math.max(120, Math.floor(Math.min(availW, availH, 640)));
  const gap = Math.max(2, Math.round(boardSize / 100));
  const cell = (boardSize - gap * (BOARD_COLS - 1)) / BOARD_COLS;

  // Phone: HUD sits right under the chrome buttons and the board is centred
  // in what remains. Desktop: centre the whole stack.
  const stackH = hudHeight + insetTop + boardSize + handHeight;
  let hudY: number;
  let handCellBoost = 0;
  let handH = handHeight;
  if (compact) {
    // Spare height: at most 48 px stays below the hand (thumb zone); the rest
    // grows the hand area (up to +80 px) and only then pads above the HUD.
    hudY = chromeStrip + pad * 0.5;
    const spare = Math.max(0, height - insetBottom - hudY - stackH - pad);
    const below = Math.min(48, spare);
    let left = spare - below;
    const grow = Math.min(80, left, Math.max(0, 202 - handHeight)); // trays max ~150 px
    handH += grow;
    left -= grow;
    handCellBoost = grow;
    hudY += left;
  } else {
    hudY = Math.max(pad, (height - insetBottom - stackH) / 2);
  }

  const boardX = (width - boardSize) / 2;
  const boardY = hudY + hudHeight + insetTop;
  const handY = boardY + boardSize;
  const handCellCap = compact ? Math.min(0.85, 0.72 + handCellBoost / 400) : 0.78;
  const handCell = Math.max(
    compact ? 28 : 34,
    Math.min(cell * handCellCap, (handHeight + handCellBoost - 40) / 5.2),
  );
  const handSlotW = boardSize / HAND_SLOTS;
  const handSlotX = Array.from(
    { length: HAND_SLOTS },
    (_, i) => boardX + handSlotW * (i + 0.5),
  );

  return {
    width,
    height,
    cell,
    gap,
    boardX,
    boardY,
    boardSize,
    hudY,
    hudHeight,
    handY,
    handHeight: handH,
    handCell,
    handSlotX,
    handSlotW,
    dragLift: coarsePointer ? cell * 2.2 : cell * 0.5,
    compact,
  };
}

/**
 * The lowest edge of the HUD's readouts — the streak pill's pressure ring
 * (centre hudY + 48, ring ~26 px below it on compact, ~29 on desktop) and
 * the compact level and mode pills under the score and clock (they end near
 * hudY + 83) — in CSS px from the top. The tutorial's caption hangs under it.
 */
export function hudBottomOf(L: Layout): number {
  return L.hudY + (L.compact ? 84 : 78);
}

export function cellToXY(l: Layout, r: number, c: number): { x: number; y: number } {
  return { x: l.boardX + c * (l.cell + l.gap), y: l.boardY + r * (l.cell + l.gap) };
}
