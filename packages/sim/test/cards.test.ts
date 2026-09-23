import { describe, expect, it } from 'vitest';
import {
  COLUMN_SLOTS,
  INITIAL_UP_SLOTS,
  STOCK_SLOTS,
  cardKey,
  dealFor,
  deckHash,
  hashSeed,
  isRed,
  rankOf,
  suitOf,
} from '../src/index.js';

describe('cards', () => {
  it('encodes suit and rank', () => {
    expect(cardKey(0)).toBe('AC');
    expect(cardKey(12)).toBe('KC');
    expect(cardKey(13)).toBe('AD');
    expect(cardKey(35)).toBe('10H');
    expect(cardKey(51)).toBe('KS');
    expect([0, 13, 26, 39].map(isRed)).toEqual([false, true, true, false]);
    expect(rankOf(24)).toBe(12);
    expect(suitOf(24)).toBe(1);
  });

  it('deals 1..7 cards to the columns and 24 to the stock, every slot once', () => {
    expect(COLUMN_SLOTS.map((c) => c.length)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const all = [...COLUMN_SLOTS.flat(), ...STOCK_SLOTS].sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 52 }, (_, i) => i));
    // Dealt in rounds: the first round is the bottom card of every column.
    expect(COLUMN_SLOTS.map((c) => c[0])).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(INITIAL_UP_SLOTS).toEqual([0, 7, 13, 18, 22, 25, 27]);
  });

  it('shuffles a permutation of 52, reproducibly', () => {
    const a = dealFor('seed-1');
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: 52 }, (_, i) => i));
    expect(dealFor('seed-1')).toEqual(a);
    expect(dealFor('seed-2')).not.toEqual(a);
  });

  it('golden deal', () => {
    // Changing this is a migration: every stored seed would deal differently.
    expect(hashSeed('')).toBe(0x811c9dc5);
    const deal = dealFor('golden');
    expect(deal.slice(0, 10).map(cardKey)).toMatchInlineSnapshot(`
      [
        "8C",
        "6C",
        "3C",
        "10H",
        "8D",
        "2H",
        "8S",
        "5S",
        "9H",
        "4H",
      ]
    `);
    expect(deckHash(deal)).toMatchInlineSnapshot(`"997c452f"`);
  });
});
