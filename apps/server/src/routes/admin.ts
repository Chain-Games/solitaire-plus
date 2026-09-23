import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { HttpError, unauthorized } from '../errors.js';
import { adminOverview, countSessions } from '../services/admin.js';

/**
 * The dashboard's one endpoint. No session: the key travels as
 * `Authorization: Bearer <ADMIN_TOKEN>`. An unset token means the API is OFF
 * (503), never open — it exposes every player's scores, devices and rough
 * locations, and a deployment that forgot to configure it must not publish
 * those. The shape mirrors 21 Wild's `/api/admin/overview`.
 */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get('/overview', async (req) => {
    const expected = app.cfg.ADMIN_TOKEN;
    if (!expected) throw new HttpError(503, 'admin-not-configured', 'admin api is not configured');
    const header = req.headers.authorization ?? '';
    const offered = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const a = Buffer.from(offered, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // timingSafeEqual throws on a length mismatch, so the length is checked first.
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw unauthorized();

    const [overview, sessions] = await Promise.all([
      adminOverview(app.db),
      countSessions(app.redis, app.sessionPrefix),
    ]);
    return { ...overview, live: { sessions }, generatedAt: new Date().toISOString() };
  });
};
