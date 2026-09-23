import { create } from 'zustand';
import type { User } from '../api/client.js';

/**
 * Rank crossings the shell owes a ceremony to. The results tray plays the
 * full rank-up in the engine; this is its echo everywhere else
 * (docs/art-direction.md "XP and ranks"): when the session's rank index has
 * risen since the last one this browser saw for the user, the crossing is
 * ARMED here; the shell FIRES it once it is on screen — the top-bar ring
 * sweeps, every badge of "me" plays the miniature — and the profile hero
 * replays the full ceremony once, on its first visit after the crossing.
 *
 * Persistence (localStorage, per user id):
 *   solitaire.rank.seen.<id>      the rank index last shown; a rise arms a crossing
 *   solitaire.rank.ceremony.<id>  the rank index whose profile ceremony has played
 *
 * `?rankUp=1` arms a crossing into the current rank on every load (capture
 * fixture) without touching storage.
 */

export interface Crossing {
  /** Rank index left behind. */
  from: number;
  /** Rank index reached. */
  to: number;
}

/**
 * The crossing's ONE timeline, in phases every placement derives from (the
 * badge, the name, the chip, the bar, the ring all read the same field and
 * change in the same React commit — never a CSS delay and a timer expected
 * to coincide):
 *   hold    from the firing: the state before the crossing; the old cube
 *           dissolves, the light blooms
 *   reveal  +MINI_REVEAL_MS: the new cube, the name's flap, the chip's flip,
 *           the bar's span and the ring's packet, together
 *   settled +MINI_REVEAL_MS + RING_SWEEP_MS: the ring's arc is the new one
 */
export type CrossingPhase = 'hold' | 'reveal' | 'settled';

export interface ActiveCrossing extends Crossing {
  /** Bumps per firing so a placement plays each crossing once. */
  seq: number;
  /** performance.now() at the firing. */
  at: number;
  phase: CrossingPhase;
}

interface RankUpState {
  /** A crossing seen by the session, waiting for the shell to be on screen. */
  armed: Crossing | null;
  /** The crossing the shell is playing now; cleared ACTIVE_MS after the firing. */
  active: ActiveCrossing | null;
  /** The profile hero's full ceremony, owed for this crossing. */
  ceremony: Crossing | null;
  /** The session's user changed: compare the rank with the last one seen. */
  observe: (user: User | null) => void;
  /** The shell (where the placements are) is mounted: a crossing observed now fires at once. */
  shellUp: boolean;
  setShellUp: (up: boolean) => void;
  /** The shell is on screen: play the armed crossing. */
  fire: () => void;
  /** Tooling (`?debug=1&hold=1`): put the timeline at `ms` since the firing. */
  seek: (ms: number) => void;
  /** The profile hero has played its ceremony for this rank. */
  ceremonyDone: () => void;
}

/** How long a fired crossing stays live for placements that mount after it (a route change into the profile, the inbox). */
export const ACTIVE_MS = 6000;
/** The reveal lands this long after the firing (styles: --mini-reveal-at is documentation only; JS drives it). */
export const MINI_REVEAL_MS = 200;
/** The ring's packet runs this long from the reveal (styles: --rank-sweep). */
export const RING_SWEEP_MS = 900;

function phaseAt(ms: number): CrossingPhase {
  return ms < MINI_REVEAL_MS ? 'hold' : ms < MINI_REVEAL_MS + RING_SWEEP_MS ? 'reveal' : 'settled';
}

const SEEN = 'solitaire.rank.seen.';
const CEREMONY = 'solitaire.rank.ceremony.';

function readIndex(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function writeIndex(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore
  }
}

let forcedCached: boolean | null = null;
/** `?rankUp=1` on the URL (read once per load). */
function forced(): boolean {
  if (forcedCached === null) {
    try {
      forcedCached = new URLSearchParams(location.search).get('rankUp') === '1';
    } catch {
      forcedCached = false;
    }
  }
  return forcedCached;
}

function debug(): boolean {
  try {
    return new URLSearchParams(location.search).has('debug');
  } catch {
    return false;
  }
}

/** `?debug=1&hold=1`: the crossing never retires (capture fixture). */
function hold(): boolean {
  try {
    const q = new URLSearchParams(location.search);
    return q.has('debug') && q.get('hold') === '1';
  } catch {
    return false;
  }
}

let seq = 0;
let timers: ReturnType<typeof setTimeout>[] = [];
let userId: string | null = null;

function clearTimers(): void {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

/** Runs `fn` after the next paint (a double rAF: the first lands before it, the second after). */
function afterPaint(fn: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

export const useRankUp = create<RankUpState>((set, get) => ({
  armed: null,
  active: null,
  ceremony: null,
  shellUp: false,
  setShellUp: (shellUp) => set({ shellUp }),
  observe: (user) => {
    if (!user) {
      userId = null;
      return;
    }
    const now = user.rank.index;
    if (forced()) {
      // The fixture: a crossing into the current rank, once per load.
      if (userId === user.id) return;
      userId = user.id;
      const from = Math.max(0, now - 1);
      set({ armed: { from, to: now }, ceremony: { from, to: now } });
      // With the shell up the firing lands in the same React batch as the user: every placement's
      // FIRST render is already the state before the crossing (never the new level, then the old).
      if (get().shellUp) get().fire();
      return;
    }
    userId = user.id;
    const seen = readIndex(SEEN + user.id);
    if (seen === null) {
      writeIndex(SEEN + user.id, now);
      return;
    }
    if (now <= seen) return;
    writeIndex(SEEN + user.id, now);
    const crossing = { from: seen, to: now };
    const played = readIndex(CEREMONY + user.id);
    set({
      armed: crossing,
      ceremony: played !== null && played >= now ? get().ceremony : crossing,
    });
    if (get().shellUp) get().fire();
  },
  fire: () => {
    const armed = get().armed;
    if (!armed) return;
    seq++;
    clearTimers();
    const mine = seq;
    const active: ActiveCrossing = { ...armed, seq, at: performance.now(), phase: 'hold' };
    set({ armed: null, active });
    if (debug()) {
      // Tooling hook (capture harness): put the crossing's timeline at a time since the firing.
      (
        window as unknown as { __blockariRankUp?: { seek: (ms: number) => void } }
      ).__blockariRankUp = { seek: get().seek };
    }
    if (hold()) return;
    const phase = (p: CrossingPhase) => {
      const a = get().active;
      if (a && a.seq === mine) set({ active: { ...a, phase: p } });
    };
    // Chained from PAINTS, not from each other's timers: the hold's clock starts once the hold
    // state has been painted (a double rAF after the firing), and the settle's once the reveal
    // has — so under a stalled main thread the hold is never held while unpainted, and the
    // packet always gets its whole run (the 74 % snap) before the ring settles.
    afterPaint(() => {
      if (get().active?.seq !== mine) return;
      timers.push(
        setTimeout(() => {
          phase('reveal');
          afterPaint(() => {
            if (get().active?.seq !== mine) return;
            timers.push(setTimeout(() => phase('settled'), RING_SWEEP_MS));
          });
        }, MINI_REVEAL_MS),
      );
    });
    timers.push(
      setTimeout(
        () => {
          if (get().active?.seq === mine) set({ active: null });
        },
        ACTIVE_MS + MINI_REVEAL_MS + RING_SWEEP_MS,
      ),
    );
  },
  seek: (ms) => {
    const a = get().active;
    if (!a) return;
    clearTimers();
    set({ active: { ...a, phase: phaseAt(ms) } });
  },
  ceremonyDone: () => {
    const c = get().ceremony;
    if (!c) return;
    if (userId && !forced()) writeIndex(CEREMONY + userId, c.to);
    set({ ceremony: null });
  },
}));
