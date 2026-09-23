import { hashSeed } from '@solitaire-plus/sim';

/**
 * The world table: which painted environment a seed is played in.
 *
 * No Pixi here, so screens (challenge detail, history) can show a world's
 * name next to the fee without pulling the renderer in. Selection is the
 * sim's FNV-1a over the seed string modulo the table, so the client, the
 * server and the tooling agree without a lookup (docs/worlds.md, Selection).
 *
 * Adding a world: drop its folder under `apps/client/public/worlds/<id>/`
 * (see tools/worldgen) and append an entry here. Order matters — it changes
 * which seed lands where — so append, never insert.
 */
export interface WorldEntry {
  /** Folder name under `public/worlds/`. */
  id: string;
  /** Display name for the challenge screens. */
  name: string;
}

// APPEND ONLY: the seed → world mapping is hashSeed(seed) % WORLDS.length,
// so inserting or reordering changes which world every existing seed lands in.
export const WORLDS: readonly WorldEntry[] = [
  { id: 'blossom-lake', name: 'Blossom Lake' },
  { id: 'alpine-falls', name: 'Alpine Falls' },
  { id: 'red-canyon', name: 'Red Canyon' },
  { id: 'sunset-shrine', name: 'Sunset Shrine' },
  { id: 'aurora-lake', name: 'Aurora Lake' },
  { id: 'coral-cove', name: 'Coral Cove' },
  { id: 'winter-embankment', name: 'Winter Embankment' },
  { id: 'temple-bay', name: 'Temple Bay' },
  { id: 'river-city', name: 'River City' },
  { id: 'alpine-village', name: 'Alpine Village' },
];

/** The world a seed is played in. Deterministic; the same on every peer. */
export function worldFor(seed: string): WorldEntry {
  const entry = WORLDS[hashSeed(seed) % WORLDS.length];
  if (!entry) throw new Error('world table is empty');
  return entry;
}

/** Display name of the world a seed is played in. */
export function worldNameFor(seed: string): string {
  return worldFor(seed).name;
}
