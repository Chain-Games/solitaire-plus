import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/index.js';
import { enqueue } from '../db/outbox.js';
import { notifications, type Notification, type NotificationKind } from '../db/schema.js';

/**
 * Notifications: the rows, their JSON shape and the words for them.
 *
 * Rows are written by `notify` from exactly one place per kind
 * (services/challenges.ts — the settlement, the take, the expiry sweep),
 * inside that change's transaction, idempotent on (user, challenge, kind).
 * Delivery (the live stream, Web Push) happens after the commit through the
 * db outbox and `Notifier` (services/notifier.ts); this module never sends.
 */

export interface NotifyInput {
  userId: string;
  kind: NotificationKind;
  challengeId: string;
  role: 'creator' | 'taker';
  opponentUsername: string;
  /** Signed $CHAIN as the player felt it: +net on a win, −stake on a loss, +refund on expiry, 0 on a take. */
  amount: number;
  myScore?: number | null;
  theirScore?: number | null;
}

/** Insert a notification row; a duplicate (same user, challenge, kind) is a no-op and returns null. */
export async function notify(
  tx: Tx,
  input: NotifyInput,
  now = new Date(),
): Promise<Notification | null> {
  const [row] = await tx
    .insert(notifications)
    .values({
      userId: input.userId,
      kind: input.kind,
      challengeId: input.challengeId,
      role: input.role,
      opponentUsername: input.opponentUsername,
      amount: input.amount,
      myScore: input.myScore ?? null,
      theirScore: input.theirScore ?? null,
      createdAt: now,
    })
    .onConflictDoNothing({
      target: [notifications.userId, notifications.challengeId, notifications.kind],
    })
    .returning();
  if (!row) return null;
  enqueue(tx, row);
  return row;
}

/** The 20 newest (optionally only those after `after`) and the unread count. */
export async function listNotifications(
  db: Db,
  userId: string,
  after: Date | undefined,
  limit = 20,
): Promise<{ items: NotificationView[]; unread: number }> {
  const conds = [eq(notifications.userId, userId)];
  if (after) conds.push(gt(notifications.createdAt, after));
  const [rows, unread] = await Promise.all([
    db.query.notifications.findMany({
      where: and(...conds),
      orderBy: desc(notifications.createdAt),
      limit,
    }),
    unreadCount(db, userId),
  ]);
  return { items: rows.map(notificationView), unread };
}

export async function unreadCount(db: Db, userId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return rows[0]?.n ?? 0;
}

/** Mark the given rows (or every unread row when `ids` is omitted) read; only the caller's own rows ever change. */
export async function markRead(
  db: Db,
  userId: string,
  ids: readonly string[] | undefined,
  now = new Date(),
): Promise<number> {
  const conds = [eq(notifications.userId, userId), isNull(notifications.readAt)];
  if (ids) {
    if (ids.length === 0) return unreadCount(db, userId);
    conds.push(inArray(notifications.id, [...ids]));
  }
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(and(...conds));
  return unreadCount(db, userId);
}

/** The JSON a client sees: the row, ISO dates, nothing about the other player but their name. */
export interface NotificationView {
  id: string;
  kind: NotificationKind;
  challengeId: string;
  role: 'creator' | 'taker';
  opponent: string;
  amount: number;
  myScore: number | null;
  theirScore: number | null;
  createdAt: string;
  readAt: string | null;
}

export function notificationView(row: Notification): NotificationView {
  return {
    id: row.id,
    kind: row.kind,
    challengeId: row.challengeId,
    role: row.role,
    opponent: row.opponentUsername,
    amount: row.amount,
    myScore: row.myScore,
    theirScore: row.theirScore,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}

/** "+20 $CHAIN" / "−10 $CHAIN" (a real minus sign). */
export function chainText(amount: number): string {
  return `${amount < 0 ? '−' : '+'}${Math.abs(amount).toLocaleString('en-US')} $CHAIN`;
}

/**
 * One line for a push notification's body: who, what, how much. The same
 * words the toast uses, so the two never disagree. Carries only what the
 * challenge page shows the player anyway — a username and the amounts.
 */
export function describe(
  row: Pick<Notification, 'kind' | 'role' | 'opponentUsername' | 'amount'>,
): string {
  const who = row.opponentUsername || 'Someone';
  const took =
    row.role === 'creator' ? `${who} took your challenge` : `You took ${who}'s challenge`;
  switch (row.kind) {
    case 'challenge_won':
      return `${took} — you won ${chainText(row.amount)}`;
    case 'challenge_lost':
      return `${took} — you lost ${chainText(row.amount)}`;
    case 'challenge_taken':
      return `${who} took your challenge · playing now`;
    case 'challenge_expired':
      return `No one took your challenge · ${Math.abs(row.amount).toLocaleString('en-US')} $CHAIN refunded`;
  }
}
