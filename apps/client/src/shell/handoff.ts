import { useCallback, useRef, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { worldFor } from '../render/world-table.js';
import { WORLD_DISSOLVE_MS, backdropWorld } from './backdrop-world.js';
import { stakeCoin } from './money.js';
import { explainFirst } from '../tutorial/guide.js';

/** The pill's number settles this long after the dissolve has landed, before the route changes. */
const COUNT_SETTLE_MS = 120;

/**
 * Menu → game continuity, in order: the stake's coin leaves the balance pill
 * for the pot card (480 ms, an arc); the pill counts down as the shell's
 * backdrop dissolves toward the seed's world (600 ms); then the route
 * changes, so the READY frame opens on a world the player is already
 * looking at. Reduced motion skips the waits.
 */
export async function stakeAndGo(o: {
  /** The pot card's coin (nothing flies without one, or for a free game). */
  coin: Element | null;
  /** The fee paid; unknown (a join by code) flies too. */
  stake?: number | undefined;
  seed: string;
  /** Re-reads the session: the balance pill's number counts to the new total. */
  refresh: () => Promise<void>;
  go: () => void;
}): Promise<void> {
  const reduced =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (o.stake === undefined || o.stake > 0) await stakeCoin(o.coin);
  backdropWorld.set(worldFor(o.seed).id);
  // The pill's 600 ms count lands before the cut (a beat after the dissolve).
  await Promise.all([
    o.refresh().catch(() => undefined),
    new Promise((r) => setTimeout(r, reduced ? 0 : WORLD_DISSOLVE_MS + COUNT_SETTLE_MS)),
  ]);
  o.go();
}

/** A fresh solo seed (32 hex chars). */
export function randomSeed(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A link to a solo game that picks the seed first, so the backdrop can come
 * up on its world before the route changes; the seed rides on the
 * navigation state (Play reads it). Modified clicks (a new tab) are left to
 * the browser. A first-timer sees the tutorial first (explainFirst) and the
 * game is dealt as it closes.
 */
export function useSoloLaunch(): (e: MouseEvent<HTMLAnchorElement>) => void {
  const navigate = useNavigate();
  const pending = useRef(false);
  return useCallback(
    (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      e.preventDefault();
      if (pending.current) return;
      pending.current = true;
      explainFirst(() => {
        const seed = randomSeed();
        const reduced =
          typeof matchMedia === 'function' &&
          matchMedia('(prefers-reduced-motion: reduce)').matches;
        backdropWorld.set(worldFor(seed).id);
        setTimeout(
          () => {
            pending.current = false;
            navigate('/play/solo', { state: { seed } });
          },
          reduced ? 0 : WORLD_DISSOLVE_MS,
        );
      });
    },
    [navigate],
  );
}
