import type { FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { StreamRegistry } from './routes/notifications.js';
import type { Notifier } from './services/notifier.js';
import { unauthorized } from './errors.js';

declare module 'fastify' {
  interface Session {
    userId?: string;
  }
  interface FastifyInstance {
    db: Db;
    cfg: Config;
    redis: Redis;
    /** The session store's key prefix, so the admin overview can count live sessions. */
    sessionPrefix: string;
    /** Delivery of committed notification rows (the bus, Web Push). */
    notifier: Notifier;
    /** The open SSE streams, so a logout can close that session's. */
    streams: StreamRegistry;
  }
}

export function requireUserId(req: FastifyRequest): string {
  const id = req.session.userId;
  if (!id) throw unauthorized();
  return id;
}
