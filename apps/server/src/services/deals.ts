import { setImmediate as nextTurn } from 'node:timers/promises';
import { dealFor, solve } from '@solitaire-plus/sim';
import type { FastifyBaseLogger } from 'fastify';
import type Redis from 'ioredis';
import type { Config } from '../config.js';
import { newSeed } from '../ids.js';

/**
 * Solvable-only deals (docs/SPEC.md §2.1, §9 c).
 *
 * Two Redis lists of seeds the sim's solver has solved:
 *
 *   deals:pool      challenges. LPOP'd once by createChallenge; the seed is
 *                   UNIQUE on `challenges`, so it can never deal twice.
 *   deals:practice  practice. Handed to anyone who asks (the seed is not a
 *                   secret there), so it comes from its own namespace:
 *                   "p-" + 128 random bits. A practice seed can never be
 *                   pushed to, or popped from, the challenge pool.
 *
 * A worker, started with the app and woken on an interval, tops each list up
 * to DEAL_POOL_TARGET. It solves one seed at a time on the main thread, with
 * a turn of the event loop between attempts and at most DEAL_POOL_TICK_MS of
 * solving per wake. One attempt is bounded by SOLVER_MAX_NODES (~150 ms at
 * worst on the dev box, ~0.1 ms for most solvable deals), so a request waits
 * at most one attempt. Only 'solved' seeds are pushed: 'unsolvable' and
 * 'unknown' are both rejected.
 *
 * An empty pool (or DEALS=any) deals a fresh, unverified seed and logs it.
 */

export type PoolName = 'challenge' | 'practice';

/** Challenge seeds: the 128-bit hex newSeed() has always made. */
export const CHALLENGE_SEED_RE = /^[0-9a-f]{32}$/;
/** Practice seeds: their own namespace. */
export const PRACTICE_SEED_RE = /^p-[0-9a-f]{32}$/;

export function newPracticeSeed(): string {
  return `p-${newSeed()}`;
}

function freshSeed(pool: PoolName): string {
  return pool === 'challenge' ? newSeed() : newPracticeSeed();
}

function inNamespace(pool: PoolName, seed: string): boolean {
  return (pool === 'challenge' ? CHALLENGE_SEED_RE : PRACTICE_SEED_RE).test(seed);
}

export interface Popped {
  readonly seed: string;
  /** True if it came from a pool (the solver solved it); false for a fallback. */
  readonly verified: boolean;
}

export interface FillReport {
  readonly attempts: number;
  readonly accepted: number;
  readonly challenge: number;
  readonly practice: number;
}

type DealsConfig = Pick<
  Config,
  | 'NODE_ENV'
  | 'DEALS'
  | 'DEAL_POOL_TARGET'
  | 'SOLVER_MAX_NODES'
  | 'DEAL_POOL_INTERVAL_MS'
  | 'DEAL_POOL_TICK_MS'
>;

export class DealPools {
  readonly keys: Readonly<Record<PoolName, string>>;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = false;

  /**
   * `prefix` namespaces the Redis keys. The tests share the dev Redis, so
   * under NODE_ENV=test it defaults to "test:" and never touches the dev pools.
   */
  constructor(
    private readonly redis: Redis,
    private readonly cfg: DealsConfig,
    private readonly log: FastifyBaseLogger,
    prefix: string = cfg.NODE_ENV === 'test' ? 'test:' : '',
  ) {
    this.keys = { challenge: `${prefix}deals:pool`, practice: `${prefix}deals:practice` };
  }

  /** The seed for a new challenge: pool first, else a fresh unverified one. */
  popChallengeSeed(): Promise<Popped> {
    return this.pop('challenge');
  }

  /** The seed for a practice game: its own pool, else a fresh unverified one. */
  popPracticeSeed(): Promise<Popped> {
    return this.pop('practice');
  }

  private async pop(pool: PoolName): Promise<Popped> {
    if (this.cfg.DEALS === 'solvable') {
      for (;;) {
        const seed = await this.redis.lpop(this.keys[pool]);
        if (seed === null) break;
        if (inNamespace(pool, seed)) return { seed, verified: true };
        // Only this module pushes, so this is corruption; never deal it.
        this.log.error({ pool, seed }, 'deal pool: dropped a seed from the wrong namespace');
      }
      this.log.warn({ pool }, 'deal pool empty: dealing an unverified seed');
    }
    return { seed: freshSeed(pool), verified: false };
  }

  async sizes(): Promise<Record<PoolName, number>> {
    const [challenge, practice] = await Promise.all([
      this.redis.llen(this.keys.challenge),
      this.redis.llen(this.keys.practice),
    ]);
    return { challenge, practice };
  }

  /**
   * Top both pools up to the target, spending at most `budgetMs` of solver
   * time. The emptier pool (challenges first on a tie) gets the next attempt.
   */
  async fill(budgetMs: number = this.cfg.DEAL_POOL_TICK_MS): Promise<FillReport> {
    const target = this.cfg.DEAL_POOL_TARGET;
    const size = await this.sizes();
    const started = performance.now();
    let attempts = 0;
    let accepted = 0;
    while (!this.stopped && performance.now() - started < budgetMs) {
      const pool: PoolName = size.challenge <= size.practice ? 'challenge' : 'practice';
      if (size[pool] >= target) break;
      const seed = freshSeed(pool);
      const t0 = performance.now();
      const r = solve(dealFor(seed), { maxNodes: this.cfg.SOLVER_MAX_NODES });
      attempts++;
      if (r.verdict === 'solved') {
        size[pool] = await this.redis.rpush(this.keys[pool], seed);
        accepted++;
      }
      this.log.debug(
        { pool, verdict: r.verdict, nodes: r.nodes, ms: Math.round(performance.now() - t0) },
        'deal pool: attempt',
      );
      await nextTurn();
    }
    if (attempts > 0) {
      this.log.info({ attempts, accepted, ...size }, 'deal pool: topped up');
    }
    return { attempts, accepted, ...size };
  }

  /** Fill now, and again every DEAL_POOL_INTERVAL_MS. Off for DEALS=any or an interval of 0. */
  start(): void {
    if (this.cfg.DEALS !== 'solvable' || this.cfg.DEAL_POOL_INTERVAL_MS === 0) return;
    if (this.timer !== null) return;
    this.wake();
    this.timer = setInterval(() => this.wake(), this.cfg.DEAL_POOL_INTERVAL_MS);
    this.timer.unref();
  }

  private wake(): void {
    if (this.running || this.stopped) return;
    this.running = this.fill()
      .catch((err: unknown) => this.log.error(err, 'deal pool: fill failed'))
      .finally(() => {
        this.running = null;
      });
  }

  /** Stop the worker and wait for a fill in progress (before Redis closes). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
