import { and, eq, lt } from 'drizzle-orm';
import {
  RULES,
  ReplayError,
  createGame,
  isTimedMove,
  replay,
  replayFrom,
  revealsIn,
  seenMask,
  stateHash,
  xpForGame,
  type Card,
  type GameState,
  type TimedMove,
} from '@solitaire-plus/sim';
import type { Config } from '../config.js';
import type { Db, Tx } from '../db/index.js';
import { games, type Game } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { resolveChallengeIfReady } from './challenges.js';
import { awardXp } from './xp.js';

/**
 * A game is one player's run through one seed. The server only ever stores
 * (seed, moves); the score is whatever sim.replay says it is.
 *
 * The seed is the answer key to every face-down card, so it never leaves the
 * server while the game can still matter. The client plays on a masked deal
 * and learns each new card from appendMoves' reply (docs/SPEC.md § 4).
 */

export async function getOwnGame(db: Db | Tx, gameId: string, userId: string): Promise<Game> {
  const game = await db.query.games.findFirst({ where: eq(games.id, gameId) });
  if (!game) throw notFound('game-not-found');
  if (game.userId !== userId) throw forbidden();
  return game;
}

/** The client calls this once its board is rendered and it is ready to run the clock. */
export async function startGame(
  db: Db,
  cfg: Config,
  gameId: string,
  userId: string,
  now = new Date(),
): Promise<Game> {
  return db.transaction(async (tx) => {
    const game = await getOwnGame(tx, gameId, userId);
    if (game.status === 'playing') return game; // idempotent: a reload during play keeps the original clock
    if (game.status !== 'pending') throw conflict('game-not-pending');
    const deadlineAt = new Date(now.getTime() + RULES.durationMs + cfg.GAME_GRACE_MS);
    const [updated] = await tx
      .update(games)
      .set({ status: 'playing', startedAt: now, deadlineAt })
      .where(eq(games.id, gameId))
      .returning();
    if (!updated) throw notFound('game-not-found');
    return updated;
  });
}

function validateMoveShape(m: unknown, i: number): TimedMove {
  if (!isTimedMove(m)) throw badRequest('bad-move', `move ${i} is malformed`);
  return m;
}

/** The game as far as its stored moves go (not run out to the clock). */
export function currentState(game: Pick<Game, 'seed' | 'moves'>): GameState {
  return replayFrom(createGame(game.seed).state, game.moves);
}

/** What a client may know of a game's deal: every card it has been shown, nothing else. */
export function maskedDeal(game: Pick<Game, 'seed' | 'moves'>): (Card | null)[] {
  return seenMask(currentState(game));
}

export interface AppendResult {
  readonly count: number;
  /** Cards the new moves showed for the first time: the only way a client learns a face. */
  readonly reveals: { readonly slot: number; readonly card: Card }[];
  /** The server's state after the moves, for the client to check it is in step. */
  readonly stateHash: string;
}

/**
 * Append moves. Clients send moves as they happen so an abandoned tab still
 * leaves a scoreable record, and send a move that turns a card up at once,
 * because the reply is how they learn the card. Idempotent on `fromIndex`:
 * re-sending a batch the server already has is a no-op (and repeats the
 * reveals it caused), and a gap is rejected. Every move is replayed here, so
 * an illegal one is refused before it is stored.
 */
export async function appendMoves(
  db: Db,
  cfg: Config,
  gameId: string,
  userId: string,
  fromIndex: number,
  incoming: readonly unknown[],
  now = new Date(),
): Promise<AppendResult> {
  return db.transaction(async (tx) => {
    const game = await getOwnGame(tx, gameId, userId);
    if (game.status !== 'playing' || !game.startedAt) throw conflict('game-not-playing');
    const existing = game.moves;
    if (fromIndex > existing.length)
      throw conflict(
        'move-gap',
        `server has ${existing.length} moves, batch starts at ${fromIndex}`,
      );
    const fresh = incoming
      .slice(existing.length - fromIndex)
      .map((m, i) => validateMoveShape(m, existing.length + i));
    // A batch the server already has (a retry) is answered with what it showed then.
    const base = replayFrom(createGame(game.seed).state, existing.slice(0, fromIndex));
    const known = replayFrom(base, existing.slice(fromIndex));
    if (fresh.length === 0)
      return {
        count: existing.length,
        reveals: revealsIn(base, known),
        stateHash: stateHash(known),
      };

    const wallElapsed = now.getTime() - game.startedAt.getTime();
    let lastT = existing[existing.length - 1]?.tMs ?? -1;
    for (const m of fresh) {
      if (m.tMs < lastT) throw badRequest('bad-move', 'clock went backwards');
      if (m.tMs >= RULES.durationMs) throw badRequest('bad-move', 'move after the clock ran out');
      if (m.tMs > wallElapsed + cfg.CLOCK_TOLERANCE_MS)
        throw badRequest('bad-move', 'move is ahead of the wall clock');
      lastT = m.tMs;
    }
    // Replayed one move at a time: a move that shows a card for the first
    // time, or ends the game, is sent the moment it is made (the client
    // waits on the reply), so its time may not be backdated past the wall
    // clock: tMs >= wall-elapsed - tolerance. Otherwise a client could hold
    // a reveal, think, and send it stamped early — or stamp a clear early for
    // the time bonus and the tiebreak. A refused move is `stale-move`; the
    // client re-stamps it at its current clock and resends.
    let after: GameState = known;
    for (let i = 0; i < fresh.length; i++) {
      const m = fresh[i]!;
      const before = after;
      try {
        after = replayFrom(before, [m]);
      } catch (err) {
        if (err instanceof ReplayError)
          throw badRequest('bad-move', `move ${existing.length + i}: ${err.reason}`);
        throw err;
      }
      const bound = revealsIn(before, after).length > 0 || after.status !== 'playing';
      if (bound && m.tMs < wallElapsed - cfg.CLOCK_TOLERANCE_MS)
        throw conflict(
          'stale-move',
          `move ${existing.length + i} at ${m.tMs} ms is behind the wall clock (${wallElapsed} ms)`,
        );
    }
    const moves = [...existing, ...fresh];
    await tx.update(games).set({ moves }).where(eq(games.id, gameId));
    return { count: moves.length, reveals: revealsIn(base, after), stateHash: stateHash(after) };
  });
}

/** Score a game from its stored moves and mark it finished. */
export async function finalizeGame(
  tx: Tx,
  cfg: Config,
  game: Game,
  now = new Date(),
): Promise<Game> {
  if (game.status === 'finished') return game;
  let moves = game.moves;
  let state;
  try {
    state = replay(game.seed, moves);
  } catch (err) {
    // A move list the sim rejects means a buggy or dishonest client. Keep the
    // longest valid prefix so the player is scored on what was legitimate.
    if (!(err instanceof ReplayError)) throw err;
    moves = moves.slice(0, err.index);
    state = replay(game.seed, moves);
  }
  const breakdown = state.breakdown;
  if (!breakdown) throw new Error('replay did not finish the game');
  const [updated] = await tx
    .update(games)
    .set({
      status: 'finished',
      moves,
      score: breakdown.total,
      elapsedMs: breakdown.elapsedMs,
      endReason: breakdown.endReason,
      breakdown,
      // From this replay only: the client never sends a level.
      levelReached: breakdown.levelReached,
      finishedAt: now,
    })
    .where(eq(games.id, game.id))
    .returning();
  if (!updated) throw notFound('game-not-found');
  // The one place a game pays XP: the non-win parts, from this replay. The
  // win part is paid by the challenge settlement below, if there is one.
  const xp = xpForGame(breakdown, { challenge: !!updated.challengeId, won: null, pot: 0 });
  if (xp.total > 0) await awardXp(tx, updated.userId, xp.total, 'game', updated.id, xp.parts, now);
  if (updated.challengeId) await resolveChallengeIfReady(tx, cfg, updated.challengeId, now);
  return updated;
}

/**
 * The client says it is done (cleared, timeout, or forfeit). Any trailing moves
 * come with it. Idempotent: finishing a finished game (a retry, a quit after
 * the results) returns it as it stands and appends nothing.
 */
export async function finishGame(
  db: Db,
  cfg: Config,
  gameId: string,
  userId: string,
  trailing: { fromIndex: number; moves: readonly unknown[] } | undefined,
  now = new Date(),
): Promise<Game> {
  const current = await getOwnGame(db, gameId, userId);
  if (current.status === 'finished') return current;
  if (trailing && trailing.moves.length > 0)
    await appendMoves(db, cfg, gameId, userId, trailing.fromIndex, trailing.moves, now);
  return db.transaction(async (tx) => {
    const game = await getOwnGame(tx, gameId, userId);
    if (game.status === 'finished') return game;
    if (game.status !== 'playing') throw conflict('game-not-playing');
    return finalizeGame(tx, cfg, game, now);
  });
}

/**
 * Housekeeping: finalise games whose clock (plus grace) has run out, and
 * pending games nobody ever started. Called on a timer and before listings.
 */
export async function sweepGames(db: Db, cfg: Config, now = new Date()): Promise<number> {
  let count = 0;
  const overdue = await db.query.games.findMany({
    where: and(eq(games.status, 'playing'), lt(games.deadlineAt, now)),
    limit: 100,
  });
  const stale = await db.query.games.findMany({
    where: and(
      eq(games.status, 'pending'),
      lt(games.createdAt, new Date(now.getTime() - cfg.PENDING_GAME_TTL_MS)),
    ),
    limit: 100,
  });
  for (const game of [...overdue, ...stale]) {
    await db.transaction(async (tx) => {
      const fresh = await tx.query.games.findFirst({ where: eq(games.id, game.id) });
      if (!fresh || fresh.status === 'finished') return;
      await finalizeGame(tx, cfg, fresh, now);
      count++;
    });
  }
  return count;
}
