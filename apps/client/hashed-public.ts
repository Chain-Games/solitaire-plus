import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/**
 * Content-addressed copies of the big `public/` trees.
 *
 * Vite copies `public/` verbatim, so `public/audio/**` and `public/worlds/**`
 * (~48 MB across every tier) shipped un-hashed: the server can only serve
 * them `no-cache`, every visit revalidated ~60 files and a CDN could not hold
 * them. This plugin emits each file under `assets/` with a content hash in
 * its name — `audio/sfx/place.ogg` → `assets/audio/sfx/place.3f2a9c1e.ogg`,
 * `worlds/coral-cove/far.1280.webp` → `assets/worlds/coral-cove/far.1280.9b1c22d0.webp`
 * — where the server's `/assets/` rule already makes them `immutable`, and
 * drops the verbatim copies from the build. The map (logical path → hashed
 * path, both relative to the base URL) is inlined as the virtual module
 * `virtual:blockari-asset-map`; `src/assets.ts` resolves through it. In dev
 * (and in vitest) the map is empty and every path resolves to the raw
 * `public/` file, so `vite dev` keeps serving the trees as they are, and
 * `tools/shot`, `tools/audiogen` and `tools/worldgen` keep reading/writing
 * `public/` directly.
 */

export const VIRTUAL_ASSET_MAP = 'virtual:blockari-asset-map';
const RESOLVED = `\0${VIRTUAL_ASSET_MAP}`;

/** The `public/` subtrees that ship hashed. */
export const HASHED_PUBLIC_DIRS = ['audio', 'worlds'] as const;

/** `worlds/x/far.1280.webp` + `9b1c22d0` → `assets/worlds/x/far.1280.9b1c22d0.webp`. */
export function hashedPath(logical: string, hash: string): string {
  const dot = logical.lastIndexOf('.');
  const slash = logical.lastIndexOf('/');
  return dot > slash
    ? `assets/${logical.slice(0, dot)}.${hash}${logical.slice(dot)}`
    : `assets/${logical}.${hash}`;
}

/** The first 8 hex digits of the content's SHA-256 — plenty for a few hundred files. */
export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && !entry.name.startsWith('.')) yield full;
  }
}

export function hashedPublic(dirs: readonly string[] = HASHED_PUBLIC_DIRS): Plugin {
  let config: ResolvedConfig;
  let map: Record<string, string> = {};
  let pending: { hashed: string; source: Buffer }[] = [];
  const building = () => config.command === 'build' && config.publicDir !== '';
  return {
    name: 'blockari:hashed-public',
    configResolved(c) {
      config = c;
    },
    resolveId(id) {
      return id === VIRTUAL_ASSET_MAP ? RESOLVED : null;
    },
    load(id) {
      return id === RESOLVED ? `export default ${JSON.stringify(map)};\n` : null;
    },
    // The map must exist before the first module loads, so the hashing is
    // done here; the files themselves are written with the bundle (below)
    // rather than emitted, which would list 300+ assets in the build report.
    buildStart() {
      map = {};
      pending = [];
      if (!building()) return;
      let bytes = 0;
      for (const dir of dirs) {
        const root = path.join(config.publicDir, dir);
        let files: string[];
        try {
          files = [...walk(root)];
        } catch {
          continue; // the tree is optional
        }
        for (const file of files) {
          const logical = path.relative(config.publicDir, file).split(path.sep).join('/');
          const source = readFileSync(file);
          const hashed = hashedPath(logical, contentHash(source));
          pending.push({ hashed, source });
          map[logical] = hashed;
          bytes += source.byteLength;
        }
      }
      config.logger.info(
        `hashed-public: ${Object.keys(map).length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB → assets/{${dirs.join(',')}}`,
      );
    },
    // Vite copies public/ into outDir before writing the bundle; the verbatim
    // trees would only ever be served no-cache, so they go, and the hashed
    // copies (the bytes that were hashed) take their place under assets/.
    writeBundle() {
      if (!building()) return;
      const outDir = path.resolve(config.root, config.build.outDir);
      for (const dir of dirs) rmSync(path.join(outDir, dir), { recursive: true, force: true });
      for (const { hashed, source } of pending) {
        const file = path.join(outDir, hashed);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, source);
      }
      pending = [];
    },
  };
}
