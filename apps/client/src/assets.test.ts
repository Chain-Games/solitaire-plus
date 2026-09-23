import { describe, expect, it } from 'vitest';
import { resolveAsset } from './assets.js';

/**
 * The asset map (apps/client/hashed-public.ts) sends the audio and world
 * files to their content-hashed copies under assets/; anything the map
 * does not know (dev, or a file the build did not hash) is served as is.
 */
describe('resolveAsset', () => {
  const map = {
    'audio/manifest.json': 'assets/audio/manifest.0f3a9c1e.json',
    'audio/sfx/place.ogg': 'assets/audio/sfx/place.3f2a9c1e.ogg',
    'worlds/coral-cove/far.1280.webp': 'assets/worlds/coral-cove/far.1280.9b1c22d0.webp',
  };

  it('resolves a mapped path to its hashed copy under the base', () => {
    expect(resolveAsset('audio/sfx/place.ogg', map, '/')).toBe(
      '/assets/audio/sfx/place.3f2a9c1e.ogg',
    );
    expect(resolveAsset('worlds/coral-cove/far.1280.webp', map, '/')).toBe(
      '/assets/worlds/coral-cove/far.1280.9b1c22d0.webp',
    );
    expect(resolveAsset('audio/manifest.json', map, '/')).toBe(
      '/assets/audio/manifest.0f3a9c1e.json',
    );
  });

  it('passes an unmapped path through (dev, or a file the build did not hash)', () => {
    expect(resolveAsset('worlds/coral-cove/far.webp', map, '/')).toBe(
      '/worlds/coral-cove/far.webp',
    );
    expect(resolveAsset('audio/sfx/place.ogg', {}, '/')).toBe('/audio/sfx/place.ogg');
  });

  it('honours a non-root base', () => {
    expect(resolveAsset('audio/sfx/place.ogg', map, '/play/')).toBe(
      '/play/assets/audio/sfx/place.3f2a9c1e.ogg',
    );
    expect(resolveAsset('brand/og-card.jpg', map, '/play/')).toBe('/play/brand/og-card.jpg');
  });
});
