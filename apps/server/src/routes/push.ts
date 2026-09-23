import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireUserId } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import {
  deleteSubscription,
  parseSubscription,
  pushEnabled,
  saveSubscription,
} from '../services/push.js';

/**
 * Web Push subscriptions. Every route answers 404 `push-off` while the
 * VAPID keys are unset: a client that asks first (`/vapid`) never subscribes
 * against a server that could not send.
 */
export const pushRoutes: FastifyPluginAsync = async (app) => {
  const requireOn = () => {
    if (!pushEnabled(app.cfg)) throw notFound('push-off', 'Push is not configured on this server.');
  };

  app.get('/vapid', async () => {
    requireOn();
    return { publicKey: app.cfg.VAPID_PUBLIC_KEY };
  });

  app.post('/subscribe', async (req) => {
    const userId = requireUserId(req);
    requireOn();
    const body = z.object({ subscription: z.unknown() }).safeParse(req.body);
    if (!body.success) throw badRequest('bad-request');
    const sub = parseSubscription(body.data.subscription);
    await saveSubscription(app.db, userId, sub, req.headers['user-agent']);
    return { ok: true };
  });

  app.delete('/subscribe', async (req) => {
    const userId = requireUserId(req);
    const body = z.object({ endpoint: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!body.success) throw badRequest('bad-request');
    // Unsubscribing is always allowed, even with push off: the row must go.
    return { ok: true, removed: await deleteSubscription(app.db, userId, body.data.endpoint) };
  });
};
