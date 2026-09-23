import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ZERO_XP_PARTS, xpForGame, xpForWin, type ScoreBreakdown } from '@solitaire-plus/sim';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { createDb } from './index.js';
import { challenges, games, xpEvents } from './schema.js';
import { awardXp } from '../services/xp.js';

/**
 * Credit XP for games finished and challenges settled before the XP system
 * existed. Idempotent: `awardXp` is unique per (ref, kind), so a row that was
 * already paid — by this script or by the live path — is skipped. Safe to run
 * on every boot; it does nothing once everything is credited.
 *
 * Awards are dated at the game's finish / the challenge's resolution so the
 * audit trail reads in order.
 */
export async function backfillXp(url: string): Promise<{ games: number; wins: number }> {
  const { db, client } = createDb(url);
  let paidGames = 0;
  let paidWins = 0;
  try {
    const unpaidGames = await db
      .select({
        id: games.id,
        userId: games.userId,
        challengeId: games.challengeId,
        breakdown: games.breakdown,
        finishedAt: games.finishedAt,
      })
      .from(games)
      .leftJoin(xpEvents, and(eq(xpEvents.refId, games.id), eq(xpEvents.kind, 'game')))
      .where(and(eq(games.status, 'finished'), isNotNull(games.breakdown), isNull(xpEvents.id)));
    for (const g of unpaidGames) {
      const xp = xpForGame(g.breakdown as ScoreBreakdown, {
        challenge: g.challengeId !== null,
        won: null,
        pot: 0,
      });
      if (xp.total === 0) continue;
      const paid = await db.transaction((tx) =>
        awardXp(tx, g.userId, xp.total, 'game', g.id, xp.parts, g.finishedAt ?? new Date()),
      );
      if (paid) paidGames++;
    }

    const unpaidWins = await db
      .select({
        id: challenges.id,
        winnerId: challenges.winnerId,
        entryFee: challenges.entryFee,
        resolvedAt: challenges.resolvedAt,
      })
      .from(challenges)
      .leftJoin(
        xpEvents,
        and(eq(xpEvents.refId, challenges.id), eq(xpEvents.kind, 'challenge_win')),
      )
      .where(
        and(eq(challenges.status, 'complete'), isNotNull(challenges.winnerId), isNull(xpEvents.id)),
      );
    for (const c of unpaidWins) {
      const winnerId = c.winnerId;
      if (!winnerId) continue;
      const win = xpForWin(c.entryFee * 2);
      const paid = await db.transaction((tx) =>
        awardXp(
          tx,
          winnerId,
          win,
          'challenge_win',
          c.id,
          { ...ZERO_XP_PARTS, win },
          c.resolvedAt ?? new Date(),
        ),
      );
      if (paid) paidWins++;
    }
  } finally {
    await client.end();
  }
  return { games: paidGames, wins: paidWins };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  backfillXp(url).then(
    (r) => {
      console.log(`xp backfill: ${r.games} games, ${r.wins} challenge wins credited`);
    },
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
