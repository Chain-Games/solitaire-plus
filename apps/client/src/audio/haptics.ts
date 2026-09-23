/**
 * Haptics: a mapped vocabulary over `navigator.vibrate`, where the platform
 * has it (Android Chrome and friends; iOS Safari has no vibration API and
 * every call here is a no-op there). Gated by the Settings "Haptics" toggle
 * (`useSettings().haptics`, default on where supported).
 *
 * The map (docs/audio.md, Haptics):
 *
 *   tick    8 ms            hover over a legal cell during a drag (max 20/s)
 *   thump   20 ms           a piece lands
 *   clear   15 / 40 / 15    a line clear (double pulse: 15 on, 40 off, 15 on)
 *   big     120 ms          a 4X streak
 *   toast   30 ms           a toast slides in
 *
 * The audio engine fires tick / thump / clear / big from the same events that
 * play the cues, so the render and shell agents only call `haptic('toast')`
 * themselves (the shell, when a toast lands) — or `haptic(kind)` anywhere a
 * new feel moment needs one.
 */
import { useSettings } from '../state/settings.js';

export type HapticKind = 'tick' | 'thump' | 'clear' | 'big' | 'toast';

export const HAPTIC_PATTERNS: Readonly<Record<HapticKind, number | readonly number[]>> = {
  tick: 8,
  thump: 20,
  clear: [15, 40, 15],
  big: 120,
  toast: 30,
};

/** Ticks are rate-limited to this many per second, like the cell-tick cue. */
const TICK_MAX_PER_S = 20;
let lastTickAt = -Infinity;

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
  if (kind === 'tick') {
    const now = performance.now();
    if (now - lastTickAt < 1000 / TICK_MAX_PER_S) return;
    lastTickAt = now;
  }
  try {
    const p = HAPTIC_PATTERNS[kind];
    navigator.vibrate(typeof p === 'number' ? p : [...p]);
  } catch {
    // some browsers throw outside a user activation; nothing to do
  }
}
