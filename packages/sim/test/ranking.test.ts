import { describe, expect, it } from 'vitest';
import { margin, winner } from '../src/index.js';

describe('ranking', () => {
  it('higher score wins', () => {
    expect(
      winner(
        { score: 100, elapsedMs: 180_000, finishedAt: 1 },
        { score: 200, elapsedMs: 1, finishedAt: 0 },
      ),
    ).toBe('b');
  });
  it('on equal score, shorter clock wins', () => {
    expect(
      winner(
        { score: 100, elapsedMs: 120_000, finishedAt: 9 },
        { score: 100, elapsedMs: 180_000, finishedAt: 0 },
      ),
    ).toBe('a');
  });
  it('on equal score and clock, earlier submission wins', () => {
    expect(
      winner(
        { score: 100, elapsedMs: 180_000, finishedAt: 5 },
        { score: 100, elapsedMs: 180_000, finishedAt: 4 },
      ),
    ).toBe('b');
  });
  it('margin explains the result', () => {
    expect(
      margin(
        { score: 300, elapsedMs: 0, finishedAt: 0 },
        { score: 100, elapsedMs: 0, finishedAt: 0 },
      ),
    ).toEqual({ by: 'score', amount: 200 });
    expect(
      margin(
        { score: 300, elapsedMs: 100, finishedAt: 0 },
        { score: 300, elapsedMs: 400, finishedAt: 0 },
      ),
    ).toEqual({ by: 'time', amountMs: 300 });
    expect(
      margin(
        { score: 300, elapsedMs: 100, finishedAt: 0 },
        { score: 300, elapsedMs: 100, finishedAt: 1 },
      ),
    ).toEqual({ by: 'submission' });
  });
});
