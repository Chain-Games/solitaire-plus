import {
  RANKS,
  RULES,
  ZERO_XP_PARTS,
  apply,
  createGame,
  createGameFromDeal,
  dealFor,
  isError,
  levelFor,
  moveOf,
  openingMask,
  rankFor,
  replayFrom,
  reveal,
  revealsIn,
  stateHash,
  tick,
  xpForGame,
  xpForWin,
  xpLevelFor,
  xpThreshold,
  type Card,
  type ScoreBreakdown,
  type TimedMove,
  type XpParts,
} from '@solitaire-plus/sim';
import { eq, inArray, sql as sqlTag } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ENTRY_FEES, loadConfig } from '../src/config.js';
import { backfillXp } from '../src/db/backfill-xp.js';
import { runMigrations } from '../src/db/migrate.js';
import { clientMeta, games, users, xpEvents } from '../src/db/schema.js';
import { claimDailyGrant } from '../src/services/auth.js';
import { resolveChallengeIfReady } from '../src/services/challenges.js';
import { appendMoves, finalizeGame } from '../src/services/games.js';
import type { AdminOverview } from '../src/services/admin.js';
import { SHARE_MAX_IMAGE_BYTES } from '../src/services/share.js';
import { locateIp, noteClient, profileOf } from '../src/services/telemetry.js';
import { awardXp } from '../src/services/xp.js';
import {
  bot,
  ensureDatabase,
  greedy,
  makeClient,
  seedOf,
  testDatabaseUrl,
  truncateAll,
} from './helpers.js';

/**
 * End-to-end challenge flow against a real Postgres + Redis (the dev compose
 * stack). Skips cleanly when DATABASE_URL is not set.
 *
 * The seed never leaves the server while it matters, so the tests read it from
 * the database (as only the server could) to have the bots play the deal.
 */
const devUrl = process.env['DATABASE_URL'];
const suite = devUrl ? describe : describe.skip;
const ADMIN_KEY = 'test-admin-key-not-for-production';

/** How many random moves the losing side plays: too few for any line to outscore greedy. */
const WEAK = 3;

type NewGame = { challengeId: string; code: string; gameId: string };
type MovesRes = {
  count: number;
  reveals: { slot: number; card: Card }[];
  stateHash: string;
};
type GameView = {
  game: {
    status: string;
    seed: string | null;
    deal: (Card | null)[];
    score: number;
    moveCount: number;
    endReason: string | null;
    levelReached: number | null;
    breakdown: ScoreBreakdown | null;
  };
};

suite('challenge flow', () => {
  let app: FastifyInstance;
  let db: postgres.Sql;
  let shareDir = '';
  const testUrl = devUrl ? testDatabaseUrl(devUrl) : '';
  const cfg = devUrl
    ? loadConfig({
        ...process.env,
        DATABASE_URL: testUrl,
        NODE_ENV: 'test',
        CLOCK_TOLERANCE_MS: '600000',
        // The flow tests assert exact balances; the daily top-up has its own test.
        DAILY_GRANT: '0',
        ADMIN_TOKEN: ADMIN_KEY,
        GEOIP_URL: '',
        PUBLIC_URL: 'https://solitaire.test',
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
    shareDir = await mkdtemp(path.join(tmpdir(), 'solitaire-share-'));
    cfg.SHARE_DIR = shareDir;
    app = await buildApp(cfg);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    if (shareDir) await rm(shareDir, { recursive: true, force: true });
  });

  const client = () => makeClient(app);
  const seedFor = (gameId: string) => seedOf(db, gameId);

  it('creates, blocks early takers, scores by replay, resolves and pays the winner', async () => {
    const A = client();
    const B = client();
    type UserRes = { user: { id: string; username: string; balance: number } };
    const ua = await A<UserRes>('POST', '/api/auth/guest');
    await B<UserRes>('POST', '/api/auth/guest');
    expect(ua.status).toBe(200);
    expect(ua.json.user.balance).toBe(cfg!.STARTING_BALANCE);

    // A creates. The seed is the answer key: it is not in the response.
    const created = await A<NewGame>('POST', '/api/challenges', { entryFee: 25 });
    expect(created.status).toBe(200);
    expect(created.json).not.toHaveProperty('seed');
    expect((await A<UserRes>('GET', '/api/auth/me')).json.user.balance).toBe(
      cfg!.STARTING_BALANCE - 25,
    );
    const seedA = await seedFor(created.json.gameId);

    // B cannot take while A is still playing.
    const early = await B<{ error: string }>('POST', '/api/challenges/take', { entryFee: 25 });
    expect(early.status).toBe(404);
    expect(early.json.error).toBe('no-open-challenge');

    // A plays. The game view hides the seed and shows only the seven up-cards.
    expect((await A('POST', `/api/games/${created.json.gameId}/start`)).status).toBe(200);
    const playing = await A<GameView>('GET', `/api/games/${created.json.gameId}`);
    expect(playing.json.game.seed).toBeNull();
    expect(playing.json.game.deal).toHaveLength(52);
    expect(playing.json.game.deal.filter((c) => c !== null)).toHaveLength(7);
    expect(playing.json.game.deal).toEqual(openingMask(dealFor(seedA)));
    const a = bot(seedA, 'bot-a', 25);
    const n = a.moves.length;
    const k1 = Math.min(10, n);
    const k2 = Math.min(12, n);
    expect(
      (
        await A('POST', `/api/games/${created.json.gameId}/moves`, {
          fromIndex: 0,
          moves: a.moves.slice(0, k1),
        })
      ).status,
    ).toBe(200);
    // Overlapping resend is idempotent; a gap is rejected.
    expect(
      (
        await A('POST', `/api/games/${created.json.gameId}/moves`, {
          fromIndex: Math.min(5, k1),
          moves: a.moves.slice(Math.min(5, k1), k2),
        })
      ).status,
    ).toBe(200);
    expect(
      (await A('POST', `/api/games/${created.json.gameId}/moves`, { fromIndex: n + 5, moves: [] }))
        .status,
    ).toBe(409);
    // Mid-game the deal shows exactly what the stored moves have shown.
    const mid = await A<GameView>('GET', `/api/games/${created.json.gameId}`);
    const midState = replayFrom(createGame(seedA).state, a.moves.slice(0, k2));
    expect(mid.json.game.seed).toBeNull();
    expect(mid.json.game.deal).toEqual(midState.deal.map((c, s) => (midState.seen[s] ? c : null)));
    const finA = await A<GameView>('POST', `/api/games/${created.json.gameId}/finish`, {
      fromIndex: k2,
      moves: a.moves.slice(k2),
    });
    expect(finA.status).toBe(200);
    expect(finA.json.game.status).toBe('finished');
    expect(finA.json.game.moveCount).toBe(a.moves.length);
    // The server's replay agrees with the sim run that produced the moves.
    expect(finA.json.game.score).toBe(a.breakdown.total);
    expect(finA.json.game.levelReached).toBe(a.breakdown.levelReached);
    expect(finA.json.game.levelReached).toBe(finA.json.game.breakdown?.levelReached);
    // Finished, but the challenge is still open: the taker would play this seed.
    expect(finA.json.game.seed).toBeNull();
    expect(
      (await A<GameView>('GET', `/api/games/${created.json.gameId}`)).json.game.seed,
    ).toBeNull();

    // Now it is open, and B sees it.
    const open = await B<{ challenges: { code: string }[] }>(
      'GET',
      '/api/challenges/open?entryFee=25',
    );
    expect(open.json.challenges.map((c) => c.code)).toContain(created.json.code);
    const taken = await B<NewGame>('POST', '/api/challenges/take', { entryFee: 25 });
    expect(taken.status).toBe(200);
    expect(taken.json).not.toHaveProperty('seed');
    const seedB = await seedFor(taken.json.gameId);
    expect(seedB).toBe(seedA);

    // B's view hides A's score until B finishes.
    type ViewRes = {
      challenge: {
        status: string;
        me: { score?: number; levelReached?: number };
        opponent: { score?: number; levelReached?: number };
        result: { won: boolean; payout: number } | null;
      };
    };
    let view = await B<ViewRes>('GET', `/api/challenges/${taken.json.challengeId}`);
    expect(view.json.challenge.status).toBe('taken');
    expect(view.json.challenge.opponent.score).toBeUndefined();
    expect(view.json.challenge.opponent.levelReached).toBeUndefined();
    expect(view.json.challenge.me.levelReached).toBeUndefined();

    // B plays; a tampered (illegal) move is refused with 400 and nothing is stored.
    await B('POST', `/api/games/${taken.json.gameId}/start`);
    const b = bot(seedB, 'bot-b', 40);
    const bad: TimedMove = { t: 'mv', from: 'f0', to: 't0', n: 13, tMs: 50 };
    expect(isError(apply(createGame(seedB).state, moveOf(bad)))).toBe(true);
    const half = Math.floor(b.moves.length / 2);
    const tampered = await B<{ error: string }>('POST', `/api/games/${taken.json.gameId}/moves`, {
      fromIndex: 0,
      moves: [...b.moves.slice(0, half), { ...bad, tMs: b.moves[half - 1]?.tMs ?? 0 }],
    });
    expect(tampered.status).toBe(400);
    expect(tampered.json.error).toBe('bad-move');
    expect((await B<GameView>('GET', `/api/games/${taken.json.gameId}`)).json.game.moveCount).toBe(
      0,
    );
    const [stored] =
      await db`SELECT jsonb_array_length(moves)::int AS n FROM games WHERE id = ${taken.json.gameId}`;
    expect(stored?.['n']).toBe(0);
    // So is one sent with the finish: the game is not finished on it.
    const tamperedFinish = await B<{ error: string }>(
      'POST',
      `/api/games/${taken.json.gameId}/finish`,
      { fromIndex: 0, moves: [bad] },
    );
    expect(tamperedFinish.status).toBe(400);
    expect((await B<GameView>('GET', `/api/games/${taken.json.gameId}`)).json.game.status).toBe(
      'playing',
    );
    const finB = await B<GameView>('POST', `/api/games/${taken.json.gameId}/finish`, {
      fromIndex: 0,
      moves: b.moves,
    });
    expect(finB.status).toBe(200);
    expect(finB.json.game.moveCount).toBe(b.moves.length);
    expect(finB.json.game.score).toBe(b.breakdown.total);

    view = await B<ViewRes>('GET', `/api/challenges/${taken.json.challengeId}`);
    expect(view.json.challenge.status).toBe('complete');
    expect(view.json.challenge.opponent.score).toBe(finA.json.game.score);
    expect(view.json.challenge.opponent.levelReached).toBe(finA.json.game.levelReached);
    expect(view.json.challenge.me.levelReached).toBe(finB.json.game.levelReached);
    expect(view.json.challenge.result).not.toBeNull();

    // Settled: now the seed can be shown, to both sides.
    expect((await A<GameView>('GET', `/api/games/${created.json.gameId}`)).json.game.seed).toBe(
      seedA,
    );
    const doneB = await B<GameView>('GET', `/api/games/${taken.json.gameId}`);
    expect(doneB.json.game.seed).toBe(seedA);

    const balA = (await A<UserRes>('GET', '/api/auth/me')).json.user.balance;
    const balB = (await B<UserRes>('GET', '/api/auth/me')).json.user.balance;
    const winnerIsA = view.json.challenge.result!.won === false;
    expect(winnerIsA ? balA : balB).toBe(cfg!.STARTING_BALANCE - 25 + 50);
    expect(winnerIsA ? balB : balA).toBe(cfg!.STARTING_BALANCE - 25);
  });

  it('sends each move once and learns exactly the cards it shows, in step with the server', async () => {
    const A = client();
    await A('POST', '/api/auth/guest');
    const created = await A<NewGame>('POST', '/api/challenges', { entryFee: 5, isPrivate: true });
    const s = await seedFor(created.json.gameId);
    const started = await A<GameView>('POST', `/api/games/${created.json.gameId}/start`);
    const deal = started.json.game.deal;
    expect(started.json.game.seed).toBeNull();
    expect(deal.filter((c) => c !== null)).toHaveLength(7);
    expect(deal).toEqual(openingMask(dealFor(s)));

    // The client's own state starts from the masked deal and is told each new card.
    let mine = createGameFromDeal(deal).state;
    let server = createGame(s).state;
    const full = dealFor(s);
    const learned = new Map<number, Card>();
    const g = greedy(s, 60);
    expect(g.moves.length).toBeGreaterThan(5);
    for (let i = 0; i < g.moves.length; i++) {
      const m = g.moves[i]!;
      const res = await A<MovesRes>('POST', `/api/games/${created.json.gameId}/moves`, {
        fromIndex: i,
        moves: [m],
      });
      expect(res.status).toBe(200);
      expect(res.json.count).toBe(i + 1);
      const before = server;
      server = replayFrom(server, [m]);
      // What the server shows is exactly what the move turned up, and true to the deal.
      expect(res.json.reveals).toEqual(revealsIn(before, server));
      for (const r of res.json.reveals) {
        expect(learned.has(r.slot)).toBe(false);
        expect(r.card).toBe(full[r.slot]);
        learned.set(r.slot, r.card);
      }
      mine = tick(mine, m.tMs - mine.elapsedMs).state;
      const applied = apply(mine, moveOf(m));
      if (isError(applied)) throw new Error(`client move ${i}: ${applied.error}`);
      mine = reveal(applied.state, res.json.reveals);
      expect(res.json.stateHash).toBe(stateHash(server));
      expect(stateHash(mine)).toBe(res.json.stateHash);
      // A retry of the same batch is answered with what it showed then.
      const again = await A<MovesRes>('POST', `/api/games/${created.json.gameId}/moves`, {
        fromIndex: i,
        moves: [m],
      });
      expect(again.status).toBe(200);
      expect(again.json).toEqual(res.json);
    }
    // The union of the reveals is every card the game has shown beyond the opening seven.
    const shown = revealsIn(createGame(s).state, server);
    expect(new Map(shown.map((r) => [r.slot, r.card]))).toEqual(learned);
    expect(learned.size).toBeGreaterThan(0);
    const view = await A<GameView>('GET', `/api/games/${created.json.gameId}`);
    expect(view.json.game.seed).toBeNull();
    expect(view.json.game.deal.filter((c) => c !== null)).toHaveLength(7 + learned.size);
    for (const [slot, card] of learned) expect(view.json.game.deal[slot]).toBe(card);
  });

  it('refuses a card-showing or game-ending move stamped behind the wall clock (stale-move), accepts it re-stamped', async () => {
    const A = client();
    type UserRes = { user: { id: string } };
    const me = await A<UserRes>('POST', '/api/auth/guest');
    const created = await A<{ gameId: string }>('POST', '/api/challenges', { entryFee: 5 });
    expect((await A('POST', `/api/games/${created.json.gameId}/start`)).status).toBe(200);
    const game = await app.db.query.games.findFirst({ where: eq(games.id, created.json.gameId) });
    const start = game!.startedAt!.getTime();
    const strict = { ...cfg!, CLOCK_TOLERANCE_MS: 2000 };
    // 60 s into the game, a first draw stamped at 1 s shows a new card: refused.
    const at60 = new Date(start + 60_000);
    await expect(
      appendMoves(
        app.db,
        strict,
        created.json.gameId,
        me.json.user.id,
        0,
        [{ t: 'draw', tMs: 1000 }],
        at60,
      ),
    ).rejects.toMatchObject({ code: 'stale-move' });
    expect(
      (await app.db.query.games.findFirst({ where: eq(games.id, created.json.gameId) }))!.moves,
    ).toEqual([]);
    // Re-stamped within the tolerance it is taken, and answers with the card it showed.
    const ok = await appendMoves(
      app.db,
      strict,
      created.json.gameId,
      me.json.user.id,
      0,
      [{ t: 'draw', tMs: 58_500 }],
      at60,
    );
    expect(ok.count).toBe(1);
    expect(ok.reveals).toHaveLength(1);
  });

  it('refuses plain moves stamped behind the batch window (no backdated streaks), accepts them re-stamped', async () => {
    const A = client();
    const me = await A<{ user: { id: string } }>('POST', '/api/auth/guest');
    const created = await A<{ gameId: string }>('POST', '/api/challenges', { entryFee: 5 });
    await A('POST', `/api/games/${created.json.gameId}/start`);
    const game = await app.db.query.games.findFirst({ where: eq(games.id, created.json.gameId) });
    const start = game!.startedAt!.getTime();
    const strict = { ...cfg!, CLOCK_TOLERANCE_MS: 2000, MOVE_BATCH_MS: 250 };
    const id = created.json.gameId;
    const uid = me.json.user.id;
    // Play honestly through one pass of the stock (every draw a reveal, each
    // sent at once) and recycle: the second pass draws only cards already seen,
    // so those draws are plain moves.
    let n = 0;
    for (let i = 0; i < 24; i++, n++) {
      const t = 1000 + i * 500;
      await appendMoves(
        app.db,
        strict,
        id,
        uid,
        n,
        [{ t: 'draw', tMs: t }],
        new Date(start + t + 100),
      );
    }
    await appendMoves(
      app.db,
      strict,
      id,
      uid,
      n++,
      [{ t: 'draw', tMs: 13_500 }],
      new Date(start + 13_600),
    );
    // Think for 40 s, then send five plain moves stamped 1 s apart just after
    // the last one: behind the batch window, refused, nothing stored.
    const late = new Date(start + 53_600);
    const backdated = [1, 2, 3, 4, 5].map((k) => ({ t: 'draw' as const, tMs: 13_500 + k * 1000 }));
    await expect(appendMoves(app.db, strict, id, uid, n, backdated, late)).rejects.toMatchObject({
      code: 'stale-move',
    });
    const stored = await app.db.query.games.findFirst({ where: eq(games.id, id) });
    expect(stored!.moves).toHaveLength(n);
    // Re-stamped at the current clock (inside the window) they are taken.
    const fresh = [0, 1, 2, 3, 4].map((k) => ({ t: 'draw' as const, tMs: 53_400 + k * 40 }));
    expect((await appendMoves(app.db, strict, id, uid, n, fresh, late)).count).toBe(n + 5);
  });

  it('rejects a private challenge from matchmaking but allows it by code', async () => {
    const A = client();
    const B = client();
    await A('POST', '/api/auth/guest');
    await B('POST', '/api/auth/guest');
    const created = await A<NewGame>('POST', '/api/challenges', { entryFee: 5, isPrivate: true });
    await A('POST', `/api/games/${created.json.gameId}/start`);
    await A('POST', `/api/games/${created.json.gameId}/finish`, { fromIndex: 0, moves: [] });
    const rand = await B<{ error: string }>('POST', '/api/challenges/take', { entryFee: 5 });
    expect(rand.status).toBe(404);
    const byCode = await B<NewGame>(
      'POST',
      `/api/challenges/take/${created.json.code.toLowerCase()}`,
    );
    expect(byCode.status).toBe(200);
    expect(byCode.json).not.toHaveProperty('seed');
    expect(await seedFor(byCode.json.gameId)).toBe(await seedFor(created.json.gameId));
    const own = await A<{ error: string }>('POST', `/api/challenges/take/${created.json.code}`);
    expect(own.status).toBe(409);
  });

  it('reports the level its own replay reached and ignores any level the client claims', async () => {
    const A = client();
    const B = client();
    await A('POST', '/api/auth/guest');
    await B('POST', '/api/auth/guest');
    type GameRes = {
      game: {
        status: string;
        score: number;
        levelReached: number | null;
        breakdown: { base: number; total: number; levelReached: number } | null;
      };
    };
    const created = await A<NewGame>('POST', '/api/challenges', { entryFee: 5 });
    // Unfinished: no level yet, and no seed.
    const pending = await A<GameRes & GameView>('GET', `/api/games/${created.json.gameId}`);
    expect(pending.json.game.levelReached).toBe(null);
    expect(pending.json.game.seed).toBeNull();
    expect(pending.json.game.deal.filter((c) => c !== null)).toHaveLength(7);
    await A('POST', `/api/games/${created.json.gameId}/start`);
    const a = greedy(await seedFor(created.json.gameId));
    // A claims level 99 alongside its moves; the claim is not part of the API and is dropped.
    const finA = await A<GameRes>('POST', `/api/games/${created.json.gameId}/finish`, {
      fromIndex: 0,
      moves: a.moves,
      levelReached: 99,
      breakdown: { levelReached: 99 },
    });
    expect(finA.status).toBe(200);
    expect(finA.json.game.levelReached).toBe(a.breakdown.levelReached);
    expect(finA.json.game.breakdown?.base).toBe(a.breakdown.base);
    expect(finA.json.game.breakdown?.levelReached).toBe(a.breakdown.levelReached);
    // The level is a pure function of the in-play score, never of the bonuses.
    expect(finA.json.game.levelReached).toBe(levelFor(a.breakdown.base));
    expect(finA.json.game.levelReached).toBe(levelFor(finA.json.game.breakdown!.base));

    // B takes and plays a lesser game; both levels show once B has finished.
    const taken = await B<NewGame>('POST', `/api/challenges/take/${created.json.code}`);
    await B('POST', `/api/games/${taken.json.gameId}/start`);
    const b = bot(await seedFor(taken.json.gameId), 'bot-levels', 12);
    const finB = await B<GameRes>('POST', `/api/games/${taken.json.gameId}/finish`, {
      fromIndex: 0,
      moves: b.moves,
    });
    expect(finB.json.game.levelReached).toBe(b.breakdown.levelReached);
    type View = {
      me: { levelReached?: number; score?: number };
      opponent: { levelReached?: number; score?: number };
      result: { won: boolean } | null;
    };
    const detail = await B<{ challenge: View }>('GET', `/api/challenges/${taken.json.challengeId}`);
    expect(detail.json.challenge.me.levelReached).toBe(finB.json.game.levelReached);
    expect(detail.json.challenge.opponent.levelReached).toBe(a.breakdown.levelReached);
    // Levels are cosmetic: the higher score wins; the ranking never reads the level.
    expect(detail.json.challenge.result?.won).toBe(finB.json.game.score > finA.json.game.score);
    // History carries it for both sides.
    const mine = await A<{ challenges: (View & { id: string })[] }>('GET', '/api/challenges/mine');
    const row = mine.json.challenges.find((c) => c.id === taken.json.challengeId);
    expect(row?.me.levelReached).toBe(a.breakdown.levelReached);
    expect(row?.opponent.levelReached).toBe(finB.json.game.levelReached);
  });

  it('lists history by the latest activity, not the creation time', async () => {
    const A = client();
    const B = client();
    await A('POST', '/api/auth/guest');
    await B('POST', '/api/auth/guest');
    const play = async (who: typeof A, gameId: string, botSeed: string) => {
      await who('POST', `/api/games/${gameId}/start`);
      const b = bot(await seedFor(gameId), botSeed, 12);
      await who('POST', `/api/games/${gameId}/finish`, { fromIndex: 0, moves: b.moves });
    };
    // Two challenges by A; the OLDER one is the one B settles last.
    const first = await A<NewGame>('POST', '/api/challenges', { entryFee: 5 });
    await play(A, first.json.gameId, 'order-a1');
    const second = await A<NewGame>('POST', '/api/challenges', { entryFee: 5 });
    await play(A, second.json.gameId, 'order-a2');
    const taken = await B<NewGame>('POST', `/api/challenges/take/${first.json.code}`);
    await play(B, taken.json.gameId, 'order-b');
    type Row = { id: string; createdAt: string; activityAt: string };
    // A sees the settled (older) one above the open (newer) one; B sees its match at the top.
    const mineA = await A<{ challenges: Row[] }>('GET', '/api/challenges/mine');
    const idsA = mineA.json.challenges.map((c) => c.id);
    expect(idsA.indexOf(first.json.challengeId)).toBeLessThan(
      idsA.indexOf(second.json.challengeId),
    );
    const rowA = mineA.json.challenges.find((c) => c.id === first.json.challengeId);
    expect(Date.parse(rowA!.activityAt)).toBeGreaterThan(Date.parse(rowA!.createdAt));
    const mineB = await B<{ challenges: Row[] }>('GET', '/api/challenges/mine');
    expect(mineB.json.challenges[0]?.id).toBe(first.json.challengeId);
  });

  it('refuses a fee the player cannot cover', async () => {
    const A = client();
    await A('POST', '/api/auth/guest');
    // Burn the balance with 100s until refused.
    let last = 200;
    for (let i = 0; i < 20 && last === 200; i++) {
      last = (await A('POST', '/api/challenges', { entryFee: 100 })).status;
    }
    expect(last).toBe(409);
  });

  it('tops up 100 $CHAIN once a day, never twice, and records each as a daily ledger row', async () => {
    const A = client();
    const first = await A<{ user: { id: string; balance: number } }>('POST', '/api/auth/guest');
    const id = first.json.user.id;
    const daily = { ...cfg!, DAILY_GRANT: 100 };
    const t0 = new Date();
    expect(await claimDailyGrant(app.db, daily, id, t0)).toBe(100);
    // Same day again: nothing.
    expect(await claimDailyGrant(app.db, daily, id, new Date(t0.getTime() + 60_000))).toBe(0);
    // Tomorrow: paid again.
    const t1 = new Date(t0.getTime() + daily.DAILY_GRANT_INTERVAL_MS + 1000);
    expect(await claimDailyGrant(app.db, daily, id, t1)).toBe(100);
    const me = await A<{ user: { balance: number } }>('GET', '/api/auth/me');
    expect(me.json.user.balance).toBe(cfg!.STARTING_BALANCE + 200);
    const sql = postgres(cfg!.DATABASE_URL);
    const rows =
      await sql`SELECT count(*)::int AS n FROM ledger WHERE user_id = ${id} AND kind = 'daily'`;
    await sql.end();
    expect(rows[0]?.n).toBe(2);
    // Two claims at the same instant (two tabs): the row lock lets exactly one pay.
    const t2 = new Date(t1.getTime() + daily.DAILY_GRANT_INTERVAL_MS + 1000);
    const both = await Promise.all([
      claimDailyGrant(app.db, daily, id, t2),
      claimDailyGrant(app.db, daily, id, t2),
    ]);
    expect([...both].sort()).toEqual([0, 100]);
    const sql2 = postgres(cfg!.DATABASE_URL);
    const rows2 =
      await sql2`SELECT count(*)::int AS n FROM ledger WHERE user_id = ${id} AND kind = 'daily'`;
    await sql2.end();
    expect(rows2[0]?.n).toBe(3);
    // Off when the grant is 0.
    expect(
      await claimDailyGrant(
        app.db,
        { ...daily, DAILY_GRANT: 0 },
        id,
        new Date(t1.getTime() + 2 * daily.DAILY_GRANT_INTERVAL_MS),
      ),
    ).toBe(0);
  });
  /** Shared shapes for the XP tests. */
  type Rank = { index: number; name: string; tier: number };
  type XpGained = {
    total: number;
    parts: XpParts;
    xpBefore: number;
    xpAfter: number;
    levelBefore: number;
    levelAfter: number;
    rankBefore: Rank;
    rankAfter: Rank;
  };
  type XpUser = {
    user: {
      id: string;
      username: string;
      xp: number;
      xpLevel: number;
      rank: Rank;
      nextThreshold: number;
      prevThreshold: number;
    };
  };
  type XpGameRes = {
    game: {
      id: string;
      status: string;
      score: number;
      breakdown: ScoreBreakdown | null;
      xpGained: XpGained | null;
    };
  };

  it('a new account starts at 0 XP, level 1, Pip I, with the next threshold ahead', async () => {
    const A = client();
    const me = await A<XpUser>('POST', '/api/auth/guest');
    expect(me.json.user).toMatchObject({
      xp: 0,
      xpLevel: 1,
      rank: { index: 0, name: RANKS[0], tier: 1 },
      prevThreshold: 0,
      nextThreshold: xpThreshold(2),
    });
    expect(me.json.user.nextThreshold).toBe(750);
  });

  it('a finished solo game awards the expected parts and bumps xp and xp_level', async () => {
    const A = client();
    const me = await A<XpUser>('POST', '/api/auth/guest');
    const userId = me.json.user.id;
    // Solo games are client-only in the product, but the award path is a
    // pure function of any finished game row: finalise one with no challenge.
    const seed = 'xp-solo-seed-2';
    const run = greedy(seed);
    const [row] = await app.db
      .insert(games)
      .values({
        userId,
        seed,
        status: 'playing',
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + RULES.durationMs + 15_000),
        moves: run.moves,
      })
      .returning();
    const finished = await app.db.transaction((tx) => finalizeGame(tx, cfg!, row!));
    expect(finished.status).toBe('finished');
    const b = finished.breakdown!;
    const expected = xpForGame(b, { challenge: false, won: null, pot: 0 });
    expect(expected.parts.challenge).toBe(0);
    expect(expected.parts.win).toBe(0);
    expect(expected.parts.played).toBe(50);
    expect(expected.parts.score).toBe(Math.floor(b.total / 50));
    expect(expected.parts.cards).toBe(RULES.xpPerCard * b.cardsHome);
    expect(expected.parts.levels).toBe(RULES.xpPerLevel * (b.levelReached - 1));
    expect(b.cardsHome).toBeGreaterThan(0);
    expect(b.levelReached).toBeGreaterThanOrEqual(2);
    expect(b).toEqual(run.breakdown);
    expect(expected.total).toBeGreaterThan(50);

    const view = await A<XpGameRes>('GET', `/api/games/${finished.id}`);
    expect(view.json.game.xpGained).toEqual({
      total: expected.total,
      parts: expected.parts,
      xpBefore: 0,
      xpAfter: expected.total,
      levelBefore: 1,
      levelAfter: xpLevelFor(expected.total),
      rankBefore: rankFor(1),
      rankAfter: rankFor(xpLevelFor(expected.total)),
    });
    let after = await A<XpUser>('GET', '/api/auth/me');
    expect(after.json.user.xp).toBe(expected.total);
    expect(after.json.user.xpLevel).toBe(xpLevelFor(expected.total));

    // Finalising the same game again is a no-op for XP (the ref + kind index).
    await app.db.transaction((tx) => finalizeGame(tx, cfg!, finished));
    const again = await app.db.transaction((tx) =>
      awardXp(tx, userId, expected.total, 'game', finished.id, expected.parts),
    );
    expect(again).toBeNull();
    expect((await A<XpUser>('GET', '/api/auth/me')).json.user.xp).toBe(expected.total);

    // Keep playing until the total crosses level 2; the cached level follows the formula.
    let total = expected.total;
    for (let i = 0; i < 6 && total < xpThreshold(2); i++) {
      const s2 = `xp-solo-seed-${i + 3}`;
      const r2 = greedy(s2);
      const [g2] = await app.db
        .insert(games)
        .values({
          userId,
          seed: s2,
          status: 'playing',
          startedAt: new Date(),
          deadlineAt: new Date(Date.now() + RULES.durationMs + 15_000),
          moves: r2.moves,
        })
        .returning();
      const f2 = await app.db.transaction((tx) => finalizeGame(tx, cfg!, g2!));
      total += xpForGame(f2.breakdown!, { challenge: false, won: null, pot: 0 }).total;
    }
    after = await A<XpUser>('GET', '/api/auth/me');
    expect(after.json.user.xp).toBe(total);
    expect(after.json.user.xpLevel).toBe(xpLevelFor(total));
    expect(after.json.user.xpLevel).toBeGreaterThanOrEqual(2);
    expect(after.json.user.rank).toEqual(rankFor(after.json.user.xpLevel));
    expect(after.json.user.prevThreshold).toBe(xpThreshold(after.json.user.xpLevel));
    expect(after.json.user.nextThreshold).toBe(xpThreshold(after.json.user.xpLevel + 1));
    // The users row agrees with the audit trail.
    const sql = postgres(cfg!.DATABASE_URL);
    const rows = await sql`
      SELECT coalesce(sum(amount), 0)::int AS total, count(*)::int AS n
      FROM xp_events WHERE user_id = ${userId} AND kind = 'game'`;
    await sql.end();
    expect(rows[0]?.total).toBe(total);
    expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it('a settled challenge awards the win part exactly once to the winner; re-settling does not double-award', async () => {
    const A = client();
    const B = client();
    const ua = await A<XpUser>('POST', '/api/auth/guest');
    const ub = await B<XpUser>('POST', '/api/auth/guest');
    const created = await A<NewGame>('POST', '/api/challenges', { entryFee: 25 });
    await A('POST', `/api/games/${created.json.gameId}/start`);
    const a = greedy(await seedFor(created.json.gameId));
    const finA = await A<XpGameRes>('POST', `/api/games/${created.json.gameId}/finish`, {
      fromIndex: 0,
      moves: a.moves,
    });
    // The finish response itemises the game's award: no win part yet, the challenge part paid.
    const gainA = finA.json.game.xpGained!;
    const expA = xpForGame(finA.json.game.breakdown!, { challenge: true, won: null, pot: 0 });
    expect(gainA.parts).toEqual(expA.parts);
    expect(gainA.parts.challenge).toBe(25);
    expect(gainA.parts.win).toBe(0);
    expect(gainA.total).toBe(expA.total);
    expect(gainA.xpBefore).toBe(0);
    expect(gainA.xpAfter).toBe(expA.total);
    expect((await A<XpUser>('GET', '/api/auth/me')).json.user.xp).toBe(expA.total);

    // The open list shows the creator's level and rank to would-be takers.
    const open = await B<{
      challenges: { code: string; creator: { username: string; xpLevel: number; rank: Rank } }[];
    }>('GET', '/api/challenges/open?entryFee=25');
    const listed = open.json.challenges.find((c) => c.code === created.json.code)!;
    expect(listed.creator.username).toBe(ua.json.user.username);
    expect(listed.creator.xpLevel).toBe(xpLevelFor(expA.total));
    expect(listed.creator.rank).toEqual(rankFor(listed.creator.xpLevel));

    const taken = await B<NewGame>('POST', '/api/challenges/take', { entryFee: 25 });
    await B('POST', `/api/games/${taken.json.gameId}/start`);
    const b = bot(await seedFor(taken.json.gameId), 'bot-xp', WEAK);
    const finB = await B<XpGameRes>('POST', `/api/games/${taken.json.gameId}/finish`, {
      fromIndex: 0,
      moves: b.moves,
    });
    const expB = xpForGame(finB.json.game.breakdown!, { challenge: true, won: null, pot: 0 });
    expect(finB.json.game.xpGained?.parts).toEqual(expB.parts);

    type View = {
      challenge: {
        status: string;
        me: { username: string; xpLevel: number; rank: Rank };
        opponent: { username: string; xpLevel: number; rank: Rank };
        result: { won: boolean; payout: number; xpGained: XpGained | null } | null;
      };
    };
    const vb = await B<View>('GET', `/api/challenges/${taken.json.challengeId}`);
    const va = await A<View>('GET', `/api/challenges/${taken.json.challengeId}`);
    expect(vb.json.challenge.status).toBe('complete');
    const aWon = va.json.challenge.result!.won;
    expect(vb.json.challenge.result!.won).toBe(!aWon);
    // No line of WEAK random moves outscores greedy, and a tie goes to A, who finished first.
    expect(aWon).toBe(true);
    const win = xpForWin(50);
    expect(win).toBe(125);

    // Winner: game parts + the win part, folded into one xpGained on the result.
    const gain = va.json.challenge.result!.xpGained!;
    expect(gain.parts).toEqual({ ...expA.parts, win });
    expect(gain.total).toBe(expA.total + win);
    expect(gain.xpBefore).toBe(0);
    expect(gain.xpAfter).toBe(expA.total + win);
    expect(gain.levelAfter).toBe(xpLevelFor(expA.total + win));
    expect(gain.rankAfter).toEqual(rankFor(gain.levelAfter));
    // Loser: the game's parts only, no win.
    const lost = vb.json.challenge.result!.xpGained!;
    expect(lost.parts).toEqual(expB.parts);
    expect(lost.parts.win).toBe(0);
    expect(lost.total).toBe(expB.total);

    const meA = await A<XpUser>('GET', '/api/auth/me');
    const meB = await B<XpUser>('GET', '/api/auth/me');
    expect(meA.json.user.xp).toBe(expA.total + win);
    expect(meB.json.user.xp).toBe(expB.total);
    expect(meA.json.user.xpLevel).toBe(xpLevelFor(expA.total + win));

    // Both sides see each other's level and rank in the view and in history.
    expect(vb.json.challenge.opponent.username).toBe(ua.json.user.username);
    expect(vb.json.challenge.opponent.xpLevel).toBe(meA.json.user.xpLevel);
    expect(vb.json.challenge.opponent.rank).toEqual(meA.json.user.rank);
    expect(vb.json.challenge.me.xpLevel).toBe(meB.json.user.xpLevel);
    expect(va.json.challenge.opponent.username).toBe(ub.json.user.username);
    expect(va.json.challenge.opponent.rank).toEqual(meB.json.user.rank);
    const mine = await B<{ challenges: (View['challenge'] & { id: string })[] }>(
      'GET',
      '/api/challenges/mine',
    );
    const row = mine.json.challenges.find((c) => c.id === taken.json.challengeId)!;
    expect(row.opponent.xpLevel).toBe(meA.json.user.xpLevel);
    expect(row.opponent.rank).toEqual(meA.json.user.rank);
    expect(row.result?.xpGained?.total).toBe(expB.total);

    // Re-settling: the challenge is already complete, and even a direct
    // re-award against the same challenge id is refused by the unique index.
    await app.db.transaction((tx) =>
      resolveChallengeIfReady(tx, cfg!, taken.json.challengeId, new Date()),
    );
    const dup = await app.db.transaction((tx) =>
      awardXp(tx, ua.json.user.id, win, 'challenge_win', taken.json.challengeId, {
        ...ZERO_XP_PARTS,
        win,
      }),
    );
    expect(dup).toBeNull();
    expect((await A<XpUser>('GET', '/api/auth/me')).json.user.xp).toBe(expA.total + win);
    const sql = postgres(cfg!.DATABASE_URL);
    const rows = await sql`
      SELECT count(*)::int AS n FROM xp_events
      WHERE ref_id = ${taken.json.challengeId} AND kind = 'challenge_win'`;
    await sql.end();
    expect(rows[0]?.n).toBe(1);
  });

  it('xp_events is unique per (ref_id, kind, user_id): two players may share a ref, one player may not repeat it', async () => {
    const A = client();
    const B = client();
    const ua = await A<XpUser>('POST', '/api/auth/guest');
    const ub = await B<XpUser>('POST', '/api/auth/guest');
    const ref = '00000000-0000-4000-8000-0000000000aa';
    const row = (userId: string) => ({
      userId,
      amount: 10,
      kind: 'challenge_win' as const,
      refId: ref,
      parts: { ...ZERO_XP_PARTS, win: 10 },
      xpBefore: 0,
      xpAfter: 10,
    });
    // Same (ref_id, kind), different users: both rows stand.
    await app.db.insert(xpEvents).values(row(ua.json.user.id));
    await app.db.insert(xpEvents).values(row(ub.json.user.id));
    // Same (ref_id, kind, user_id) twice: the unique index refuses it.
    await expect(
      db`INSERT INTO xp_events (user_id, amount, kind, ref_id, parts, xp_before, xp_after)
         VALUES (${ua.json.user.id}, 10, 'challenge_win', ${ref}, ${db.json({ ...ZERO_XP_PARTS })}, 0, 10)`,
    ).rejects.toMatchObject({ code: '23505' });
    const rows = await db`SELECT user_id FROM xp_events WHERE ref_id = ${ref}`;
    expect(rows.map((r) => r['user_id']).sort()).toEqual([ua.json.user.id, ub.json.user.id].sort());
    // awardXp keys its idempotency on the same triple: B's row does not block A's award.
    await app.db.delete(xpEvents).where(eq(xpEvents.userId, ua.json.user.id));
    const paid = await app.db.transaction((tx) =>
      awardXp(tx, ua.json.user.id, 10, 'challenge_win', ref, { ...ZERO_XP_PARTS, win: 10 }),
    );
    expect(paid?.xpAfter).toBe(10);
    const dup = await app.db.transaction((tx) =>
      awardXp(tx, ua.json.user.id, 10, 'challenge_win', ref, { ...ZERO_XP_PARTS, win: 10 }),
    );
    expect(dup).toBeNull();
    expect((await A<XpUser>('GET', '/api/auth/me')).json.user.xp).toBe(10);
  });

  it('serves a public profile at /api/users/:username', async () => {
    const A = client();
    const B = client();
    const ua = await A<XpUser>('POST', '/api/auth/guest');
    await B('POST', '/api/auth/guest');
    // One complete challenge, which A wins, plus one open one.
    const c1 = await A<NewGame>('POST', '/api/challenges', { entryFee: 10 });
    await A('POST', `/api/games/${c1.json.gameId}/start`);
    const a = greedy(await seedFor(c1.json.gameId));
    const finA = await A<XpGameRes>('POST', `/api/games/${c1.json.gameId}/finish`, {
      fromIndex: 0,
      moves: a.moves,
    });
    const t1 = await B<NewGame>('POST', `/api/challenges/take/${c1.json.code}`);
    await B('POST', `/api/games/${t1.json.gameId}/start`);
    await B('POST', `/api/games/${t1.json.gameId}/finish`, { fromIndex: 0, moves: [] });
    const c2 = await A<NewGame>('POST', '/api/challenges', { entryFee: 5 });
    await A('POST', `/api/games/${c2.json.gameId}/start`);
    await A('POST', `/api/games/${c2.json.gameId}/finish`, { fromIndex: 0, moves: [] });

    type Profile = {
      profile: {
        username: string;
        isGuest: boolean;
        createdAt: string;
        xp: number;
        xpLevel: number;
        rank: Rank;
        nextThreshold: number;
        prevThreshold: number;
        gamesPlayed: number;
        challengesWon: number;
        challengesPlayed: number;
        bestScore: number;
        bestLevel: number;
        chainStaked: number;
        chainWon: number;
        chainLost: number;
        chainPnl: number;
        chainPnlPct: number | null;
      };
    };
    // No session needed: a fresh client can read it.
    const P = client();
    const res = await P<Profile>('GET', `/api/users/${ua.json.user.username}`);
    expect(res.status).toBe(200);
    const me = await A<XpUser>('GET', '/api/auth/me');
    expect(res.json.profile).toEqual({
      username: ua.json.user.username,
      isGuest: true,
      createdAt: expect.any(String),
      xp: me.json.user.xp,
      xpLevel: me.json.user.xpLevel,
      rank: me.json.user.rank,
      nextThreshold: me.json.user.nextThreshold,
      prevThreshold: me.json.user.prevThreshold,
      // c2 was finished with no moves: not a game anyone played.
      gamesPlayed: 1,
      challengesWon: 1,
      challengesPlayed: 1,
      bestScore: finA.json.game.score,
      bestLevel: a.breakdown.levelReached,
      // One 10-fee win (pot 20 → +10 net), one 5-fee open challenge not counted.
      chainStaked: 10,
      chainWon: 10,
      chainLost: 0,
      chainPnl: 10,
      chainPnlPct: 100,
    });
    expect(res.json.profile.xp).toBe(
      xpForGame(finA.json.game.breakdown!, { challenge: true, won: true, pot: 20 }).total,
    );
    expect((await P<{ error: string }>('GET', '/api/users/nobody_here_1')).status).toBe(404);
    expect((await P<{ error: string }>('GET', '/api/users/bad%20name')).status).toBe(400);
  });

  it('a client cannot post XP: the finish body has no such field and any sent is ignored', async () => {
    const A = client();
    await A<XpUser>('POST', '/api/auth/guest');
    const created = await A<NewGame>('POST', '/api/challenges', { entryFee: 5 });
    await A('POST', `/api/games/${created.json.gameId}/start`);
    const a = bot(await seedFor(created.json.gameId), 'bot-xp-claim', 10);
    const fin = await A<XpGameRes>('POST', `/api/games/${created.json.gameId}/finish`, {
      fromIndex: 0,
      moves: a.moves,
      xp: 999_999,
      xpGained: { total: 999_999 },
      xpLevel: 99,
    });
    expect(fin.status).toBe(200);
    const expected = xpForGame(fin.json.game.breakdown!, { challenge: true, won: null, pot: 0 });
    expect(fin.json.game.xpGained?.total).toBe(expected.total);
    const me = await A<XpUser>('GET', '/api/auth/me');
    expect(me.json.user.xp).toBe(expected.total);
    expect(me.json.user.xpLevel).toBe(xpLevelFor(expected.total));
    // And the same on the moves endpoint: an xp key there is simply not read.
    const created2 = await A<NewGame>('POST', '/api/challenges', { entryFee: 5 });
    await A('POST', `/api/games/${created2.json.gameId}/start`);
    expect(
      (
        await A('POST', `/api/games/${created2.json.gameId}/moves`, {
          fromIndex: 0,
          moves: [],
          xp: 5000,
        })
      ).status,
    ).toBe(200);
    expect((await A<XpUser>('GET', '/api/auth/me')).json.user.xp).toBe(expected.total);
    // A never-started game (no moves) pays nothing when it is finalised.
    const stale = await app.db.query.games.findFirst({ where: eq(games.id, created2.json.gameId) });
    await app.db.transaction((tx) => finalizeGame(tx, cfg!, stale!));
    expect((await A<XpUser>('GET', '/api/auth/me')).json.user.xp).toBe(expected.total);
    expect(
      (await A<XpGameRes>('GET', `/api/games/${created2.json.gameId}`)).json.game.xpGained,
    ).toBeNull();
  });
  it('backfill credits games and wins settled before XP existed, once', async () => {
    const A = client();
    const B = client();
    const ua = await A<XpUser>('POST', '/api/auth/guest');
    const ub = await B<XpUser>('POST', '/api/auth/guest');
    const created = await A<NewGame>('POST', '/api/challenges', { entryFee: 10 });
    await A('POST', `/api/games/${created.json.gameId}/start`);
    const a = greedy(await seedFor(created.json.gameId));
    await A('POST', `/api/games/${created.json.gameId}/finish`, { fromIndex: 0, moves: a.moves });
    const taken = await B<NewGame>('POST', `/api/challenges/take/${created.json.code}`);
    await B('POST', `/api/games/${taken.json.gameId}/start`);
    const b = bot(await seedFor(taken.json.gameId), 'bot-backfill', WEAK);
    await B('POST', `/api/games/${taken.json.gameId}/finish`, { fromIndex: 0, moves: b.moves });
    const ids = [ua.json.user.id, ub.json.user.id];
    const before = await app.db
      .select({ id: users.id, xp: users.xp })
      .from(users)
      .where(inArray(users.id, ids));
    expect(before.every((u) => u.xp > 0)).toBe(true);

    // Pretend the XP system arrived after these games: wipe the awards.
    await app.db.delete(xpEvents).where(inArray(xpEvents.userId, ids));
    await app.db.update(users).set({ xp: 0, xpLevel: 1 }).where(inArray(users.id, ids));

    const first = await backfillXp(cfg!.DATABASE_URL);
    expect(first).toEqual({ games: 2, wins: 1 });
    const after = await app.db
      .select({ id: users.id, xp: users.xp, xpLevel: users.xpLevel })
      .from(users)
      .where(inArray(users.id, ids));
    for (const u of before) {
      const now = after.find((x) => x.id === u.id);
      expect(now?.xp).toBe(u.xp);
      expect(now?.xpLevel).toBe(xpLevelFor(u.xp));
    }
    // Idempotent: a second run credits nothing.
    expect(await backfillXp(cfg!.DATABASE_URL)).toEqual({ games: 0, wins: 0 });
    expect(
      (
        await app.db
          .select({ id: users.id, xp: users.xp })
          .from(users)
          .where(inArray(users.id, ids))
      ).map((u) => u.xp),
    ).toEqual(after.map((u) => u.xp));
  });
  it('the fee ladder has no free rung, rejects 0 with bad-fee, and its floor is within the daily top-up', async () => {
    expect(ENTRY_FEES).not.toContain(0);
    // A player who busts must be able to play again on the stipend alone.
    expect(Math.min(...ENTRY_FEES)).toBeLessThanOrEqual(loadConfig().DAILY_GRANT);
    const A = client();
    await A('POST', '/api/auth/guest');
    const r = await A<{ error: string }>('POST', '/api/challenges', { entryFee: 0 });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('bad-fee');
    const t = await A<{ error: string }>('POST', '/api/challenges/take', { entryFee: 7 });
    expect(t.status).toBe(400);
    expect(t.json.error).toBe('bad-fee');
  });
  /* ------------------------------------------------------------- admin -- */

  it('admin overview is off (503) when ADMIN_TOKEN is unset, never open', async () => {
    const dark = await buildApp({ ...cfg!, ADMIN_TOKEN: '' });
    try {
      const r = await dark.inject({ method: 'GET', url: '/api/admin/overview' });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({
        error: 'admin-not-configured',
        message: 'admin api is not configured',
      });
      const withKey = await dark.inject({
        method: 'GET',
        url: '/api/admin/overview',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(withKey.statusCode).toBe(503);
    } finally {
      await dark.close();
    }
  });

  it('admin overview rejects a missing, wrong or wrong-length key with 401', async () => {
    for (const authorization of ['', 'Bearer nope', `Bearer ${ADMIN_KEY}x`, ADMIN_KEY]) {
      const r = await app.inject({
        method: 'GET',
        url: '/api/admin/overview',
        headers: authorization ? { authorization } : {},
      });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'unauthorized', message: 'unauthorized' });
    }
  });

  it('admin overview with the key returns every section, internally consistent', async () => {
    // Note one client so the telemetry sections have a row to show.
    const A = client();
    const me = await A<{ user: { id: string } }>('POST', '/api/auth/guest');
    const ipad =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
    expect(
      await noteClient(
        app.db,
        cfg!,
        { headers: { 'user-agent': ipad, 'x-solitaire-touch': '1' }, ip: '203.0.113.9' },
        me.json.user.id,
        Date.now(),
        { force: true, locate: async () => ({ country: 'PT', region: 'Lisbon' }) },
      ),
    ).toBe(true);

    const r = await app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(r.statusCode).toBe(200);
    const o = r.json<AdminOverview & { live: { sessions: number }; generatedAt: string }>();

    // Every field is present, in the documented order and shape.
    for (const k of [
      'players',
      'guests',
      'gamesPlayed',
      'bestScore',
      'avgScore',
      'bestLevel',
      'xpAwarded',
      'chainStaked',
    ] as const)
      expect(typeof o.totals[k]).toBe('number');
    expect(o.gamesPerDay).toHaveLength(30);
    expect(o.gamesPerDay.map((d) => d.day)).toEqual([...o.gamesPerDay.map((d) => d.day)].sort());
    expect(o.gamesPerDay.at(-1)?.day).toBe(new Date().toISOString().slice(0, 10));
    expect(Object.keys(o.howGamesEnd).sort()).toEqual(['cleared', 'forfeit', 'timeout']);
    expect(o.scoreSpread.map((b) => b.label)).toEqual([
      '0–999',
      '1,000–2,999',
      '3,000–5,999',
      '6,000–9,999',
      '10,000+',
    ]);
    expect(o.levelsReached.map((l) => l.level)).toEqual([
      ...Array.from({ length: 9 }, (_, i) => String(i + 1)),
      '10+',
    ]);
    expect(o.ranks.map((x) => x.rank)).toEqual([...RANKS]);
    expect(o.challengePool.map((p) => p.fee)).toEqual([...ENTRY_FEES]);
    expect(o.live.sessions).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(o.generatedAt))).toBe(false);

    // Internally consistent. Every game in this database finished inside the
    // window, so the spine sums to the total; so do the reasons, the spread
    // and the levels.
    const played = o.totals.gamesPlayed;
    expect(played).toBeGreaterThan(0);
    expect(o.gamesPerDay.reduce((s, d) => s + d.games, 0)).toBe(played);
    expect(Object.values(o.howGamesEnd).reduce((s, v) => s + v, 0)).toBe(played);
    expect(o.scoreSpread.reduce((s, b) => s + b.games, 0)).toBe(played);
    expect(o.levelsReached.reduce((s, l) => s + l.games, 0)).toBe(played);
    const allUsers = await app.db.select({ xpLevel: users.xpLevel }).from(users);
    expect(o.totals.players + o.totals.guests).toBe(allUsers.length);
    expect(o.ranks.reduce((s, x) => s + x.players, 0)).toBe(allUsers.length);
    expect(o.ranks[0]?.players).toBe(allUsers.filter((u) => rankFor(u.xpLevel).index === 0).length);
    // The pool matches the challenges table fee by fee, and the stake is the
    // complete rows' fees.
    const pool = [
      ...(await app.db.execute<{ entry_fee: number; status: string; n: number }>(
        sqlTag`SELECT entry_fee, status, count(*)::int AS n FROM challenges GROUP BY 1, 2`,
      )),
    ];
    for (const p of o.challengePool)
      for (const st of ['open', 'taken', 'complete', 'expired'] as const)
        expect(p[st]).toBe(pool.find((x) => x.entry_fee === p.fee && x.status === st)?.n ?? 0);
    expect(o.totals.chainStaked).toBe(
      pool.filter((x) => x.status === 'complete').reduce((s, x) => s + x.entry_fee * x.n, 0),
    );
    const xpRows = await app.db.select({ amount: xpEvents.amount }).from(xpEvents);
    expect(o.totals.xpAwarded).toBe(xpRows.reduce((s, e) => s + e.amount, 0));

    // Leaderboard: challenge games, best first, the rank is the sim's.
    expect(o.leaderboard.length).toBeGreaterThan(0);
    expect(o.leaderboard.length).toBeLessThanOrEqual(20);
    for (let i = 1; i < o.leaderboard.length; i++)
      expect(o.leaderboard[i - 1]!.score).toBeGreaterThanOrEqual(o.leaderboard[i]!.score);
    // Best over challenge games only; the all-games best (solo included) is the total.
    const [bestChallenge] = await app.db.execute<{ best: number }>(
      sqlTag`SELECT max(score)::int AS best FROM games WHERE challenge_id IS NOT NULL AND status = 'finished'`,
    );
    expect(o.leaderboard[0]?.score).toBe(bestChallenge?.best);
    expect(o.leaderboard[0]!.score).toBeLessThanOrEqual(o.totals.bestScore);
    for (const row of o.leaderboard)
      expect(row.rank).toEqual(rankFor(row.rank.index * RULES.xpRankSpan + row.rank.tier));
    // Recent: newest first, every reason one the sim names.
    expect(o.recentGames.length).toBeGreaterThan(0);
    for (let i = 1; i < o.recentGames.length; i++)
      expect(Date.parse(o.recentGames[i - 1]!.endedAt)).toBeGreaterThanOrEqual(
        Date.parse(o.recentGames[i]!.endedAt),
      );
    for (const g of o.recentGames) expect(['cleared', 'timeout', 'forfeit']).toContain(g.endReason);

    // Telemetry: the iPad-as-Mac client above (the earlier /me calls noted
    // UA-less desktops too), located by the stubbed lookup, and the address
    // itself nowhere in the row.
    expect(o.devices).toContainEqual({ name: 'tablet', players: 1 });
    expect(o.systems).toContainEqual({ name: 'iPadOS', players: 1 });
    expect(o.browsers).toContainEqual({ name: 'Safari', players: 1 });
    expect(o.devices.reduce((s, d) => s + d.players, 0)).toBe(
      (await app.db.select({ id: clientMeta.userId }).from(clientMeta)).length,
    );
    expect(o.where).toEqual([{ country: 'PT', region: 'Lisbon', players: 1 }]);
    expect(o.leaderboard.every((row) => row.where === null || row.where === 'Lisbon, PT')).toBe(
      true,
    );
    const [row] = await app.db
      .select()
      .from(clientMeta)
      .where(eq(clientMeta.userId, me.json.user.id));
    expect(row?.ipHash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain('203.0.113.9');
  });

  it('noteClient never throws: garbage UA, no ip, unknown user; a repeat within the hour is skipped', async () => {
    const garbage = {
      headers: { 'user-agent': [String.fromCharCode(0, 65535), 42] as unknown as string },
    };
    // An unknown user violates the foreign key; the error is swallowed.
    await expect(
      noteClient(app.db, cfg!, garbage, '00000000-0000-0000-0000-000000000000', Date.now(), {
        force: true,
      }),
    ).resolves.toBe(false);
    await expect(
      noteClient(app.db, cfg!, { headers: {} }, 'not-a-uuid', Date.now(), { force: true }),
    ).resolves.toBe(false);
    const A = client();
    const me = await A<{ user: { id: string } }>('POST', '/api/auth/guest');
    const id = me.json.user.id;
    const now = Date.now();
    expect(await noteClient(app.db, cfg!, { headers: { 'user-agent': 12 }, ip: '' }, id, now)).toBe(
      true,
    );
    // Once an hour per user: the same hour is a no-op, the next hour writes again.
    expect(await noteClient(app.db, cfg!, { headers: {} }, id, now + 1000)).toBe(false);
    expect(await noteClient(app.db, cfg!, { headers: {} }, id, now + 61 * 60 * 1000)).toBe(true);
    // A failed or skipped lookup never erases a location that succeeded earlier,
    // and a private address is never sent anywhere.
    let asked = 0;
    await noteClient(app.db, cfg!, { headers: {}, ip: '198.51.100.7' }, id, now, {
      force: true,
      locate: async () => ({ country: 'GB', region: null }),
    });
    await noteClient(app.db, cfg!, { headers: {}, ip: '192.168.1.4' }, id, now, {
      force: true,
      locate: async (template, ip) => {
        asked++;
        return locateIp(template, ip);
      },
    });
    expect(asked).toBe(1);
    expect(await locateIp('http://127.0.0.1:1/{ip}', '192.168.1.4')).toBeNull();
    expect(await locateIp('', '8.8.8.8')).toBeNull();
    const [row] = await app.db.select().from(clientMeta).where(eq(clientMeta.userId, id));
    expect(row?.country).toBe('GB');
    expect(row?.device).toBe('desktop');
    expect(row?.os).toBe('Unknown');
  });

  /** A JPEG start (SOI + APP0 marker) over a little padding: what the upload gate checks. */
  const TINY_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(28)]);

  it("share: refuses another player's game (403), an unfinished game (409) and an oversize card (413)", async () => {
    const A = client();
    const B = client();
    await A('POST', '/api/auth/guest');
    await B('POST', '/api/auth/guest');
    const created = await A<NewGame>('POST', '/api/challenges', { entryFee: 5, isPrivate: true });
    const png = TINY_JPEG.toString('base64');
    const body = { gameId: created.json.gameId, story: png, link: png };

    // Not B's game.
    const theirs = await B<{ error: string }>('POST', '/api/share', body);
    expect(theirs.status).toBe(403);

    // A's, but still pending.
    const early = await A<{ error: string }>('POST', '/api/share', body);
    expect(early.status).toBe(409);
    expect(early.json.error).toBe('game-not-finished');

    await A('POST', `/api/games/${created.json.gameId}/start`);
    await A('POST', `/api/games/${created.json.gameId}/finish`, { fromIndex: 0, moves: [] });

    // A JPEG signature on a file past the cap.
    const fat = Buffer.concat([TINY_JPEG, Buffer.alloc(SHARE_MAX_IMAGE_BYTES)]).toString('base64');
    const big = await A<{ error: string }>('POST', '/api/share', { ...body, story: fat });
    expect(big.status).toBe(413);
    expect(big.json.error).toBe('card-too-large');

    // Not a JPEG at all.
    const text = Buffer.from('hello').toString('base64');
    const junk = await A<{ error: string }>('POST', '/api/share', { ...body, link: text });
    expect(junk.status).toBe(400);
    expect(junk.json.error).toBe('bad-image');

    // No session at all.
    const anon = await app.inject({ method: 'POST', url: '/api/share', payload: body });
    expect(anon.statusCode).toBe(401);
  });

  it("share: stores a finished game's cards once, /s/:id carries the OG tags and the code while open, the PNGs are served immutable", async () => {
    const A = client();
    type UserRes = { user: { username: string } };
    const me = await A<UserRes>('POST', '/api/auth/guest');
    const created = await A<NewGame>('POST', '/api/challenges', { entryFee: 5, isPrivate: true });
    await A('POST', `/api/games/${created.json.gameId}/start`);
    const g = greedy(await seedFor(created.json.gameId), 12);
    await A('POST', `/api/games/${created.json.gameId}/finish`, { fromIndex: 0, moves: g.moves });
    const score = (await A<{ game: { score: number } }>('GET', `/api/games/${created.json.gameId}`))
      .json.game.score;

    const png = TINY_JPEG.toString('base64');
    const body = { gameId: created.json.gameId, story: png, link: png };
    const first = await A<{ id: string; url: string }>('POST', '/api/share', body);
    expect(first.status).toBe(200);
    expect(first.json.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(first.json.url).toBe(`https://solitaire.test/s/${first.json.id}`);

    // One card per game: the second share hands back the first id.
    const again = await A<{ id: string; url: string }>('POST', '/api/share', body);
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(first.json.id);

    // The page a scraper reads (no session).
    const page = await app.inject({ method: 'GET', url: `/s/${first.json.id}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    const html = page.body;
    const title = `Solitaire Plus — ${score.toLocaleString('en-US')} by ${me.json.user.username}`;
    expect(html).toContain(`<meta property="og:title" content="${title}">`);
    expect(html).toContain(
      `<meta property="og:description" content="Same deal, ${RULES.durationMs / 60000} minutes. Beat me: ${created.json.code}">`,
    );
    expect(html).toContain(
      `<meta property="og:image" content="https://solitaire.test/s/${first.json.id}/link.jpg">`,
    );
    expect(html).toContain('<meta property="og:image:type" content="image/jpeg">');
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain(
      `<meta http-equiv="refresh" content="0; url=/take?code=${created.json.code}">`,
    );
    expect(html).toContain(`<a href="/take?code=${created.json.code}">Open Solitaire Plus</a>`);
    expect(html).not.toContain('<script');

    // The files, immutable.
    for (const f of ['link.jpg', 'story.jpg']) {
      const img = await app.inject({ method: 'GET', url: `/s/${first.json.id}/${f}` });
      expect(img.statusCode).toBe(200);
      expect(img.headers['content-type']).toBe('image/jpeg');
      expect(img.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(img.rawPayload.equals(TINY_JPEG)).toBe(true);
    }
    expect(
      (await app.inject({ method: 'GET', url: `/s/${first.json.id}/other.png` })).statusCode,
    ).toBe(404);

    // Once the challenge is settled the page follows: no code to beat, the front door instead
    // (the stored image is the snapshot the player shared).
    const B = client();
    await B('POST', '/api/auth/guest');
    const taken = await B<NewGame>('POST', `/api/challenges/take/${created.json.code}`);
    await B('POST', `/api/games/${taken.json.gameId}/start`);
    const gb = greedy(await seedFor(taken.json.gameId), 12);
    await B('POST', `/api/games/${taken.json.gameId}/finish`, { fromIndex: 0, moves: gb.moves });
    const settled = (await app.inject({ method: 'GET', url: `/s/${first.json.id}` })).body;
    expect(settled).toContain(`<meta property="og:title" content="${title}">`);
    expect(settled).toContain(
      `<meta property="og:description" content="Same deal, ${RULES.durationMs / 60000} minutes.">`,
    );
    expect(settled).not.toContain(created.json.code);
    expect(settled).toContain('<meta http-equiv="refresh" content="0; url=/">');

    // A dead or malformed id sends a person home rather than showing JSON.
    const gone = await app.inject({ method: 'GET', url: '/s/AAAAAAAAAAAA' });
    expect(gone.statusCode).toBe(302);
    expect(gone.headers['location']).toBe('/');
    expect((await app.inject({ method: 'GET', url: '/s/not-an-id!' })).statusCode).toBe(302);
  });

  it('profileOf tells phones, tablets and desktops apart despite what the UA claims', () => {
    const mac =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
    expect(profileOf(mac)).toEqual({ device: 'desktop', os: 'macOS', browser: 'Safari' });
    expect(profileOf(mac, true)).toEqual({ device: 'tablet', os: 'iPadOS', browser: 'Safari' });
    expect(
      profileOf(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0 Mobile/15E148 Safari/604.1',
      ),
    ).toEqual({ device: 'phone', os: 'iOS', browser: 'Chrome' });
    expect(
      profileOf(
        'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Mobile Safari/537.36',
      ),
    ).toEqual({ device: 'phone', os: 'Android', browser: 'Chrome' });
    expect(
      profileOf(
        'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0 Safari/537.36',
      ),
    ).toEqual({ device: 'tablet', os: 'Android', browser: 'Samsung Internet' });
    expect(
      profileOf(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0',
      ),
    ).toEqual({ device: 'desktop', os: 'Windows', browser: 'Edge' });
    expect(
      profileOf('Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0'),
    ).toEqual({ device: 'desktop', os: 'Linux', browser: 'Firefox' });
    expect(profileOf(undefined)).toEqual({ device: 'desktop', os: 'Unknown', browser: 'Unknown' });
    expect(profileOf(null, true)).toEqual({ device: 'phone', os: 'Unknown', browser: 'Unknown' });
  });
});
