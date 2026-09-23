import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import session from '@fastify/session';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import Redis from 'ioredis';
import { RULES } from '@solitaire-plus/sim';
import type { Config } from './config.js';
import { createDb } from './db/index.js';
import { HttpError } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { challengeRoutes } from './routes/challenges.js';
import { gameRoutes } from './routes/games.js';
import { StreamRegistry, notificationRoutes } from './routes/notifications.js';
import { practiceRoutes } from './routes/practice.js';
import { pushRoutes } from './routes/push.js';
import { shareRoutes } from './routes/share.js';
import { userRoutes } from './routes/users.js';
import { sweepChallenges } from './services/challenges.js';
import { DealPools } from './services/deals.js';
import { sweepGames } from './services/games.js';
import { Notifier } from './services/notifier.js';
import { MemoryNotifyBus } from './services/notify-bus.js';
import { PushSender, type WebPushLib } from './services/push.js';
import { RedisSessionStore } from './session-store.js';

const SESSION_TTL_S = 30 * 24 * 60 * 60;

export interface BuildOptions {
  /** The Web Push transport; a test hands in a fake, production uses the `web-push` package. */
  webPush?: WebPushLib | undefined;
}

export async function buildApp(cfg: Config, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    logger: { level: cfg.NODE_ENV === 'test' ? 'silent' : 'info' },
    trustProxy: true,
  });

  const { db, client } = createDb(cfg.DATABASE_URL);
  const redis = new Redis(cfg.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
  await redis.connect();

  const sessionStore = new RedisSessionStore(redis, SESSION_TTL_S);
  app.decorate('db', db);
  app.decorate('cfg', cfg);
  app.decorate('redis', redis);
  app.decorate('sessionPrefix', sessionStore.prefix);

  // Notifications: rows committed by a settlement / take / expiry reach the
  // user's open streams through the bus and their browsers through Web Push.
  // The bus is in-process (services/notify-bus.ts explains the one seam a
  // multi-instance deploy replaces).
  const bus = new MemoryNotifyBus();
  const streams = new StreamRegistry();
  const notifier = new Notifier(
    db,
    bus,
    new PushSender(db, cfg, opts.webPush, (err) => app.log.warn(err, 'web push failed')),
  );
  app.decorate('notifier', notifier);
  app.decorate('streams', streams);
  const deals = new DealPools(redis, cfg, app.log);
  app.decorate('deals', deals);

  await app.register(cors, { origin: cfg.PUBLIC_URL, credentials: true });
  await app.register(cookie);
  await app.register(session, {
    secret: cfg.SESSION_SECRET,
    cookieName: 'solitaire.sid',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.NODE_ENV === 'production',
      maxAge: SESSION_TTL_S * 1000,
      path: '/',
    },
    saveUninitialized: false,
    store: sessionStore,
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    const e = err as { statusCode?: unknown; message?: unknown };
    const status = typeof e.statusCode === 'number' ? e.statusCode : 500;
    if (status >= 500) req.log.error(err);
    return reply.status(status).send({
      error: status >= 500 ? 'internal' : 'bad-request',
      message: status >= 500 ? 'Something went wrong.' : String(e.message ?? 'Bad request'),
    });
  });

  app.get('/api/health', async () => ({ ok: true, rules: { durationMs: RULES.durationMs } }));
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(challengeRoutes, { prefix: '/api/challenges' });
  await app.register(gameRoutes, { prefix: '/api/games' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(notificationRoutes, { prefix: '/api/notifications', bus, streams });
  await app.register(pushRoutes, { prefix: '/api/push' });
  await app.register(practiceRoutes, { prefix: '/api/practice' });
  // Full paths inside: /api/share, and /s/:id outside the API namespace so a
  // pasted link is short and the static fallback below never sees it.
  await app.register(shareRoutes);

  // Production: the built client from STATIC_DIR — hashed assets cached for a
  // year, index.html never, and every non-API path falls back to index.html so
  // the client router owns /profile, /challenge/:id, ... on a hard reload.
  if (cfg.STATIC_DIR && existsSync(path.join(cfg.STATIC_DIR, 'index.html'))) {
    // index.html is served from memory, not disk: its social-card tags carry
    // absolute URLs, and the origin is only known here (PUBLIC_URL), so the
    // __PUBLIC_URL__ token the client build leaves in is filled in once.
    const indexHtml = readFileSync(path.join(cfg.STATIC_DIR, 'index.html'), 'utf8').replaceAll(
      '__PUBLIC_URL__',
      cfg.PUBLIC_URL.replace(/\/+$/, ''),
    );
    const sendIndex = (reply: FastifyReply) =>
      reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').send(indexHtml);

    await app.register(fastifyStatic, {
      root: path.resolve(cfg.STATIC_DIR),
      wildcard: false,
      index: false, // `/` is ours (below), so it gets the substituted index.html
      allowedPath: (pathName) => pathName !== '/index.html', // 404 → fallback → substituted
      cacheControl: false, // ours below; the plugin's own header would replace it
      setHeaders: (res, filePath) => {
        res.setHeader(
          'cache-control',
          filePath.includes(`${path.sep}assets${path.sep}`)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        );
      },
    });
    app.get('/', (_req, reply) => sendIndex(reply));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET')
        return reply.status(404).send({ error: 'not-found', message: 'not-found' });
      return sendIndex(reply);
    });
  }

  // Housekeeping: finalise overdue games and refund expired challenges.
  const sweeper = setInterval(() => {
    void Promise.all([sweepGames(db, cfg), sweepChallenges(db)]).catch((err: unknown) =>
      app.log.error(err),
    );
  }, 30_000);
  sweeper.unref();

  // Keep the solvable-deal pools topped up (a no-op for DEALS=any).
  deals.start();

  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    await deals.stop();
    streams.closeAll();
    notifier.close();
    await redis.quit();
    await client.end();
  });

  return app;
}
