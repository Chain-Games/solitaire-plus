import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../errors.js';
import { USERNAME_RE } from '../services/auth.js';
import { publicProfile } from '../services/profiles.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  /** Public profile: progression and lifetime counts. No session needed. */
  app.get('/:username', async (req) => {
    const p = z.object({ username: z.string().regex(USERNAME_RE) }).safeParse(req.params);
    if (!p.success) throw badRequest('bad-username');
    return { profile: await publicProfile(app.db, p.data.username) };
  });
};
