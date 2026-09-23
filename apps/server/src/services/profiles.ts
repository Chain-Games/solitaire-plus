import { eq, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { challenges, games, users } from '../db/schema.js';
import { notFound } from '../errors.js';
import { xpProgress } from './xp.js';

/**
 * A player's public profile: progression plus lifetime counts. Two aggregate
 * queries over the user's own games and challenges, both on indexed columns.
 */
export async function publicProfile(db: Db, username: string) {
  const user = await db.query.users.findFirst({ where: eq(users.username, username) });
  if (!user) throw notFound('user-not-found');
  const [gameStats, challengeStats] = await Promise.all([
    db
      .select({
        // Played = finished with at least one move, the same line XP draws:
        // a game swept before its first piece is not a game anyone played.
        gamesPlayed:
          sql<number>`count(*) filter (where ${games.status} = 'finished' and coalesce((${games.breakdown} ->> 'moves')::int, 0) >= 1)`.mapWith(
            Number,
          ),
        bestScore: sql<number>`coalesce(max(${games.score}), 0)`.mapWith(Number),
        bestLevel: sql<number>`coalesce(max(${games.levelReached}), 0)`.mapWith(Number),
      })
      .from(games)
      .where(eq(games.userId, user.id)),
    db
      .select({
        challengesPlayed: sql<number>`count(*)`.mapWith(Number),
        challengesWon:
          sql<number>`count(*) filter (where ${challenges.winnerId} = ${user.id})`.mapWith(Number),
        // Money: a win nets payout − fee, a loss costs the fee, and every
        // complete challenge risked its fee. All from the settled rows, so
        // the numbers can never disagree with where the $CHAIN went.
        chainStaked: sql<number>`coalesce(sum(${challenges.entryFee}), 0)`.mapWith(Number),
        chainWon:
          sql<number>`coalesce(sum(coalesce(${challenges.payout}, 0) - ${challenges.entryFee}) filter (where ${challenges.winnerId} = ${user.id}), 0)`.mapWith(
            Number,
          ),
        chainLost:
          sql<number>`coalesce(sum(${challenges.entryFee}) filter (where ${challenges.winnerId} <> ${user.id}), 0)`.mapWith(
            Number,
          ),
      })
      .from(challenges)
      .where(
        sql`${or(eq(challenges.creatorId, user.id), eq(challenges.takerId, user.id))} AND ${challenges.status} = 'complete'`,
      ),
  ]);
  const g = gameStats[0];
  const c = challengeStats[0];
  const chainStaked = c?.chainStaked ?? 0;
  const chainWon = c?.chainWon ?? 0;
  const chainLost = c?.chainLost ?? 0;
  const chainPnl = chainWon - chainLost;
  return {
    username: user.username,
    isGuest: user.isGuest,
    createdAt: user.createdAt.toISOString(),
    ...xpProgress(user.xp, user.xpLevel),
    gamesPlayed: g?.gamesPlayed ?? 0,
    challengesWon: c?.challengesWon ?? 0,
    challengesPlayed: c?.challengesPlayed ?? 0,
    bestScore: g?.bestScore ?? 0,
    bestLevel: g?.bestLevel ?? 0,
    chainStaked,
    chainWon,
    chainLost,
    chainPnl,
    /** Share of everything staked that came back as winnings, in percent; null until something was staked. */
    chainPnlPct: chainStaked > 0 ? Math.round((chainWon / chainStaked) * 1000) / 10 : null,
  };
}

export type PublicProfile = Awaited<ReturnType<typeof publicProfile>>;
