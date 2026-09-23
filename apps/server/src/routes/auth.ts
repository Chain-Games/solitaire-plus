import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireUserId } from '../context.js';
import { badRequest, unauthorized } from '../errors.js';
import {
  USERNAME_RE,
  claimDailyGrant,
  createGuest,
  getUser,
  login,
  publicUser,
  register,
} from '../services/auth.js';
import { noteClient } from '../services/telemetry.js';

const credentials = z.object({
  username: z.string().regex(USERNAME_RE, '3-20 letters, digits or underscores'),
  password: z.string().min(8).max(200),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/register', async (req) => {
    const body = credentials.safeParse(req.body);
    if (!body.success) throw badRequest('bad-request', body.error.issues[0]?.message);
    const user = await register(app.db, app.cfg, body.data.username, body.data.password);
    await req.session.regenerate();
    req.session.userId = user.id;
    return { user: publicUser(user) };
  });

  app.post('/login', async (req) => {
    const body = credentials.safeParse(req.body);
    if (!body.success) throw badRequest('bad-request', body.error.issues[0]?.message);
    const user = await login(app.db, body.data.username, body.data.password);
    await req.session.regenerate();
    req.session.userId = user.id;
    return { user: publicUser(user) };
  });

  app.post('/guest', async (req) => {
    const user = await createGuest(app.db, app.cfg);
    await req.session.regenerate();
    req.session.userId = user.id;
    return { user: publicUser(user) };
  });

  app.post('/logout', async (req) => {
    const sessionId = req.session.sessionId;
    await req.session.destroy();
    // A stream opened by this session must not outlive it.
    app.streams.closeSession(sessionId);
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const id = requireUserId(req);
    // The daily top-up lands here: the session check every page load makes.
    const granted = await claimDailyGrant(app.db, app.cfg, id);
    const user = await getUser(app.db, id);
    if (!user) throw unauthorized();
    // Telemetry for the admin dashboard, after the response has gone out and
    // never on a game path; it swallows its own errors and rate-limits itself.
    const client = { headers: req.headers, ip: req.ip };
    setImmediate(() => void noteClient(app.db, app.cfg, client, id));
    return { user: publicUser(user), dailyGranted: granted };
  });
};
