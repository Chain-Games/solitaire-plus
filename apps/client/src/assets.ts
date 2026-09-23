import map from 'virtual:blockari-asset-map';

/**
 * URLs for the big `public/` trees (audio, worlds). The production build
 * ships them content-hashed under `/assets/` (apps/client/hashed-public.ts)
 * so the server can mark them immutable; the map says where each logical
 * path went. Dev has no map and serves `public/` as it is.
 */

export type AssetMap = Readonly<Record<string, string>>;

/**
 * The URL for a logical `public/` path (`worlds/coral-cove/far.webp`,
 * `audio/manifest.json`) under `base`: the hashed copy when the map has one,
 * the path itself otherwise.
 */
export function resolveAsset(logical: string, assetMap: AssetMap, base: string): string {
  return `${base}${assetMap[logical] ?? logical}`;
}

/** `resolveAsset` through the build's map, under the app's base URL. */
export function assetUrl(logical: string, base: string = import.meta.env.BASE_URL): string {
  return resolveAsset(logical, map, base);
}
