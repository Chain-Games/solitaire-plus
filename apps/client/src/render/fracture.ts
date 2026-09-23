import { Container, Sprite } from 'pixi.js';
import type { Particles } from './effects.js';
import { pieceColor } from './palette.js';
import { CHUNK_PATTERNS, type Textures } from './textures.js';

/**
 * Fracture on clear: a cleared tile breaks into 4–6 chunks cut from its own
 * baked texture (UV sub-rects re-baked with thickness, see `CHUNK_PATTERNS`
 * and the chunk atlas in textures.ts). The chunks are thrown outward from the
 * tile's centre and along the line away from the placed piece, spin, and rock
 * about one in-plane axis by at most 30° so a face is always readable: the
 * rock squashes the sprite and drives a two-sided Lambert term toward the
 * top-left key light, ±25% around the baked brightness (the plus side is an
 * additive copy of the chunk — a glint — on tiers with the glow layer). They
 * fall under gravity to the cleared line's own band, bounce once, and
 * dissolve — a spark at the landing and an ember as they go, both from the
 * shared particle pool. From heat 0.5 the same additive copy carries the heat
 * colour, so hot chunks glow like heated glass.
 *
 * Pooled once from the tier (`fracturePool`, sized for a 4-line clear at the
 * tier's chunk cap); a bigger clear recycles the oldest chunks. Nothing
 * allocates during play. Both containers are masked to the table by the
 * caller, so a chunk never leaves the plate.
 */

interface Chunk {
  sprite: Sprite;
  glow: Sprite | null;
  alive: boolean;
  life: number;
  ttl: number;
  vx: number;
  vy: number;
  /** In-plane spin, rad/s. */
  spin: number;
  /** Rock about a local axis (0 = x, 1 = y): oscillator phase and rate (rad, rad/s). */
  flip: number;
  flipRate: number;
  flipAxis: 0 | 1;
  floorY: number;
  landed: boolean;
  /** This chunk sparks on landing and leaves an ember when it dissolves. */
  sparks: boolean;
  color: number;
  /** Texture scale for one board cell. */
  scale: number;
  /** 0..1 heat glow strength. */
  glowK: number;
}

/** Key light direction (unit), from the top-left and above the table. */
const LIGHT_X = -0.42;
const LIGHT_Y = -0.56;
const LIGHT_Z = 0.71;
/** Chunks fall at this many cells per second squared. */
const GRAVITY_CELLS = 16;
/** Bounce: vertical restitution, and the speed below which a chunk comes to rest. */
const BOUNCE = 0.32;
const REST_CELLS = 1.5;
/** Dissolve starts at this fraction of a chunk's life. */
const FADE_FROM = 0.55;
/** A chunk rocks at most this far off the table plane, so its face stays readable. */
const ROCK_MAX = (30 * Math.PI) / 180;
/** Facing-light brightness swing around the baked value. */
const SHADE_SWING = 0.25;
/** Lambert of a flat chunk under the key light: the baked (neutral) facing. */
const LAMBERT_FLAT = LIGHT_Z;
/** Lambert range a 30° rock reaches toward / away from the light. */
const LAMBERT_RANGE = Math.cos(Math.PI / 4 - ROCK_MAX) - LIGHT_Z;

export class Fracture {
  readonly container = new Container();
  /** Additive copies of the chunks: the facing glint and the heat glow (empty when the tier has no glow). */
  readonly glowContainer = new Container();
  readonly capacity: number;
  private readonly pool: Chunk[] = [];
  private next = 0;
  private cell = 40;
  private floorMax = 1e9;
  private rimX0 = -1e9;
  private rimY0 = -1e9;
  private rimX1 = 1e9;
  private readonly texSize: number;
  /** Read at spawn time: the tile look (painted or lit bake) can change with the tier. */
  private readonly tex: Textures;
  private particles: Particles | null = null;

  constructor(cap: number, glow: boolean, tex: Textures) {
    this.capacity = cap;
    this.texSize = tex.size;
    this.tex = tex;
    this.glowContainer.blendMode = 'add';
    for (let i = 0; i < cap; i++) {
      const sprite = new Sprite(tex.tileChunks[0]?.[0]?.[0] ?? tex.tiles[0]);
      sprite.anchor.set(0.5);
      sprite.visible = false;
      this.container.addChild(sprite);
      let g: Sprite | null = null;
      if (glow) {
        g = new Sprite(tex.tileChunks[0]?.[0]?.[0] ?? tex.tiles[0]);
        g.anchor.set(0.5);
        g.blendMode = 'add';
        g.visible = false;
        this.glowContainer.addChild(g);
      }
      this.pool.push({
        sprite,
        glow: g,
        alive: false,
        life: 0,
        ttl: 1,
        vx: 0,
        vy: 0,
        spin: 0,
        flip: 0,
        flipRate: 0,
        flipAxis: 0,
        floorY: 0,
        landed: false,
        sparks: false,
        color: 0xffffff,
        scale: 1,
        glowK: 0,
      });
    }
  }

  /** Sparks and embers go to this pool. */
  bindParticles(p: Particles): void {
    this.particles = p;
  }

  /**
   * Board cell size, the lowest floor a chunk may land on (the plate's bottom
   * edge), and the other three rim edges chunks bounce off instead of leaving
   * the table.
   */
  layout(cell: number, floorMax: number, x0: number, y0: number, x1: number): void {
    this.cell = cell;
    this.floorMax = floorMax;
    this.rimX0 = x0;
    this.rimY0 = y0;
    this.rimX1 = x1;
  }

  private take(): Chunk | undefined {
    const c = this.pool[this.next];
    if (!c) return undefined;
    this.next = (this.next + 1) % this.pool.length;
    return c;
  }

  /**
   * Break the tile centred at (x, y), colour index `colorIndex`, into up to
   * `count` chunks (4 or 6; the largest pattern that fits). `dirX/dirY` is
   * the unit drift along the line away from the placed piece (0, 0 = none).
   * `heat` 0..1 scales the launch, the spin and the glow; `glowColor` is the
   * heat colour the glow takes.
   */
  burst(
    x: number,
    y: number,
    colorIndex: number,
    count: number,
    dirX: number,
    dirY: number,
    heat: number,
    glowColor: number,
  ): void {
    if (this.pool.length === 0) return;
    // Largest pattern with at most `count` chunks; its variants are
    // contiguous, one is picked at random. No allocation.
    let want = 0;
    for (const p of CHUNK_PATTERNS) if (p.count <= count && p.count > want) want = p.count;
    if (want === 0) return;
    let first = -1;
    let variants = 0;
    for (let i = 0; i < CHUNK_PATTERNS.length; i++) {
      if (CHUNK_PATTERNS[i]!.count !== want) continue;
      if (first < 0) first = i;
      variants++;
    }
    const patIdx = first + Math.floor(Math.random() * variants);
    const pat = CHUNK_PATTERNS[patIdx];
    const texs = this.tex.tileChunks[colorIndex]?.[patIdx];
    if (!pat || !texs) return;
    const cell = this.cell;
    const tint = pieceColor(colorIndex);
    // Launch grows with heat, but stays a burst around the line, never a
    // spray across the board: the drift along the line is the sweep's push.
    const launch = cell * (2.0 + 1.6 * heat);
    const drift = cell * (1.6 + 2.6 * heat);
    const lift = cell * (1.5 + 1.1 * heat);
    const glowK = heat < 0.5 ? 0 : 0.5 + 0.5 * Math.min(1, (heat - 0.5) / 0.5);
    for (let i = 0; i < pat.rects.length; i++) {
      const rect = pat.rects[i];
      const t = texs[i];
      if (!rect || !t) continue;
      const s = this.take();
      if (!s) return;
      const [u0, v0, u1, v1] = rect;
      const ox = ((u0 + u1) / 2 - 0.5) * cell;
      const oy = ((v0 + v1) / 2 - 0.5) * cell;
      let dx = ox;
      let dy = oy;
      const len = Math.hypot(dx, dy);
      if (len < 1e-3) {
        const a = Math.random() * Math.PI * 2;
        dx = Math.cos(a);
        dy = Math.sin(a);
      } else {
        dx /= len;
        dy /= len;
      }
      const v = launch * (0.5 + Math.random() * 0.7);
      const d = drift * (0.4 + Math.random() * 0.8);
      s.vx = dx * v + dirX * d + (Math.random() - 0.5) * cell * 0.8;
      s.vy = dy * v * 0.6 + dirY * d - lift * (0.4 + Math.random() * 0.8);
      s.spin = (Math.random() - 0.5) * 2 * (5 + 6 * heat);
      s.flip = Math.random() * Math.PI * 2;
      s.flipRate = (Math.random() < 0.5 ? -1 : 1) * (5 + 6 * heat) * (0.6 + Math.random() * 0.8);
      s.flipAxis = Math.random() < 0.5 ? 0 : 1;
      // The floor is the cleared line's own band (its sockets are empty now):
      // chunks come back down into the trench, not onto the row below.
      s.floorY = Math.min(this.floorMax, y + cell * (0.05 + Math.random() * 0.4));
      s.life = 0;
      s.ttl = 0.55 + Math.random() * 0.25;
      s.landed = false;
      s.sparks = i % 2 === 0;
      s.color = tint;
      s.scale = cell / this.texSize;
      s.glowK = glowK;
      s.alive = true;
      const sp = s.sprite;
      sp.texture = t;
      sp.position.set(x + ox, y + oy);
      sp.rotation = 0;
      sp.alpha = 1;
      sp.tint = 0xffffff;
      sp.scale.set(s.scale);
      sp.visible = true;
      if (s.glow) {
        s.glow.visible = true;
        s.glow.texture = t;
        s.glow.tint = glowK > 0 ? glowColor : 0xffffff;
        s.glow.alpha = 0;
        s.glow.position.set(x + ox, y + oy);
        s.glow.rotation = 0;
        s.glow.scale.set(s.scale);
      }
    }
  }

  update(dt: number): void {
    const cell = this.cell;
    const g = cell * GRAVITY_CELLS;
    const rest = cell * REST_CELLS;
    for (const s of this.pool) {
      if (!s.alive) continue;
      s.life += dt;
      const t = s.life / s.ttl;
      const sp = s.sprite;
      if (t >= 1) {
        s.alive = false;
        sp.visible = false;
        if (s.glow) s.glow.visible = false;
        // Dissolve into the ember language: one soft ember lifts off the spot.
        if (s.sparks && this.particles)
          this.particles.ember(
            sp.x,
            sp.y,
            s.color,
            s.vx * 0.15,
            -cell * (0.8 + Math.random() * 0.6),
            s.scale * 0.45,
            0.4 + Math.random() * 0.2,
          );
        continue;
      }
      s.vy += g * dt;
      sp.x += s.vx * dt;
      sp.y += s.vy * dt;
      // The plate rim is a wall: a chunk that reaches it bounces back in.
      if (sp.x < this.rimX0 && s.vx < 0) {
        sp.x = this.rimX0;
        s.vx = -s.vx * 0.4;
      } else if (sp.x > this.rimX1 && s.vx > 0) {
        sp.x = this.rimX1;
        s.vx = -s.vx * 0.4;
      }
      if (sp.y < this.rimY0 && s.vy < 0) {
        sp.y = this.rimY0;
        s.vy = -s.vy * 0.4;
      }
      if (sp.y >= s.floorY && s.vy > 0) {
        sp.y = s.floorY;
        if (s.vy > rest) {
          // Bounce once, hard; the landing throws a spark.
          s.vy = -s.vy * BOUNCE;
          s.vx *= 0.6;
          s.spin *= 0.5;
          s.flipRate *= 0.5;
          if (!s.landed && s.sparks && this.particles)
            this.particles.spark(
              sp.x,
              sp.y,
              s.color,
              s.vx * 0.6 + (Math.random() - 0.5) * cell * 2,
              -cell * (1.5 + Math.random() * 2),
              s.scale * 0.5,
              0.2 + Math.random() * 0.15,
            );
        } else {
          // At rest on the plate: skid to a stop.
          s.vy = 0;
          const k = Math.max(0, 1 - dt * 8);
          s.vx *= k;
          s.spin *= k;
          s.flipRate *= Math.max(0, 1 - dt * 6);
        }
        s.landed = true;
      }
      sp.rotation += s.spin * dt;
      s.flip += s.flipRate * dt;

      // Lighting by facing: the chunk rocks about one local axis by at most
      // 30°, tilting its normal; Lambert toward the key light, ±25% around the
      // flat (baked) value. The squash along the other axis is the visible rock.
      const angle = ROCK_MAX * Math.sin(s.flip);
      const sf = Math.sin(angle);
      const cf = Math.cos(angle);
      const rot = sp.rotation;
      const ax = s.flipAxis === 0 ? -Math.sin(rot) : Math.cos(rot);
      const ay = s.flipAxis === 0 ? Math.cos(rot) : Math.sin(rot);
      const lam = sf * ax * LIGHT_X + sf * ay * LIGHT_Y + cf * LIGHT_Z;
      const swing = Math.max(-1, Math.min(1, (lam - LAMBERT_FLAT) / LAMBERT_RANGE));
      const b = 1 + SHADE_SWING * swing;
      const grey = Math.round(Math.min(1, b) * 255);
      sp.tint = (grey << 16) | (grey << 8) | grey;
      const fadeT = Math.max(0, (t - FADE_FROM) / (1 - FADE_FROM));
      const fade = 1 - fadeT * fadeT;
      const shrink = 1 - 0.3 * fadeT;
      const sx = s.scale * shrink * (s.flipAxis === 1 ? cf : 1);
      const sy = s.scale * shrink * (s.flipAxis === 0 ? cf : 1);
      sp.scale.set(sx, sy);
      sp.alpha = fade;
      if (s.glow) {
        // The additive copy: the glint (brightness above the baked value,
        // which a tint cannot give) and, hot, the heat colour.
        const glint = Math.max(0, b - 1);
        s.glow.position.set(sp.x, sp.y);
        s.glow.rotation = rot;
        s.glow.scale.set(sx, sy);
        s.glow.alpha = (glint * 1.6 + s.glowK * 0.35) * fade;
      }
    }
  }
}
