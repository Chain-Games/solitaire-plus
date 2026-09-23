import { and, asc, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { ZERO_XP_PARTS, margin, winner, xpForWin } from '@solitaire-plus/sim';
import { ENTRY_FEES, type Config } from '../config.js';
import type { Db, Tx } from '../db/index.js';
import { challenges, games, users, type Challenge, type Game } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { newCode } from '../ids.js';
import type { DealPools } from './deals.js';
import { credit, debit } from './economy.js';
import { levelReachedOf } from './levels.js';
import { notify } from './notifications.js';
import { awardXp, foldXpGained, xpBadge, xpEventsFor, type XpBadge, type XpGained } from './xp.js';

/**
 * Challenge flow.
 *
 *   create  — creator pays the fee, gets a seed, plays. Challenge is `pending`.
 *   (creator finishes) — challenge becomes `open`.
 *   take    — taker pays the fee, gets the SAME seed, plays. Challenge is `taken`.
 *   (taker finishes) — both scored by replay, winner takes the pot. `complete`.
 *   expire  — nobody took it in time; creator refunded. `expired`.
 *
 * Matchmaking is "oldest open public challenge at this fee that isn't mine",
 * which is the same rule the original game used.
 */

export function assertValidFee(fee: number): void {
  if (!(ENTRY_FEES as readonly number[]).includes(fee))
    throw badRequest('bad-fee', `entry fee must be one of ${ENTRY_FEES.join(', ')}`);
}

export async function createChallenge(
  db: Db,
  cfg: Config,
  deals: Pick<DealPools, 'popChallengeSeed'>,
  creatorId: string,
  entryFee: number,
  isPrivate: boolean,
  now = new Date(),
): Promise<{ challenge: Challenge; game: Game }> {
  assertValidFee(entryFee);
  // A solver-verified seed from the pool (an unverified one if it is empty).
  // Popped before the transaction: if that fails the seed is spent, never reused.
  const { seed } = await deals.popChallengeSeed();
  return db.transaction(async (tx) => {
    const [game] = await tx.insert(games).values({ userId: creatorId, seed }).returning();
    if (!game) throw new Error('failed to create game');
    const [challenge] = await tx
      .insert(challenges)
      .values({
        code: newCode(),
        creatorId,
        seed,
        entryFee,
        isPrivate,
        status: 'pending',
        creatorGameId: game.id,
        expiresAt: new Date(now.getTime() + cfg.CHALLENGE_TTL_MS),
      })
      .returning();
    if (!challenge) throw new Error('failed to create challenge');
    await tx.update(games).set({ challengeId: challenge.id }).where(eq(games.id, game.id));
    await debit(tx, creatorId, entryFee, 'entry_fee', challenge.id);
    return { challenge, game: { ...game, challengeId: challenge.id } };
  });
}

/** Public challenges waiting for an opponent, oldest first. */
export async function listOpen(db: Db, userId: string, entryFee: number | undefined, limit = 50) {
  const conds = [
    eq(challenges.status, 'open'),
    eq(challenges.isPrivate, false),
    ne(challenges.creatorId, userId),
  ];
  if (entryFee !== undefined) conds.push(eq(challenges.entryFee, entryFee));
  const rows = await db
    .select({
      id: challenges.id,
      code: challenges.code,
      entryFee: challenges.entryFee,
      createdAt: challenges.createdAt,
      expiresAt: challenges.expiresAt,
      creator: { id: users.id, username: users.username, xpLevel: users.xpLevel },
    })
    .from(challenges)
    .innerJoin(users, eq(users.id, challenges.creatorId))
    .where(and(...conds))
    .orderBy(asc(challenges.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    creator: { id: r.creator.id, username: r.creator.username, ...xpBadge(r.creator.xpLevel) },
  }));
}

async function takeLocked(
  tx: Tx,
  cfg: Config,
  challenge: Challenge,
  takerId: string,
  now: Date,
): Promise<{ challenge: Challenge; game: Game }> {
  if (challenge.status !== 'open') throw conflict('challenge-not-open');
  if (challenge.creatorId === takerId)
    throw conflict('own-challenge', 'You cannot take your own challenge.');
  if (challenge.expiresAt.getTime() <= now.getTime()) throw conflict('challenge-expired');
  const [game] = await tx
    .insert(games)
    .values({ userId: takerId, seed: challenge.seed, challengeId: challenge.id })
    .returning();
  if (!game) throw new Error('failed to create game');
  const [updated] = await tx
    .update(challenges)
    .set({ status: 'taken', takerId, takerGameId: game.id })
    .where(eq(challenges.id, challenge.id))
    .returning();
  if (!updated) throw notFound('challenge-not-found');
  await debit(tx, takerId, challenge.entryFee, 'entry_fee', challenge.id);
  // The creator hears their challenge was taken (the taker's game starts now).
  const taker = await tx.query.users.findFirst({
    where: eq(users.id, takerId),
    columns: { username: true },
  });
  await notify(
    tx,
    {
      userId: challenge.creatorId,
      kind: 'challenge_taken',
      challengeId: challenge.id,
      role: 'creator',
      opponentUsername: taker?.username ?? '',
      amount: 0,
    },
    now,
  );
  void cfg;
  return { challenge: updated, game };
}

/** Matchmaking: take the oldest open public challenge at this fee. */
export async function takeRandom(
  db: Db,
  cfg: Config,
  takerId: string,
  entryFee: number,
  now = new Date(),
) {
  assertValidFee(entryFee);
  return db.transaction(async (tx) => {
    // SKIP LOCKED so two takers arriving together get two different challenges.
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT id FROM challenges
      WHERE status = 'open' AND is_private = false AND entry_fee = ${entryFee}
        AND creator_id <> ${takerId} AND expires_at > ${now.toISOString()}::timestamptz
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    const id = rows[0]?.id;
    if (!id)
      throw notFound(
        'no-open-challenge',
        'No challengers have games in queue at this fee. Create one instead?',
      );
    const challenge = await tx.query.challenges.findFirst({ where: eq(challenges.id, id) });
    if (!challenge) throw notFound('challenge-not-found');
    return takeLocked(tx, cfg, challenge, takerId, now);
  });
}

/** Take a specific challenge by its share code (private or public). */
export async function takeByCode(
  db: Db,
  cfg: Config,
  takerId: string,
  code: string,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT id FROM challenges WHERE code = ${code.toUpperCase()} FOR UPDATE
    `);
    const id = rows[0]?.id;
    if (!id) throw notFound('challenge-not-found');
    const challenge = await tx.query.challenges.findFirst({ where: eq(challenges.id, id) });
    if (!challenge) throw notFound('challenge-not-found');
    if (challenge.status === 'pending')
      throw conflict(
        'challenge-pending',
        'The challenger is still playing. Try again in a few minutes.',
      );
    return takeLocked(tx, cfg, challenge, takerId, now);
  });
}

/**
 * Called inside finalizeGame's transaction after a game is scored. Moves a
 * pending challenge to open when the creator finishes, and settles a taken
 * challenge when both games are finished.
 */
export async function resolveChallengeIfReady(
  tx: Tx,
  cfg: Config,
  challengeId: string,
  now: Date,
): Promise<void> {
  const rows = await tx.execute<{ id: string }>(
    sql`SELECT id FROM challenges WHERE id = ${challengeId} FOR UPDATE`,
  );
  if (rows.length === 0) return;
  const ch = await tx.query.challenges.findFirst({ where: eq(challenges.id, challengeId) });
  if (!ch) return;

  const creatorGame = await tx.query.games.findFirst({ where: eq(games.id, ch.creatorGameId) });
  if (!creatorGame) return;

  if (ch.status === 'pending') {
    if (creatorGame.status === 'finished') {
      await tx.update(challenges).set({ status: 'open' }).where(eq(challenges.id, ch.id));
    }
    return;
  }
  if (ch.status !== 'taken' || !ch.takerGameId || !ch.takerId) return;
  const takerGame = await tx.query.games.findFirst({ where: eq(games.id, ch.takerGameId) });
  if (!takerGame || takerGame.status !== 'finished' || creatorGame.status !== 'finished') return;

  const a = entry(creatorGame);
  const b = entry(takerGame);
  const winnerId = winner(a, b) === 'a' ? ch.creatorId : ch.takerId;
  const pot = ch.entryFee * 2;
  const payout = pot - Math.floor((pot * cfg.RAKE_BPS) / 10_000);
  await credit(tx, winnerId, payout, 'payout', ch.id);
  await tx
    .update(challenges)
    .set({ status: 'complete', winnerId, payout, resolvedAt: now })
    .where(eq(challenges.id, ch.id));
  // The one place a challenge pays XP: the win part, to the winner, once.
  const win = xpForWin(pot);
  await awardXp(tx, winnerId, win, 'challenge_win', ch.id, { ...ZERO_XP_PARTS, win }, now);
  // Both sides hear the result: the winner's net (the payout less their own
  // stake), the loser's stake as a minus. Idempotent with the rest of this
  // transaction: a re-settle inserts nothing.
  const names = await tx.query.users.findMany({
    where: inArray(users.id, [ch.creatorId, ch.takerId]),
    columns: { id: true, username: true },
  });
  const nameOf = (id: string) => names.find((u) => u.id === id)?.username ?? '';
  const sides = [
    { userId: ch.creatorId, role: 'creator' as const, other: ch.takerId, mine: a, theirs: b },
    { userId: ch.takerId, role: 'taker' as const, other: ch.creatorId, mine: b, theirs: a },
  ];
  for (const side of sides) {
    const won = side.userId === winnerId;
    await notify(
      tx,
      {
        userId: side.userId,
        kind: won ? 'challenge_won' : 'challenge_lost',
        challengeId: ch.id,
        role: side.role,
        opponentUsername: nameOf(side.other),
        amount: won ? payout - ch.entryFee : -ch.entryFee,
        myScore: side.mine.score,
        theirScore: side.theirs.score,
      },
      now,
    );
  }
}

function entry(g: Game) {
  return {
    score: g.score ?? 0,
    elapsedMs: g.elapsedMs ?? 0,
    finishedAt: g.finishedAt?.getTime() ?? 0,
  };
}

/** Refund open challenges nobody took in time. */
export async function sweepChallenges(db: Db, now = new Date()): Promise<number> {
  const stale = await db.query.challenges.findMany({
    where: and(eq(challenges.status, 'open'), lt(challenges.expiresAt, now)),
    limit: 100,
  });
  let count = 0;
  for (const ch of stale) {
    await db.transaction(async (tx) => {
      const rows = await tx.execute<{ status: string }>(
        sql`SELECT status FROM challenges WHERE id = ${ch.id} FOR UPDATE`,
      );
      if (rows[0]?.status !== 'open') return;
      await tx
        .update(challenges)
        .set({ status: 'expired', resolvedAt: now })
        .where(eq(challenges.id, ch.id));
      await credit(tx, ch.creatorId, ch.entryFee, 'refund', ch.id);
      await notify(
        tx,
        {
          userId: ch.creatorId,
          kind: 'challenge_expired',
          challengeId: ch.id,
          role: 'creator',
          opponentUsername: '',
          amount: ch.entryFee,
        },
        now,
      );
      count++;
    });
  }
  return count;
}

/** A challenge as one participant should see it. Opponent scores are hidden until you have finished. */
export async function viewChallenge(db: Db, challengeId: string, viewerId: string) {
  const ch = await db.query.challenges.findFirst({ where: eq(challenges.id, challengeId) });
  if (!ch) throw notFound('challenge-not-found');
  const isCreator = ch.creatorId === viewerId;
  const isTaker = ch.takerId === viewerId;
  if (!isCreator && !isTaker) throw forbidden();
  return buildView(db, ch, viewerId);
}

/**
 * The viewer's challenges, newest ACTIVITY first — the settlement, the last
 * game finished, or the creation, whichever is latest — so a match you just
 * played sits at the top even when the challenge was created hours ago.
 */
export async function listMine(db: Db, userId: string, limit = 50) {
  const rows = await db.query.challenges.findMany({
    where: or(eq(challenges.creatorId, userId), eq(challenges.takerId, userId)),
    orderBy: desc(challenges.createdAt),
    limit,
  });
  const views = await Promise.all(rows.map((ch) => buildView(db, ch, userId)));
  return views.sort((a, b) => Date.parse(b.activityAt) - Date.parse(a.activityAt));
}

export interface ParticipantView extends XpBadge {
  id: string;
  username: string;
  gameId: string | null;
  finished: boolean;
  /** Only present when the viewer is allowed to see it. */
  score?: number;
  elapsedMs?: number;
  endReason?: string;
  /** Cosmetic level reached; revealed with the score. */
  levelReached?: number;
}

async function buildView(db: Db, ch: Challenge, viewerId: string) {
  const isCreator = ch.creatorId === viewerId;
  const myGameId = isCreator ? ch.creatorGameId : ch.takerGameId;
  const [creator, taker, creatorGame, takerGame, myXp] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, ch.creatorId),
      columns: { id: true, username: true, xpLevel: true },
    }),
    ch.takerId
      ? db.query.users.findFirst({
          where: eq(users.id, ch.takerId),
          columns: { id: true, username: true, xpLevel: true },
        })
      : null,
    db.query.games.findFirst({ where: eq(games.id, ch.creatorGameId) }),
    ch.takerGameId ? db.query.games.findFirst({ where: eq(games.id, ch.takerGameId) }) : null,
    // The viewer's own awards for this match: the game's and, once settled, the win's.
    xpEventsFor(db, viewerId, myGameId ? [myGameId, ch.id] : [ch.id]),
  ]);
  const myGame = isCreator ? creatorGame : takerGame;
  const iAmDone = myGame?.status === 'finished';

  const part = (
    u: { id: string; username: string; xpLevel: number } | null | undefined,
    g: Game | null | undefined,
    reveal: boolean,
  ): ParticipantView | null => {
    if (!u) return null;
    const v: ParticipantView = {
      id: u.id,
      username: u.username,
      ...xpBadge(u.xpLevel),
      gameId: g?.id ?? null,
      finished: g?.status === 'finished',
    };
    if (reveal && g?.status === 'finished') {
      v.score = g.score ?? 0;
      v.elapsedMs = g.elapsedMs ?? 0;
      v.endReason = g.endReason ?? 'timeout';
      v.levelReached = levelReachedOf(g);
    }
    return v;
  };

  const me = part(isCreator ? creator : taker, myGame, true);
  const opponent = part(isCreator ? taker : creator, isCreator ? takerGame : creatorGame, iAmDone);

  let result: {
    won: boolean;
    margin: ReturnType<typeof margin>;
    payout: number;
    /** What this match paid the viewer: the game's parts plus the win part if they won. */
    xpGained: XpGained | null;
  } | null = null;
  if (ch.status === 'complete' && creatorGame && takerGame && ch.winnerId) {
    const mine = entry(isCreator ? creatorGame : takerGame);
    const theirs = entry(isCreator ? takerGame : creatorGame);
    const won = ch.winnerId === viewerId;
    result = {
      won,
      margin: won ? margin(mine, theirs) : margin(theirs, mine),
      payout: ch.payout ?? 0,
      xpGained: foldXpGained(myXp),
    };
  }

  return {
    id: ch.id,
    code: ch.code,
    status: ch.status,
    entryFee: ch.entryFee,
    isPrivate: ch.isPrivate,
    role: isCreator ? ('creator' as const) : ('taker' as const),
    createdAt: ch.createdAt.toISOString(),
    expiresAt: ch.expiresAt.toISOString(),
    resolvedAt: ch.resolvedAt?.toISOString() ?? null,
    /** The latest thing that happened here: settlement, a finished game, or the creation. */
    activityAt: new Date(
      Math.max(
        ch.createdAt.getTime(),
        ch.resolvedAt?.getTime() ?? 0,
        creatorGame?.finishedAt?.getTime() ?? 0,
        takerGame?.finishedAt?.getTime() ?? 0,
      ),
    ).toISOString(),
    me,
    opponent,
    myGameId: myGame?.id ?? null,
    myGameStatus: myGame?.status ?? null,
    result,
  };
}

export type ChallengeView = Awaited<ReturnType<typeof buildView>>;
