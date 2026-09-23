import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { RANKS, rankFor, type Rank } from '@solitaire-plus/sim';
import { ENTRY_FEES } from '../config.js';
import type { Db } from '../db/index.js';
import type { DeviceKind, EndReason } from '../db/schema.js';

/**
 * Everything the admin dashboard shows, in one round trip. One call rather
 * than a dozen endpoints because the page refreshes as a whole and the numbers
 * have to agree with each other — a leaderboard read a second after the
 * counts is a leaderboard that can contradict them. The shape mirrors
 * 21 Wild's `/api/admin/overview` so one combined dashboard can read both.
 *
 * "Played" throughout = finished with at least one move, the same line
 * the profile and XP draw: a game swept before its first piece is not a game
 * anyone played.
 */

export interface AdminOverview {
  totals: {
    players: number;
    guests: number;
    gamesPlayed: number;
    bestScore: number;
    avgScore: number;
    bestLevel: number;
    xpAwarded: number;
    chainStaked: number;
  };
  gamesPerDay: { day: string; games: number; players: number }[];
  howGamesEnd: Record<EndReason, number>;
  scoreSpread: { label: string; games: number }[];
  levelsReached: { level: string; games: number }[];
  ranks: { rank: string; players: number }[];
  challengePool: { fee: number; open: number; taken: number; complete: number; expired: number }[];
  leaderboard: {
    username: string;
    rank: Rank;
    score: number;
    level: number;
    where: string | null;
    endedAt: string;
  }[];
  recentGames: {
    username: string;
    score: number;
    level: number;
    cards: number;
    endReason: EndReason;
    fee: number | null;
    endedAt: string;
  }[];
  where: { country: string; region: string | null; players: number }[];
  devices: { name: DeviceKind; players: number }[];
  systems: { name: string; players: number }[];
  browsers: { name: string; players: number }[];
}

export const DAYS = 30;
export const SCORE_BUCKETS: readonly { label: string; from: number; to: number | null }[] = [
  { label: '0–999', from: 0, to: 1000 },
  { label: '1,000–2,999', from: 1000, to: 3000 },
  { label: '3,000–5,999', from: 3000, to: 6000 },
  { label: '6,000–9,999', from: 6000, to: 10_000 },
  { label: '10,000+', from: 10_000, to: null },
];
export const MAX_LEVEL_BUCKET = 10;

const played = (t: string) =>
  sql`${sql.raw(t)}.status = 'finished' AND coalesce((${sql.raw(t)}.breakdown ->> 'moves')::int, 0) >= 1`;

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const whereOf = (country: unknown, region: unknown): string | null => {
  if (typeof country !== 'string' || !country) return null;
  return typeof region === 'string' && region ? `${region}, ${country}` : country;
};

/** Count the session keys without KEYS: SCAN the store's prefix in batches. */
export async function countSessions(redis: Redis, prefix: string): Promise<number> {
  let cursor = '0';
  let total = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    total += keys.length;
  } while (cursor !== '0');
  return total;
}

export async function adminOverview(db: Db, now = new Date()): Promise<AdminOverview> {
  type Row = Record<string, unknown>;
  const q = (query: ReturnType<typeof sql>): Promise<Row[]> =>
    db.execute<Row>(query).then((r) => [...r]);

  // One Promise.all: every number on the page comes from the same instant.
  const [
    userRows,
    gameRows,
    xpRows,
    stakeRows,
    dayRows,
    endRows,
    spreadRows,
    levelRows,
    rankRows,
    poolRows,
    boardRows,
    recentRows,
    whereRows,
    deviceRows,
    osRows,
    browserRows,
  ] = await Promise.all([
    q(sql`SELECT count(*) FILTER (WHERE NOT is_guest)::int AS players,
                 count(*) FILTER (WHERE is_guest)::int AS guests
            FROM users`),
    q(sql`SELECT count(*)::int AS games_played,
                 coalesce(max(score), 0)::int AS best_score,
                 coalesce(round(avg(score)), 0)::int AS avg_score,
                 coalesce(max(level_reached), 0)::int AS best_level
            FROM games g WHERE ${played('g')}`),
    q(sql`SELECT coalesce(sum(amount), 0)::int AS xp_awarded FROM xp_events`),
    q(sql`SELECT coalesce(sum(entry_fee), 0)::int AS chain_staked
            FROM challenges WHERE status = 'complete'`),
    // A date spine, so a day with no games is a zero and not a gap.
    q(sql`SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                 count(g.id)::int AS games,
                 count(DISTINCT g.user_id)::int AS players
            FROM generate_series(
                   (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')::date - ${sql.raw(String(DAYS - 1))},
                   (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')::date,
                   interval '1 day') AS d(day)
            LEFT JOIN games g
              ON (g.finished_at AT TIME ZONE 'UTC')::date = d.day
             AND ${played('g')}
           GROUP BY d.day ORDER BY d.day`),
    q(sql`SELECT end_reason, count(*)::int AS games
            FROM games g WHERE ${played('g')} GROUP BY end_reason`),
    q(
      sql`SELECT ${sql.join(
        SCORE_BUCKETS.map(
          (b, i) =>
            sql`count(*) FILTER (WHERE score >= ${sql.raw(String(b.from))}${b.to === null ? sql`` : sql` AND score < ${sql.raw(String(b.to))}`})::int AS ${sql.raw(`b${i}`)}`,
        ),
        sql`, `,
      )} FROM games g WHERE ${played('g')}`,
    ),
    q(sql`SELECT least(level_reached, ${sql.raw(String(MAX_LEVEL_BUCKET))})::int AS level, count(*)::int AS games
            FROM games g WHERE ${played('g')} AND level_reached IS NOT NULL GROUP BY 1`),
    q(sql`SELECT xp_level, count(*)::int AS players FROM users GROUP BY xp_level`),
    q(sql`SELECT entry_fee, status, count(*)::int AS challenges
            FROM challenges GROUP BY entry_fee, status`),
    q(sql`SELECT u.username, u.xp_level, g.score, g.level_reached, g.finished_at,
                 c.country, c.region
            FROM games g
            JOIN users u ON u.id = g.user_id
            LEFT JOIN client_meta c ON c.user_id = g.user_id
           WHERE ${played('g')} AND g.challenge_id IS NOT NULL
           ORDER BY g.score DESC, g.finished_at ASC
           LIMIT 20`),
    q(sql`SELECT u.username, g.score, g.level_reached, g.end_reason, g.finished_at,
                 coalesce((g.breakdown ->> 'cardsHome')::int, 0) AS cards,
                 ch.entry_fee
            FROM games g
            JOIN users u ON u.id = g.user_id
            LEFT JOIN challenges ch ON ch.id = g.challenge_id
           WHERE ${played('g')}
           ORDER BY g.finished_at DESC
           LIMIT 20`),
    q(sql`SELECT country, region, count(*)::int AS players
            FROM client_meta WHERE country IS NOT NULL
           GROUP BY country, region ORDER BY players DESC, country, region LIMIT 20`),
    q(sql`SELECT device AS name, count(*)::int AS players FROM client_meta
           GROUP BY device ORDER BY players DESC, name`),
    q(sql`SELECT os AS name, count(*)::int AS players FROM client_meta
           GROUP BY os ORDER BY players DESC, name LIMIT 10`),
    q(sql`SELECT browser AS name, count(*)::int AS players FROM client_meta
           GROUP BY browser ORDER BY players DESC, name LIMIT 10`),
  ]);

  const u = userRows[0] ?? {};
  const g = gameRows[0] ?? {};

  const howGamesEnd: Record<EndReason, number> = { cleared: 0, timeout: 0, forfeit: 0 };
  for (const r of endRows) {
    const k = String(r['end_reason']);
    if (k in howGamesEnd) howGamesEnd[k as EndReason] = n(r['games']);
  }

  const spread = spreadRows[0] ?? {};
  const scoreSpread = SCORE_BUCKETS.map((b, i) => ({ label: b.label, games: n(spread[`b${i}`]) }));

  const levels = new Map(levelRows.map((r) => [n(r['level']), n(r['games'])]));
  const levelsReached = Array.from({ length: MAX_LEVEL_BUCKET }, (_, i) => {
    const level = i + 1;
    return {
      level: level === MAX_LEVEL_BUCKET ? `${level}+` : String(level),
      games: levels.get(level) ?? 0,
    };
  });

  // Ladder order, zeros included; "Legend II" and beyond fold into Legend.
  const ranks = RANKS.map((rank) => ({ rank, players: 0 }));
  for (const r of rankRows) {
    const slot = ranks[rankFor(n(r['xp_level'])).index];
    if (slot) slot.players += n(r['players']);
  }

  const challengePool = ENTRY_FEES.map((fee) => ({
    fee,
    open: 0,
    taken: 0,
    complete: 0,
    expired: 0,
  }));
  for (const r of poolRows) {
    const slot = challengePool.find((p) => p.fee === n(r['entry_fee']));
    const status = String(r['status']);
    if (
      slot &&
      (status === 'open' || status === 'taken' || status === 'complete' || status === 'expired')
    )
      slot[status] = n(r['challenges']);
  }

  return {
    totals: {
      players: n(u['players']),
      guests: n(u['guests']),
      gamesPlayed: n(g['games_played']),
      bestScore: n(g['best_score']),
      avgScore: n(g['avg_score']),
      bestLevel: n(g['best_level']),
      xpAwarded: n(xpRows[0]?.['xp_awarded']),
      chainStaked: n(stakeRows[0]?.['chain_staked']),
    },
    gamesPerDay: dayRows.map((r) => ({
      day: String(r['day']),
      games: n(r['games']),
      players: n(r['players']),
    })),
    howGamesEnd,
    scoreSpread,
    levelsReached,
    ranks,
    challengePool,
    leaderboard: boardRows.map((r) => ({
      username: String(r['username']),
      rank: rankFor(n(r['xp_level'])),
      score: n(r['score']),
      level: n(r['level_reached']),
      where: whereOf(r['country'], r['region']),
      endedAt: iso(r['finished_at']),
    })),
    recentGames: recentRows.map((r) => ({
      username: String(r['username']),
      score: n(r['score']),
      level: n(r['level_reached']),
      cards: n(r['cards']),
      endReason: String(r['end_reason']) as EndReason,
      fee: r['entry_fee'] === null || r['entry_fee'] === undefined ? null : n(r['entry_fee']),
      endedAt: iso(r['finished_at']),
    })),
    where: whereRows.map((r) => ({
      country: String(r['country']),
      region: typeof r['region'] === 'string' ? r['region'] : null,
      players: n(r['players']),
    })),
    devices: deviceRows.map((r) => ({
      name: String(r['name']) as DeviceKind,
      players: n(r['players']),
    })),
    systems: osRows.map((r) => ({ name: String(r['name']), players: n(r['players']) })),
    browsers: browserRows.map((r) => ({ name: String(r['name']), players: n(r['players']) })),
  };
}
