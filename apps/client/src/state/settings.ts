import { create } from 'zustand';
import type { QualityTier } from '../render/quality.js';
import { defaultTier } from '../render/quality.js';

export interface Volumes {
  master: number;
  music: number;
  sfx: number;
}

/** Music leads; SFX are a complement under it. */
export const DEFAULT_VOLUMES: Volumes = { master: 0.8, music: 0.85, sfx: 0.4 };

interface Settings {
  quality: QualityTier;
  sound: boolean;
  volumes: Volumes;
  /** Vibration on feel moments (audio/haptics.ts). Default on where the platform has it. */
  haptics: boolean;
  /**
   * Supersampling cap for this session (render/quality.ts `ssaa`): the
   * resolution the in-game governor stepped down to after a stretch of slow
   * frames — the renderer's on a fine pointer, the world filter's on a
   * coarse one — so the next game starts there instead of thrashing.
   * Never persisted; `null` = uncapped.
   */
  ssaaCap: number | null;
  setQuality: (q: QualityTier) => void;
  setSound: (on: boolean) => void;
  setVolume: (key: keyof Volumes, value: number) => void;
  setHaptics: (on: boolean) => void;
  setSsaaCap: (cap: number | null) => void;
}

const KEY = 'blockari.settings';

type Saved = Pick<Settings, 'quality' | 'sound' | 'volumes' | 'haptics'>;

/**
 * On by default where the device can buzz and is held: `navigator.vibrate`
 * plus a coarse pointer / touch points (desktop Chrome has `vibrate` too, and
 * nothing to buzz). iOS Safari has no vibration API; the toggle then does nothing.
 */
function defaultHaptics(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)').matches : false;
  return coarse || (navigator.maxTouchPoints ?? 0) > 0;
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Saved>;
      return {
        quality: parsed.quality ?? defaultTier(),
        sound: parsed.sound ?? true,
        volumes: { ...DEFAULT_VOLUMES, ...(parsed.volumes ?? {}) },
        haptics: parsed.haptics ?? defaultHaptics(),
      };
    }
  } catch {
    // ignore
  }
  return {
    quality: defaultTier(),
    sound: true,
    volumes: { ...DEFAULT_VOLUMES },
    haptics: defaultHaptics(),
  };
}

function saved(s: Settings): Saved {
  return { quality: s.quality, sound: s.sound, volumes: s.volumes, haptics: s.haptics };
}

function save(s: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

export const useSettings = create<Settings>((set, get) => ({
  ...load(),
  ssaaCap: null,
  setQuality: (quality) => {
    set({ quality });
    save(saved(get()));
  },
  setSound: (sound) => {
    set({ sound });
    save(saved(get()));
  },
  setVolume: (key, value) => {
    const volumes = { ...get().volumes, [key]: Math.max(0, Math.min(1, value)) };
    set({ volumes });
    save(saved(get()));
  },
  setHaptics: (haptics) => {
    set({ haptics });
    save(saved(get()));
  },
  setSsaaCap: (ssaaCap) => set({ ssaaCap }),
}));
