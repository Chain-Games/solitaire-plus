import type { Rank, ScoreBreakdown, TimedMove, XpParts } from '@solitaire-plus/sim';

/** Thin typed fetch wrapper. Cookies carry the session; nothing is stored client-side. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * iPadOS reports itself as a Mac; the one thing that tells them apart is
 * touch. The server's device telemetry (admin dashboard) reads this hint.
 */
const TOUCH = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;

async function call<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (TOUCH) headers['x-solitaire-touch'] = '1';
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: body !== undefined ? JSON.stringify(body) : null,
  });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = (json ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, e.error ?? 'error', e.message ?? res.statusText);
  }
  return json as T;
}

/**
 * The compact progression badge shown next to any username seen by other
 * players. `rank` is `rankFor(xpLevel)` from the sim; the server computes it.
 */
export interface XpBadge {
  xpLevel: number;
  rank: Rank;
}

/** The caller's own progression: lifetime XP plus the level's window [prev, next). */
export interface XpProgress extends XpBadge {
  xp: number;
  /** xpThreshold(xpLevel + 1): where the next level begins. */
  nextThreshold: number;
  /** xpThreshold(xpLevel): where the current level began. */
  prevThreshold: number;
}

/**
 * What a finished game (and, once settled, its challenge) paid, itemised for
 * the results screen. Server-computed from its own replay; the client never
 * sends an XP number. On the finish response the win part is always 0; on a
 * complete ChallengeView's `result` it is folded in for the winner.
 */
export interface XpGained {
  total: number;
  parts: XpParts;
  xpBefore: number;
  xpAfter: number;
  levelBefore: number;
  levelAfter: number;
  rankBefore: Rank;
  rankAfter: Rank;
}

export interface User extends XpProgress {
  id: string;
  username: string;
  isGuest: boolean;
  balance: number;
}

/** GET /api/users/:username. Public; no session needed. */
export interface UserProfile extends XpProgress {
  username: string;
  isGuest: boolean;
  createdAt: string;
  /** Finished games (challenge games; solo games are client-only). */
  gamesPlayed: number;
  challengesWon: number;
  /** Complete challenges the player was a side of. */
  challengesPlayed: number;
  bestScore: number;
  bestLevel: number;
  /** $CHAIN over complete challenges: fees risked, net won on wins, fees lost on losses. */
  chainStaked: number;
  chainWon: number;
  chainLost: number;
  /** chainWon − chainLost. */
  chainPnl: number;
  /** chainWon / chainStaked × 100, one decimal (owner's definition); null until something was staked. */
  chainPnlPct: number | null;
}

/** POST /games/:id/moves: the cards the moves showed, and the server's state hash after them. */
export interface MovesReply {
  count: number;
  reveals: { slot: number; card: number }[];
  stateHash: string;
}

export interface GameView {
  id: string;
  challengeId: string | null;
  /** Null until the game is finished and its challenge settled: the seed is the answer key. */
  seed: string | null;
  /** Slot -> card for every card this game has shown; null for the rest. */
  deal: (number | null)[];
  status: 'pending' | 'playing' | 'finished';
  startedAt: string | null;
  deadlineAt: string | null;
  moveCount: number;
  moves: TimedMove[];
  score: number | null;
  elapsedMs: number | null;
  endReason: string | null;
  breakdown: ScoreBreakdown | null;
  /** Cosmetic level the server's replay reached; null until finished. */
  levelReached: number | null;
  finishedAt: string | null;
  /** The game's own XP award (no win part); null until finished, or if it paid nothing. */
  xpGained: XpGained | null;
  serverNow: string;
}

export interface Participant extends XpBadge {
  id: string;
  username: string;
  gameId: string | null;
  finished: boolean;
  score?: number;
  elapsedMs?: number;
  endReason?: string;
  /** Cosmetic level reached; present whenever the score is. */
  levelReached?: number;
}

export type Margin =
  { by: 'score'; amount: number } | { by: 'time'; amountMs: number } | { by: 'submission' };

export interface ChallengeView {
  id: string;
  code: string;
  status: 'pending' | 'open' | 'taken' | 'complete' | 'expired';
  entryFee: number;
  isPrivate: boolean;
  role: 'creator' | 'taker';
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  /** The latest thing that happened here (settlement, a finished game, or the creation) — the list order and the row's time. */
  activityAt: string;
  me: Participant | null;
  opponent: Participant | null;
  myGameId: string | null;
  myGameStatus: 'pending' | 'playing' | 'finished' | null;
  result: {
    won: boolean;
    margin: Margin;
    payout: number;
    /** The viewer's game award plus the win part if they won; null if the game paid nothing. */
    xpGained: XpGained | null;
  } | null;
}

export interface OpenChallenge {
  id: string;
  code: string;
  entryFee: number;
  createdAt: string;
  expiresAt: string;
  creator: XpBadge & { id: string; username: string };
}

export type NotificationKind =
  'challenge_won' | 'challenge_lost' | 'challenge_taken' | 'challenge_expired';

/**
 * One thing the player should be told about a challenge they are a side of
 * (GET /api/notifications, the `notification` SSE event). `amount` is signed
 * $CHAIN as they felt it: +net on a win, −stake on a loss, +refund on an
 * expiry, 0 on a take.
 */
export interface NotificationItem {
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

export interface NewGameRef {
  challengeId: string;
  code: string;
  gameId: string;
  seed: string;
}

export const api = {
  me: () => call<{ user: User; dailyGranted?: number }>('GET', '/api/auth/me'),
  register: (username: string, password: string) =>
    call<{ user: User }>('POST', '/api/auth/register', { username, password }),
  login: (username: string, password: string) =>
    call<{ user: User }>('POST', '/api/auth/login', { username, password }),
  guest: () => call<{ user: User }>('POST', '/api/auth/guest'),
  logout: () => call<{ ok: true }>('POST', '/api/auth/logout'),

  fees: () => call<{ fees: number[] }>('GET', '/api/challenges/fees'),
  createChallenge: (entryFee: number, isPrivate: boolean) =>
    call<NewGameRef>('POST', '/api/challenges', { entryFee, isPrivate }),
  openChallenges: (entryFee?: number) =>
    call<{ challenges: OpenChallenge[] }>(
      'GET',
      `/api/challenges/open${entryFee !== undefined ? `?entryFee=${entryFee}` : ''}`,
    ),
  takeRandom: (entryFee: number) => call<NewGameRef>('POST', '/api/challenges/take', { entryFee }),
  takeByCode: (code: string) =>
    call<NewGameRef>('POST', `/api/challenges/take/${encodeURIComponent(code)}`),
  myChallenges: () => call<{ challenges: ChallengeView[] }>('GET', '/api/challenges/mine'),
  challenge: (id: string) => call<{ challenge: ChallengeView }>('GET', `/api/challenges/${id}`),

  game: (id: string) => call<{ game: GameView }>('GET', `/api/games/${id}`),
  startGame: (id: string) => call<{ game: GameView }>('POST', `/api/games/${id}/start`),
  sendMoves: (id: string, fromIndex: number, moves: TimedMove[]) =>
    call<MovesReply>('POST', `/api/games/${id}/moves`, { fromIndex, moves }),
  finishGame: (id: string, fromIndex: number, moves: TimedMove[]) =>
    call<{ game: GameView }>('POST', `/api/games/${id}/finish`, { fromIndex, moves }),

  profile: (username: string) =>
    call<{ profile: UserProfile }>('GET', `/api/users/${encodeURIComponent(username)}`),

  notifications: (after?: string) =>
    call<{ items: NotificationItem[]; unread: number }>(
      'GET',
      `/api/notifications${after ? `?after=${encodeURIComponent(after)}` : ''}`,
    ),
  /** Mark these rows read, or every unread row when `ids` is omitted. */
  markNotificationsRead: (ids?: string[]) =>
    call<{ unread: number }>('POST', '/api/notifications/read', ids ? { ids } : {}),

  /** 404 `push-off` when the server has no VAPID keys. */
  pushVapid: () => call<{ publicKey: string }>('GET', '/api/push/vapid'),
  pushSubscribe: (subscription: unknown) =>
    call<{ ok: true }>('POST', '/api/push/subscribe', { subscription }),
  pushUnsubscribe: (endpoint: string) =>
    call<{ ok: true; removed: boolean }>('DELETE', '/api/push/subscribe', { endpoint }),

  /** Stores a finished challenge game's share cards (base64 JPEGs); `url` is the `/s/:id` link that unfurls into them. */
  shareCard: (gameId: string, story: string, link: string) =>
    call<{ id: string; url: string }>('POST', '/api/share', { gameId, story, link }),
};
