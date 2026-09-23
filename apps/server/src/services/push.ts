import { and, eq } from 'drizzle-orm';
import webpush from 'web-push';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { pushSubscriptions, type Notification } from '../db/schema.js';
import { badRequest } from '../errors.js';
import { describe } from './notifications.js';

/**
 * Web Push. OFF unless all three VAPID values are configured: then
 * `/api/push/vapid` is 404, subscribe is refused, and `send` is never
 * called. When on, every committed notification row becomes one push per
 * subscription of that user, carrying a username, an amount and a link —
 * the same words the toast shows, nothing the challenge page would not.
 *
 * Push must never break settlement: sends run after the commit, detached,
 * and every failure is swallowed here — a 404/410 (the browser dropped the
 * subscription) deletes the row, anything else stamps `failed_at`.
 */

/** The slice of the `web-push` library this module uses, so a test can hand in a fake. */
export interface WebPushLib {
  sendNotification: (
    subscription: webpush.PushSubscription,
    payload: string,
    options: webpush.RequestOptions,
  ) => Promise<unknown>;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export function pushEnabled(cfg: Config): boolean {
  return !!(cfg.VAPID_PUBLIC_KEY && cfg.VAPID_PRIVATE_KEY && cfg.VAPID_SUBJECT);
}

/** What a push carries for a row: title, one line, where to go, a tag so a re-send replaces rather than stacks. */
export function pushPayload(row: Notification): PushPayload {
  return {
    title: 'Solitaire Plus',
    body: describe(row),
    url: `/challenge/${row.challengeId}`,
    tag: `challenge-${row.challengeId}`,
  };
}

/** How long a push service should hold an undelivered push (a day: the challenge TTL). */
const PUSH_TTL_S = 24 * 60 * 60;

export class PushSender {
  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly lib: WebPushLib = webpush,
    private readonly log: (err: unknown) => void = () => {},
  ) {}

  /** Send `row` to every subscription of its user. Never throws. */
  async send(row: Notification): Promise<void> {
    if (!pushEnabled(this.cfg)) return;
    let subs;
    try {
      subs = await this.db.query.pushSubscriptions.findMany({
        where: eq(pushSubscriptions.userId, row.userId),
      });
    } catch (err) {
      this.log(err);
      return;
    }
    if (subs.length === 0) return;
    const payload = JSON.stringify(pushPayload(row));
    const vapidDetails = {
      subject: this.cfg.VAPID_SUBJECT,
      publicKey: this.cfg.VAPID_PUBLIC_KEY,
      privateKey: this.cfg.VAPID_PRIVATE_KEY,
    };
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await this.lib.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { vapidDetails, TTL: PUSH_TTL_S, urgency: 'normal', topic: payloadTopic(row) },
          );
          if (sub.failedAt)
            await this.db
              .update(pushSubscriptions)
              .set({ failedAt: null })
              .where(eq(pushSubscriptions.endpoint, sub.endpoint));
        } catch (err) {
          const status = statusOf(err);
          try {
            if (status === 404 || status === 410)
              await this.db
                .delete(pushSubscriptions)
                .where(eq(pushSubscriptions.endpoint, sub.endpoint));
            else {
              this.log(err);
              await this.db
                .update(pushSubscriptions)
                .set({ failedAt: new Date() })
                .where(eq(pushSubscriptions.endpoint, sub.endpoint));
            }
          } catch (dbErr) {
            this.log(dbErr);
          }
        }
      }),
    );
  }
}

/** Push services accept a `Topic` header of ≤ 32 URL-safe chars; a re-send for the same challenge replaces a pending one. */
function payloadTopic(row: Notification): string {
  return row.challengeId.replaceAll('-', '').slice(0, 32);
}

function statusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const s = (err as { statusCode?: unknown }).statusCode;
    if (typeof s === 'number') return s;
  }
  return undefined;
}

/* --------------------------------------------------------------------------
   Subscriptions
   -------------------------------------------------------------------------- */

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** What a browser's `PushSubscription.toJSON()` looks like, checked before it touches the database. */
export function parseSubscription(raw: unknown): SubscriptionInput {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const endpoint = o['endpoint'];
  const keys = (typeof o['keys'] === 'object' && o['keys'] !== null ? o['keys'] : {}) as Record<
    string,
    unknown
  >;
  const p256dh = keys['p256dh'];
  const auth = keys['auth'];
  if (typeof endpoint !== 'string' || !/^https:\/\/\S{1,1500}$/.test(endpoint))
    throw badRequest('bad-subscription', 'endpoint must be an https URL');
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !p256dh || !auth)
    throw badRequest('bad-subscription', 'keys.p256dh and keys.auth are required');
  if (p256dh.length > 200 || auth.length > 100)
    throw badRequest('bad-subscription', 'keys are too long');
  return { endpoint, keys: { p256dh, auth } };
}

/** Upsert: the same endpoint re-subscribed (a reload, a new session) is refreshed and re-owned. */
export async function saveSubscription(
  db: Db,
  userId: string,
  sub: SubscriptionInput,
  userAgent: string | undefined,
  now = new Date(),
): Promise<void> {
  const ua = userAgent?.slice(0, 300) ?? null;
  await db
    .insert(pushSubscriptions)
    .values({
      endpoint: sub.endpoint,
      userId,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent: ua,
      createdAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent: ua,
        lastSeenAt: now,
        failedAt: null,
      },
    });
}

/** Remove one of the caller's subscriptions; someone else's endpoint is silently left alone. */
export async function deleteSubscription(
  db: Db,
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const rows = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)))
    .returning({ endpoint: pushSubscriptions.endpoint });
  return rows.length > 0;
}
