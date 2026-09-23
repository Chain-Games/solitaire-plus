import { createGame, isError, place, type GameEvent, type GameState } from '@solitaire-plus/sim';
import { describe, expect, it } from 'vitest';
import { TUTORIAL_BEATS, TUTORIAL_MOVES, TUTORIAL_SEED } from './script.js';

/** What one placement did, as the sim tells it. */
interface Fact {
  lines: number;
  streak: number;
  broken: boolean;
  status: GameState['status'];
}

function replay(): Fact[] {
  let state = createGame(TUTORIAL_SEED).state;
  const facts: Fact[] = [];
  for (const m of TUTORIAL_MOVES) {
    const r = place(state, m);
    if (isError(r)) throw new Error(`move ${facts.length} is illegal: ${r.error}`);
    const events: readonly GameEvent[] = r.events;
    let lines = 0;
    let broken = false;
    for (const e of events) {
      if (e.type === 'linesCleared') lines = e.rows.length + e.cols.length;
      if (e.type === 'streakBroken') broken = true;
    }
    state = r.state;
    facts.push({ lines, streak: state.streak, broken, status: state.status });
  }
  return facts;
}

describe('tutorial script', () => {
  const facts = replay();

  it('plays every move legally and the game is still running at the end', () => {
    expect(facts).toHaveLength(TUTORIAL_MOVES.length);
    for (const f of facts) expect(f.status).toBe('playing');
  });

  it('spends exactly the scripted moves across the beats', () => {
    const used = TUTORIAL_BEATS.reduce((n, b) => n + b.moves, 0);
    expect(used).toBe(TUTORIAL_MOVES.length);
    expect(TUTORIAL_BEATS.length).toBeLessThanOrEqual(9);
    // The first beat speaks; a silent beat only ever primes (no payoff of its own).
    expect(TUTORIAL_BEATS[0]?.caption).toBeTruthy();
    for (const b of TUTORIAL_BEATS) if (b.caption === null) expect(b.expect).toBe('place');
    expect(TUTORIAL_MOVES.length).toBeLessThanOrEqual(16);
  });

  it('lands every beat, in order', () => {
    let i = 0;
    for (const beat of TUTORIAL_BEATS) {
      const own = facts.slice(i, i + beat.moves);
      i += beat.moves;
      const last = own[own.length - 1];
      // Priming moves under a caption clear nothing: the payoff is the last move.
      for (const f of own.slice(0, -1)) expect(f.lines).toBe(0);
      switch (beat.expect) {
        case 'place':
          expect(last?.lines).toBe(0);
          break;
        case 'clear-1':
          expect(last?.lines).toBe(1);
          expect(last?.streak).toBe(1);
          break;
        case 'clear-2':
          expect(last?.lines).toBeGreaterThanOrEqual(2);
          // A fresh streak: the 2X beat that follows must be the second clear in a row.
          expect(last?.streak).toBe(1);
          break;
        case 'streak-2':
          expect(last?.lines).toBeGreaterThanOrEqual(1);
          expect(last?.streak).toBe(2);
          break;
        case 'streak-3':
          expect(last?.lines).toBeGreaterThanOrEqual(1);
          expect(last?.streak).toBe(3);
          break;
        case 'streak-broken':
          expect(last?.lines).toBe(0);
          expect(last?.broken).toBe(true);
          expect(facts[i - 2]?.streak).toBeGreaterThanOrEqual(2);
          expect(last?.streak).toBe(0);
          break;
        case 'none':
          expect(beat.moves).toBe(0);
          break;
      }
    }
  });

  it('keeps the arc in order: clear, double, 2X, 3X, break', () => {
    // A break is the loss of a streak the HUD showed (2X or more); the sim
    // also reports one after a lone clear, which nobody sees.
    const kinds = facts.map((f, i) => {
      const before = facts[i - 1]?.streak ?? 0;
      if (f.broken && before >= 2) return 'break';
      return f.lines >= 2 ? 'double' : f.lines === 1 ? 'clear' : 'place';
    });
    const order = kinds.filter((k) => k !== 'place');
    expect(order).toEqual(['clear', 'double', 'clear', 'clear', 'break']);
    expect(facts.map((f) => f.streak).filter((s) => s >= 2)).toEqual([2, 3]);
  });

  it('holds to the pacing budget (per-beat hold 0.6–3.5 s)', () => {
    for (const b of TUTORIAL_BEATS) {
      if (b.caption === null) continue;
      expect(b.hold).toBeGreaterThanOrEqual(0.6);
      expect(b.hold).toBeLessThanOrEqual(3.5);
    }
  });
});
