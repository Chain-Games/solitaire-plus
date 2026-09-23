import { describe, expect, it } from 'vitest';
import {
  RULES,
  apply,
  autoTarget,
  canMove,
  forfeit,
  isError,
  tick,
  type GameState,
  type PileId,
  type Suit,
} from '../src/index.js';
import { c, layout, mustApply } from './util.js';

const SUIT_KEYS = ['C', 'D', 'H', 'S'] as const;
const RANK_KEYS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
const key = (suit: number, rank: number): string => `${RANK_KEYS[rank - 1]}${SUIT_KEYS[suit]}`;
const red = (suit: number): boolean => suit === 1 || suit === 2;

describe('tableau builds down in alternating colours', () => {
  it('every pair of cards: legal exactly when one lower and opposite colour', () => {
    for (let ts = 0; ts < 4; ts++)
      for (let tr = 1; tr <= 13; tr++)
        for (let ms = 0; ms < 4; ms++)
          for (let mr = 1; mr <= 13; mr++) {
            if (ts === ms && tr === mr) continue;
            const s = layout({ tableau: [[key(ts, tr)], [key(ms, mr)]] });
            const expected = tr === mr + 1 && red(ts) !== red(ms);
            expect(canMove(s, 't1', 't0', 1), `${key(ms, mr)} onto ${key(ts, tr)}`).toBe(expected);
          }
  });

  it('only a king goes on an empty column', () => {
    for (let r = 1; r <= 13; r++) {
      const s = layout({ tableau: [[], [key(0, r)]] });
      expect(canMove(s, 't1', 't0', 1)).toBe(r === 13);
    }
  });

  it('moves a valid run as a unit and refuses an invalid one', () => {
    const s = layout({
      tableau: [['_2C', '9H', '8S', '7H'], ['10S'], ['10C'], ['_3C', '9C', '8S']],
    });
    expect(canMove(s, 't0', 't1', 3)).toBe(true); // 9H 8S 7H onto 10S
    expect(canMove(s, 't0', 't1', 2)).toBe(false); // 8S 7H onto 10S
    expect(canMove(s, 't3', 't2', 2)).toBe(false); // 9C 8S is not alternating
    const after = mustApply(s, { t: 'mv', from: 't0', to: 't1', n: 3 });
    expect(after.tableau[1]?.slots.length).toBe(4);
    expect(after.tableau[0]?.down).toBe(0); // 2C turned up
  });

  it('never picks up face-down cards', () => {
    const s = layout({ tableau: [['_9H', '8S'], ['10S']] });
    expect(canMove(s, 't0', 't1', 2)).toBe(false);
    const r = apply(s, { t: 'mv', from: 't0', to: 't1', n: 2 });
    expect(isError(r) && r.error).toBe('not-face-up');
  });
});

describe('foundations build up by suit from the ace', () => {
  it('every card onto every foundation height', () => {
    for (let fs = 0; fs < 4; fs++)
      for (let h = 0; h < 13; h++)
        for (let ms = 0; ms < 4; ms++)
          for (let mr = 1; mr <= 13; mr++) {
            if (ms === fs && mr <= h) continue; // that card is already home
            const home: [number, number, number, number] = [0, 0, 0, 0];
            home[fs] = h;
            const s = layout({ home, tableau: [[key(ms, mr)]] });
            const to = `f${fs}` as PileId;
            expect(canMove(s, 't0', to, 1), `${key(ms, mr)} onto f${fs}@${h}`).toBe(
              ms === fs && mr === h + 1,
            );
          }
  });

  it('takes one card at a time, never a run', () => {
    const s = layout({ home: [1, 0, 0, 0], tableau: [['3H', '2C']] });
    expect(canMove(s, 't0', 'f0', 1)).toBe(true);
    expect(canMove(s, 't0', 'f0', 2)).toBe(false);
  });

  it('lets a card come back down to the tableau, at a cost', () => {
    const s = layout({ home: [0, 0, 5, 0], tableau: [['6S']] });
    expect(canMove(s, 'f2', 't0', 1)).toBe(true);
    const after = mustApply(s, { t: 'mv', from: 'f2', to: 't0', n: 1 });
    expect(after.score).toBe(RULES.foundationReturnPoints);
    expect(after.foundations[2]?.length).toBe(4);
  });

  it('never foundation to foundation', () => {
    const s = layout({ home: [1, 0, 0, 0] });
    expect(canMove(s, 'f0', 'f1', 1)).toBe(false);
  });
});

describe('waste', () => {
  it('plays only its top card', () => {
    const s = layout({ waste: ['AC', '5D', 'AH'], tableau: [['6C']] });
    expect(canMove(s, 'waste', 'f2', 1)).toBe(true);
    expect(canMove(s, 'waste', 't0', 1)).toBe(false);
    expect(canMove(s, 'waste', 'f0', 1)).toBe(false);
    expect(canMove(s, 'waste', 't0', 2)).toBe(false);
  });
});

describe('the stock', () => {
  const stock = ['2C', '3C', '4C', '5C', '6C', '7C', '8C'];

  it('draws one at a time, then recycles in order, repeatedly', () => {
    expect(RULES.drawCount).toBe(1);
    let s = layout({ stock });
    const top = (st: GameState) => st.deal[st.waste[st.waste.length - 1] as number];
    s = mustApply(s, { t: 'draw' }); // 8C, the stock's top
    expect(s.waste.length).toBe(1);
    expect(top(s)).toBe(c('8C'));
    for (let i = 0; i < 6; i++) s = mustApply(s, { t: 'draw' });
    expect(s.waste.length).toBe(7);
    expect(s.stock.length).toBe(0);
    expect(top(s)).toBe(c('2C'));
    const firstPass = s.waste.slice();
    s = mustApply(s, { t: 'draw' }); // recycle
    expect(s.waste.length).toBe(0);
    expect(s.stock.length).toBe(7);
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < 7; i++) s = mustApply(s, { t: 'draw' });
      expect(s.waste).toEqual(firstPass);
      s = mustApply(s, { t: 'draw' });
    }
  });

  it('draws the last card when one remains', () => {
    let s = layout({ stock: ['2C'] });
    s = mustApply(s, { t: 'draw' });
    expect(s.waste.length).toBe(1);
    expect(s.stock.length).toBe(0);
    expect(s.deal[s.waste[0] as number]).toBe(c('2C'));
  });

  it('refuses with nothing in the stock or the waste', () => {
    const r = apply(layout({}), { t: 'draw' });
    expect(isError(r) && r.error).toBe('empty');
  });
});

describe('turning cards up', () => {
  it('turns the exposed card up as part of the move, and scores it', () => {
    const s = layout({ tableau: [['_KD', '_2S', 'AH']] });
    const after = mustApply(s, { t: 'mv', from: 't0', to: 'f2', n: 1 });
    expect(after.tableau[0]?.down).toBe(1);
    expect(after.revealed).toBe(1);
    expect(after.score).toBe(RULES.foundationPoints + RULES.revealPoints);
  });
});

describe('tap to place', () => {
  it('prefers the foundation, then the first legal column left to right', () => {
    const s = layout({ home: [0, 0, 1, 0], tableau: [['9C'], ['9S'], ['2H', '8H']] });
    expect(autoTarget(s, 't2', 1)).toEqual({ t: 'mv', from: 't2', to: 't0', n: 1 });
    const s2 = layout({ home: [0, 0, 1, 0], tableau: [['3S'], ['2H']] });
    expect(autoTarget(s2, 't1', 1)).toEqual({ t: 'mv', from: 't1', to: 'f2', n: 1 });
    expect(autoTarget(layout({ tableau: [['2H']] }), 't0', 1)).toBeNull();
  });
});

describe('scoring', () => {
  it('waste to tableau', () => {
    const s = mustApply(layout({ waste: ['8H'], tableau: [['9S']] }), {
      t: 'mv',
      from: 'waste',
      to: 't0',
      n: 1,
    });
    expect(s.score).toBe(RULES.wastePoints);
    expect(s.streak).toBe(0);
  });

  it('tableau to tableau with nothing turned up scores nothing', () => {
    const s = mustApply(layout({ tableau: [['8H'], ['9S']] }), {
      t: 'mv',
      from: 't0',
      to: 't1',
      n: 1,
    });
    expect(s.score).toBe(0);
  });

  it('a card bounced down and back up nets a loss', () => {
    let s = layout({ home: [0, 0, 5, 0], tableau: [['6S']] });
    s = mustApply(s, { t: 'mv', from: 'f2', to: 't0', n: 1 });
    s = mustApply(s, { t: 'mv', from: 't0', to: 'f2', n: 1 });
    expect(s.score).toBe(RULES.foundationReturnPoints + RULES.foundationPoints);
    expect(s.score).toBeLessThan(0);
    // The in-play score may dip below 0; the result never does.
    expect(forfeit(s).state.breakdown?.total).toBe(0);
  });
});

describe('streak', () => {
  const home = (s: GameState, from: PileId, suit: Suit) =>
    mustApply(s, { t: 'mv', from, to: `f${suit}` as PileId, n: 1 });

  it('grows while scoring moves come within the window, and pays each step', () => {
    let s = layout({ tableau: [['4C', '3C', '2C', 'AC']] });
    s = home(s, 't0', 0);
    expect(s.streak).toBe(1);
    s = tick(s, RULES.streakWindowMs).state; // exactly on the window: still alive
    s = home(s, 't0', 0);
    expect(s.streak).toBe(2);
    s = tick(s, 1000).state;
    s = home(s, 't0', 0);
    expect(s.streak).toBe(3);
    expect(s.streakPts).toBe(RULES.streakStep * (1 + 2));
    expect(s.score).toBe(3 * RULES.foundationPoints + RULES.streakStep * 3);
    expect(s.bestStreak).toBe(3);
  });

  it('breaks when the window runs out', () => {
    let s = home(layout({ tableau: [['2C', 'AC']] }), 't0', 0);
    const t = tick(s, RULES.streakWindowMs + 1);
    expect(t.events).toContainEqual({ type: 'streakBroken', length: 1 });
    s = home(t.state, 't0', 0);
    expect(s.streak).toBe(1);
  });

  it('breaks on a draw, and on a card taken off a foundation', () => {
    let s = home(layout({ tableau: [['AC']], stock: ['5D'] }), 't0', 0);
    s = mustApply(s, { t: 'draw' });
    expect(s.streak).toBe(0);
    let r = home(layout({ home: [0, 0, 0, 3], tableau: [['2C', 'AC'], ['4D']] }), 't0', 0);
    r = mustApply(r, { t: 'mv', from: 'f3', to: 't1', n: 1 });
    expect(r.streak).toBe(0);
  });

  it('breaks on a plain tableau move or a waste play', () => {
    let s = home(layout({ tableau: [['AC'], ['8H'], ['9S']], waste: ['7C'] }), 't0', 0);
    expect(s.streak).toBe(1);
    s = mustApply(s, { t: 'mv', from: 't1', to: 't2', n: 1 });
    expect(s.streak).toBe(0);
    s = home(layout({ tableau: [['AC'], ['8H']], waste: ['7C'] }), 't0', 0);
    s = mustApply(s, { t: 'mv', from: 'waste', to: 't1', n: 1 });
    expect(s.streak).toBe(0);
  });

  it('a move that both sends a card home and turns one up is one step', () => {
    let s = layout({ tableau: [['_9D', '2C', 'AC']] });
    s = home(s, 't0', 0);
    s = home(s, 't0', 0);
    expect(s.streak).toBe(2);
    expect(s.score).toBe(2 * RULES.foundationPoints + RULES.revealPoints + RULES.streakStep);
  });

  it('the step stops growing at the cap', () => {
    const cards = ['K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2', 'A'].map(
      (r) => `${r}C`,
    );
    let s = layout({ tableau: [cards] });
    for (let i = 0; i < 13; i++) s = home(s, 't0', 0);
    expect(s.streak).toBe(13);
    const cap = RULES.streakCap - 1;
    const steps = Array.from({ length: 12 }, (_, i) => Math.min(i + 1, cap));
    expect(s.streakPts).toBe(RULES.streakStep * steps.reduce((a, b) => a + b, 0));
  });
});

describe('autocomplete', () => {
  const allUp = (): GameState =>
    layout({
      home: [10, 10, 10, 10],
      tableau: [
        ['KC', 'QD', 'JC'],
        ['KD', 'QC', 'JD'],
        ['KH', 'QS', 'JH'],
        ['KS', 'QH', 'JS'],
      ],
    });

  it('is offered only when the stock and waste are empty and nothing is face down', () => {
    expect(apply(allUp(), { t: 'auto' })).not.toHaveProperty('error');
    const down = layout({ home: [12, 12, 12, 12], tableau: [['_KC']] });
    expect(apply(down, { t: 'auto' })).toEqual({ error: 'no-autocomplete' });
    const stock = layout({ home: [12, 12, 12, 11], tableau: [['KC']], stock: ['QS'] });
    expect(apply(stock, { t: 'auto' })).toEqual({ error: 'no-autocomplete' });
  });

  it('sends every card home, lowest first, and clears on the clock it was pressed', () => {
    let s = tick(allUp(), 42_000).state;
    const r = apply(s, { t: 'auto' });
    if (isError(r)) throw new Error(r.error);
    s = r.state;
    expect(s.status).toBe('ended');
    const order = r.events
      .filter((e) => e.type === 'moved')
      .map((e) => (e.type === 'moved' ? s.deal[e.slots[0] as number] : -1));
    expect(order.slice(0, 4)).toEqual([c('JC'), c('JD'), c('JH'), c('JS')]);
    const b = s.breakdown;
    expect(b?.endReason).toBe('cleared');
    expect(b?.cardsHome).toBe(52);
    expect(b?.elapsedMs).toBe(42_000);
    expect(b?.clearBonus).toBe(RULES.clearBonus);
    expect(b?.timeBonus).toBe(RULES.clearPerSecond * 258);
    expect(s.score).toBe(12 * RULES.foundationPoints);
    expect(s.streak).toBe(0); // autocomplete never touches the streak
  });

  it('a clear by hand ends the game too', () => {
    const s = layout({ home: [13, 13, 13, 12], tableau: [['KS']] });
    const after = mustApply(s, { t: 'mv', from: 't0', to: 'f3', n: 1 });
    expect(after.status).toBe('ended');
    expect(after.breakdown?.endReason).toBe('cleared');
  });
});
