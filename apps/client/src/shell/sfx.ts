/**
 * The shell's way to a sound. The shell owns no AudioEngine — one lives per
 * game session inside GameHost — so this shim plays a cue through whatever
 * engine has registered itself (audio/engine.ts calls `registerSfxEngine`
 * when it is unlocked, or exposes `window.__blockariAudio`) and is a no-op
 * otherwise. Cue names are the audio engine's (docs/audio.md).
 */

export type ShellCue =
  'rank-up' | 'ui-hover' | 'ui-press' | 'toast-in' | 'inbox-open' | 'odometer-flip';

/** What the audio engine exposes to the shell: a cue by name, and the rank-up (the chime twice). */
export interface SfxEngine {
  cue?: (name: ShellCue) => void;
  rankUp?: () => void;
}

let engine: SfxEngine | null = null;

/** The audio engine announces itself here (null on teardown). */
export function registerSfxEngine(e: SfxEngine | null): void {
  engine = e;
}

function current(): SfxEngine | null {
  if (engine) return engine;
  const w = window as unknown as { __blockariAudio?: SfxEngine };
  return w.__blockariAudio ?? null;
}

/** Play a shell cue if an engine is up; silent otherwise. Never throws. */
export function sfx(name: ShellCue): void {
  const e = current();
  if (!e) return;
  try {
    if (name === 'rank-up' && e.rankUp) e.rankUp();
    else e.cue?.(name);
  } catch {
    // A cue is never worth an error.
  }
}
