import { dealFor, solve } from '@solitaire-plus/sim';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { CHALLENGE_SEED_RE, DealPools, PRACTICE_SEED_RE } from '../src/services/deals.js';
import { ensureDatabase, makeClient, seedOf, testDatabaseUrl, truncateAll } from './helpers.js';

/**
 * Solvable-only deals: the Redis pools, their worker's fill, the challenge
 * and practice pops, and the fallback. Real Postgres + Redis, like flow.test.
 * The worker's timer is off (DEAL_POOL_INTERVAL_MS 0); the tests fill by hand.
 */
const devUrl = process.env['DATABASE_URL'];
const suite = devUrl ? describe : describe.skip;
const TARGET = 4;

suite('deal pools', () => {
  let app: FastifyInstance;
  let db: postgres.Sql;
  const testUrl = devUrl ? testDatabaseUrl(devUrl) : '';
  const cfg = devUrl
    ? loadConfig({
        ...process.env,
        DATABASE_URL: testUrl,
        NODE_ENV: 'test',
        DAILY_GRANT: '0',
        DEALS: 'solvable',
        DEAL_POOL_TARGET: String(TARGET),
        DEAL_POOL_INTERVAL_MS: '0',
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

  beforeEach(async () => {
    await app.redis.del(app.deals.keys.challenge, app.deals.keys.practice);
  });

  const list = (key: string) => app.redis.lrange(key, 0, -1);

  it('uses test-only Redis keys, never the dev pools', () => {
    expect(app.deals.keys).toEqual({
      challenge: 'test:deals:pool',
      practice: 'test:deals:practice',
    });
  });

  it('fills both pools to the target with solved seeds only, then pops them in order', async () => {
    const r = await app.deals.fill(60_000);
    expect(r.challenge).toBe(TARGET);
    expect(r.practice).toBe(TARGET);
    expect(r.accepted).toBe(2 * TARGET);
    expect(r.attempts).toBeGreaterThanOrEqual(2 * TARGET);
    expect(await app.deals.sizes()).toEqual({ challenge: TARGET, practice: TARGET });

    const challenge = await list(app.deals.keys.challenge);
    const practice = await list(app.deals.keys.practice);
    for (const seed of challenge) expect(seed).toMatch(CHALLENGE_SEED_RE);
    for (const seed of practice) expect(seed).toMatch(PRACTICE_SEED_RE);
    for (const seed of [...challenge, ...practice]) {
      expect(solve(dealFor(seed), { maxNodes: cfg!.SOLVER_MAX_NODES }).verdict).toBe('solved');
    }

    // A full pool: another fill does nothing.
    expect((await app.deals.fill(60_000)).attempts).toBe(0);

    // LPOP: oldest first, each once.
    for (const seed of challenge) {
      expect(await app.deals.popChallengeSeed()).toEqual({ seed, verified: true });
    }
    for (const seed of practice) {
      expect(await app.deals.popPracticeSeed()).toEqual({ seed, verified: true });
    }
    expect(await app.deals.sizes()).toEqual({ challenge: 0, practice: 0 });
  });

  it('practice and challenge pools never share a seed', async () => {
    await app.deals.fill(60_000);
    const challenge = await list(app.deals.keys.challenge);
    const practice = await list(app.deals.keys.practice);
    expect(challenge.filter((s) => practice.includes(s))).toEqual([]);
    // Different namespaces: no practice seed is ever a valid challenge seed.
    for (const seed of practice) expect(seed).not.toMatch(CHALLENGE_SEED_RE);
    for (const seed of challenge) expect(seed).not.toMatch(PRACTICE_SEED_RE);

    // Even planted there, a practice seed is never dealt as a challenge.
    await app.redis.lpush(app.deals.keys.challenge, practice[0]!);
    const popped = await app.deals.popChallengeSeed();
    expect(popped.seed).toBe(challenge[0]);
    expect(popped.verified).toBe(true);
  });

  it('an empty pool falls back to a fresh, unverified seed in the right namespace', async () => {
    const c = await app.deals.popChallengeSeed();
    expect(c.verified).toBe(false);
    expect(c.seed).toMatch(CHALLENGE_SEED_RE);
    const p = await app.deals.popPracticeSeed();
    expect(p.verified).toBe(false);
    expect(p.seed).toMatch(PRACTICE_SEED_RE);
    expect((await app.deals.popChallengeSeed()).seed).not.toBe(c.seed);
  });

  it('DEALS=any deals fresh seeds and leaves the pools alone', async () => {
    const any = new DealPools(app.redis, { ...cfg!, DEALS: 'any' }, app.log);
    await app.redis.rpush(app.deals.keys.challenge, 'a'.repeat(32));
    const r = await any.popChallengeSeed();
    expect(r.verified).toBe(false);
    expect(r.seed).not.toBe('a'.repeat(32));
    expect(await app.redis.llen(app.deals.keys.challenge)).toBe(1);
    any.start(); // a no-op: no worker for DEALS=any
    await any.stop();
  });

  it('a created challenge deals a pool seed the solver solved', async () => {
    await app.deals.fill(60_000);
    const pooled = await list(app.deals.keys.challenge);
    const A = makeClient(app);
    const B = makeClient(app);
    await A('POST', '/api/auth/guest');
    await B('POST', '/api/auth/guest');
    const seeds: string[] = [];
    for (const who of [A, B]) {
      const created = await who<{ gameId: string }>('POST', '/api/challenges', { entryFee: 5 });
      expect(created.status).toBe(200);
      seeds.push(await seedOf(db, created.json.gameId));
    }
    expect(seeds).toEqual(pooled.slice(0, 2));
    for (const seed of seeds) {
      expect(solve(dealFor(seed), { maxNodes: cfg!.SOLVER_MAX_NODES }).verdict).toBe('solved');
    }
    // Single-use: popped seeds are gone from the pool.
    expect(await list(app.deals.keys.challenge)).toEqual(pooled.slice(2));
  });

  it('a challenge on an empty pool still deals (unverified)', async () => {
    const A = makeClient(app);
    await A('POST', '/api/auth/guest');
    const created = await A<{ gameId: string }>('POST', '/api/challenges', { entryFee: 5 });
    expect(created.status).toBe(200);
    expect(await seedOf(db, created.json.gameId)).toMatch(CHALLENGE_SEED_RE);
  });

  it('GET /api/practice/deal hands out practice seeds, no session needed', async () => {
    await app.deals.fill(60_000);
    const practice = await list(app.deals.keys.practice);
    const res = await app.inject({ method: 'GET', url: '/api/practice/deal' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ seed: practice[0] });
    expect(res.headers['cache-control']).toBe('no-store');

    // Drained: still answers, from the practice namespace.
    await app.redis.del(app.deals.keys.practice);
    const fallback = await app.inject({ method: 'GET', url: '/api/practice/deal' });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json<{ seed: string }>().seed).toMatch(PRACTICE_SEED_RE);
  });
});
