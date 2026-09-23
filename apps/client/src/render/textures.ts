import { Container, Graphics, Rectangle, Sprite, Texture, type Renderer } from 'pixi.js';
import { PALETTE, PIECE_COLORS, shade } from './palette.js';

/**
 * Procedural textures, baked once at startup. Every visible surface is a
 * sprite of one of these, so the scene is a handful of draw calls and no
 * per-frame Graphics work.
 *
 * Tiles are baked per colour rather than tinted white, so highlights can go
 * lighter than the base colour and the side face can go darker — a tint can
 * only ever darken. See docs/art-direction.md "Materials".
 */
export interface Textures {
  /**
   * Tile per piece colour index, for every sprite that shows a piece (hand,
   * drag, landing, results chips). Starts as the painted bake; on tiers with
   * the lit mesh `applyTileLook` (tile-material.ts) points it at the lit
   * bake so every piece is one material. `tilesHand` is the hand's set,
   * `tilesHandPx` the size it was baked at.
   */
  tiles: readonly Texture[];
  tilesHand: readonly Texture[];
  tilesHandPx: number;
  /**
   * Fracture chunks, `tileChunks[color][pattern][i]` matching
   * `CHUNK_PATTERNS[pattern].rects[i]`: each is that UV sub-rect of the baked
   * tile re-baked with thickness (a dark side band along its bottom edge, a
   * bright top edge, a hairline outline), one atlas per colour.
   */
  tileChunks: readonly (readonly (readonly Texture[])[])[];
  /** The painted bakes (128 px; hand at 64 px with a larger specular and rim), kept for the low tier. */
  tilesPainted: readonly Texture[];
  tilesHandPainted: readonly Texture[];
  tilesHandPaintedPx: number;
  tileChunksPainted: readonly (readonly (readonly Texture[])[])[];
  /**
   * Tile material (tile-material.ts). `tileAtlasLit` is the nine tiles in one
   * strip WITHOUT the painted rim light and specular — the albedo for the lit
   * mesh, which produces those from the normal map and the lights.
   * `tileAtlasPainted` is the same strip with the full bake, for the tier
   * that lights the tiles without a specular term. Tile i starts at
   * `atlasPad + i * atlasStep` px in a strip `atlasWidth` px wide.
   */
  tileAtlasLit: Texture;
  tileAtlasPainted: Texture;
  atlasPad: number;
  atlasStep: number;
  atlasWidth: number;
  /** Baked tangent-space normal map of the tile (y down, z toward the viewer), 128 px. */
  tileNormal: Texture;
  /**
   * Contact shadow / ambient-occlusion stamp: a soft dark frame around a
   * `aoInner` px tile centred in a 256 px texture, biased down-right, clear
   * inside the tile. One per filled tile, accumulated where they overlap.
   */
  aoStamp: Texture;
  aoInner: number;
  /** Recessed empty-cell socket. */
  socket: Texture;
  /** Stroke-only rounded square, white, for ghost outlines. */
  outline: Texture;
  /** Flat rounded square, white, for ghost fills and flashes. */
  flat: Texture;
  /** Soft radial glow. */
  glow: Texture;
  /** Elongated spark (3:1), white. */
  spark: Texture;
  /** Blossom petal: a soft-edged teardrop with a notched tip, white (world particles). */
  petal: Texture;
  /** Thin white ring. */
  ring: Texture;
  /** Hairline ring at 256 px (2.25 px core), for board-sized expanding rings that must stay thin. */
  ringThin: Texture;
  /** 3 px ring at 256 px, for the 3X second ring. */
  ringMid: Texture;
  /**
   * Glowing frame for the streak tile rim light: a soft stroke straddling the
   * edge of a 100 px tile centred in the 128 px texture (`haloInner` px), so
   * drawn at cell/haloInner the glow spills into the gaps around the tile.
   */
  halo: Texture;
  haloInner: number;
  /** Horizontal light bar for line sweeps. */
  sweep: Texture;
  /** The clear sweep's bar: the same frame with its core baked at SWEEP_BAR_CORE_ALPHA, so the tint survives the add over a lifted tile. */
  sweepBar: Texture;
  /** Soft-edged square for drop shadows (256 px, 3-band falloff). */
  shadow: Texture;
  /** Same falloff in white, for additive light pools. */
  soft: Texture;
  /** Radial light pool with a solid centre, for the board spotlight. */
  spotlight: Texture;
  /** Base size the square textures were drawn at. */
  size: number;
}

/** The clear sweep bar's core alpha (the line-sweep frame's is 0.95; see `sweepBar`). */
const SWEEP_BAR_CORE_ALPHA = 0.55;
const TILE_PX = 128;

/**
 * A fracture pattern: the tile split into a brick-like grid of rects in tile
 * UV (u0, v0, u1, v1). Row cuts are jittered, and every row has its own
 * column cuts, so no pattern reads as an even grid.
 */
export interface ChunkPattern {
  count: number;
  rects: readonly (readonly [number, number, number, number])[];
}

/**
 * Two variants each of 4 (2x2) and 6 (3x2) chunks, cut with a fixed seed.
 * Never 3x3: at 1080p a ninth of a cell is under 20 px and reads as confetti.
 */
export const CHUNK_PATTERNS: readonly ChunkPattern[] = buildChunkPatterns();

/**
 * Chunk thickness at the 128 px bake (drawn at ~0.45x on a 1080p board):
 * the side band along the bottom edge lands at ~2 px, the bright top edge at
 * ~1 px, like the tile's own side face and rim light.
 */
const CHUNK_SIDE_PX = 4.5;
const CHUNK_TOP_PX = 2.2;
const CHUNK_PAD = 3;

function buildChunkPatterns(): ChunkPattern[] {
  // mulberry32 with a fixed seed: the cuts are the same in every session and
  // recording.
  let seed = 0x9e3779b1;
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const jitter = (v: number, amount: number): number =>
    v <= 0 || v >= 1 ? v : v + (rand() - 0.5) * 2 * amount;
  const out: ChunkPattern[] = [];
  for (const [rows, cols] of [
    [2, 2],
    [2, 2],
    [2, 3],
    [2, 3],
  ] as const) {
    const ys: number[] = [];
    for (let r = 0; r <= rows; r++) ys.push(jitter(r / rows, 0.09));
    const rects: [number, number, number, number][] = [];
    for (let r = 0; r < rows; r++) {
      const xs: number[] = [];
      for (let c = 0; c <= cols; c++) xs.push(jitter(c / cols, 0.1));
      for (let c = 0; c < cols; c++) rects.push([xs[c]!, ys[r]!, xs[c + 1]!, ys[r + 1]!]);
    }
    out.push({ count: rows * cols, rects });
  }
  return out;
}

function bakeTile(base: number, size: number, hand = false, flat = false): Graphics {
  const r = size * 0.18;
  const top = shade(base, 0.14);
  const side = shade(base, -0.32);
  const sideH = size * 0.12;
  const g = new Graphics();
  // Side face: the whole rounded square in the dark shade.
  g.roundRect(0, 0, size, size, r).fill({ color: side });
  // A darker seam at the very bottom so the band reads as a face, not a
  // stripe. It follows the silhouette's corner arcs: a rounded rect of its
  // own height clamps to a 2 px radius and pokes past the tile's corners as
  // dark "ears" (visible once the frame is supersampled).
  const seamH = sideH * 0.35;
  const phi = Math.asin((r - seamH) / r);
  const inset = r * (1 - Math.cos(phi));
  g.moveTo(inset, size - seamH)
    .lineTo(size - inset, size - seamH)
    .arc(size - r, size - r, r, phi, Math.PI / 2)
    .lineTo(r, size)
    .arc(r, size - r, r, Math.PI / 2, Math.PI - phi)
    .closePath()
    .fill({ color: shade(base, -0.5), alpha: 0.35 });
  // Top face: vertical gradient from the lightened top down to the base
  // colour at 55% height, then a short gradient into the side colour at the join.
  const bands = 16;
  const faceH = size - sideH;
  // Every band is clipped to the face's rounded silhouette: a plain
  // full-width rect through a corner zone pokes past the arc and leaves
  // square "ears" at the corners once the frame is supersampled.
  const faceBand = (y0: number, y1: number, color: number, bottom = faceH) => {
    if (y0 >= r && y1 <= bottom - r) {
      g.rect(0, y0, size, y1 - y0).fill({ color });
      return;
    }
    const inset = (y: number): number => {
      const d = y < r ? r - y : y > bottom - r ? y - (bottom - r) : 0;
      return r - Math.sqrt(Math.max(0, r * r - d * d));
    };
    const left: number[] = [];
    const right: number[] = [];
    for (let y = y0; ; y = Math.min(y1, y + 1)) {
      left.push(inset(y), y);
      right.unshift(size - inset(y), y);
      if (y >= y1) break;
    }
    g.poly([...left, ...right]).fill({ color });
  };
  for (let i = 0; i < bands; i++) {
    const t0 = i / bands;
    const t1 = (i + 1) / bands;
    const t = Math.min(1, t0 / 0.55);
    const c = lerpColor(top, base, t);
    const y0 = t0 * faceH;
    const y1 = t1 * faceH;
    if (i === 0) g.roundRect(0, 0, size, faceH, r).fill({ color: c });
    else faceBand(y0, Math.min(faceH, y1 + 0.5), c);
  }
  for (let i = 0; i < 3; i++) {
    // The join sits in the tile's own bottom corner zone (the side's silhouette).
    faceBand(faceH + i, faceH + i + 1, lerpColor(base, side, (i + 1) / 4), size);
  }
  // Fine material noise, too small to read as a grid.
  const n = 48;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = Math.abs((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1);
      if (v > 0.6)
        g.rect((x * size) / n, (y * faceH) / n, size / n + 0.3, faceH / n + 0.3).fill({
          color: 0xffffff,
          alpha: (v - 0.6) * 0.05,
        });
    }
  }
  // Rim light on the top and left edges, thick enough to survive downscale.
  // The lit-mesh albedo skips these and the specular: the shader makes them.
  const rw = size * (hand ? 0.04 : 0.028);
  if (!flat) bakeTileLights(g, base, size, hand, r, rw, faceH);
  // Dark inner outline so adjacent same-colour cells separate.
  g.roundRect(0.75, 0.75, size - 1.5, size - 1.5, r).stroke({
    color: 0x000000,
    width: 1.5,
    alpha: 0.3,
  });
  return g;
}

function bakeTileLights(
  g: Graphics,
  base: number,
  size: number,
  hand: boolean,
  r: number,
  rw: number,
  faceH: number,
): void {
  const rim = shade(base, 0.4);
  g.moveTo(r, rw / 2)
    .lineTo(size - r, rw / 2)
    .stroke({ color: rim, width: rw, alpha: 0.8 });
  g.moveTo(rw / 2, r)
    .lineTo(rw / 2, faceH - r)
    .stroke({ color: rim, width: rw, alpha: 0.6 });
  // Bright reflection line just inside the top edge.
  g.moveTo(r * 1.2, rw * 1.6)
    .lineTo(size - r * 1.2, rw * 1.6)
    .stroke({ color: 0xffffff, width: 1, alpha: 0.3 });
  // Specular hotspot: five concentric ellipses, hard-ish peak.
  const cx = size * 0.28;
  const cy = size * (hand ? 0.2 : 0.18);
  const ex = size * (hand ? 0.58 : 0.36);
  const ey = size * (hand ? 0.2 : 0.12);
  for (let i = 5; i >= 1; i--) {
    const k = i / 5;
    g.ellipse(cx, cy, (ex / 2) * k, (ey / 2) * k).fill({
      color: 0xffffff,
      alpha: 0.08 + (1 - k) * 0.5,
    });
  }
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

function bakeSocket(size: number): Graphics {
  const r = size * 0.18;
  const g = new Graphics();
  g.roundRect(0, 0, size, size, r).fill({ color: PALETTE.socket });
  // Inner shadow on the top and left (recess), inner light on bottom/right.
  const w = size * 0.04;
  g.moveTo(r, w / 2)
    .lineTo(size - r, w / 2)
    .stroke({ color: 0x000000, width: w, alpha: 0.35 });
  g.moveTo(w / 2, r)
    .lineTo(w / 2, size - r)
    .stroke({ color: 0x000000, width: w, alpha: 0.35 });
  g.moveTo(r, size - w / 2)
    .lineTo(size - r, size - w / 2)
    .stroke({ color: 0xffffff, width: w / 2, alpha: 0.06 });
  g.moveTo(size - w / 2, r)
    .lineTo(size - w / 2, size - r)
    .stroke({ color: 0xffffff, width: w / 2, alpha: 0.06 });
  g.roundRect(0.5, 0.5, size - 1, size - 1, r).stroke({
    color: PALETTE.plateRim,
    width: 1,
    alpha: 0.6,
  });
  return g;
}

/**
 * The tile's normal map, from a height field: a rounded fillet along the
 * rounded-square edge (0.037 of the tile wide, ~2 px at a 58 px cell), a shallow paraboloid dome
 * over the top face (slope ~9 deg at the face edge, so the specular has
 * somewhere to travel), the 12%-tall side face at the bottom tilted 37 deg
 * toward the viewer, and a whisper of material noise (+-0.07 px on a 9 px
 * lattice) so the sharp specular lobe is not a perfect line. Screen space: x right,
 * y down, z toward the viewer, packed as n * 0.5 + 0.5.
 */
function bakeTileNormal(size: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Texture.WHITE;
  const img = ctx.createImageData(size, size);
  const r = size * 0.18;
  const half = size / 2;
  const faceH = size * 0.88;
  const bevel = size * 0.037;
  const domeK = 0.16 / (2 * (half - bevel)); // paraboloid: slope 0.16 (~9 deg) at the face edge
  const noiseAmp = 0.07;
  const sdf = (x: number, y: number) => {
    const qx = Math.abs(x - half) - (half - r);
    const qy = Math.abs(y - half) - (half - r);
    const ox = Math.max(qx, 0);
    const oy = Math.max(qy, 0);
    return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
  };
  const noise = (x: number, y: number) => {
    // Bilinear value noise on a 9 px lattice.
    const ix = Math.floor(x / 9);
    const iy = Math.floor(y / 9);
    const fx = x / 9 - ix;
    const fy = y / 9 - iy;
    const h = (a: number, b: number) =>
      Math.abs((Math.sin(a * 12.9898 + b * 78.233) * 43758.5453) % 1);
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const top = h(ix, iy) + (h(ix + 1, iy) - h(ix, iy)) * sx;
    const bot = h(ix, iy + 1) + (h(ix + 1, iy + 1) - h(ix, iy + 1)) * sx;
    return top + (bot - top) * sy - 0.5;
  };
  const height = (x: number, y: number) => {
    const d = sdf(x, y);
    if (d >= 0) return -bevel; // off the tile: keep the fillet falling
    // Fillet: circular profile from the edge inward.
    const t = Math.min(1, Math.max(0, (d + bevel) / bevel)); // 0 inside the bevel band, 1 at the edge
    const fillet = -bevel * (1 - Math.sqrt(Math.max(0, 1 - t * t)));
    const dx = x - half;
    const dy = y - half;
    const dome = -domeK * (dx * dx + dy * dy);
    return fillet + dome + noise(x, y) * noiseAmp;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let nx: number;
      let ny: number;
      let nz: number;
      if (y + 0.5 >= faceH) {
        // Side face: nearly vertical, tilted toward the viewer.
        nx = 0;
        ny = 0.6;
        nz = 0.8;
      } else {
        const px = x + 0.5;
        const py = y + 0.5;
        const ddx = (height(px + 1, py) - height(px - 1, py)) / 2;
        const ddy = (height(px, py + 1) - height(px, py - 1)) / 2;
        const len = Math.hypot(ddx, ddy, 1);
        nx = -ddx / len;
        ny = -ddy / len;
        nz = 1 / len;
      }
      img.data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return Texture.from(canvas);
}

/**
 * Contact shadow + ambient occlusion around one tile: a gaussian drop shadow
 * biased down-right (the contact side under the key light) over an all-round
 * occlusion halo, both cleared inside the tile so only the gaps and the
 * neighbouring socket edges darken.
 */
function bakeAoStamp(size: number, inner: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Texture.EMPTY;
  const o = (size - inner) / 2;
  const r = inner * 0.18;
  const tile = () => {
    ctx.beginPath();
    ctx.roundRect(o, o, inner, inner, r);
  };
  // Draw the shape off-canvas and let only its shadow land on it.
  const off = size * 2;
  const shadowed = (blur: number, dx: number, dy: number, alpha: number) => {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${alpha})`;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = off + dx;
    ctx.shadowOffsetY = off + dy;
    ctx.translate(-off, -off);
    tile();
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
  };
  shadowed(inner * 0.22, 0, 0, 0.5); // occlusion: all round
  shadowed(inner * 0.11, inner * 0.05, inner * 0.09, 0.55); // contact: tight, down-right
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.roundRect(o + 0.5, o + 0.5, inner - 1, inner - 1, r);
  ctx.fillStyle = '#000';
  ctx.fill();
  return Texture.from(canvas);
}

/**
 * The fracture chunks of one tile texture, `[pattern][i]`: each chunk is that
 * UV sub-rect of the tile re-baked with thickness (a dark side band along its
 * bottom edge, a bright top edge, a hairline outline) into one atlas per
 * tile, so a chunk is a small tile, not a paper cut-out. Re-run on the lit
 * bake so chunks match the resting material.
 */
export function bakeChunks(renderer: Renderer, tile: Texture, base: number): Texture[][] {
  const opts = { resolution: 1, antialias: true } as const;
  const side = shade(base, -0.32);
  const seam = shade(base, -0.5);
  const rim = shade(base, 0.4);
  const sheet = new Container();
  const temp: Texture[] = [];
  const frames: Rectangle[][] = [];
  let y = CHUNK_PAD;
  let width = 0;
  for (const pat of CHUNK_PATTERNS) {
    let x = CHUNK_PAD;
    let rowH = 0;
    const row: Rectangle[] = [];
    for (const [u0, v0, u1, v1] of pat.rects) {
      const w = Math.ceil((u1 - u0) * tile.frame.width);
      const h = Math.ceil((v1 - v0) * tile.frame.height);
      const sub = new Texture({
        source: tile.source,
        frame: new Rectangle(
          tile.frame.x + u0 * tile.frame.width,
          tile.frame.y + v0 * tile.frame.height,
          w,
          h,
        ),
      });
      temp.push(sub);
      const sp = new Sprite(sub);
      sp.position.set(x, y);
      sheet.addChild(sp);
      const g = new Graphics();
      // Side face along the bottom edge, with a darker seam where it meets the face.
      g.rect(x, y + h - CHUNK_SIDE_PX, w, CHUNK_SIDE_PX).fill({ color: side, alpha: 0.92 });
      g.rect(x, y + h - CHUNK_SIDE_PX - 1, w, 1).fill({ color: seam, alpha: 0.5 });
      // Rim light on the top edge (the thickness catching the key light).
      g.rect(x, y, w, CHUNK_TOP_PX).fill({ color: rim, alpha: 0.85 });
      g.rect(x, y + CHUNK_TOP_PX, w, 1).fill({ color: 0xffffff, alpha: 0.25 });
      // Hairline outline: the cut edges.
      g.rect(x + 0.5, y + 0.5, w - 1, h - 1).stroke({ color: 0x000000, width: 1, alpha: 0.4 });
      sheet.addChild(g);
      row.push(new Rectangle(x, y, w, h));
      x += w + CHUNK_PAD;
      rowH = Math.max(rowH, h);
    }
    width = Math.max(width, x);
    frames.push(row);
    y += rowH + CHUNK_PAD;
  }
  // Transparent backing so the atlas is exactly this size.
  sheet.addChildAt(new Graphics().rect(0, 0, width, y).fill({ color: 0, alpha: 0 }), 0);
  const atlas = renderer.generateTexture({ target: sheet, ...opts });
  sheet.destroy({ children: true });
  for (const t of temp) t.destroy(false);
  return frames.map((row) => row.map((frame) => new Texture({ source: atlas.source, frame })));
}

export function buildTextures(renderer: Renderer): Textures {
  const size = TILE_PX;
  const r = size * 0.18;
  const opts = { resolution: 1, antialias: true } as const;
  const gen = (g: Graphics) => {
    const t = renderer.generateTexture({ target: g, ...opts });
    g.destroy();
    return t;
  };

  const tiles = PIECE_COLORS.map((c) => gen(bakeTile(c, size)));
  const tileChunks = tiles.map((tile, ci) => bakeChunks(renderer, tile, PIECE_COLORS[ci]!));
  const tilesHand = PIECE_COLORS.map((c) => gen(bakeTile(c, 64, true)));
  // Tile atlases for the lit mesh: nine tiles in one strip, padded so bilinear
  // sampling at a tile's edge never reads its neighbour.
  const atlasPad = 4;
  const atlasStep = size + atlasPad * 2;
  const atlasWidth = atlasStep * PIECE_COLORS.length;
  const bakeAtlas = (flat: boolean) => {
    const strip = new Container();
    // A transparent backing so the strip's texture is exactly atlasWidth wide.
    strip.addChild(new Graphics().rect(0, 0, atlasWidth, size).fill({ color: 0, alpha: 0 }));
    PIECE_COLORS.forEach((c, i) => {
      const g = bakeTile(c, size, false, flat);
      g.x = atlasPad + i * atlasStep;
      strip.addChild(g);
    });
    const t = renderer.generateTexture({ target: strip, ...opts });
    strip.destroy({ children: true });
    return t;
  };
  const tileAtlasLit = bakeAtlas(true);
  const tileAtlasPainted = bakeAtlas(false);
  const tileNormal = bakeTileNormal(size);
  const aoInner = 128;
  const aoStamp = bakeAoStamp(256, aoInner);
  const socket = gen(bakeSocket(size));
  const outline = gen(
    new Graphics().roundRect(2, 2, size - 4, size - 4, r).stroke({ color: 0xffffff, width: 4 }),
  );
  const flat = gen(new Graphics().roundRect(0, 0, size, size, r).fill({ color: 0xffffff }));

  // Particle sheet: glow and spark share ONE texture source, because a
  // ParticleContainer batches against a single source. Sliced into frames.
  const sheet = new Graphics();
  for (let i = 10; i >= 1; i--) {
    const t = i / 10;
    sheet
      .circle(size / 2, size / 2, (size / 2) * t)
      .fill({ color: 0xffffff, alpha: 0.09 * (1 - t) * (1 - t) + 0.015 });
  }
  const sx = size; // spark frame starts here: soft halo + hard bright core
  sheet
    .roundRect(sx + size * 0.05, size * 0.36, size * 0.9, size * 0.28, size * 0.14)
    .fill({ color: 0xffffff, alpha: 0.35 });
  sheet
    .roundRect(sx + size * 0.1, size * 0.44, size * 0.8, size * 0.12, size * 0.06)
    .fill({ color: 0xffffff, alpha: 1 });
  // Petal frame: a 2:1 ellipse with a darker rim (the tint multiplies, so
  // the rim reads as the petal's edge) inside a soft halo; the worlds' petal,
  // snow, ember and firefly particles all slice this one sheet.
  const px0 = size * 2;
  const pcx = px0 + size / 2;
  const pcy = size / 2;
  sheet.ellipse(pcx, pcy, size * 0.36, size * 0.19).fill({ color: 0xffffff, alpha: 0.35 });
  sheet.ellipse(pcx, pcy, size * 0.33, size * 0.165).fill({ color: 0xffffff, alpha: 1 });
  sheet
    .ellipse(pcx, pcy, size * 0.31, size * 0.15)
    .stroke({ color: 0x8c8c8c, width: size * 0.035, alpha: 1 });
  const sheetTex = gen(sheet);
  const glow = new Texture({ source: sheetTex.source, frame: new Rectangle(0, 0, size, size) });
  const spark = new Texture({ source: sheetTex.source, frame: new Rectangle(size, 0, size, size) });
  const petal = new Texture({
    source: sheetTex.source,
    frame: new Rectangle(size * 2, 0, size, size),
  });

  const ring = new Graphics()
    .circle(size / 2, size / 2, size / 2 - 3)
    .stroke({ color: 0xffffff, width: 5 });
  // Halo: four stroke bands, wide and faint to narrow and bright, on a 100 px
  // rounded square (tile corner radius 18%) centred in the 128 px texture.
  const haloInner = 100;
  const halo = new Graphics();
  const hi = (size - haloInner) / 2;
  for (const [w, a] of [
    [16, 0.08],
    [11, 0.16],
    [7, 0.3],
    [3.5, 0.85],
  ] as const) {
    halo
      .roundRect(hi, hi, haloInner, haloInner, haloInner * 0.18)
      .stroke({ color: 0xffffff, width: w, alpha: a });
  }
  const thinPx = 256;
  const ringThin = new Graphics()
    .circle(thinPx / 2, thinPx / 2, thinPx / 2 - 3)
    .stroke({ color: 0xffffff, width: 4.5, alpha: 0.35 })
    .circle(thinPx / 2, thinPx / 2, thinPx / 2 - 3)
    .stroke({ color: 0xffffff, width: 2.25 });
  const ringMid = new Graphics()
    .circle(thinPx / 2, thinPx / 2, thinPx / 2 - 3)
    .stroke({ color: 0xffffff, width: 6, alpha: 0.35 })
    .circle(thinPx / 2, thinPx / 2, thinPx / 2 - 3)
    .stroke({ color: 0xffffff, width: 3 });
  // Sweep: a bright core line with soft falloff in both axes.
  const sweep = new Graphics();
  for (let k = 8; k >= 1; k--) {
    const t = k / 8;
    const w = size * t;
    const h = size * 0.5 * t;
    sweep
      .rect((size - w) / 2, (size - h) / 2, w, h)
      .fill({ color: 0xffffff, alpha: 0.03 + (1 - t) * 0.16 });
  }
  sweep
    .roundRect(size * 0.08, size * 0.47, size * 0.84, size * 0.06, size * 0.03)
    .fill({ color: 0xffffff, alpha: 0.95 });
  // The clear sweep's bar: a 0.95 core added over a lifted tile blew through
  // any tint to (246,246,246); at SWEEP_BAR_CORE_ALPHA the core stays the hue.
  const sweepBar = new Graphics();
  for (let k = 8; k >= 1; k--) {
    const t = k / 8;
    const w = size * t;
    const h = size * 0.5 * t;
    sweepBar
      .rect((size - w) / 2, (size - h) / 2, w, h)
      .fill({ color: 0xffffff, alpha: 0.03 + (1 - t) * 0.16 });
  }
  sweepBar
    .roundRect(size * 0.08, size * 0.47, size * 0.84, size * 0.06, size * 0.03)
    .fill({ color: 0xffffff, alpha: SWEEP_BAR_CORE_ALPHA });

  const shadowPx = 256;
  const shadow = new Graphics();
  const bandsS = 12;
  for (let i = bandsS; i >= 1; i--) {
    const t = i / bandsS;
    const inset = (1 - t) * shadowPx * 0.22;
    shadow
      .roundRect(inset, inset, shadowPx - inset * 2, shadowPx - inset * 2, shadowPx * 0.12)
      .fill({ color: 0x000000, alpha: 0.11 * (1 - t) + 0.02 });
  }
  const soft = new Graphics();
  for (let i = bandsS; i >= 1; i--) {
    const t = i / bandsS;
    const inset = (1 - t) * shadowPx * 0.22;
    soft
      .roundRect(inset, inset, shadowPx - inset * 2, shadowPx - inset * 2, shadowPx * 0.12)
      .fill({ color: 0xffffff, alpha: 0.11 * (1 - t) + 0.02 });
  }
  const spot = new Graphics();
  const spotBands = 40;
  for (let i = spotBands; i >= 1; i--) {
    const t = i / spotBands;
    // Cumulative alpha of many thin discs approximates a smooth quadratic falloff.
    spot
      .circle(shadowPx / 2, shadowPx / 2, (shadowPx / 2) * t)
      .fill({ color: 0xffffff, alpha: 0.03 * (1 - t) + 0.004 });
  }

  return {
    tiles,
    tilesHand,
    tilesHandPx: 64,
    tilesPainted: tiles,
    tilesHandPainted: tilesHand,
    tilesHandPaintedPx: 64,
    tileChunksPainted: tileChunks,
    tileChunks,
    tileAtlasLit,
    tileAtlasPainted,
    atlasPad,
    atlasStep,
    atlasWidth,
    tileNormal,
    aoStamp,
    aoInner,
    shadow: gen(shadow),
    soft: gen(soft),
    spotlight: gen(spot),
    socket,
    outline,
    flat,
    glow,
    spark,
    petal,
    ring: gen(ring),
    ringThin: gen(ringThin),
    ringMid: gen(ringMid),
    halo: gen(halo),
    haloInner,
    sweep: gen(sweep),
    sweepBar: gen(sweepBar),
    size,
  };
}
