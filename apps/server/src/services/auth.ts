import { hash, verify } from '@node-rs/argon2';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { ledger, users, type User } from '../db/schema.js';
import { conflict, unauthorized } from '../errors.js';
import { newCode } from '../ids.js';
import { xpProgress } from './xp.js';

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    isGuest: u.isGuest,
    balance: u.balance,
    ...xpProgress(u.xp, u.xpLevel),
  };
}

export async function register(
  db: Db,
  cfg: Config,
  username: string,
  password: string,
): Promise<User> {
  const passwordHash = await hash(password);
  return db.transaction(async (tx) => {
    const existing = await tx.query.users.findFirst({ where: eq(users.username, username) });
    if (existing) throw conflict('username-taken');
    const [user] = await tx
      .insert(users)
      .values({ username, passwordHash, balance: cfg.STARTING_BALANCE })
      .returning();
    if (!user) throw new Error('failed to create user');
    if (cfg.STARTING_BALANCE > 0)
      await tx
        .insert(ledger)
        .values({ userId: user.id, amount: cfg.STARTING_BALANCE, kind: 'grant', refId: null });
    return user;
  });
}

export async function login(db: Db, username: string, password: string): Promise<User> {
  const user = await db.query.users.findFirst({ where: eq(users.username, username) });
  if (!user || !user.passwordHash) throw unauthorized('bad-credentials');
  const ok = await verify(user.passwordHash, password);
  if (!ok) throw unauthorized('bad-credentials');
  return user;
}

/** Frictionless try-it account. Cannot log back in once the session ends. */
export async function createGuest(db: Db, cfg: Config): Promise<User> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = `guest_${newCode(6).toLowerCase()}`;
    const existing = await db.query.users.findFirst({ where: eq(users.username, username) });
    if (existing) continue;
    return db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ username, isGuest: true, balance: cfg.STARTING_BALANCE })
        .returning();
      if (!user) throw new Error('failed to create guest');
      if (cfg.STARTING_BALANCE > 0)
        await tx
          .insert(ledger)
          .values({ userId: user.id, amount: cfg.STARTING_BALANCE, kind: 'grant', refId: null });
      return user;
    });
  }
  throw new Error('could not allocate a guest username');
}

export async function getUser(db: Db, id: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: eq(users.id, id) });
}

/**
 * The daily top-up: DAILY_GRANT once per DAILY_GRANT_INTERVAL_MS, credited
 * on the first session check of the day (so a returning player sees it the
 * moment they open the game). One ledger row of kind 'daily' per grant is
 * the record; the interval is measured from the last such row. Runs under a
 * row lock on the user so two tabs opening together cannot double-grant.
 * Returns the amount granted this call (0 when not due).
 */
export async function claimDailyGrant(db: Db, cfg: Config, userId: string, now = new Date()) {
  if (cfg.DAILY_GRANT <= 0) return 0;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
    const last = await tx.query.ledger.findFirst({
      where: and(eq(ledger.userId, userId), eq(ledger.kind, 'daily')),
      orderBy: [desc(ledger.createdAt)],
    });
    if (last && now.getTime() - last.createdAt.getTime() < cfg.DAILY_GRANT_INTERVAL_MS) return 0;
    await tx.insert(ledger).values({
      userId,
      amount: cfg.DAILY_GRANT,
      kind: 'daily',
      refId: null,
      createdAt: now,
    });
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${cfg.DAILY_GRANT}` })
      .where(eq(users.id, userId));
    return cfg.DAILY_GRANT;
  });
}
