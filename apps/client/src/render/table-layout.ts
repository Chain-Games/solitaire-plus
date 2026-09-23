import { CARD_ASPECT } from './card-art.js';
import type { Layout } from './layout.js';

/**
 * Where everything sits on the Klondike table, in CSS px. The table is the
 * plate Blockari puts its board AND hand tray on (layout.ts): the HUD above
 * it is measured against Blockari's, and the table takes the board square
 * plus the hand band below it — a tall slab for seven columns.
 *
 *   top row   stock · waste (fanned to 3) · gap · four foundations
 *   tableau   seven columns; face-down cards overlap by `downStep`, face-up
 *             by `upStep` — enough to read the index band (card-art.ts
 *             INDEX) — and a long column compresses to stay on the plate
 */
export interface TableLayout {
  /** The plate's inner rect: cards never leave it. */
  x: number;
  y: number;
  w: number;
  h: number;
  cardW: number;
  cardH: number;
  /** Column pitch (card + gap). */
  pitch: number;
  /** Top-left of each column's first card, t0..t6. */
  colX: number[];
  topY: number;
  tableauY: number;
  /** Tableau offsets per face-down / face-up card (before any compression). */
  downStep: number;
  upStep: number;
  /** Waste fan: how far each of the top three steps right. */
  fanStep: number;
  stockX: number;
  wasteX: number;
  /** Foundations f0..f3 (C, D, H, S), left to right. */
  foundX: number[];
  /** The bottom edge a column may reach. */
  bottom: number;
  /** Tap / hit targets are never below this (KLONDIKE-BRIEF §6). */
  minHit: number;
}

/** Inner padding between the plate's rim and the cards, of card width. */
const INNER = 0.14;
/** Gap between columns, of card width. */
const GAP = 0.1;
/** Tableau overlap: face-down / face-up, of card height. */
const DOWN_STEP = 0.1;
const UP_STEP = 0.26;
/** A column never compresses its face-up step below this (the rank still reads). */
const UP_STEP_MIN = 0.2;

export function computeTable(L: Layout): TableLayout {
  const x = L.boardX;
  const y = L.boardY;
  const w = L.boardSize;
  const h = L.boardSize + L.handHeight - L.gap * 2;
  // 7 cards + 6 gaps + 2 inner pads, all in card widths.
  const cardW = Math.floor(w / (7 + 6 * GAP + 2 * INNER));
  const cardH = Math.round(cardW * CARD_ASPECT);
  const gap = cardW * GAP;
  const pitch = cardW + gap;
  const inner = (w - (7 * cardW + 6 * gap)) / 2;
  const colX = Array.from({ length: 7 }, (_, i) => Math.round(x + inner + i * pitch));
  const topY = Math.round(y + inner);
  const tableauY = Math.round(topY + cardH + Math.max(gap * 1.6, cardH * 0.16));
  return {
    x,
    y,
    w,
    h,
    cardW,
    cardH,
    pitch,
    colX,
    topY,
    tableauY,
    downStep: Math.round(cardH * DOWN_STEP),
    upStep: Math.round(cardH * UP_STEP),
    fanStep: Math.round(cardW * 0.3),
    stockX: colX[0] ?? x,
    wasteX: colX[1] ?? x,
    foundX: [colX[3] ?? x, colX[4] ?? x, colX[5] ?? x, colX[6] ?? x],
    bottom: Math.round(y + h - inner * 0.6),
    minHit: 44,
  };
}

/**
 * The y of each card in a column (face-down first), compressed so the last
 * card's bottom stays on the plate: the face-up step shrinks first (to
 * UP_STEP_MIN), then the face-down one.
 */
export function columnYs(T: TableLayout, down: number, total: number): number[] {
  const up = total - down;
  let dStep = T.downStep;
  let uStep = T.upStep;
  const room = T.bottom - T.tableauY - T.cardH;
  const need = () => down * dStep + Math.max(0, up - 1) * uStep;
  if (need() > room && up > 1) {
    const minU = Math.round(T.cardH * UP_STEP_MIN);
    uStep = Math.max(minU, Math.floor((room - down * dStep) / (up - 1)));
  }
  if (need() > room && down > 0) {
    dStep = Math.max(2, Math.floor((room - Math.max(0, up - 1) * uStep) / down));
  }
  const ys: number[] = [];
  let yy = T.tableauY;
  for (let i = 0; i < total; i++) {
    ys.push(yy);
    yy += i < down ? dStep : uStep;
  }
  return ys;
}
