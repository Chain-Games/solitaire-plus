import { describe, expect, it } from 'vitest';
import { contentHash, hashedPath } from './hashed-public.js';

describe('hashedPath', () => {
  it('puts the hash before the extension, under assets/', () => {
    expect(hashedPath('audio/sfx/place.ogg', '3f2a9c1e')).toBe(
      'assets/audio/sfx/place.3f2a9c1e.ogg',
    );
    expect(hashedPath('worlds/coral-cove/far.1280.webp', '9b1c22d0')).toBe(
      'assets/worlds/coral-cove/far.1280.9b1c22d0.webp',
    );
    expect(hashedPath('audio/manifest.json', '0f3a9c1e')).toBe(
      'assets/audio/manifest.0f3a9c1e.json',
    );
  });

  it('does not mistake a dot in a folder name for an extension', () => {
    expect(hashedPath('worlds/v1.2/plate', 'abcdef01')).toBe('assets/worlds/v1.2/plate.abcdef01');
  });
});

describe('contentHash', () => {
  it('is 8 hex digits of the content, not the name', () => {
    const a = contentHash(new TextEncoder().encode('hello'));
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(contentHash(new TextEncoder().encode('hello'))).toBe(a);
    expect(contentHash(new TextEncoder().encode('hello!'))).not.toBe(a);
  });
});
