import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ENTRY_FEES } from '../config.js';
import { requireUserId } from '../context.js';
import { badRequest } from '../errors.js';
import {
  createChallenge,
  listMine,
  listOpen,
  sweepChallenges,
  takeByCode,
  takeRandom,
  viewChallenge,
} from '../services/challenges.js';
import { sweepGames } from '../services/games.js';

const feeSchema = z
  .number()
  .int()
  .refine((f) => (ENTRY_FEES as readonly number[]).includes(f), 'bad-fee');

/** A fee outside the ladder is `bad-fee` (the code 21 Wild answers too); anything else malformed is `bad-request`. */
function feeError(issues: { message: string }[]) {
  const msg = issues[0]?.message;
  return msg === 'bad-fee'
    ? badRequest('bad-fee', `entry fee must be one of ${ENTRY_FEES.join(', ')}`)
    : badRequest('bad-request', msg);
}

export const challengeRoutes: FastifyPluginAsync = async (app) => {
  app.get('/fees', async () => ({ fees: ENTRY_FEES }));

  app.post('/', async (req) => {
    const userId = requireUserId(req);
    const body = z
      .object({ entryFee: feeSchema, isPrivate: z.boolean().default(false) })
      .safeParse(req.body);
    if (!body.success) throw feeError(body.error.issues);
    const { challenge, game } = await createChallenge(
      app.db,
      app.cfg,
      app.deals,
      userId,
      body.data.entryFee,
      body.data.isPrivate,
    );
    return { challengeId: challenge.id, code: challenge.code, gameId: game.id };
  });

  app.get('/open', async (req) => {
    const userId = requireUserId(req);
    const q = z.object({ entryFee: z.coerce.number().int().optional() }).safeParse(req.query);
    if (!q.success) throw badRequest('bad-request');
    await sweepGames(app.db, app.cfg);
    await sweepChallenges(app.db);
    const items = await listOpen(app.db, userId, q.data.entryFee);
    return { challenges: items };
  });

  app.post('/take', async (req) => {
    const userId = requireUserId(req);
    const body = z.object({ entryFee: feeSchema }).safeParse(req.body);
    if (!body.success) throw feeError(body.error.issues);
    await sweepGames(app.db, app.cfg);
    const { challenge, game } = await takeRandom(app.db, app.cfg, userId, body.data.entryFee);
    return { challengeId: challenge.id, code: challenge.code, gameId: game.id };
  });

  app.post('/take/:code', async (req) => {
    const userId = requireUserId(req);
    const params = z.object({ code: z.string().regex(/^[A-Za-z0-9]{6}$/) }).safeParse(req.params);
    if (!params.success) throw badRequest('bad-code');
    await sweepGames(app.db, app.cfg);
    const { challenge, game } = await takeByCode(app.db, app.cfg, userId, params.data.code);
    return { challengeId: challenge.id, code: challenge.code, gameId: game.id };
  });

  app.get('/mine', async (req) => {
    const userId = requireUserId(req);
    await sweepGames(app.db, app.cfg);
    await sweepChallenges(app.db);
    return { challenges: await listMine(app.db, userId) };
  });

  app.get('/:id', async (req) => {
    const userId = requireUserId(req);
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) throw badRequest('bad-id');
    await sweepGames(app.db, app.cfg);
    return { challenge: await viewChallenge(app.db, params.data.id, userId) };
  });
};
