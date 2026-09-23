import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { assetUrl } from '../assets.js';

/**
 * The game's READY frame on the world the shell just dissolved to: the
 * world's flat painting, in the shell's exposure, under GameHost's ready
 * overlay (its scrim and blur sit on top), so the route change is no cut in
 * luminance. It lives inside `.game-root` (a portal, between the canvas and
 * the overlay) and fades out over WORLD_VEIL_OUT_MS once the game starts,
 * handing over to the engine's own world under the countdown.
 */
export const WORLD_VEIL_OUT_MS = 600;

export function WorldVeil({ worldId, leaving }: { worldId: string | null; leaving: boolean }) {
  const [host, setHost] = useState<Element | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    setHost(document.querySelector('.game-root'));
  }, []);
  useEffect(() => {
    if (!leaving) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = setTimeout(() => setGone(true), reduced ? 0 : WORLD_VEIL_OUT_MS);
    return () => clearTimeout(t);
  }, [leaving]);
  if (!host || !worldId || gone) return null;
  return createPortal(
    <div
      className={`world-veil${leaving ? ' leaving' : ''}`}
      style={
        { backgroundImage: `url(${assetUrl(`worlds/${worldId}/flat.1280.webp`)})` } as CSSProperties
      }
      aria-hidden
    />,
    host,
  );
}
