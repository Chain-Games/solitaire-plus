import { Rng } from './rng.js';

/**
 * A card is an integer 0..51: suit * 13 + (rank - 1).
 * Suits in canonical order C, D, H, S; ranks 1 (A) .. 13 (K).
 * Foundation f<n> holds suit n only.
 */
export type Card = number;

export const SUITS = ['C', 'D', 'H', 'S'] as const;
export type Suit = 0 | 1 | 2 | 3;

export const RANK_LABELS = [
  'A',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
] as const;

export function card(suit: Suit, rank: number): Card {
  return suit * 13 + (rank - 1);
}

export function suitOf(c: Card): Suit {
  return Math.floor(c / 13) as Suit;
}

/** 1 (A) .. 13 (K). */
export function rankOf(c: Card): number {
  return (c % 13) + 1;
}

export function isRed(c: Card): boolean {
  const s = suitOf(c);
  return s === 1 || s === 2;
}

/** "AS", "10H", "KC" — the notpeter Vector-Playing-Cards file stem. */
export function cardKey(c: Card): string {
  return `${RANK_LABELS[rankOf(c) - 1]}${SUITS[suitOf(c)]}`;
}

/**
 * The deal: slot -> card. A slot is a physical position in the original
 * deal, and it is what piles hold, so a client can play with slots whose
 * cards it has not been told yet.
 *
 *   slots 0..27   tableau, dealt the way a person deals: round r (0..6) puts
 *                 one card on each column c >= r, left to right. Column c's
 *                 slots, bottom to top, are its cards from rounds 0..c.
 *   slots 28..51  the stock, bottom to top (slot 51 is drawn first).
 *
 * The shuffle is Fisher-Yates over the canonical order, walking down from 51,
 * drawing j from Rng(seed).int(i + 1).
 */
export function dealFor(seed: string): Card[] {
  const rng = new Rng(seed);
  const deck: Card[] = [];
  for (let c = 0; c < 52; c++) deck.push(c);
  for (let i = 51; i > 0; i--) {
    const j = rng.int(i + 1);
    const a = deck[i] as Card;
    deck[i] = deck[j] as Card;
    deck[j] = a;
  }
  return deck;
}

/** Tableau slots per column, bottom to top, per the dealing order above. */
export const COLUMN_SLOTS: readonly (readonly number[])[] = (() => {
  const cols: number[][] = [[], [], [], [], [], [], []];
  let slot = 0;
  for (let round = 0; round < 7; round++) {
    for (let c = round; c < 7; c++) {
      (cols[c] as number[]).push(slot++);
    }
  }
  return cols;
})();

export const STOCK_SLOTS: readonly number[] = Array.from({ length: 24 }, (_, i) => 28 + i);

/** The seven slots face up at the start: the top of each column. */
export const INITIAL_UP_SLOTS: readonly number[] = COLUMN_SLOTS.map(
  (col) => col[col.length - 1] as number,
);
