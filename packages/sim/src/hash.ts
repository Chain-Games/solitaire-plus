import type { Card } from './cards.js';
import type { GameState } from './game.js';

/**
 * Stable string digest of a state, for golden tests and for the client and
 * server to confirm they reached the same place. FNV-1a over a canonical
 * serialisation; not cryptographic.
 *
 * Only cards that have been seen are hashed, so a client holding a masked deal
 * and the server holding the full deal produce the same hash for the same
 * game (once the client has been told every card it has seen).
 */
export function stateHash(state: GameState): string {
  const cards = state.deal.map((c, s) => (state.seen[s] ? (c === null ? '?' : String(c)) : '-'));
  const parts: string[] = [
    state.stock.join(','),
    state.waste.join(','),
    state.foundations.map((f) => f.join(',')).join('/'),
    state.tableau.map((c) => `${c.down}:${c.slots.join(',')}`).join('/'),
    cards.join(','),
    String(state.score),
    String(state.level),
    String(state.streak),
    String(state.bestStreak),
    String(state.lastScoreMs),
    String(state.foundationPts),
    String(state.revealPts),
    String(state.tableauPts),
    String(state.streakPts),
    String(state.revealed),
    String(state.undo.length),
    String(state.moves),
    String(state.undos),
    String(state.elapsedMs),
    state.status,
    state.breakdown ? String(state.breakdown.total) : '-',
  ];
  return fnv1a(parts.join('|'));
}

/** Digest of a full deal (slot -> card). */
export function deckHash(deal: readonly Card[]): string {
  return fnv1a(deal.join(','));
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
