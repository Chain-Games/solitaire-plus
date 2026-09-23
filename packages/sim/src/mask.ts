import { INITIAL_UP_SLOTS, type Card } from './cards.js';
import type { GameEvent } from './events.js';
import type { GameState } from './game.js';

/**
 * Hidden information. In a staked game the seed never leaves the server: it
 * is the answer key to every face-down card and the whole stock. A client
 * gets a masked deal (only the cards it has been shown) and learns each new
 * face from the server when the move that shows it is verified.
 */

/** The opening deal a client may see: the seven up-cards, everything else null. */
export function openingMask(deal: readonly Card[]): (Card | null)[] {
  const out = new Array<Card | null>(52).fill(null);
  for (const s of INITIAL_UP_SLOTS) out[s] = deal[s] ?? null;
  return out;
}

/** The deal masked to what this game has shown so far (for a resume). */
export function seenMask(state: GameState): (Card | null)[] {
  return state.deal.map((c, s) => (state.seen[s] ? c : null));
}

/**
 * The cards a transition showed for the first time: the server sends these
 * back with the move that caused them. Reads the full deal from `after`.
 */
export function revealsIn(
  before: GameState,
  after: GameState,
): { readonly slot: number; readonly card: Card }[] {
  const out: { slot: number; card: Card }[] = [];
  for (let s = 0; s < 52; s++) {
    if (after.seen[s] && !before.seen[s]) {
      const card = after.deal[s];
      if (card !== null && card !== undefined) out.push({ slot: s, card });
    }
  }
  return out;
}

/** True if any event in a transition turned a never-seen card face up. */
export function showsNewCards(before: GameState, events: readonly GameEvent[]): boolean {
  for (const e of events) {
    if (e.type === 'flipped' && !before.seen[e.slot]) return true;
    if (e.type === 'drew' && e.slots.some((s) => !before.seen[s])) return true;
  }
  return false;
}
