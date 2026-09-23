import { describe, expect, it } from 'vitest';
import { apply, canUndo, createGame, stateHash, tick, type GameState } from '../src/index.js';
import { layout, mustApply } from './util.js';

const undo = (s: GameState) => mustApply(s, { t: 'undo' });
/** The state as an undo sees it: everything but the clock and the counters. */
const board = (s: GameState) =>
  JSON.stringify([
    s.stock,
    s.waste,
    s.foundations,
    s.tableau,
    s.score,
    s.level,
    s.streak,
    s.bestStreak,
    s.lastScoreMs,
  ]);

describe('undo', () => {
  it('reverses a tableau move, a waste play, a foundation play and a return', () => {
    const s0 = layout({
      home: [0, 0, 3, 0],
      waste: ['7C'],
      tableau: [['8H'], ['9S'], ['AC'], ['4S']],
    });
    let s = s0;
    s = mustApply(s, { t: 'mv', from: 't0', to: 't1', n: 1 }); // 8H onto 9S
    s = mustApply(s, { t: 'mv', from: 'waste', to: 't1', n: 1 }); // 7C onto 8H
    s = mustApply(s, { t: 'mv', from: 't2', to: 'f0', n: 1 }); // AC home
    s = mustApply(s, { t: 'mv', from: 'f2', to: 't3', n: 1 }); // 3H back down onto 4S
    expect(s.undo.length).toBe(4);
    for (let i = 0; i < 4; i++) s = undo(s);
    expect(board(s)).toBe(board(s0));
    expect(s.undos).toBe(4);
    expect(s.moves).toBe(4); // undo is not a move and does not take moves back
    expect(apply(s, { t: 'undo' })).toEqual({ error: 'nothing-to-undo' });
  });

  it('reverses a recycle and a draw of cards already seen', () => {
    let s = layout({ stock: ['2C', '3C', '4C'] });
    s = mustApply(s, { t: 'draw' }); // first sight: a barrier
    expect(canUndo(s)).toBe(false);
    const drawn = board(s);
    s = mustApply(s, { t: 'draw' }); // recycle
    const recycled = board(s);
    s = mustApply(s, { t: 'draw' }); // the same three again: seen, so no barrier
    expect(canUndo(s)).toBe(true);
    s = undo(s);
    expect(board(s)).toBe(recycled);
    s = undo(s);
    expect(board(s)).toBe(drawn);
    expect(canUndo(s)).toBe(false);
  });

  it('never undoes past a card turned up', () => {
    let s = layout({ tableau: [['_2C', '8H'], ['9S'], ['7C'], ['8D']] });
    s = mustApply(s, { t: 'mv', from: 't2', to: 't3', n: 1 }); // 7C onto 8D: undoable
    expect(canUndo(s)).toBe(true);
    s = mustApply(s, { t: 'mv', from: 't0', to: 't1', n: 1 }); // turns 2C up
    expect(s.tableau[0]?.down).toBe(0);
    expect(canUndo(s)).toBe(false);
    expect(apply(s, { t: 'undo' })).toEqual({ error: 'nothing-to-undo' });
  });

  it('restores the score, the streak and the level, but not the clock', () => {
    let s = layout({ tableau: [['2C', 'AC'], ['8H'], ['9S']] });
    s = mustApply(s, { t: 'mv', from: 't1', to: 't2', n: 1 });
    const before = board(s);
    s = tick(s, 1000).state;
    s = mustApply(s, { t: 'mv', from: 't0', to: 'f0', n: 1 });
    s = tick(s, 1000).state;
    s = mustApply(s, { t: 'mv', from: 't0', to: 'f0', n: 1 });
    expect(s.streak).toBe(2);
    s = undo(undo(s));
    expect(board(s)).toBe(before);
    expect(s.elapsedMs).toBe(2000);
  });

  it('a real opening: the first draw is a barrier', () => {
    let s = createGame('undo-real').state;
    s = mustApply(s, { t: 'draw' });
    expect(canUndo(s)).toBe(false);
    expect(stateHash(s)).toMatch(/^[0-9a-f]{8}$/);
  });
});
