import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  ZERO_XP_PARTS,
  rankFor,
  xpLevelFor,
  xpThreshold,
  type Rank,
  type XpParts,
} from '@solitaire-plus/sim';
import type { Db, Tx } from '../db/index.js';
import { users, xpEvents, type XpEvent, type XpEventKind } from '../db/schema.js';

/**
 * XP awards. Two call sites and no others: finalizeGame (kind 'game', the
 * non-win parts of the game just scored) and the challenge settlement
 * (kind 'challenge_win', the win part to the winner). Both run inside the
 * caller's transaction and are idempotent on (ref_id, kind): a game or a
 * challenge that has already awarded is a no-op.
 *
 * The client never sends an XP number; every award is derived from the
 * server's own replay and the settled challenge row.
 */

export interface XpAwardResult {
  readonly amount: number;
  readonly parts: XpParts;
  readonly xpBefore: number;
  readonly xpAfter: number;
  readonly levelBefore: number;
  readonly levelAfter: number;
}

export async function awardXp(
  tx: Tx,
  userId: string,
  amount: number,
  kind: XpEventKind,
  refId: string | null,
  parts: XpParts,
  now = new Date(),
): Promise<XpAwardResult | null> {
  if (!Number.isInteger(amount) || amount < 0)
    throw new Error('xp award must be a non-negative integer');
  // Row lock: a game finalising and a challenge settling for the same player
  // in two transactions must serialise on the running total.
  const locked = await tx.execute<{ xp: number }>(
    sql`SELECT xp FROM users WHERE id = ${userId} FOR UPDATE`,
  );
  const xpBefore = locked[0]?.xp;
  if (xpBefore === undefined) return null;
  const xpAfter = xpBefore + amount;
  const inserted = await tx
    .insert(xpEvents)
    .values({ userId, amount, kind, refId, parts, xpBefore, xpAfter, createdAt: now })
    .onConflictDoNothing({ target: [xpEvents.refId, xpEvents.kind, xpEvents.userId] })
    .returning({ id: xpEvents.id });
  if (inserted.length === 0) return null; // already awarded for this ref + kind + user
  const levelAfter = xpLevelFor(xpAfter);
  await tx.update(users).set({ xp: xpAfter, xpLevel: levelAfter }).where(eq(users.id, userId));
  return {
    amount,
    parts,
    xpBefore,
    xpAfter,
    levelBefore: xpLevelFor(xpBefore),
    levelAfter,
  };
}

/** What the API shows next to a username seen by other players. */
export interface XpBadge {
  readonly xpLevel: number;
  readonly rank: Rank;
}

export function xpBadge(xpLevel: number): XpBadge {
  return { xpLevel, rank: rankFor(xpLevel) };
}

/** The full progression block on the caller's own user object and on profiles. */
export function xpProgress(xp: number, xpLevel: number) {
  return {
    xp,
    xpLevel,
    rank: rankFor(xpLevel),
    nextThreshold: xpThreshold(xpLevel + 1),
    prevThreshold: xpThreshold(xpLevel),
  };
}

/** The "you gained" block for a results screen, folded from one or more award rows. */
export interface XpGained {
  readonly total: number;
  readonly parts: XpParts;
  readonly xpBefore: number;
  readonly xpAfter: number;
  readonly levelBefore: number;
  readonly levelAfter: number;
  readonly rankBefore: Rank;
  readonly rankAfter: Rank;
}

/**
 * Fold award rows (in the order they were made) into one XpGained. The game
 * award and, once settled, the challenge-win award of the same match combine:
 * parts add, xpBefore is the first award's, xpAfter the last's.
 */
export function foldXpGained(events: readonly XpEvent[]): XpGained | null {
  const sorted = [...events].sort((a, b) => a.id - b.id);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return null;
  let total = 0;
  const parts: Record<keyof XpParts, number> = { ...ZERO_XP_PARTS };
  for (const e of sorted) {
    total += e.amount;
    for (const k of Object.keys(parts) as (keyof XpParts)[]) parts[k] += e.parts[k] ?? 0;
  }
  const levelBefore = xpLevelFor(first.xpBefore);
  const levelAfter = xpLevelFor(last.xpAfter);
  return {
    total,
    parts,
    xpBefore: first.xpBefore,
    xpAfter: last.xpAfter,
    levelBefore,
    levelAfter,
    rankBefore: rankFor(levelBefore),
    rankAfter: rankFor(levelAfter),
  };
}

/** The award rows a user holds against any of the given refs (game and challenge ids). */
export async function xpEventsFor(
  db: Db | Tx,
  userId: string,
  refIds: readonly string[],
): Promise<XpEvent[]> {
  const ids = refIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return [];
  return db.query.xpEvents.findMany({
    where: and(eq(xpEvents.userId, userId), inArray(xpEvents.refId, ids)),
  });
}

/** XpGained for one finished game, from its 'game' award alone. */
export async function gameXpGained(db: Db | Tx, userId: string, gameId: string) {
  return foldXpGained(await xpEventsFor(db, userId, [gameId]));
}
