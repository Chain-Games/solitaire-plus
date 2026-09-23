import {
  RULES,
  Rng,
  apply,
  canAutocomplete,
  createGame,
  faceUpCount,
  isError,
  isFoundation,
  isTableau,
  legalMoves,
  pileSlots,
  replay,
  tick,
  type GameState,
  type Move,
  type ScoreBreakdown,
  type TimedMove,
} from '@solitaire-plus/sim';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';

/**
 * Shared test plumbing. The tests TRUNCATE every table, so they must never
 * run against the dev database: `DATABASE_URL_TEST`, or the dev URL with
 * the database name suffixed `_test`, created on first run.
 */
export function testDatabaseUrl(dev: string): string {
  const explicit = process.env['DATABASE_URL_TEST'];
  if (explicit) return explicit;
  const u = new URL(dev);
  if (!u.pathname.endsWith('_test')) u.pathname = `${u.pathname}_test`;
  return u.toString();
}

export async function ensureDatabase(dev: string, test: string): Promise<void> {
  const name = new URL(test).pathname.replace(/^\//, '');
  const admin = postgres(dev);
  try {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (rows.length === 0) await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}

export async function truncateAll(url: string): Promise<void> {
  const sql = postgres(url);
  await sql`TRUNCATE push_subscriptions, notifications, share_cards, challenges, games, ledger, xp_events, client_meta, users CASCADE`;
  await sql.end();
}

export type Method = 'GET' | 'POST' | 'DELETE';

export interface TestClient {
  <T>(method: Method, url: string, body?: unknown): Promise<{ status: number; json: T }>;
  /** The session cookie as the browser would send it. */
  readonly cookie: () => string;
}

/** A cookie-carrying client bound to `app.inject`. */
export function makeClient(app: FastifyInstance): TestClient {
  let cookie = '';
  const call = async <T>(method: Method, url: string, body?: unknown) => {
    const res = await app.inject({
      method,
      url,
      headers: { cookie },
      ...(body !== undefined ? { payload: body } : {}),
    });
    const set = res.headers['set-cookie'];
    const first = Array.isArray(set) ? set[0] : set;
    if (first) cookie = first.split(';')[0] ?? '';
    return { status: res.statusCode, json: res.json<T>() };
  };
  return Object.assign(call, { cookie: () => cookie });
}

/** A bot's moves and what the server's replay of them will score. */
export interface BotRun {
  readonly moves: TimedMove[];
  /** The sim's own finished replay of `moves` (run out to the clock). */
  readonly breakdown: ScoreBreakdown;
}

function finished(seed: string, moves: TimedMove[]): BotRun {
  const breakdown = replay(seed, moves).breakdown;
  if (!breakdown) throw new Error('replay did not finish');
  return { moves, breakdown };
}

/** Seeded random-legal-move bot: at most `maxMoves` moves, 100-300 ms apart. */
export function bot(seed: string, botSeed: string, maxMoves: number): BotRun {
  const rng = new Rng(botSeed);
  let state = createGame(seed).state;
  const moves: TimedMove[] = [];
  let t = 0;
  while (state.status === 'playing' && moves.length < maxMoves) {
    const opts = legalMoves(state);
    const move = opts[rng.int(opts.length)];
    if (!move) break;
    t += 100 + rng.int(200);
    if (t >= RULES.durationMs) break;
    state = tick(state, t - state.elapsedMs).state;
    const r = apply(state, move);
    if (isError(r)) throw new Error(`bot move ${JSON.stringify(move)}: ${r.error}`);
    state = r.state;
    moves.push({ ...move, tMs: t });
  }
  return finished(seed, moves);
}

/**
 * Greedy bot: at each step it searches every short line of play (moves to a
 * foundation, tableau and waste moves, draws; never a card back off a
 * foundation) and takes the first move of the line that scores most, with the
 * sim's test bot (packages/sim/test/util.ts) as the tie-break and the fallback
 * once nothing scores within reach: anything to a foundation, then a move that
 * turns a card up, then waste to tableau, then draw, giving up after a stock
 * cycle with no progress. The first moves look `openingDepth` deep, so no
 * random line that short can outscore it. Plays at 200-500 ms a move to keep
 * its streaks alive. Deterministic for a seed.
 */
export function greedy(seed: string, maxMoves = 1000, openingDepth = 3): BotRun {
  const rng = new Rng(`greedy:${seed}`);
  let state = createGame(seed).state;
  const moves: TimedMove[] = [];
  let idleDraws = 0;
  let t = 0;
  while (state.status === 'playing' && moves.length < maxMoves) {
    const depth = moves.length < openingDepth ? openingDepth : 2;
    const move = searchPick(state, depth) ?? heuristicPick(state);
    if (move === null || idleDraws > state.stock.length + state.waste.length + 2) break;
    t += 200 + rng.int(301);
    if (t >= RULES.durationMs) break;
    state = tick(state, t - state.elapsedMs).state;
    if (state.status !== 'playing') break;
    const r = apply(state, move);
    if (isError(r)) throw new Error(`greedy move ${JSON.stringify(move)}: ${r.error}`);
    idleDraws = move.t === 'draw' ? idleDraws + 1 : 0;
    state = r.state;
    moves.push({ ...move, tMs: t });
  }
  return finished(seed, moves);
}

/** What a state is worth if the game ended now, less the clear bonuses. */
function worth(state: GameState): number {
  const best = Math.min(state.bestStreak, RULES.streakCap);
  return (
    state.score + Math.max(0, best - 1) * RULES.streakEndStep + (state.status === 'ended' ? 1e6 : 0)
  );
}

function candidates(state: GameState): Move[] {
  return legalMoves(state).filter((m) => m.t !== 'mv' || !isFoundation(m.from));
}

function bestWorth(state: GameState, depth: number): number {
  let best = worth(state);
  if (depth === 0 || state.status !== 'playing') return best;
  for (const m of candidates(state)) {
    const r = apply(state, m);
    if (!isError(r)) best = Math.max(best, bestWorth(r.state, depth - 1));
  }
  return best;
}

/** Heuristic preference, lower first: the sim bot's order. */
function preference(state: GameState, m: Move): number {
  if (m.t === 'auto') return 0;
  if (m.t !== 'mv') return 5;
  if (isFoundation(m.to)) return 1;
  if (
    isTableau(m.from) &&
    m.n === faceUpCount(state, m.from) &&
    pileSlots(state, m.from).length > m.n
  )
    return 2;
  if (m.from === 'waste') return 3;
  return 4;
}

/** The first move of the best-scoring line within `depth`, or null if none gains. */
function searchPick(state: GameState, depth: number): Move | null {
  const now = worth(state);
  let best: { v: number; p: number; m: Move } | null = null;
  for (const m of candidates(state)) {
    const r = apply(state, m);
    if (isError(r)) continue;
    const v = bestWorth(r.state, depth - 1);
    const p = preference(state, m);
    if (!best || v > best.v || (v === best.v && p < best.p)) best = { v, p, m };
  }
  return best && best.v > now ? best.m : null;
}

function heuristicPick(state: GameState): Move | null {
  if (canAutocomplete(state)) return { t: 'auto' };
  const mv = legalMoves(state).filter((m): m is Extract<Move, { t: 'mv' }> => m.t === 'mv');
  const toF = mv.find((m) => isFoundation(m.to) && !isFoundation(m.from));
  if (toF) return toF;
  // A whole face-up run moved off a face-down card (turns it up).
  const flips = mv.find(
    (m) =>
      isTableau(m.from) &&
      isTableau(m.to) &&
      m.n === faceUpCount(state, m.from) &&
      pileSlots(state, m.from).length > m.n,
  );
  if (flips) return flips;
  const wasteMove = mv.find((m) => m.from === 'waste' && isTableau(m.to));
  if (wasteMove) return wasteMove;
  if (state.stock.length > 0 || state.waste.length > 0) return { t: 'draw' };
  return null;
}

/** A game's seed, straight from the database: the API never shows it while it matters. */
export async function seedOf(sql: postgres.Sql, gameId: string): Promise<string> {
  const rows = await sql<{ seed: string }[]>`SELECT seed FROM games WHERE id = ${gameId}`;
  const seed = rows[0]?.seed;
  if (!seed) throw new Error(`no game ${gameId}`);
  return seed;
}
