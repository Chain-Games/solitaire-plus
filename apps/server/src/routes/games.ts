import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireUserId } from '../context.js';
import { badRequest } from '../errors.js';
import { eq } from 'drizzle-orm';
import { challenges } from '../db/schema.js';
import { appendMoves, finishGame, getOwnGame, maskedDeal, startGame } from '../services/games.js';
import { levelReachedOf } from '../services/levels.js';
import { gameXpGained, type XpGained } from '../services/xp.js';

const id = z.object({ id: z.string().uuid() });
const batch = z.object({
  fromIndex: z.number().int().nonnegative(),
  moves: z.array(z.unknown()).max(500),
});

function view(
  g: Awaited<ReturnType<typeof getOwnGame>>,
  xpGained: XpGained | null,
  seedOpen: boolean,
) {
  return {
    id: g.id,
    challengeId: g.challengeId,
    /**
     * The seed is the answer key, so it is only shown once nothing can use it:
     * this game is finished and its challenge (if any) is settled or expired.
     */
    seed: seedOpen ? g.seed : null,
    /** Slot -> card for every card this game has shown; null for the rest. */
    deal: maskedDeal(g),
    status: g.status,
    startedAt: g.startedAt?.toISOString() ?? null,
    deadlineAt: g.deadlineAt?.toISOString() ?? null,
    moveCount: g.moves.length,
    moves: g.moves,
    score: g.score,
    elapsedMs: g.elapsedMs,
    endReason: g.endReason,
    breakdown: g.breakdown,
    levelReached: g.status === 'finished' ? levelReachedOf(g) : null,
    finishedAt: g.finishedAt?.toISOString() ?? null,
    /** What this game paid, from the server's award; null until finished. */
    xpGained,
    serverNow: new Date().toISOString(),
  };
}

export const gameRoutes: FastifyPluginAsync = async (app) => {
  /** A finished game's own award (the 'game' row); pending/playing games have none. */
  const withXp = async (g: Awaited<ReturnType<typeof getOwnGame>>) => {
    let seedOpen = g.status === 'finished';
    if (seedOpen && g.challengeId) {
      const c = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, g.challengeId),
        columns: { status: true },
      });
      seedOpen = c?.status === 'complete' || c?.status === 'expired';
    }
    return view(
      g,
      g.status === 'finished' ? await gameXpGained(app.db, g.userId, g.id) : null,
      seedOpen,
    );
  };

  app.get('/:id', async (req) => {
    const userId = requireUserId(req);
    const p = id.safeParse(req.params);
    if (!p.success) throw badRequest('bad-id');
    return { game: await withXp(await getOwnGame(app.db, p.data.id, userId)) };
  });

  app.post('/:id/start', async (req) => {
    const userId = requireUserId(req);
    const p = id.safeParse(req.params);
    if (!p.success) throw badRequest('bad-id');
    return { game: await withXp(await startGame(app.db, app.cfg, p.data.id, userId)) };
  });

  app.post('/:id/moves', async (req) => {
    const userId = requireUserId(req);
    const p = id.safeParse(req.params);
    if (!p.success) throw badRequest('bad-id');
    const b = batch.safeParse(req.body);
    if (!b.success) throw badRequest('bad-request', b.error.issues[0]?.message);
    return appendMoves(app.db, app.cfg, p.data.id, userId, b.data.fromIndex, b.data.moves);
  });

  app.post('/:id/finish', async (req) => {
    const userId = requireUserId(req);
    const p = id.safeParse(req.params);
    if (!p.success) throw badRequest('bad-id');
    const b = batch.optional().safeParse(req.body ?? undefined);
    if (!b.success) throw badRequest('bad-request', b.error.issues[0]?.message);
    return { game: await withXp(await finishGame(app.db, app.cfg, p.data.id, userId, b.data)) };
  });
};
