/**
 * The shell's shared UI audio: one small engine (scope `ui`) that loads only
 * the five UI cues and follows the sound settings, so a toast, the inbox, a
 * button or a split-flap counter can make its sound from anywhere in the
 * React tree without a game session in scope.
 *
 *   import { uiSound } from '../audio/ui.js';
 *   uiSound('press');     // 'hover' | 'press' | 'toast' | 'inbox' | 'flip'
 *
 * The engine unlocks itself on the first pointerdown / keydown anywhere (a
 * user gesture is required before any audio can play), so a sound asked for
 * before that is simply not played — a UI tick is never worth a queue.
 * `uiSound('toast')` also fires the 30 ms haptic (audio/haptics.ts).
 */
import { useSettings } from '../state/settings.js';
import { AudioEngine, type UiCue } from './engine.js';

let shared: AudioEngine | null = null;

function engine(): AudioEngine {
  if (shared) return shared;
  const s = useSettings.getState();
  const e = new AudioEngine(s.sound, { scope: 'ui' });
  e.setMix(s.volumes);
  useSettings.subscribe((next, prev) => {
    if (next.sound !== prev.sound) e.setEnabled(next.sound);
    if (next.volumes !== prev.volumes) e.setMix(next.volumes);
  });
  if (typeof document !== 'undefined') {
    const unlock = (): void => e.unlock();
    document.addEventListener('pointerdown', unlock, { passive: true, capture: true });
    document.addEventListener('keydown', unlock, { passive: true, capture: true });
  }
  shared = e;
  return e;
}

/** Prime the shared engine early (optional: the first gesture does it anyway). */
export function unlockUiAudio(): void {
  engine().unlock();
}

/**
 * Create the shared engine so the shell's `sfx()` shim has something to
 * reach outside a game: the engine announces itself on
 * `window.__blockariAudio` (the shim's fallback) once a gesture unlocks it.
 */
export function installUiAudio(): void {
  engine();
}

export function uiSound(kind: UiCue): void {
  engine().ui(kind);
}

export type { UiCue };
