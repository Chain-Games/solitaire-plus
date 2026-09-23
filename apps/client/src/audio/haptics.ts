/**
 * Haptics: a mapped vocabulary over `navigator.vibrate`, where the platform
 * has it (Android Chrome and friends; iOS Safari has no vibration API and
 * every call here is a no-op there). Gated by the Settings "Haptics" toggle
 * (`useSettings().haptics`, default on where supported).
 *
 * The map (docs/audio.md, Haptics):
 *
 *   tick    8 ms            a card settles on a tableau pile, a return, each
 *                           autocomplete step; hover over a legal target (max 20/s)
 *   tap     14 ms           a card lands on a foundation (max 12/s)
 *   thump   20 ms           an illegal drop snaps back
 *   clear   15 / 40 / 15    (Blockari's line clear; unused by the card game)
 *   big     120 ms          a 4X streak
 *   toast   30 ms           a toast slides in
 *
 * The audio engine fires tick / tap / thump / big from the same events that
 * play the cues, so the render and shell agents only call `haptic('toast')`
 * themselves (the shell, when a toast lands) — or `haptic(kind)` anywhere a
 * new feel moment needs one.
 */
import { useSettings } from '../state/settings.js';

export type HapticKind = 'tick' | 'tap' | 'thump' | 'clear' | 'big' | 'toast';

export const HAPTIC_PATTERNS: Readonly<Record<HapticKind, number | readonly number[]>> = {
  tick: 8,
  tap: 14,
  thump: 20,
  clear: [15, 40, 15],
  big: 120,
  toast: 30,
};

/**
 * The light kinds are rate-limited (per second), like the cell-tick cue: a
 * fast run of card plays or the autocomplete must not turn into a buzz.
 */
const MAX_PER_S: Partial<Record<HapticKind, number>> = { tick: 20, tap: 12 };
const lastAt = new Map<HapticKind, number>();

/**
 * A platform that can buzz AND is held in the hand: `navigator.vibrate`
 * exists on desktop Chrome and Firefox too (where it does nothing, or worse,
 * fires 20 times a second under a mouse drag), so the gate is the touch
 * device — `(pointer: coarse)` or touch points — the way the shell gates its
 * Settings row.
 */
export function hapticsSupported(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)').matches : false;
  return coarse || (navigator.maxTouchPoints ?? 0) > 0;
}

/**
 * Fire one pattern. Silent when unsupported, when the toggle is off, or when
 * the page is hidden (a vibration with nothing on screen is a bug report).
 */
export function haptic(kind: HapticKind): void {
  if (!hapticsSupported()) return;
  if (!useSettings.getState().haptics) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  const max = MAX_PER_S[kind];
  if (max !== undefined) {
    const now = performance.now();
    if (now - (lastAt.get(kind) ?? -Infinity) < 1000 / max) return;
    lastAt.set(kind, now);
  }
  try {
    const p = HAPTIC_PATTERNS[kind];
    navigator.vibrate(typeof p === 'number' ? p : [...p]);
  } catch {
    // some browsers throw outside a user activation; nothing to do
  }
}
