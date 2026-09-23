import { randomBytes } from 'node:crypto';

/** Game seed: 128 bits of server-side randomness, hex. The client never chooses a seed. */
export function newSeed(): string {
  return randomBytes(16).toString('hex');
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/** Short human-shareable challenge code, e.g. "K7QF2M". */
export function newCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    const b = bytes[i] ?? 0;
    out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  }
  return out;
}

/** Share card id: 72 bits of randomness as 12 URL-safe characters — unguessable, never sequential. */
export function newShareId(): string {
  return randomBytes(9).toString('base64url');
}

/** The shape `newShareId` produces; anything else is refused before the database is asked. */
export const SHARE_ID_RE = /^[A-Za-z0-9_-]{12}$/;
