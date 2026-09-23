import { Container, Particle, ParticleContainer, Sprite, TextStyle, type Renderer } from 'pixi.js';
import { GlyphCache, GlyphString } from './glyph-text.js';
import { PALETTE } from './palette.js';
import type { Textures } from './textures.js';

/**
 * Pooled effects. Every pool is allocated at its maximum once and reused;
 * nothing here allocates during play.
 *
 * Particles are additive: light on a dark table. Five kinds share one pool —
 * sparks (elongated along their velocity), embers (soft glow with gravity),
 * dust (low slow puffs), rise (streak-heat embers drifting up with a sway)
 * and shards (long thin velocity-stretched light, no gravity, hard decel).
 */

/** A clear spark's length cap in cells, and its across-size as a fraction of that cap (a ≥ 2.5 px core at 1080p). */
const SPARK_MAX_CELLS = 0.4;
const SPARK_MIN_ACROSS = 0.55;
/** The spark frame's hard core is this fraction of the frame's height (textures.ts). */
const SPARK_CORE_FRAC = 0.12;

interface P {
  p: Particle;
  kind: 'spark' | 'ember' | 'dust' | 'rise' | 'shard';
  vx: number;
  vy: number;
  life: number;
  ttl: number;
  /** Spin (embers), sway phase (rise). */
  spin: number;
  size: number;
  /** Peak alpha (dust, rise; sparks and embers start at 1). */
  alpha: number;
  alive: boolean;
  /** Rise only: the hard core layer (vs the soft halo underneath it). */
  core: boolean;
  /** Rise only: vertical stretch factor. */
  stretch: number;
  /** Spark only: a floor on the across scale, so the core never thins to a hairline. */
  across: number;
}

export class Particles {
  readonly container: ParticleContainer;
  private pool: P[] = [];
  private next = 0;
  /** Particles leaving this rect fade out fast, so bursts stay around the board. */
  bounds = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
  /** Rising embers fade out fast where this says true (over a tile face). */
  riseBlocked: ((x: number, y: number) => boolean) | null = null;
  private readonly sparkTex;
  private readonly glowTex;
  private readonly texSize: number;

  constructor(cap: number, tex: Textures) {
    this.sparkTex = tex.spark;
    this.glowTex = tex.glow;
    this.texSize = tex.size;
    // In Pixi 8 scale is folded into `vertex`, and texture frames into `uvs`;
    // both must be dynamic or particles keep their construction values.
    this.container = new ParticleContainer({
      dynamicProperties: { vertex: true, position: true, rotation: true, uvs: true, color: true },
      texture: tex.glow,
    });
    this.container.blendMode = 'add';
    for (let i = 0; i < cap; i++) {
      const p = new Particle({ texture: tex.glow, anchorX: 0.5, anchorY: 0.5, alpha: 0 });
      p.scaleX = p.scaleY = 0;
      this.container.addParticle(p);
      this.pool.push({
        p,
        kind: 'ember',
        vx: 0,
        vy: 0,
        life: 0,
        ttl: 1,
        spin: 0,
        size: 1,
        alpha: 1,
        alive: false,
        core: false,
        stretch: 1,
        across: 0,
      });
    }
  }

  private take(): P | undefined {
    const s = this.pool[this.next];
    if (!s) return undefined;
    this.next = (this.next + 1) % this.pool.length;
    return s;
  }

  /**
   * Sparks + embers from a cleared cell. `size` is one board cell as a texture
   * scale; spark length is 0.8–1.6 cells. `axisX/axisY` is the line's axis: 30%
   * of sparks travel along it.
   */
  burst(
    x: number,
    y: number,
    color: number,
    count: number,
    speed: number,
    size: number,
    axisX = 0,
    axisY = 0,
  ): void {
    for (let i = 0; i < count; i++) {
      const s = this.take();
      if (!s) return;
      const spark = i % 2 === 0;
      const along = spark && (axisX !== 0 || axisY !== 0) && Math.random() < 0.3;
      const a = Math.random() * Math.PI * 2;
      const v = speed * (spark ? 0.7 + Math.random() * 0.9 : 0.25 + Math.random() * 0.6);
      s.kind = spark ? 'spark' : 'ember';
      // A clear's spark is a short bright dash, never a hairline across a
      // face: its length is capped at SPARK_MAX_CELLS of the cell (`stretch`
      // carries the cap) and its core kept at least SPARK_MIN_ACROSS thick.
      s.stretch = size * SPARK_MAX_CELLS;
      s.across = 0;
      if (along) {
        const sign = Math.random() < 0.5 ? -1 : 1;
        s.vx = axisX * sign * v * 1.3 + (Math.random() - 0.5) * v * 0.2;
        s.vy = axisY * sign * v * 1.3 + (Math.random() - 0.5) * v * 0.2;
      } else {
        s.vx = Math.cos(a) * v;
        s.vy = Math.sin(a) * v - speed * 0.2;
      }
      s.life = 0;
      s.ttl = spark ? 0.25 + Math.random() * 0.2 : 0.6 + Math.random() * 0.3;
      s.spin = spark ? 0 : (Math.random() - 0.5) * 6;
      s.size = size * (spark ? 0.8 + Math.random() * 0.8 : 0.3 + Math.random() * 0.25);
      s.alive = true;
      s.p.texture = spark ? this.sparkTex : this.glowTex;
      s.p.x = x;
      s.p.y = y;
      s.p.tint = color;
      s.p.alpha = 1;
    }
  }

  /**
   * Low, slow puffs at a placement footprint edge. With a direction (unit
   * `dirX/dirY`) the puffs travel outward along the plate in that direction
   * with no lift — a skid, not a splash — and sit lower (alpha 0.22).
   */
  dust(
    x: number,
    y: number,
    color: number,
    count: number,
    speed: number,
    size: number,
    dirX = 0,
    dirY = 0,
    /** With a core size, every puff is a soft halo over a hard core on the same path (two pool entries). */
    coreSize = 0,
  ): void {
    const directed = dirX !== 0 || dirY !== 0;
    for (let i = 0; i < count; i++) {
      const halo = this.take();
      if (!halo) return;
      const core = coreSize > 0 ? this.take() : undefined;
      let vx: number;
      let vy: number;
      if (directed) {
        const v = speed * (0.6 + Math.random() * 0.6);
        const side = (Math.random() - 0.5) * speed * 0.5;
        vx = dirX * v - dirY * side;
        vy = dirY * v + dirX * side;
      } else {
        const a = Math.random() * Math.PI * 2;
        vx = Math.cos(a) * speed * (0.5 + Math.random() * 0.5);
        vy = Math.sin(a) * speed * 0.35 - speed * 0.2;
      }
      const ttl = 0.35 + Math.random() * 0.25;
      const k = 0.8 + Math.random() * 0.8;
      for (const s of core ? [halo, core] : [halo]) {
        s.kind = 'dust';
        s.vx = vx;
        s.vy = vy;
        s.life = 0;
        s.ttl = ttl;
        s.spin = 0;
        s.size = (s === core ? coreSize : size) * k;
        s.alive = true;
        s.p.texture = this.glowTex;
        s.p.x = x;
        s.p.y = y;
        s.p.tint = s === core ? 0xffffff : color;
        s.alpha = s === core ? 0.9 : directed ? 0.22 : 0.3;
        s.p.alpha = s.alpha;
      }
    }
  }

  /**
   * One streak-heat ember: two pool entries on the same path — a soft halo
   * (alpha 0.7, 2.5x the core's radius) under a hard core (the spark frame
   * stood upright, alpha 1) — rising from (x, y) at `speed` px/s with a
   * slight sway, stretched 1.4–1.8x along a near-vertical axis (±8° tilt) so
   * it reads as motion, flickering at 12–18 Hz, gone in 0.9–1.4 s. `size` is
   * one board cell as a texture scale; the core is 0.3–0.5 of it. `hot`
   * (0..1) speeds it up.
   */
  rise(x: number, y: number, color: number, size: number, speed: number, hot: number): void {
    const halo = this.take();
    const core = this.take();
    if (!halo || !core) return;
    const vx = (Math.random() - 0.5) * speed * 0.2;
    const vy = -speed * (0.75 + Math.random() * 0.5) * (1 + hot * 0.6);
    const ttl = 0.9 + Math.random() * 0.5;
    const phase = Math.random() * Math.PI * 2;
    const sz = size * (0.3 + Math.random() * 0.2);
    // Vertical stretch: the halo's, the core's follows from the frame's 3:1 shape.
    const stretch = 1.4 + Math.random() * 0.4;
    const tilt = ((Math.random() - 0.5) * 16 * Math.PI) / 180;
    for (const s of [halo, core]) {
      s.kind = 'rise';
      s.core = s === core;
      s.vx = vx;
      s.vy = vy;
      s.life = 0;
      s.ttl = ttl;
      s.spin = phase;
      s.size = sz;
      s.stretch = stretch;
      s.alpha = s.core ? 1 : 0.7;
      s.alive = true;
      s.p.texture = s.core ? this.sparkTex : this.glowTex;
      s.p.x = x;
      s.p.y = y;
      s.p.tint = color;
      s.p.alpha = 0;
      s.p.scaleX = s.p.scaleY = 0;
      // The spark frame is horizontal; stand it up. Both layers share the tilt.
      s.p.rotation = (s.core ? -Math.PI / 2 : 0) + tilt;
    }
  }

  /**
   * Burst of light shards from a point, Hades-style: a few varied shards
   * clustered in two or three random lobes (never an even spoke wheel), 0.6–2
   * cells long, decelerating hard, gone in 0.25–0.4 s. Every third shard is
   * white so the burst reads as light rather than confetti.
   */
  shards(x: number, y: number, color: number, count: number, speed: number, size: number): void {
    const lobes = 2 + (Math.random() < 0.5 ? 1 : 0);
    const base = Math.random() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const s = this.take();
      if (!s) return;
      // Lobe centres are spread unevenly around the circle; each shard sits
      // within ±0.45 rad of its lobe.
      const lobe = i % lobes;
      const a =
        base + (lobe * Math.PI * 2) / lobes + (lobe === 0 ? 0 : 0.6) + (Math.random() - 0.5) * 0.9;
      const v = speed * (0.55 + Math.random() * 0.9);
      s.kind = 'shard';
      s.vx = Math.cos(a) * v;
      s.vy = Math.sin(a) * v;
      s.life = 0;
      s.ttl = 0.25 + Math.random() * 0.15;
      s.spin = 0;
      // Length 0.6–2.0 cells at rest scale; the velocity stretch is on top.
      s.size = size * (0.6 + Math.random() * 1.4);
      s.alpha = 1;
      s.alive = true;
      s.p.texture = this.sparkTex;
      s.p.x = x;
      s.p.y = y;
      s.p.tint = i % 3 === 2 ? 0xffffff : color;
      s.p.alpha = 1;
      s.p.rotation = a;
    }
  }

  /**
   * One spark with an explicit velocity (rim sparks, supernova rain). With
   * `corePx` it is a short bright dash like a clear's: its length is capped
   * at SPARK_MAX_CELLS of `cellSize` and its hard core never thins below
   * `corePx` (a rim spark at full stretch and 0.28 across was a 1 px
   * hairline across the sockets).
   */
  spark(
    x: number,
    y: number,
    color: number,
    vx: number,
    vy: number,
    size: number,
    ttl: number,
    corePx = 0,
    cellSize = 0,
  ): void {
    const s = this.take();
    if (!s) return;
    s.kind = 'spark';
    s.vx = vx;
    s.vy = vy;
    s.life = 0;
    s.ttl = ttl;
    s.spin = 0;
    s.size = size;
    s.stretch = cellSize > 0 ? cellSize * SPARK_MAX_CELLS : 0;
    s.across = corePx > 0 ? corePx / (SPARK_CORE_FRAC * this.texSize) : 0;
    s.alpha = 1;
    s.alive = true;
    s.p.texture = this.sparkTex;
    s.p.x = x;
    s.p.y = y;
    s.p.tint = color;
    s.p.alpha = 1;
  }

  /** One soft ember with an explicit velocity (a fracture chunk dissolving). */
  ember(
    x: number,
    y: number,
    color: number,
    vx: number,
    vy: number,
    size: number,
    ttl: number,
  ): void {
    const s = this.take();
    if (!s) return;
    s.kind = 'ember';
    s.vx = vx;
    s.vy = vy;
    s.life = 0;
    s.ttl = ttl;
    s.spin = (Math.random() - 0.5) * 6;
    s.size = size;
    s.alpha = 1;
    s.alive = true;
    s.p.texture = this.glowTex;
    s.p.x = x;
    s.p.y = y;
    s.p.tint = color;
    s.p.alpha = 1;
  }

  update(dt: number): void {
    const g = 900;
    for (const s of this.pool) {
      if (!s.alive) continue;
      s.life += dt;
      if (s.life >= s.ttl) {
        s.alive = false;
        s.p.alpha = 0;
        s.p.scaleX = s.p.scaleY = 0;
        continue;
      }
      const t = s.life / s.ttl;
      const p = s.p;
      if (
        p.x < this.bounds.x0 ||
        p.x > this.bounds.x1 ||
        p.y < this.bounds.y0 ||
        p.y > this.bounds.y1
      ) {
        s.life = Math.max(s.life, s.ttl * 0.8);
      }
      if (s.kind === 'ember') s.vy += g * dt;
      else if (s.kind === 'spark') s.vy += g * 0.6 * dt;
      if (s.kind === 'rise') {
        // Buoyant: no gravity, a slight sway, slowing as it cools. Flicker at
        // 12–18 Hz (frequency from the phase), fade in fast and out slow.
        // Never across a tile face: an ember drifting into one dies there.
        if (t < 0.9 && this.riseBlocked) {
          const halfLen = p.scaleX * this.texSize * 0.45 + 2; // the core's long axis is vertical; tip + 2 px
          if (this.riseBlocked(p.x, p.y) || this.riseBlocked(p.x, p.y + halfLen))
            s.life = s.ttl * 0.9;
        }
        s.vx *= 1 - dt * 0.8;
        s.vy *= 1 - dt * 0.2;
        s.p.x += (s.vx + Math.sin(s.spin + s.life * 3.1) * 10) * dt;
        s.p.y += s.vy * dt;
        const env = Math.min(1, t * 6) * (1 - t * t);
        const hz = 12 + (s.spin / (Math.PI * 2)) * 6;
        const flicker = 1 - 0.3 * (0.5 + 0.5 * Math.sin(s.spin + s.life * hz * Math.PI * 2));
        const w = s.size * (0.85 + 0.15 * (1 - t));
        if (s.core) {
          // Spark frame stood upright: its long axis (scaleX) is now vertical.
          s.p.scaleX = w * s.stretch * 0.9;
          s.p.scaleY = w * 0.55;
        } else {
          // Halo at ~2.5x the core's visible radius (the frame's soft part is ~0.28 of its height).
          s.p.scaleX = w * 0.4;
          s.p.scaleY = w * 0.4 * s.stretch * 1.6;
        }
        s.p.alpha = s.alpha * env * flicker;
        continue;
      }
      if (s.kind === 'shard') {
        s.vx *= 1 - dt * 7;
        s.vy *= 1 - dt * 7;
        s.p.x += s.vx * dt;
        s.p.y += s.vy * dt;
        const sp = Math.hypot(s.vx, s.vy);
        const fade = 1 - t * t;
        s.p.scaleX = s.size * (0.6 + Math.min(1.6, sp / 500)) * (0.55 + 0.45 * fade);
        s.p.scaleY = s.size * 0.2 * (0.5 + 0.5 * fade);
        s.p.alpha = fade;
        continue;
      }
      s.vx *= 1 - dt * (s.kind === 'dust' ? 3 : 1.2);
      s.vy *= 1 - dt * (s.kind === 'dust' ? 3 : 0.4);
      s.p.x += s.vx * dt;
      s.p.y += s.vy * dt;
      const fade = 1 - t * t;
      if (s.kind === 'spark') {
        const sp = Math.hypot(s.vx, s.vy);
        s.p.rotation = Math.atan2(s.vy, s.vx);
        const sx = s.size * (0.7 + Math.min(0.6, sp / 600)) * (0.4 + 0.6 * fade);
        s.p.scaleX = s.stretch > 0 ? Math.min(sx, s.stretch) : sx;
        s.p.scaleY = Math.max(
          Math.max(s.stretch > 0 ? s.stretch * SPARK_MIN_ACROSS : 0, s.size * 0.28) *
            (0.5 + 0.5 * fade),
          s.across,
        );
        s.p.alpha = fade;
      } else if (s.kind === 'ember') {
        s.p.rotation += s.spin * dt;
        s.p.scaleX = s.p.scaleY = s.size * (0.8 + 0.4 * fade);
        s.p.alpha = fade;
      } else {
        s.p.scaleX = s.p.scaleY = s.size * (1 + t * 0.8);
        s.p.alpha = s.alpha * (1 - t);
      }
    }
  }
}

// ---------------------------------------------------------------------------

interface F {
  text: GlyphString;
  life: number;
  ttl: number;
  vy: number;
  alive: boolean;
  baseScale: number;
  /** Impact frames: the float holds white at 1.4x for this long before easing (0 = none). */
  impact: number;
  color: number;
}

/** Every char a float shows (`+points`), baked ahead; anything else bakes on first use. */
const FLOAT_ALPHABET = '+0123456789';
/** Glyphs a float can hold (a `+` and up to seven digits, or a short tag). */
const FLOAT_GLYPHS = 12;

/**
 * Floating score. The floats are strings of cached glyphs (glyph-text.ts):
 * the fill is baked white and tinted the float's colour, so showing one on
 * the clear frame rasterises nothing.
 */
export class FloatText {
  readonly container = new Container();
  private pool: F[] = [];
  private next = 0;
  /** Floats never rise above this y (HUD band); when clamped they fade instead. */
  minY = -1e9;
  private readonly cache: GlyphCache;
  private readonly shadowAlpha: number;

  /** `res`: the text rasterisation resolution (the renderer's, capped; playfield.ts). */
  constructor(renderer: Renderer, cap = 10, res = 1) {
    const style = new TextStyle({
      fontFamily: 'Rajdhani, "Space Grotesk", sans-serif',
      fontWeight: '700',
      fontSize: 40,
      fill: 0xffffff,
      align: 'center',
      stroke: { color: PALETTE.bgDeep, width: 5, join: 'round' },
      dropShadow: { alpha: 0.6, blur: 6, color: 0x000000, distance: 2 },
    });
    this.shadowAlpha = style.dropShadow?.alpha ?? 0;
    this.cache = new GlyphCache(renderer, style, res, {
      shadow: true,
      stroke: true,
      fill: true,
      body: false,
    });
    this.cache.setAlphabet(FLOAT_ALPHABET);
    for (let i = 0; i < cap; i++) {
      const text = new GlyphString(this.cache, FLOAT_GLYPHS);
      text.setShadow(this.shadowAlpha, 0x000000);
      text.container.visible = false;
      this.container.addChild(text.container);
      this.pool.push({
        text,
        life: 0,
        ttl: 1,
        vy: -60,
        alive: false,
        baseScale: 1,
        impact: 0,
        color: 0xffffff,
      });
    }
  }

  /** Whether glyphs of the alphabet are still waiting to be baked. */
  get pending(): boolean {
    return this.cache.pending;
  }

  /** Bake the next glyph of the alphabet. */
  step(): void {
    this.cache.step(1);
  }

  /**
   * `impact` (seconds) holds the float white at 1.4x for that long before the
   * usual punch-in — two frames on a streak clear so the number hits, not floats.
   */
  show(
    x: number,
    y: number,
    value: string,
    color: number,
    scale = 1,
    ttl = 1.1,
    delayS = 0,
    impact = 0,
  ): void {
    const f = this.pool[this.next];
    if (!f) return;
    this.next = (this.next + 1) % this.pool.length;
    f.text.set(value);
    // Impact floats show white and take the colour as a tint after the hold.
    f.text.setFill(impact > 0 ? 0xffffff : color);
    const c = f.text.container;
    c.tint = 0xffffff;
    f.impact = impact;
    f.color = color;
    c.x = x;
    c.y = y;
    c.visible = true;
    c.alpha = 1;
    f.life = 0;
    f.ttl = ttl;
    f.vy = -70 * scale;
    f.baseScale = scale;
    f.alive = true;
    c.scale.set(scale * 0.6);
    // A negative life is a delay; the float stays hidden until it reaches zero.
    f.life = -delayS;
    c.visible = delayS <= 0;
  }

  update(dt: number): void {
    for (const f of this.pool) {
      if (!f.alive) continue;
      f.life += dt;
      const t = f.life / f.ttl;
      if (t < 0) continue;
      const c = f.text.container;
      c.visible = true;
      if (t >= 1) {
        f.alive = false;
        c.visible = false;
        continue;
      }
      if (f.impact > 0) {
        if (f.life < f.impact) {
          c.scale.set(f.baseScale * 1.4);
          c.alpha = 1;
          continue;
        }
        f.impact = 0;
        c.tint = f.color;
      }
      // Punch in, hold, drift up and fade.
      const pop =
        t < 0.15 ? 0.6 + easeOutBack(t / 0.15) * 0.5 : 1.1 - Math.min(0.1, (t - 0.15) * 0.3);
      c.scale.set(f.baseScale * pop);
      c.y += f.vy * dt * (t < 0.3 ? 0.3 : 1);
      const limit = this.minY + (f.text.height * c.scale.y) / 2;
      if (c.y < limit) {
        c.y = limit;
        f.life = Math.max(f.life, f.ttl * 0.6);
        c.alpha = Math.min(c.alpha, 1) - dt * 2;
        if (c.alpha <= 0) {
          f.alive = false;
          c.visible = false;
        }
        continue;
      }
      c.alpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * One-shot sprite animations (sweep bars, rings, residual line glow, board
 * flash) from a shared sprite pool with a tiny per-item program.
 */
interface OneShot {
  sprite: Sprite;
  life: number;
  ttl: number;
  alive: boolean;
  program: (s: Sprite, t: number, o: OneShot) => void;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  sx: number;
  sy: number;
  alpha: number;
}

export class OneShots {
  readonly container = new Container();
  private pool: OneShot[] = [];
  private next = 0;

  constructor(cap: number, tex: Textures) {
    this.container.blendMode = 'add';
    for (let i = 0; i < cap; i++) {
      const sprite = new Sprite(tex.glow);
      sprite.anchor.set(0.5);
      sprite.visible = false;
      sprite.blendMode = 'add';
      this.container.addChild(sprite);
      this.pool.push({
        sprite,
        life: 0,
        ttl: 1,
        alive: false,
        program: () => {},
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
        sx: 1,
        sy: 1,
        alpha: 1,
      });
    }
  }

  private take(): OneShot | undefined {
    const o = this.pool[this.next];
    if (!o) return undefined;
    this.next = (this.next + 1) % this.pool.length;
    return o;
  }

  /** A light bar of fixed `lengthPx` travelling from (x0,y0) to (x1,y1). */
  sweep(
    tex: Textures,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: number,
    thickness: number,
    ttl: number,
    lengthPx = thickness * 3,
    delayS = 0,
    alpha = 1,
    /** The clear's bar frame (core at 0.55) instead of the line-sweep frame. */
    bar = false,
  ): void {
    const o = this.take();
    if (!o) return;
    const s = o.sprite;
    s.texture = bar ? tex.sweepBar : tex.sweep;
    s.tint = color;
    s.rotation = Math.atan2(y1 - y0, x1 - x0);
    s.visible = true;
    Object.assign(o, {
      life: 0,
      ttl,
      alive: true,
      x0,
      y0,
      x1,
      y1,
      sx: lengthPx / tex.size,
      sy: (thickness * 2) / tex.size,
      alpha,
    });
    o.life = -delayS; // a negative life is a delay; the program sees t < 0 as "not yet"
    s.visible = delayS <= 0;
    o.program = (sp, t, oo) => {
      sp.x = oo.x0 + (oo.x1 - oo.x0) * t;
      sp.y = oo.y0 + (oo.y1 - oo.y0) * t;
      sp.scale.set(oo.sx, oo.sy * (1 - t * 0.3));
      sp.alpha = (1 - t * t) * 0.9 * oo.alpha;
    };
    this.arm(o);
  }

  /**
   * Expanding ring at a point. `style` 0 is the 128 px ring, 1 the 256 px
   * hairline, 2 the 256 px 3 px ring (streak bursts).
   */
  ring(
    tex: Textures,
    x: number,
    y: number,
    color: number,
    fromPx: number,
    toPx: number,
    ttl: number,
    alpha = 0.6,
    style: 0 | 1 | 2 = 0,
    delayS = 0,
  ): void {
    const o = this.take();
    if (!o) return;
    const s = o.sprite;
    s.texture = style === 2 ? tex.ringMid : style === 1 ? tex.ringThin : tex.ring;
    const texSize = style > 0 ? tex.ringThin.width : tex.size;
    s.tint = color;
    s.rotation = 0;
    s.visible = true;
    Object.assign(o, {
      life: 0,
      ttl,
      alive: true,
      x0: x,
      y0: y,
      sx: fromPx / texSize,
      sy: toPx / texSize,
      alpha,
    });
    o.life = -delayS;
    s.visible = delayS <= 0;
    o.program = (sp, t, oo) => {
      const k = easeOutCubic(t);
      sp.x = oo.x0;
      sp.y = oo.y0;
      sp.scale.set(oo.sx + (oo.sy - oo.sx) * k);
      sp.alpha = (1 - t) * oo.alpha;
    };
    this.arm(o);
  }

  /** Residual glow along a line (a stretched soft glow), fading out. */
  lineGlow(
    tex: Textures,
    cx: number,
    cy: number,
    lengthPx: number,
    thicknessPx: number,
    horizontal: boolean,
    color: number,
    ttl: number,
    alpha = 0.4,
    delayS = 0,
  ): void {
    const o = this.take();
    if (!o) return;
    const s = o.sprite;
    s.texture = tex.glow;
    s.tint = color;
    s.rotation = 0;
    s.visible = true;
    const sx = (horizontal ? lengthPx : thicknessPx) / tex.size;
    const sy = (horizontal ? thicknessPx : lengthPx) / tex.size;
    Object.assign(o, { life: -delayS, ttl, alive: true, x0: cx, y0: cy, sx, sy, alpha });
    o.program = (sp, t, oo) => {
      sp.x = oo.x0;
      sp.y = oo.y0;
      sp.scale.set(oo.sx * 1.4, oo.sy * (1.2 + t * 0.6));
      sp.alpha = (1 - t) * (1 - t) * oo.alpha;
    };
    this.arm(o);
  }

  /**
   * A hairline highlight along a cleared line's top edge: the sweep frame
   * stretched to the line, so a 1.5 px core sits in a soft falloff. Peaks
   * fast, then a cubic decay over `ttl`.
   */
  lineHighlight(
    tex: Textures,
    cx: number,
    cy: number,
    lengthPx: number,
    horizontal: boolean,
    color: number,
    ttl: number,
    alpha = 0.7,
    delayS = 0,
  ): void {
    const o = this.take();
    if (!o) return;
    const s = o.sprite;
    s.texture = tex.sweep;
    s.tint = color;
    s.rotation = horizontal ? 0 : Math.PI / 2;
    s.visible = true;
    // The sweep core is 6% of the frame: 1.5 px of core means a 25 px frame.
    Object.assign(o, {
      life: -delayS,
      ttl,
      alive: true,
      x0: cx,
      y0: cy,
      sx: (lengthPx * 1.05) / tex.size,
      sy: 25 / tex.size,
      alpha,
    });
    o.program = (sp, t, oo) => {
      sp.x = oo.x0;
      sp.y = oo.y0;
      sp.scale.set(oo.sx, oo.sy);
      const env = t < 0.12 ? t / 0.12 : 1 - Math.pow((t - 0.12) / 0.88, 3);
      sp.alpha = env * oo.alpha;
    };
    this.arm(o);
  }

  /** Soft glow that pops and fades (deal-in, placement). */
  puff(
    tex: Textures,
    x: number,
    y: number,
    color: number,
    px: number,
    ttl: number,
    alpha: number,
    /** `true` draws the 40-band spotlight instead of the 10-band glow: a big puff without banding rings. */
    smooth = false,
    delayS = 0,
  ): void {
    const o = this.take();
    if (!o) return;
    const s = o.sprite;
    const texture = smooth ? tex.spotlight : tex.glow;
    s.texture = texture;
    s.tint = color;
    s.rotation = 0;
    s.visible = true;
    Object.assign(o, {
      life: -delayS,
      ttl,
      alive: true,
      x0: x,
      y0: y,
      sx: px / texture.width,
      sy: px / texture.width,
      alpha,
    });
    o.program = (sp, t, oo) => {
      sp.x = oo.x0;
      sp.y = oo.y0;
      sp.scale.set(oo.sx * (0.6 + t * 0.8));
      sp.alpha = (1 - t) * oo.alpha;
    };
    this.arm(o);
  }

  /** A held core: full alpha for `holdS`, then out over `outS`; no growth. */
  flare(
    tex: Textures,
    x: number,
    y: number,
    color: number,
    px: number,
    holdS: number,
    outS: number,
    alpha: number,
    delayS = 0,
  ): void {
    const o = this.take();
    if (!o) return;
    const s = o.sprite;
    s.texture = tex.spotlight;
    s.tint = color;
    s.rotation = 0;
    s.visible = true;
    const ttl = holdS + outS;
    Object.assign(o, {
      life: -delayS,
      ttl,
      alive: true,
      x0: x,
      y0: y,
      sx: px / tex.spotlight.width,
      sy: holdS / ttl, // the hold's share of the life
      alpha,
    });
    o.program = (sp, t, oo) => {
      sp.x = oo.x0;
      sp.y = oo.y0;
      sp.scale.set(oo.sx);
      const out = t <= oo.sy ? 1 : 1 - (t - oo.sy) / (1 - oo.sy);
      sp.alpha = out * out * oo.alpha;
    };
    this.arm(o);
  }

  /**
   * A light column rising from a cleared line (3+ lines): the feathered
   * glow stretched to the line's length, FILLED (no hoop), widening across
   * the line from 0.6 to `widthPx` and drifting up by `risePx` over `ttl`;
   * alpha peaks in the first 12% and eases out.
   */
  column(
    tex: Textures,
    cx: number,
    cy: number,
    lengthPx: number,
    widthPx: number,
    horizontal: boolean,
    color: number,
    ttl: number,
    alpha: number,
    risePx: number,
    delayS = 0,
  ): void {
    const o = this.take();
    if (!o) return;
    const s = o.sprite;
    s.texture = tex.glow;
    s.tint = color;
    s.rotation = horizontal ? 0 : Math.PI / 2;
    s.visible = true;
    Object.assign(o, {
      life: -delayS,
      ttl,
      alive: true,
      x0: cx,
      y0: cy,
      x1: lengthPx / tex.size,
      y1: widthPx / tex.size,
      sx: risePx,
      sy: 0,
      alpha,
    });
    o.program = (sp, t, oo) => {
      const k = easeOutCubic(t);
      sp.x = oo.x0;
      sp.y = oo.y0 - oo.sx * k;
      const across = oo.y1 * (0.6 + 0.4 * k);
      sp.scale.set(oo.x1 * 1.1, across);
      const env = t < 0.12 ? t / 0.12 : 1 - Math.pow((t - 0.12) / 0.88, 2);
      sp.alpha = env * oo.alpha;
    };
    this.arm(o);
  }

  update(dt: number): void {
    for (const o of this.pool) {
      if (!o.alive) continue;
      o.life += dt;
      const t = o.life / o.ttl;
      if (t < 0) continue;
      o.sprite.visible = true;
      if (t >= 1) {
        o.alive = false;
        o.sprite.visible = false;
        continue;
      }
      o.program(o.sprite, t, o);
    }
  }

  /**
   * Apply a freshly issued one-shot's program at t = 0 (or hide it while it
   * waits on a delay). Without this, a one-shot issued AFTER this frame's
   * update() was drawn once with its slot's previous transform — the results'
   * win flare showed up at a stale position for a frame and never at its
   * α 1 first frame.
   */
  private arm(o: OneShot): void {
    if (o.life < 0) {
      o.sprite.visible = false;
      return;
    }
    o.sprite.visible = true;
    o.program(o.sprite, 0, o);
  }
}

// ---------------------------------------------------------------------------
// Easing

export function easeOutBack(t: number, s = 1.6): number {
  const u = t - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function easeInQuad(t: number): number {
  return t * t;
}

export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
