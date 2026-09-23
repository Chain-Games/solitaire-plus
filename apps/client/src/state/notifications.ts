import { create } from 'zustand';
import { ApiError, api, type NotificationItem } from '../api/client.js';
import { COIN_FLY_MS } from '../shell/money.js';
import { useSession } from './session.js';

/**
 * Notifications: the inbox (the 20 newest rows and the unread count), the
 * live feed, and the toasts.
 *
 * Delivery: an EventSource on `/api/notifications/stream` (the server pings
 * every 25 s and asks for a 5 s retry); after three errors in a row — or
 * where EventSource does not exist — it falls back to polling the list
 * every 30 s with `after=<newest seen>`. A reconnect catches up the same
 * way, so nothing that landed during a drop is lost.
 *
 * A row that arrives while a game is in progress (GameHost playing or
 * counting down) is QUEUED and shown when the board is gone — never over
 * it. A row about the challenge the player is looking at right now (its
 * results screen, its page) is marked read silently: the screen already
 * says it.
 */

/** Toasts on screen at once; older ones leave first. */
export /** Gap between queued toasts released after a game. */
const FLUSH_STAGGER_MS = 1200;
const MAX_TOASTS = 3;
/** Polling cadence once the stream has given up. */
const POLL_MS = 30_000;
/** EventSource errors in a row before polling takes over. */
const SSE_GIVE_UP = 3;
/** Rows kept in the inbox (the server's page). */
const INBOX_SIZE = 20;

type Transport = 'idle' | 'sse' | 'polling';

interface NotificationsState {
  items: NotificationItem[];
  unread: number;
  /** The first inbox load has answered. */
  loaded: boolean;
  transport: Transport;
  toasts: NotificationItem[];
  queued: NotificationItem[];
  inGame: boolean;
  viewing: string | null;
  connect: () => void;
  disconnect: () => void;
  loadInbox: () => Promise<void>;
  markRead: (ids?: string[]) => Promise<void>;
  dismissToast: (id: string) => void;
  setInGame: (on: boolean) => void;
  setViewing: (challengeId: string | null) => void;
  /** A row arrived (the stream, a poll): inbox first, then the toast. */
  receive: (item: NotificationItem) => void;
}

let source: EventSource | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let sseErrors = 0;
/** createdAt of the newest row seen, for `after=` catch-ups. */
let newest = '';
/** Bumped by connect() so a stale connection's callbacks are ignored. */
let generation = 0;

function stopTransport(): void {
  if (source) {
    source.close();
    source = null;
  }
  if (poll) {
    clearInterval(poll);
    poll = null;
  }
}

export const useNotifications = create<NotificationsState>((set, get) => {
  /** Newer rows than `newest`, oldest first so they toast in order. */
  const catchUp = async (gen: number) => {
    try {
      const { items, unread } = await api.notifications(newest || undefined);
      if (gen !== generation) return;
      for (const item of [...items].reverse()) get().receive(item);
      set({ unread });
    } catch {
      // the next tick tries again
    }
  };

  const startPolling = (gen: number) => {
    if (gen !== generation || poll) return;
    set({ transport: 'polling' });
    poll = setInterval(() => void catchUp(gen), POLL_MS);
  };

  const startStream = (gen: number) => {
    if (typeof EventSource === 'undefined') {
      startPolling(gen);
      return;
    }
    const es = new EventSource('/api/notifications/stream');
    source = es;
    set({ transport: 'sse' });
    let dropped = false;
    es.addEventListener('open', () => {
      if (gen !== generation) return;
      sseErrors = 0;
      // Back after a drop: whatever landed meanwhile.
      if (dropped) void catchUp(gen);
      dropped = false;
    });
    es.addEventListener('notification', (e) => {
      if (gen !== generation) return;
      try {
        get().receive(JSON.parse((e as MessageEvent<string>).data) as NotificationItem);
      } catch {
        // a malformed event is dropped; the next poll or reconnect has the row
      }
    });
    es.addEventListener('error', () => {
      if (gen !== generation) return;
      dropped = true;
      sseErrors++;
      if (sseErrors >= SSE_GIVE_UP) {
        es.close();
        source = null;
        startPolling(gen);
      }
    });
  };

  return {
    items: [],
    unread: 0,
    loaded: false,
    transport: 'idle',
    toasts: [],
    queued: [],
    inGame: false,
    viewing: null,

    connect: () => {
      stopTransport();
      const gen = ++generation;
      sseErrors = 0;
      void get()
        .loadInbox()
        .then(() => {
          if (gen === generation) startStream(gen);
        });
    },

    disconnect: () => {
      generation++;
      stopTransport();
      newest = '';
      set({
        items: [],
        unread: 0,
        loaded: false,
        transport: 'idle',
        toasts: [],
        queued: [],
      });
    },

    loadInbox: async () => {
      try {
        const { items, unread } = await api.notifications();
        const top = items[0]?.createdAt;
        if (top && top > newest) newest = top;
        set({ items, unread, loaded: true });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) get().disconnect();
        else set({ loaded: true });
      }
    },

    markRead: async (ids) => {
      const now = new Date().toISOString();
      const wanted = ids ? new Set(ids) : null;
      // Optimistic: the rows read now, the count from the server after.
      set((s) => ({
        items: s.items.map((i) =>
          i.readAt === null && (!wanted || wanted.has(i.id)) ? { ...i, readAt: now } : i,
        ),
        unread: wanted
          ? Math.max(
              0,
              s.unread - s.items.filter((i) => i.readAt === null && wanted.has(i.id)).length,
            )
          : 0,
      }));
      try {
        const { unread } = await api.markNotificationsRead(ids);
        set({ unread });
      } catch {
        // the next load corrects the count
      }
    },

    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    setInGame: (on) => {
      if (on) {
        set({ inGame: true });
        return;
      }
      // Leaving the game: the queue flushes as ONE toast at a time, newest
      // first — three stale results landing together read as an error.
      const { queued, toasts } = get();
      const flush = [...queued].reverse();
      set({ inGame: false, queued: [], toasts: [...toasts, ...flush].slice(-1) });
      const rest = flush.slice(1);
      let i = 0;
      const next = () => {
        const t = rest[i++];
        if (!t) return;
        set({ toasts: [...get().toasts, t].slice(-MAX_TOASTS) });
        setTimeout(next, FLUSH_STAGGER_MS);
      };
      if (rest.length) setTimeout(next, FLUSH_STAGGER_MS);
    },

    setViewing: (challengeId) => set({ viewing: challengeId }),

    receive: (item) => {
      const s = get();
      if (s.items.some((i) => i.id === item.id)) return;
      if (item.createdAt > newest) newest = item.createdAt;
      set({
        items: [item, ...s.items].slice(0, INBOX_SIZE),
        unread: s.unread + (item.readAt === null ? 1 : 0),
      });
      // The stake moved: the balance pill counts to the new number — after the toast's coin
      // has landed on it (shell/money.ts), so the coin arrives before the number moves.
      if (item.kind === 'challenge_won' || item.kind === 'challenge_expired')
        setTimeout(() => void useSession.getState().refresh(), COIN_FLY_MS + 40);
      // The screen the player is on already says it.
      if (s.viewing === item.challengeId) {
        if (item.readAt === null) void get().markRead([item.id]);
        return;
      }
      if (item.readAt !== null) return; // a catch-up of something already read: no toast
      // A later word about the same challenge supersedes an earlier one that
      // is still waiting (taken → won): one toast per challenge, the latest.
      const supersede = (list: NotificationItem[]) =>
        list.filter((t) => t.challengeId !== item.challengeId);
      if (s.inGame) set({ queued: [...supersede(get().queued), item] });
      else set({ toasts: [...supersede(get().toasts), item].slice(-MAX_TOASTS) });
    },
  };
});
