import type { NotificationItem, NotificationKind } from '../api/client.js';

/**
 * The words for a notification, shared by the toast, the inbox and the
 * push payload (the server's `describe` says the same thing in one line).
 * Outcome language from docs/art-direction.md § Outcome: a win is mint with
 * the Coin and "+20 $CHAIN" as the loud element; a loss is rose and quieter,
 * "−10 $CHAIN" with a real minus; the take is the accent; an expiry is dim.
 */

export type Tone = 'won' | 'lost' | 'taken' | 'expired';

export const TONE: Record<NotificationKind, Tone> = {
  challenge_won: 'won',
  challenge_lost: 'lost',
  challenge_taken: 'taken',
  challenge_expired: 'expired',
};

/** The outcome chip's word. */
export const CHIP: Record<Tone, string> = {
  won: 'WON',
  lost: 'LOST',
  taken: 'TAKEN',
  expired: 'EXPIRED',
};

/** "+20 $CHAIN" / "−10 $CHAIN" — a real minus sign, never a hyphen. */
export function chainText(amount: number): string {
  return `${amount < 0 ? '−' : '+'}${Math.abs(amount).toLocaleString()} $CHAIN`;
}

/** "8,470 vs 5,120", or '' when a score is unknown. */
export function scoresText(n: NotificationItem): string {
  if (n.myScore === null || n.theirScore === null) return '';
  return `${n.myScore.toLocaleString()} vs ${n.theirScore.toLocaleString()}`;
}

/** The one line under the amount: who did what (the chip or eyebrow says the outcome). */
export function lineText(n: NotificationItem): string {
  const who = n.opponent || 'Someone';
  switch (n.kind) {
    case 'challenge_won':
    case 'challenge_lost':
    case 'challenge_taken':
      return n.role === 'creator' ? `${who} took your challenge` : `You took ${who}'s challenge`;
    case 'challenge_expired':
      return `No one took it \u00b7 ${Math.abs(n.amount).toLocaleString()} $CHAIN refunded`;
  }
}

/**
 * What follows the line on a wide toast: "— you won", "· playing now". One
 * unbreakable run, so it wraps whole or not at all; a phone drops it
 * (styles), the eyebrow already says it.
 */
export function suffixText(n: NotificationItem): string {
  switch (n.kind) {
    case 'challenge_won':
      return '\u00a0\u2014\u00a0you\u00a0won';
    case 'challenge_lost':
      return '\u00a0\u2014\u00a0you\u00a0lost';
    case 'challenge_taken':
      return '\u00a0\u00b7\u00a0playing\u00a0now';
    case 'challenge_expired':
      return '';
  }
}

/** Everything in one sentence, for screen readers and the push body. */
export function summaryText(n: NotificationItem): string {
  const amount = n.amount !== 0 ? ` ${chainText(n.amount)}` : '';
  const scores = scoresText(n);
  return `${lineText(n)}${suffixText(n)}${amount}${scores ? ` · ${scores}` : ''}`;
}
