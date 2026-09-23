import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { ScoreBreakdown, TimedMove, XpParts } from '@solitaire-plus/sim';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  /** Null for guest accounts, which cannot log back in. */
  passwordHash: text('password_hash'),
  isGuest: boolean('is_guest').notNull().default(false),
  /** Mock $CHAIN, whole units. Off-chain for the alpha. */
  balance: integer('balance').notNull().default(0),
  /** Lifetime XP. Only ever grows; every change is an xp_events row. */
  xp: integer('xp').notNull().default(0),
  /** Cached xpLevelFor(xp), recomputed on every award. */
  xpLevel: integer('xp_level').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type XpEventKind = 'game' | 'challenge_win' | 'adjust';

/**
 * Every XP award, for audit and for the "you gained" itemisation on the
 * results screen. (ref_id, kind, user_id) is unique so a game or a challenge
 * can never award the same player twice, whatever path re-finalises it. The
 * user is part of the key: a challenge ref is shared by both players, and a
 * key without it would silently drop the second player's award.
 */
export const xpEvents = pgTable(
  'xp_events',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    amount: integer('amount').notNull(),
    kind: text('kind').$type<XpEventKind>().notNull(),
    /** Game id for 'game', challenge id for 'challenge_win', null for a manual adjustment. */
    refId: uuid('ref_id'),
    parts: jsonb('parts').$type<XpParts>().notNull(),
    /** The user's XP total either side of this award. */
    xpBefore: integer('xp_before').notNull(),
    xpAfter: integer('xp_after').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('xp_events_user_idx').on(t.userId, t.createdAt),
    uniqueIndex('xp_events_ref_kind_user_idx').on(t.refId, t.kind, t.userId),
  ],
);

export type LedgerKind = 'grant' | 'daily' | 'entry_fee' | 'payout' | 'refund';

/** Every balance change, so the mock economy can be audited and later mirrored on-chain. */
export const ledger = pgTable(
  'ledger',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Signed. Negative for fees. */
    amount: integer('amount').notNull(),
    kind: text('kind').$type<LedgerKind>().notNull(),
    /** Challenge id for fees/payouts/refunds. */
    refId: uuid('ref_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ledger_user_idx').on(t.userId, t.createdAt)],
);

export type GameStatus = 'pending' | 'playing' | 'finished';
export type EndReason = 'cleared' | 'timeout' | 'forfeit';

export const games = pgTable(
  'games',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    challengeId: uuid('challenge_id'),
    /** The deal. Never sent to the client while either side of the challenge is unfinished. */
    seed: text('seed').notNull(),
    status: text('status').$type<GameStatus>().notNull().default('pending'),
    /** Set when the client reports it is ready; the game clock runs from here. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    /** startedAt + duration + grace. After this the server finalises whatever it has. */
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    moves: jsonb('moves')
      .$type<TimedMove[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    score: integer('score'),
    elapsedMs: integer('elapsed_ms'),
    endReason: text('end_reason').$type<EndReason>(),
    breakdown: jsonb('breakdown').$type<ScoreBreakdown>(),
    /** Cosmetic level reached, from the server's own replay. Never taken from the client. */
    levelReached: integer('level_reached'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('games_user_idx').on(t.userId, t.createdAt),
    index('games_status_idx').on(t.status),
  ],
);

/**
 * Challenge lifecycle:
 *   pending  — creator is still playing their game
 *   open     — creator finished; waiting for a taker
 *   taken    — taker is playing
 *   complete — both finished, winner paid
 *   expired  — no taker before expiresAt; creator refunded
 */
export type ChallengeStatus = 'pending' | 'open' | 'taken' | 'complete' | 'expired';

export const challenges = pgTable(
  'challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Short shareable code for private challenges and links. */
    code: text('code').notNull().unique(),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => users.id),
    takerId: uuid('taker_id').references(() => users.id),
    seed: text('seed').notNull(),
    entryFee: integer('entry_fee').notNull(),
    /** Private challenges are only joinable by code, never by matchmaking. */
    isPrivate: boolean('is_private').notNull().default(false),
    status: text('status').$type<ChallengeStatus>().notNull().default('pending'),
    creatorGameId: uuid('creator_game_id')
      .notNull()
      .references(() => games.id),
    takerGameId: uuid('taker_game_id').references(() => games.id),
    winnerId: uuid('winner_id').references(() => users.id),
    /** What the winner was paid. */
    payout: integer('payout'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('challenges_open_idx').on(t.status, t.entryFee, t.isPrivate, t.createdAt),
    // A deal is dealt to one challenge, ever: a pool seed is single-use.
    uniqueIndex('challenges_seed_idx').on(t.seed),
    index('challenges_creator_idx').on(t.creatorId, t.createdAt),
    index('challenges_taker_idx').on(t.takerId, t.createdAt),
  ],
);

export type DeviceKind = 'phone' | 'tablet' | 'desktop';

/**
 * What the admin dashboard can tell about a player's browser: one row per
 * user, touched on the session check, never on the game path. The address
 * itself is never stored — `ip_hash` is sha256(ip + SESSION_SECRET), enough to
 * recognise a repeat address (and to geolocate it once) without being able
 * to say what it was. Location is coarse: country and region, never finer.
 */
export const clientMeta = pgTable(
  'client_meta',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id),
    device: text('device').$type<DeviceKind>().notNull(),
    os: text('os').notNull(),
    browser: text('browser').notNull(),
    /** ISO 3166-1 alpha-2 when known. */
    country: text('country'),
    region: text('region'),
    ipHash: text('ip_hash'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // The geo cache is "any row that already knows this hash", so the hash is indexed.
  (t) => [index('client_meta_ip_hash_idx').on(t.ipHash)],
);

/**
 * A score card the player chose to share: `/s/:id` unfurls into it. The PNGs
 * live on disk under SHARE_DIR named by the id; the row ties them to the game
 * (one card per game — a second share returns the first id) and to the user
 * who made it. Nothing is stored that the card does not already show.
 */
export const shareCards = pgTable(
  'share_cards',
  {
    /** Random, URL-safe, unguessable (`newShareId`). */
    id: text('id').primaryKey(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('share_cards_game_idx').on(t.gameId)],
);

export type NotificationKind =
  'challenge_won' | 'challenge_lost' | 'challenge_taken' | 'challenge_expired';

/**
 * One row per thing a player should be told about a challenge they are a
 * side of. Written in exactly one place per kind (services/challenges.ts):
 * the settlement writes `challenge_won` to the winner and `challenge_lost`
 * to the loser, the take writes `challenge_taken` to the creator, the expiry
 * sweep writes `challenge_expired` to the creator — each inside the same
 * transaction as the change it reports, and (user, challenge, kind) is
 * unique so a re-settled challenge can never tell anyone twice. `amount` is
 * signed $CHAIN as the player felt it: +net payout on a win, −stake on a
 * loss, +refund on expiry, 0 for a take. The row carries the opponent's
 * username and both scores so the inbox and the push payload never need a
 * second query — and never carry more than the challenge page shows anyway.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').$type<NotificationKind>().notNull(),
    challengeId: uuid('challenge_id')
      .notNull()
      .references(() => challenges.id),
    /** Which side the recipient was, so the copy can say "took your challenge" or "you took". */
    role: text('role').$type<'creator' | 'taker'>().notNull(),
    /** Empty when there was no opponent (an expiry). */
    opponentUsername: text('opponent_username').notNull().default(''),
    amount: integer('amount').notNull(),
    myScore: integer('my_score'),
    theirScore: integer('their_score'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.createdAt.desc()),
    index('notifications_user_read_idx').on(t.userId, t.readAt),
    uniqueIndex('notifications_user_challenge_kind_idx').on(t.userId, t.challengeId, t.kind),
  ],
);

/**
 * A browser's Web Push subscription (the endpoint is the push service's URL
 * for that browser + site, unique by construction). A 404/410 from the push
 * service deletes the row; any other failure stamps `failed_at` and the row
 * is tried again next time. Nothing here identifies the device beyond the
 * User-Agent the browser sent when it subscribed.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    endpoint: text('endpoint').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (t) => [index('push_subscriptions_user_idx').on(t.userId)],
);

export type User = typeof users.$inferSelect;
export type Game = typeof games.$inferSelect;
export type Challenge = typeof challenges.$inferSelect;
export type XpEvent = typeof xpEvents.$inferSelect;
export type ClientMeta = typeof clientMeta.$inferSelect;
export type ShareCard = typeof shareCards.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
