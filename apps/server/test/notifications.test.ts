import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { resolveChallengeIfReady, sweepChallenges } from '../src/services/challenges.js';
import { chainText, describe as describeRow } from '../src/services/notifications.js';
import type { WebPushLib } from '../src/services/push.js';
import {
  bot,
  ensureDatabase,
  greedy,
  makeClient,
  seedOf,
  testDatabaseUrl,
  truncateAll,
  type TestClient,
} from './helpers.js';

const devUrl = process.env['DATABASE_URL'];
const suite = devUrl ? describe : describe.skip;

type NewGame = { challengeId: string; code: string; gameId: string };

/** Random moves the losing side plays: too few for any line to outscore greedy. */
const WEAK = 3;
type UserRes = { user: { id: string; username: string; balance: number } };
type Item = {
  id: string;
  kind: string;
  challengeId: string;
  role: string;
  opponent: string;
  amount: number;
  myScore: number | null;
  theirScore: number | null;
  createdAt: string;
  readAt: string | null;
};
type ListRes = { items: Item[]; unread: number };

suite('notifications', () => {
  let app: FastifyInstance;
  let db: postgres.Sql;
  const testUrl = devUrl ? testDatabaseUrl(devUrl) : '';
  const cfg = devUrl
    ? loadConfig({
        ...process.env,
        DATABASE_URL: testUrl,
        NODE_ENV: 'test',
        CLOCK_TOLERANCE_MS: '600000',
        DAILY_GRANT: '0',
        VAPID_PUBLIC_KEY: '',
        VAPID_PRIVATE_KEY: '',
        VAPID_SUBJECT: '',
      })
    : null;

  beforeAll(async () => {
    if (!cfg || !devUrl) return;
    if (cfg.DATABASE_URL === devUrl)
      throw new Error('refusing to run the tests on the dev database');
    await ensureDatabase(devUrl, cfg.DATABASE_URL);
    await runMigrations(cfg.DATABASE_URL);
    await truncateAll(cfg.DATABASE_URL);
    db = postgres(cfg.DATABASE_URL);
    app = await buildApp(cfg);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  /** Two guests; A creates and plays (greedy), B takes and plays (a few random moves) — A wins. */
  async function playOut(
    A: TestClient,
    B: TestClient,
    fee: number,
    opts: { finishB?: boolean; signedIn?: boolean } = {},
  ) {
    const who = (c: TestClient) =>
      opts.signedIn ? c<UserRes>('GET', '/api/auth/me') : c<UserRes>('POST', '/api/auth/guest');
    const ua = await who(A);
    const ub = await who(B);
    const created = await A<NewGame>('POST', '/api/challenges', { entryFee: fee });
    expect(created.status).toBe(200);
    await A('POST', `/api/games/${created.json.gameId}/start`);
    await A('POST', `/api/games/${created.json.gameId}/finish`, {
      fromIndex: 0,
      moves: greedy(await seedOf(db, created.json.gameId)).moves,
    });
    const taken = await B<NewGame>('POST', '/api/challenges/take', { entryFee: fee });
    expect(taken.status).toBe(200);
    await B('POST', `/api/games/${taken.json.gameId}/start`);
    if (opts.finishB !== false)
      await B('POST', `/api/games/${taken.json.gameId}/finish`, {
        fromIndex: 0,
        moves: bot(await seedOf(db, taken.json.gameId), 'bot-n', WEAK).moves,
      });
    return { a: ua.json.user, b: ub.json.user, challengeId: created.json.challengeId, taken };
  }

  it('settlement tells the winner (+net) and the loser (−stake) once; a re-settle adds nothing', async () => {
    const A = makeClient(app);
    const B = makeClient(app);
    const { a, b, challengeId } = await playOut(A, B, 25);

    const la = await A<ListRes>('GET', '/api/notifications');
    const lb = await B<ListRes>('GET', '/api/notifications');
    expect(la.status).toBe(200);
    const won = la.json.items.find((i) => i.kind === 'challenge_won')!;
    expect(won).toBeDefined();
    expect(won.challengeId).toBe(challengeId);
    expect(won.role).toBe('creator');
    expect(won.opponent).toBe(b.username);
    // The pot is 50, the stake 25: the winner's net is +25.
    expect(won.amount).toBe(25);
    // Greedy never scores below WEAK random moves; a tie goes to A, who finished first.
    expect(won.myScore).toBeGreaterThanOrEqual(won.theirScore ?? 0);
    expect(won.readAt).toBeNull();
    // A also heard the take, before the result.
    const taken = la.json.items.find((i) => i.kind === 'challenge_taken')!;
    expect(taken.amount).toBe(0);
    expect(taken.opponent).toBe(b.username);
    expect(la.json.items[0]?.kind).toBe('challenge_won'); // newest first
    expect(la.json.unread).toBe(2);

    const lost = lb.json.items.find((i) => i.kind === 'challenge_lost')!;
    expect(lost.role).toBe('taker');
    expect(lost.opponent).toBe(a.username);
    expect(lost.amount).toBe(-25);
    expect(lost.myScore).toBe(won.theirScore);
    expect(lost.theirScore).toBe(won.myScore);
    expect(lb.json.items.some((i) => i.kind === 'challenge_taken')).toBe(false);
    expect(lb.json.unread).toBe(1);

    // Re-settle: the unique (user, challenge, kind) index swallows the duplicate.
    await app.db.transaction((tx) => resolveChallengeIfReady(tx, cfg!, challengeId, new Date()));
    const sql = postgres(cfg!.DATABASE_URL);
    const rows =
      await sql`SELECT count(*)::int AS n FROM notifications WHERE challenge_id = ${challengeId}`;
    await sql.end();
    expect(rows[0]?.n).toBe(3); // taken + won + lost
    expect((await A<ListRes>('GET', '/api/notifications')).json.unread).toBe(2);
  });

  it('an expiry tells the creator the stake came back', async () => {
    const A = makeClient(app);
    await A<UserRes>('POST', '/api/auth/guest');
    const created = await A<NewGame>('POST', '/api/challenges', { entryFee: 10 });
    await A('POST', `/api/games/${created.json.gameId}/start`);
    await A('POST', `/api/games/${created.json.gameId}/finish`, { fromIndex: 0, moves: [] });
    const later = new Date(Date.now() + cfg!.CHALLENGE_TTL_MS + 60_000);
    expect(await sweepChallenges(app.db, later)).toBeGreaterThanOrEqual(1);
    expect(await sweepChallenges(app.db, later)).toBe(0);
    const l = await A<ListRes>('GET', '/api/notifications');
    const exp = l.json.items.find((i) => i.challengeId === created.json.challengeId)!;
    expect(exp.kind).toBe('challenge_expired');
    expect(exp.amount).toBe(10);
    expect(exp.opponent).toBe('');
    expect(
      describeRow({ kind: 'challenge_expired', role: 'creator', opponentUsername: '', amount: 10 }),
    ).toBe('No one took your challenge · 10 $CHAIN refunded');
  });

  it('lists the newest 20 with the unread count; read by ids, then all; `after` filters', async () => {
    const A = makeClient(app);
    const B = makeClient(app);
    const { challengeId } = await playOut(A, B, 5);
    const l1 = await A<ListRes>('GET', '/api/notifications');
    expect(l1.json.unread).toBe(2);
    const wonId = l1.json.items.find((i) => i.kind === 'challenge_won')!.id;

    const r1 = await A<{ unread: number }>('POST', '/api/notifications/read', { ids: [wonId] });
    expect(r1.status).toBe(200);
    expect(r1.json.unread).toBe(1);
    const l2 = await A<ListRes>('GET', '/api/notifications');
    expect(l2.json.items.find((i) => i.id === wonId)!.readAt).not.toBeNull();
    expect(l2.json.items.find((i) => i.kind === 'challenge_taken')!.readAt).toBeNull();

    // B cannot mark A's row: it stays as it is.
    const other = l2.json.items.find((i) => i.kind === 'challenge_taken')!.id;
    await B('POST', '/api/notifications/read', { ids: [other] });
    expect((await A<ListRes>('GET', '/api/notifications')).json.unread).toBe(1);

    const r2 = await A<{ unread: number }>('POST', '/api/notifications/read');
    expect(r2.json.unread).toBe(0);
    expect((await A<ListRes>('GET', '/api/notifications')).json.items.every((i) => i.readAt)).toBe(
      true,
    );

    // `after` returns only rows newer than the stamp.
    const newest = l2.json.items[0]!.createdAt;
    const after = await A<ListRes>('GET', `/api/notifications?after=${encodeURIComponent(newest)}`);
    expect(after.json.items).toHaveLength(0);
    expect(after.json.items.every((i) => i.challengeId === challengeId)).toBe(true);
    expect((await A('GET', '/api/notifications?after=yesterday')).status).toBe(400);
    expect((await makeClient(app)('GET', '/api/notifications')).status).toBe(401);
  });

  it('the stream delivers a settlement as an SSE event and closes on logout', async () => {
    const A = makeClient(app);
    const B = makeClient(app);
    const { challengeId } = await playOut(A, B, 5, { finishB: false });

    // A listens; B finishes; A's stream gets the won row.
    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications/stream',
      headers: { cookie: A.cookie() },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const stream = res.stream();
    let buffer = '';
    const chunks: string[] = [];
    const gotEvent = new Promise<string>((resolve) => {
      stream.on('data', (c: Buffer) => {
        buffer += c.toString();
        chunks.push(c.toString());
        const m = /event: notification\ndata: (.*)\n\n/.exec(buffer);
        if (m?.[1]) resolve(m[1]);
      });
    });
    // The retry hint is the first thing on the wire.
    await new Promise((r) => setTimeout(r, 50));
    expect(buffer.startsWith('retry: 5000\n\n')).toBe(true);
    expect(app.streams.count((await A<UserRes>('GET', '/api/auth/me')).json.user.id)).toBe(1);

    const taken = await B<{ challenges: { id: string; myGameId: string }[] }>(
      'GET',
      '/api/challenges/mine',
    );
    const gameId = taken.json.challenges.find((c) => c.id === challengeId)!.myGameId;
    // The API keeps the seed to itself mid-challenge; the bot reads it from the database.
    expect(
      (await B<{ game: { seed: string | null } }>('GET', `/api/games/${gameId}`)).json.game.seed,
    ).toBeNull();
    await B('POST', `/api/games/${gameId}/finish`, {
      fromIndex: 0,
      moves: bot(await seedOf(db, gameId), 'bot-sse', WEAK).moves,
    });
    const data = JSON.parse(await gotEvent) as Item;
    expect(data.kind).toBe('challenge_won');
    expect(data.challengeId).toBe(challengeId);
    expect(data.amount).toBe(5);
    expect(data.readAt).toBeNull();

    // Logout ends the stream.
    const ended = new Promise<void>((resolve) => stream.on('end', () => resolve()));
    await A('POST', '/api/auth/logout');
    await ended;
  });

  it('caps a user at three streams: the oldest yields', async () => {
    const A = makeClient(app);
    const me = await A<UserRes>('POST', '/api/auth/guest');
    const open = async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/notifications/stream',
        headers: { cookie: A.cookie() },
        payloadAsStream: true,
      });
      const s = res.stream();
      const ended = new Promise<void>((resolve) => s.on('end', () => resolve()));
      s.resume();
      return { ended };
    };
    const first = await open();
    await open();
    await open();
    expect(app.streams.count(me.json.user.id)).toBe(3);
    await open();
    await first.ended; // the first stream was closed to make room
    expect(app.streams.count(me.json.user.id)).toBe(3);
    await A('POST', '/api/auth/logout');
    expect(app.streams.count(me.json.user.id)).toBe(0);
  });

  it('push is OFF without VAPID keys: /vapid and subscribe answer 404 push-off', async () => {
    const A = makeClient(app);
    await A('POST', '/api/auth/guest');
    const v = await A<{ error: string }>('GET', '/api/push/vapid');
    expect(v.status).toBe(404);
    expect(v.json.error).toBe('push-off');
    const s = await A<{ error: string }>('POST', '/api/push/subscribe', {
      subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } },
    });
    expect(s.status).toBe(404);
    expect(s.json.error).toBe('push-off');
  });

  it('push ON: subscribe, one send per subscription on settlement, a 410 deletes the row, unsubscribe', async () => {
    const sent: { endpoint: string; payload: unknown; topic: string | undefined }[] = [];
    const gone = new Set<string>();
    const fake: WebPushLib = {
      sendNotification: async (sub, payload, options) => {
        sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), topic: options.topic });
        if (gone.has(sub.endpoint)) {
          const err = Object.assign(new Error('Gone'), { statusCode: 410 });
          throw err;
        }
        if (sub.endpoint.includes('flaky')) {
          throw Object.assign(new Error('Bad Gateway'), { statusCode: 502 });
        }
        return { statusCode: 201 };
      },
    };
    const on = await buildApp(
      {
        ...cfg!,
        VAPID_PUBLIC_KEY: 'BPublic',
        VAPID_PRIVATE_KEY: 'private',
        VAPID_SUBJECT: 'mailto:test@solitaire.test',
      },
      { webPush: fake },
    );
    try {
      const A = makeClient(on);
      const B = makeClient(on);
      await A<UserRes>('POST', '/api/auth/guest');
      await B<UserRes>('POST', '/api/auth/guest');
      expect((await A<{ publicKey: string }>('GET', '/api/push/vapid')).json.publicKey).toBe(
        'BPublic',
      );

      const good = 'https://push.example/good';
      const dead = 'https://push.example/dead';
      const flaky = 'https://push.example/flaky';
      for (const endpoint of [good, dead, flaky]) {
        const r = await A('POST', '/api/push/subscribe', {
          subscription: { endpoint, keys: { p256dh: 'p256', auth: 'auth' } },
        });
        expect(r.status).toBe(200);
      }
      // Re-subscribing the same endpoint is an upsert, not a second row.
      await A('POST', '/api/push/subscribe', {
        subscription: { endpoint: good, keys: { p256dh: 'p256-2', auth: 'auth-2' } },
      });
      expect(
        (
          await A<{ error: string }>('POST', '/api/push/subscribe', {
            subscription: { endpoint: 'nope' },
          })
        ).json.error,
      ).toBe('bad-subscription');
      gone.add(dead);

      const { a, b, challengeId } = await playOut(A, B, 10, { signedIn: true });
      await on.notifier.idle();

      const sql = postgres(cfg!.DATABASE_URL);
      const subs = await sql<{ endpoint: string; p256dh: string; failed_at: Date | null }[]>`
        SELECT endpoint, p256dh, failed_at FROM push_subscriptions WHERE user_id = ${a.id} ORDER BY endpoint`;
      // A got two pushes (taken, won) to each of three endpoints; the dead one is gone after the first 410.
      const toA = sent.filter((s) => [good, dead, flaky].includes(s.endpoint));
      expect(toA.filter((s) => s.endpoint === good)).toHaveLength(2);
      expect(toA.filter((s) => s.endpoint === dead)).toHaveLength(1);
      expect(subs.map((s) => s.endpoint)).toEqual([flaky, good]);
      expect(subs.find((s) => s.endpoint === good)!.p256dh).toBe('p256-2');
      expect(subs.find((s) => s.endpoint === flaky)!.failed_at).not.toBeNull();
      expect(subs.find((s) => s.endpoint === good)!.failed_at).toBeNull();

      const won = toA.find(
        (s) => s.endpoint === good && (s.payload as { body: string }).body.includes('won'),
      )!;
      expect(won.payload).toEqual({
        title: 'Solitaire Plus',
        body: `${b.username} took your challenge — you won ${chainText(10)}`,
        url: `/challenge/${challengeId}`,
        tag: `challenge-${challengeId}`,
      });
      expect(won.topic).toBe(challengeId.replaceAll('-', ''));
      // B had no subscription: nothing was sent for the loss.
      expect(sent.some((s) => (s.payload as { body: string }).body.includes('lost'))).toBe(false);

      const del = await A<{ removed: boolean }>('DELETE', '/api/push/subscribe', {
        endpoint: good,
      });
      expect(del.json.removed).toBe(true);
      // Someone else's endpoint is not theirs to remove.
      const delB = await B<{ removed: boolean }>('DELETE', '/api/push/subscribe', {
        endpoint: flaky,
      });
      expect(delB.json.removed).toBe(false);
      const left = await sql<{ endpoint: string }[]>`
        SELECT endpoint FROM push_subscriptions WHERE user_id = ${a.id}`;
      await sql.end();
      expect(left.map((s) => s.endpoint)).toEqual([flaky]);
    } finally {
      await on.close();
    }
  });
});
