import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../state/settings.js';
import type { ShellBackdrop } from './backdrop.js';

/**
 * Mounts the living backdrop behind the shell. Pixi is loaded lazily so the
 * lobby's first paint does not wait on the engine chunk; the canvas fades in
 * once its first frame is drawn. Low tier and reduced motion get one still
 * frame; a hidden tab parks the loop (see ShellBackdrop). A backdrop that
 * starts on the world the game just left (results → home) skips the fade-in:
 * its first frame IS the world, and the dissolve back to the ground is the
 * transition (`backdrop-world.ts`).
 */
export function Backdrop() {
  const ref = useRef<HTMLDivElement>(null);
  const quality = useSettings((s) => s.quality);
  const [live, setLive] = useState<'' | 'is-live' | 'is-live from-world'>('');
  const instance = useRef<ShellBackdrop | null>(null);

  useEffect(() => {
    const parent = ref.current;
    if (!parent) return;
    let cancelled = false;
    let backdrop: ShellBackdrop | null = null;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const tier = useSettings.getState().quality;
    const animate = !reduced && tier !== 'low';

    import('./backdrop.js').then(
      async ({ ShellBackdrop }) => {
        if (cancelled) return;
        backdrop = new ShellBackdrop();
        instance.current = backdrop;
        try {
          await backdrop.init(parent, tier, animate);
          if (cancelled) return;
          setLive(backdrop.startedOnWorld ? 'is-live from-world' : 'is-live');
          if (new URLSearchParams(location.search).has('debug')) {
            (window as unknown as { __blockariBackdrop?: unknown }).__blockariBackdrop = backdrop;
          }
        } catch {
          // No WebGL: the CSS gradient ground stays. Nothing to do.
        }
      },
      () => {
        // Chunk failed to load; the CSS ground stays.
      },
    );

    return () => {
      cancelled = true;
      backdrop?.destroy();
      instance.current = null;
    };
  }, []);

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    instance.current?.setAnimate(!reduced && quality !== 'low');
  }, [quality]);

  return <div ref={ref} className={`backdrop${live ? ` ${live}` : ''}`} aria-hidden />;
}
