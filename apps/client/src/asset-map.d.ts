/**
 * The build's asset map (apps/client/hashed-public.ts): logical `public/`
 * path → content-hashed path under `assets/`, both relative to the base URL.
 * Empty in dev, where the raw `public/` files are served.
 */
declare module 'virtual:blockari-asset-map' {
  const map: Readonly<Record<string, string>>;
  export default map;
}
