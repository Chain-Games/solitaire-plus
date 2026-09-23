import { describe, expect, it } from 'vitest';
import {
  apply,
  createGame,
  createGameFromDeal,
  dealFor,
  isError,
  openingMask,
  reveal,
  revealsIn,
  seenMask,
  stateHash,
  tick,
  unrevealedSlots,
  moveOf,
} from '../src/index.js';
import { botGame } from './util.js';

describe('hidden information', () => {
  it('the opening mask shows exactly the seven up-cards', () => {
    const deal = dealFor('mask-1');
    const mask = openingMask(deal);
    expect(mask.filter((c) => c !== null).length).toBe(7);
  });

  it('a client on a masked deal stays in lockstep with the server, card by card', () => {
    for (const seed of ['mask-a', 'mask-b', 'mask-c', 'mask-d']) {
      const { moves } = botGame(seed, `bot-${seed}`);
      let server = createGame(seed).state;
      let client = createGameFromDeal(openingMask(dealFor(seed))).state;
      expect(stateHash(client)).toBe(stateHash(server));
      for (const m of moves) {
        server = tick(server, m.tMs - server.elapsedMs).state;
        client = tick(client, m.tMs - client.elapsedMs).state;
        const sr = apply(server, moveOf(m));
        const cr = apply(client, moveOf(m));
        if (isError(sr) || isError(cr)) throw new Error('move refused');
        // The server answers with what the move showed; the client needs exactly that.
        const reveals = revealsIn(server, sr.state);
        server = sr.state;
        expect(unrevealedSlots(cr.state).sort()).toEqual(reveals.map((r) => r.slot).sort());
        client = reveal(cr.state, reveals);
        expect(stateHash(client)).toBe(stateHash(server));
        // The client never holds a card it has not been shown.
        client.deal.forEach((c, s) => {
          if (!client.seen[s]) expect(c).toBeNull();
        });
      }
    }
  });

  it('a resume from the seen mask replays to the same place', () => {
    const { moves, state } = botGame('mask-resume', 'bot');
    const half = moves.slice(0, Math.floor(moves.length / 2));
    let server = createGame('mask-resume').state;
    for (const m of half) {
      server = tick(server, m.tMs - server.elapsedMs).state;
      const r = apply(server, moveOf(m));
      if (isError(r)) throw new Error(r.error);
      server = r.state;
    }
    let client = createGameFromDeal(seenMask(server)).state;
    for (const m of half) {
      client = tick(client, m.tMs - client.elapsedMs).state;
      const r = apply(client, moveOf(m));
      if (isError(r)) throw new Error(r.error);
      client = r.state;
    }
    expect(stateHash(client)).toBe(stateHash(server));
    expect(state.status).toBe('ended');
  });

  it('refuses a move that needs a card this side has not been told', () => {
    const seed = 'mask-refuse';
    const { moves } = botGame(seed, 'bot');
    let client = createGameFromDeal(openingMask(dealFor(seed))).state;
    // Play until a draw shows cards, then try to play from the waste without the reveal.
    for (const m of moves) {
      client = tick(client, m.tMs - client.elapsedMs).state;
      const r = apply(client, moveOf(m));
      if (isError(r)) {
        expect(r.error).toBe('unrevealed');
        return;
      }
      client = r.state;
    }
    throw new Error('expected an unrevealed refusal');
  });

  it('a reveal that contradicts a known card is a desync', () => {
    const s = createGame('mask-x').state;
    expect(() => reveal(s, [{ slot: 0, card: ((s.deal[0] as number) + 1) % 52 }])).toThrow();
  });
});
