import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireUserId } from '../context.js';
import { badRequest } from '../errors.js';
import type { Notification } from '../db/schema.js';
import { listNotifications, markRead, notificationView } from '../services/notifications.js';
import type { NotifyBus } from '../services/notify-bus.js';

/** Open streams per user before the oldest is closed to make room. */
export const MAX_STREAMS_PER_USER = 3;
/** The comment that keeps proxies and browsers from timing an idle stream out. */
const PING_MS = 25_000;
/** What the client waits before reconnecting after a drop (the SSE `retry` field). */
const RETRY_MS = 5_000;

interface Stream {
  userId: string;
  sessionId: string;
  openedAt: number;
  close: () => void;
}

/**
 * The open Server-Sent-Events streams of this process: who holds them, so a
 * logout can close that session's and the per-user cap can evict the
 * oldest. Rows reach a stream through the bus (services/notify-bus.ts).
 */
export class StreamRegistry {
  private readonly byUser = new Map<string, Set<Stream>>();

  add(s: Stream): void {
    let set = this.byUser.get(s.userId);
    if (!set) {
      set = new Set();
      this.byUser.set(s.userId, set);
    }
    // The cap: the oldest stream of this user yields to the new one.
    while (set.size >= MAX_STREAMS_PER_USER) {
      const oldest = [...set].sort((x, y) => x.openedAt - y.openedAt)[0];
      if (!oldest) break;
      oldest.close();
      set.delete(oldest);
    }
    set.add(s);
  }

  remove(s: Stream): void {
    const set = this.byUser.get(s.userId);
    if (!set) return;
    set.delete(s);
    if (set.size === 0) this.byUser.delete(s.userId);
  }

  count(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }

  /** A session ended (logout): its streams close now, not at the next ping. */
  closeSession(sessionId: string): void {
    for (const set of this.byUser.values())
      for (const s of [...set]) if (s.sessionId === sessionId) s.close();
  }

  closeAll(): void {
    for (const set of this.byUser.values()) for (const s of [...set]) s.close();
    this.byUser.clear();
  }
}

export function sseEvent(row: Notification): string {
  return `event: notification\ndata: ${JSON.stringify(notificationView(row))}\n\n`;
}

export const notificationRoutes: FastifyPluginAsync<{
  bus: NotifyBus;
  streams: StreamRegistry;
}> = async (app, { bus, streams }) => {
  app.get('/', async (req) => {
    const userId = requireUserId(req);
    const q = z
      .object({ after: z.string().datetime({ offset: true }).optional() })
      .safeParse(req.query);
    if (!q.success) throw badRequest('bad-request', 'after must be an ISO date');
    return listNotifications(app.db, userId, q.data.after ? new Date(q.data.after) : undefined);
  });

  app.post('/read', async (req) => {
    const userId = requireUserId(req);
    const body = z
      .object({ ids: z.array(z.string().uuid()).max(200).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) throw badRequest('bad-request');
    return { unread: await markRead(app.db, userId, body.data.ids) };
  });

  /**
   * Server-Sent Events: one `notification` event per row written for this
   * user from now on, a `: ping` comment every 25 s, `retry: 5000` so a
   * dropped connection comes back on its own. The reply is hijacked and
   * written raw; nothing is buffered.
   */
  app.get('/stream', (req, reply: FastifyReply) => {
    const userId = requireUserId(req);
    const sessionId = req.session.sessionId;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx and friends would otherwise hold the stream in a buffer.
      'x-accel-buffering': 'no',
    });
    res.write(`retry: ${RETRY_MS}\n\n`);

    let open = true;
    const write = (chunk: string) => {
      if (!open) return;
      try {
        res.write(chunk);
      } catch {
        stream.close();
      }
    };
    const unsubscribe = bus.subscribe(userId, (row) => write(sseEvent(row)));
    const ping = setInterval(() => write(': ping\n\n'), PING_MS);
    ping.unref();
    const stream: Stream = {
      userId,
      sessionId,
      openedAt: Date.now(),
      close: () => {
        if (!open) return;
        open = false;
        clearInterval(ping);
        unsubscribe();
        streams.remove(stream);
        try {
          res.end();
        } catch {
          // already gone
        }
      },
    };
    streams.add(stream);
    req.raw.on('close', stream.close);
    res.on('close', stream.close);
  });
};
