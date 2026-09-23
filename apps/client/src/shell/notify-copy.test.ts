import { describe, expect, it } from 'vitest';
import type { NotificationItem } from '../api/client.js';
import { chainText, lineText, scoresText, suffixText, summaryText, TONE } from './notify-copy.js';

const base: NotificationItem = {
  id: 'n1',
  kind: 'challenge_won',
  challengeId: 'c1',
  role: 'creator',
  opponent: 'guest_x',
  amount: 20,
  myScore: 8470,
  theirScore: 5120,
  createdAt: '2026-09-17T10:00:00.000Z',
  readAt: null,
};

describe('notification copy', () => {
  it('signs the amount with a real minus and groups thousands', () => {
    expect(chainText(20)).toBe('+20 $CHAIN');
    expect(chainText(-10)).toBe('−10 $CHAIN');
    expect(chainText(1250)).toBe('+1,250 $CHAIN');
  });

  it("says who did what from the recipient's side; the outcome rides in a no-widow suffix", () => {
    expect(lineText(base)).toBe('guest_x took your challenge');
    expect(suffixText(base)).toBe(' — you won');
    expect(lineText({ ...base, role: 'taker', kind: 'challenge_lost', amount: -10 })).toBe(
      "You took guest_x's challenge",
    );
    expect(suffixText({ ...base, kind: 'challenge_lost' })).toBe(' — you lost');
    expect(lineText({ ...base, kind: 'challenge_taken', amount: 0 })).toBe(
      'guest_x took your challenge',
    );
    expect(suffixText({ ...base, kind: 'challenge_taken' })).toBe(' · playing now');
    expect(
      lineText({ ...base, kind: 'challenge_expired', opponent: '', amount: 10, myScore: null }),
    ).toBe('No one took it · 10 $CHAIN refunded');
    expect(suffixText({ ...base, kind: 'challenge_expired' })).toBe('');
  });

  it('shows scores only when both are known, and folds everything into one sentence', () => {
    expect(scoresText(base)).toBe('8,470 vs 5,120');
    expect(scoresText({ ...base, theirScore: null })).toBe('');
    expect(summaryText(base)).toBe(
      'guest_x took your challenge — you won +20 $CHAIN · 8,470 vs 5,120',
    );
    expect(TONE.challenge_lost).toBe('lost');
  });
});
