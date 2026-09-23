import { Container, Sprite, type Texture } from 'pixi.js';
import { PALETTE } from './palette.js';

/**
 * Drifting depth motes behind the board: two parallax layers of additive
 * glow sprites that wrap at the screen edges, warm up with streak heat, and
 * get a radial shove from every line clear that settles back to drift.
 *
 * Integration in playfield.ts (replaces `motes`, `moteLayer`, `MOTE_COUNT`,
 * the `Mote` interface, the mote loop in `applyLayout()` and `animateMotes()`):
 *
 *   import { MoteField } from './motes.js';
 *   private motes!: MoteField;
 *
 *   // build(), where `this.world.addChild(this.moteLayer)` was:
 *   this.motes = new MoteField(this.tex, 30);
 *   this.world.addChild(this.motes.container);
 *
 *   // applyLayout(), where the per-mote size/position loop was:
 *   this.motes.layout(w, h, { x: L.boardX, y: L.boardY, w: L.boardSize, h: L.boardSize });
 *
 *   // the clear handler: one push per cleared line, from the line's centre.
 *   // In the `for (const r of e.rows)` loop after `const y = ...`:
 *   this.motes.impulse(L.boardX + L.boardSize / 2, y, 90 + 40 * lines, L.boardSize * 0.9);
 *   // In the `for (const c of e.cols)` loop after `const x = ...`:
 *   this.motes.impulse(x, L.boardY + L.boardSize / 2, 90 + 40 * lines, L.boardSize * 0.9);
 *   // (strength is px/s at the source; a 1-line clear nudges, a 4-line
 *   // clear shoves. Back-layer motes take a third of it for parallax.)
 *
 *   // animateHeat(), next to `this.background?.setHeat(h)`:
 *   this.motes.setHeat(h);
 *
 *   // frame(), where `this.animateMotes(dt)` was:
 *   this.motes.update(dt, this.app.screen.width, this.app.screen.height);
 *
 * Sprites are allocated once in the constructor; update() allocates nothing.
 *
 * WORLD PRESETS (docs/worlds.md): a world names a particle kind — petal,
 * snow, ember, firefly — and `setPreset` re-dresses the same pool: texture
 * frame off the shared sheet, blend, tint, size, drift direction, spin, sway
 * or blink. `rate` sets how many of the pool are live (4 per unit). The
 * `gust` event blows the field away from a cleared line at six times the
 * drift for 1.2 s. With no preset the field is the original blue motes.
 * Particles are the one non-deterministic system (visual noise).
 */

/** Motes with index >= count - BIG_COUNT are the large wide-screen ones. */
const BIG_COUNT = 12;
/** Wide-screen threshold, matching the side bands in playfield.ts. */
const WIDE_PX = 1100;
/** Gap between the board and the outer thirds, matching the side bands. */
const BOARD_MARGIN = 40;
/** Wrap margin so a mote is fully off screen before it reappears opposite. */
const WRAP_PX = 40;
/**
 * Impulse velocity decays as exp(-t * IMPULSE_DECAY): at 3/s it is down to
 * 1% after ~1.5 s, which is when the field reads as "back to drift".
 */
const IMPULSE_DECAY = 3;
/** Heat makes the drift up to this much faster. */
const HEAT_SPEED = 0.5;
const COOL_TINT = 0x8f96ff;
const WARM_TINT = PALETTE.accentWarm;
/** A gust multiplies the drift by this much for this long (world event). */
const GUST_SPEED = 6;
const GUST_S = 1.2;
/** Live motes per unit of a preset's rate. */
const RATE_TO_COUNT = 4;

export type MoteKind = 'mote' | 'petal' | 'snow' | 'ember' | 'firefly' | 'none';

export interface MotePreset {
  kind: MoteKind;
  /** Live particles = rate x 4, capped by the pool. */
  rate: number;
  /** Pixi colour. */
  tint: number;
}

export interface BoardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class MoteField {
  /** Additive layer; add it to the world above the backdrop and spotlight. */
  readonly container = new Container();
  private readonly sprites: Sprite[] = [];
  private readonly count: number;
  private readonly texSize: number;
  private readonly rng: () => number;

  // Hot per-mote state in typed arrays so update() touches no objects but sprites.
  private readonly driftX: Float64Array;
  private readonly driftY: Float64Array;
  private readonly kickX: Float64Array;
  private readonly kickY: Float64Array;
  /** 0 = back layer (small, slow, dim), 1 = front layer. */
  private readonly depth: Float64Array;
  private readonly accentIdx: Uint8Array;

  /** Per-mote spin (rad/s) and phase for sway / blink, used by the world presets. */
  private readonly spin: Float64Array;
  private readonly phase: Float64Array;
  private readonly baseAlpha: Float64Array;

  private heat = 0;
  private lastTintHeat = -1;
  private preset: MotePreset | null = null;
  private readonly tex: { glow: Texture; petal?: Texture };
  private live: number;
  private t = 0;
  private gustT = 0;
  /** Viewport from the last layout, for a preset change. */
  private lastW = 0;
  private lastH = 0;
  private lastBoard: BoardRect = { x: 0, y: 0, w: 0, h: 0 };

  /**
   * @param tex   the glow texture (any square soft radial; `Textures.glow`) and the petal frame
   * @param count total motes; the last {@link BIG_COUNT} are the large ones
   * @param rng   random source, injectable for deterministic tests
   */
  constructor(
    tex: { glow: Texture; petal?: Texture },
    count: number,
    rng: () => number = Math.random,
  ) {
    this.count = count;
    this.live = count;
    this.rng = rng;
    this.tex = tex;
    this.texSize = Math.max(1, tex.glow.width);
    this.driftX = new Float64Array(count);
    this.driftY = new Float64Array(count);
    this.kickX = new Float64Array(count);
    this.kickY = new Float64Array(count);
    this.depth = new Float64Array(count);
    this.accentIdx = new Uint8Array(count);
    this.spin = new Float64Array(count);
    this.phase = new Float64Array(count);
    this.baseAlpha = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const s = new Sprite(tex.glow);
      s.anchor.set(0.5);
      s.blendMode = 'add';
      this.accentIdx[i] = i % 3 === 0 ? 1 : 0;
      this.container.addChild(s);
      this.sprites.push(s);
    }
    this.applyTint(0);
  }

  /** Number of motes in the field. */
  get size(): number {
    return this.count;
  }

  /** Current velocity of mote i (drift + impulse), in px/s. For tests and tooling. */
  velocityOf(i: number): { vx: number; vy: number } {
    const speed = 1 + this.heat * HEAT_SPEED;
    return {
      vx: (this.driftX[i] ?? 0) * speed + (this.kickX[i] ?? 0),
      vy: (this.driftY[i] ?? 0) * speed + (this.kickY[i] ?? 0),
    };
  }

  /** Impulse velocity of mote i alone, in px/s. For tests and tooling. */
  impulseOf(i: number): { vx: number; vy: number } {
    return { vx: this.kickX[i] ?? 0, vy: this.kickY[i] ?? 0 };
  }

  /** Position of mote i in screen px. For tests and tooling. */
  positionOf(i: number): { x: number; y: number } {
    const s = this.sprites[i];
    return s ? { x: s.x, y: s.y } : { x: 0, y: 0 };
  }

  /** Depth of mote i: 0 = back layer, 1 = front layer. */
  depthOf(i: number): number {
    return this.depth[i] ?? 0;
  }

  /**
   * (Re)scatter the field for a viewport. Near motes go anywhere; on wide
   * screens the last dozen are large and confined to the outer thirds beside
   * the board. Call on every resize, as the old mote loop was.
   */
  layout(w: number, h: number, board: BoardRect): void {
    this.lastW = w;
    this.lastH = h;
    this.lastBoard = board;
    if (this.preset && this.preset.kind !== 'mote') {
      this.layoutPreset(w, h, this.preset);
      return;
    }
    const wide = w >= WIDE_PX;
    const leftW = board.x - BOARD_MARGIN;
    const rightX = board.x + board.w + BOARD_MARGIN;
    const rightW = w - rightX;
    const nearCount = this.count - BIG_COUNT;
    for (let i = 0; i < this.count; i++) {
      const s = this.sprites[i];
      if (!s) continue;
      const big = wide && i >= nearCount;
      // Two depth layers among the near motes: the first ~60% at the back.
      let depth: number;
      let size: number;
      let alpha: number;
      if (big) {
        depth = 1;
        size = 40 + this.rng() * 40;
        alpha = 0.08;
      } else if (i < nearCount * 0.6) {
        depth = 0;
        size = 4 + this.rng() * 14;
        alpha = 0.04 + (size / 18) * 0.04;
      } else {
        depth = 1;
        size = 18 + this.rng() * 22;
        alpha = 0.08 + (size / 40) * 0.06;
      }
      this.depth[i] = depth;
      s.scale.set(size / this.texSize);
      s.alpha = alpha;
      if (big && leftW > 0 && rightW > 0) {
        const left = this.rng() < 0.5;
        s.position.set(left ? this.rng() * leftW : rightX + this.rng() * rightW, this.rng() * h);
      } else {
        s.position.set(this.rng() * w, this.rng() * h);
      }
      // Parallax by size: bigger reads nearer, so it moves faster.
      const speed = (depth === 0 ? 4 : 8) + (size / 40) * 14;
      const a = this.rng() * Math.PI * 2;
      this.driftX[i] = Math.cos(a) * speed;
      this.driftY[i] = Math.sin(a) * speed;
      this.kickX[i] = 0;
      this.kickY[i] = 0;
      s.visible = true;
      s.rotation = 0;
      s.blendMode = 'add';
      s.texture = this.tex.glow;
    }
    this.applyTint(this.heat);
  }

  /**
   * Dress the pool for a world's particle kind, or `null` for the original
   * motes. Re-scatters the field (call after `layout`).
   */
  setPreset(preset: MotePreset | null): void {
    this.preset = preset && preset.kind !== 'none' ? preset : null;
    this.live = preset
      ? preset.kind === 'none'
        ? 0
        : Math.min(this.count, Math.round(preset.rate * RATE_TO_COUNT))
      : this.count;
    if (this.lastW > 0) this.layout(this.lastW, this.lastH, this.lastBoard);
    if (preset?.kind === 'none') for (const s of this.sprites) s.visible = false;
  }

  /**
   * The world's `gust`: six times the drift for 1.2 s, and every petal
   * streams sideways away from the cleared line's centre x at `lateralPxS`
   * (1.5 cells/s), so a multiline reads as one wind, not a splash.
   */
  gust(x: number, y: number, radiusPx: number, lateralPxS = 90): void {
    this.gustT = GUST_S;
    this.impulse(x, y, 120, radiusPx);
    for (let i = 0; i < this.live; i++) {
      const s = this.sprites[i];
      if (!s) continue;
      const dir = s.x >= x ? 1 : -1;
      this.kickX[i] = (this.kickX[i] ?? 0) + dir * lateralPxS;
    }
  }

  private layoutPreset(w: number, h: number, p: MotePreset): void {
    const k = Math.max(0.6, Math.min(1.6, h / 1080)); // sizes scale with the frame
    const petal = this.tex.petal ?? this.tex.glow;
    for (let i = 0; i < this.count; i++) {
      const s = this.sprites[i];
      if (!s) continue;
      const on = i < this.live;
      s.visible = on;
      // Two depths: the first 60% at the back (smaller, slower, dimmer).
      const depth = i < this.live * 0.6 ? 0 : 1;
      this.depth[i] = depth;
      const near = depth === 1;
      let size: number;
      let alpha: number;
      let vx: number;
      let vy: number;
      s.rotation = 0;
      this.spin[i] = 0;
      this.phase[i] = this.rng() * Math.PI * 2;
      s.tint = p.tint;
      switch (p.kind) {
        case 'petal': {
          // Petals come off the blossoms that frame the scene: they spawn at
          // a side edge (never in open sky) and drift in and down.
          s.texture = petal;
          s.blendMode = 'normal';
          size = (near ? 16 + this.rng() * 8 : 10 + this.rng() * 6) * k;
          alpha = near ? 0.7 : 0.55;
          const left = this.rng() < 0.5;
          const speed = (near ? 24 : 14) + this.rng() * 16;
          vx = left ? speed : -speed;
          vy = (near ? 26 : 14) + this.rng() * 16;
          s.rotation = this.rng() * Math.PI * 2;
          this.spin[i] = (this.rng() - 0.5) * 3;
          break;
        }
        case 'snow':
          s.texture = this.tex.glow;
          s.blendMode = 'normal';
          size = (near ? 7 + this.rng() * 5 : 3 + this.rng() * 3) * k;
          alpha = near ? 0.8 : 0.55;
          vx = (this.rng() - 0.5) * 16;
          vy = (near ? 34 : 18) + this.rng() * 20;
          break;
        case 'ember':
          s.texture = this.tex.glow;
          s.blendMode = 'add';
          size = (near ? 6 + this.rng() * 4 : 3 + this.rng() * 3) * k;
          alpha = near ? 0.9 : 0.6;
          vx = (this.rng() - 0.5) * 20;
          vy = -((near ? 44 : 22) + this.rng() * 30);
          break;
        default: // firefly
          s.texture = this.tex.glow;
          s.blendMode = 'add';
          size = (near ? 8 + this.rng() * 5 : 4 + this.rng() * 3) * k;
          alpha = near ? 0.9 : 0.6;
          vx = (this.rng() - 0.5) * 24;
          vy = (this.rng() - 0.5) * 16;
          break;
      }
      s.scale.set(size / this.texSize);
      s.alpha = alpha;
      this.baseAlpha[i] = alpha;
      if (p.kind === 'petal') this.spawnPetal(i, w, h, vx > 0, true);
      else s.position.set(this.rng() * w, this.rng() * h);
      this.driftX[i] = vx;
      this.driftY[i] = vy;
      this.kickX[i] = 0;
      this.kickY[i] = 0;
    }
  }

  /**
   * A petal's start: within the blossom band at the side it drifts in from
   * (8% of the width), anywhere in the top 85% of the frame; a fresh field
   * (`scatter`) also seeds some mid-flight so the first frame is not empty.
   */
  private spawnPetal(i: number, w: number, h: number, fromLeft: boolean, scatter: boolean): void {
    const s = this.sprites[i];
    if (!s) return;
    const band = w * 0.08;
    let x = fromLeft ? this.rng() * band : w - this.rng() * band;
    let y = this.rng() * h * 0.85;
    if (scatter && this.rng() < 0.5) {
      // Mid-flight: along the drift line from the edge.
      const t = this.rng() * 0.6;
      x += (fromLeft ? 1 : -1) * t * w * 0.5;
      y += t * h * 0.5;
    }
    s.position.set(x, y);
  }

  /** Streak heat 0..1: warmer tint, slightly faster drift. */
  setHeat(h: number): void {
    this.heat = Math.min(1, Math.max(0, h));
    if (!this.preset && Math.abs(this.heat - this.lastTintHeat) > 0.01) this.applyTint(this.heat);
  }

  /**
   * Radial push from (x, y): every mote within radiusPx gets a velocity kick
   * away from the point, `strength` px/s at the centre falling smoothly to
   * zero at the radius. Back-layer motes take a third of it (parallax). The
   * kick decays back to plain drift over ~1.5 s.
   */
  impulse(x: number, y: number, strength: number, radiusPx: number): void {
    if (radiusPx <= 0 || strength === 0) return;
    const r2 = radiusPx * radiusPx;
    for (let i = 0; i < this.count; i++) {
      const s = this.sprites[i];
      if (!s) continue;
      const dx = s.x - x;
      const dy = s.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r2) continue;
      const d = Math.sqrt(d2);
      // Unit direction away from the source; a mote sitting on it goes straight up.
      let ux = 0;
      let uy = -1;
      if (d > 1e-3) {
        ux = dx / d;
        uy = dy / d;
      }
      const t = 1 - d / radiusPx;
      const falloff = t * t * (3 - 2 * t);
      const parallax = 0.33 + 0.67 * (this.depth[i] ?? 0);
      const k = strength * falloff * parallax;
      this.kickX[i] = (this.kickX[i] ?? 0) + ux * k;
      this.kickY[i] = (this.kickY[i] ?? 0) + uy * k;
    }
  }

  /** Advance drift and impulse, wrapping at the screen edges. No allocation. */
  update(dtSec: number, w: number, h: number): void {
    if (dtSec <= 0) return;
    this.t += dtSec;
    const p = this.preset;
    let speed = 1 + this.heat * HEAT_SPEED;
    if (this.gustT > 0) {
      this.gustT = Math.max(0, this.gustT - dtSec);
      speed *= 1 + (GUST_SPEED - 1) * (this.gustT / GUST_S);
    }
    const decay = Math.exp(-dtSec * IMPULSE_DECAY);
    const t = this.t;
    for (let i = 0; i < this.count; i++) {
      const s = this.sprites[i];
      if (!s) continue;
      if (i >= this.live) continue;
      const kx = (this.kickX[i] ?? 0) * decay;
      const ky = (this.kickY[i] ?? 0) * decay;
      this.kickX[i] = kx;
      this.kickY[i] = ky;
      let sway = 0;
      if (p) {
        const ph = this.phase[i] ?? 0;
        const spin = this.spin[i] ?? 0;
        if (spin !== 0) s.rotation += spin * dtSec;
        if (p.kind === 'petal' || p.kind === 'snow') sway = Math.sin(t * 1.3 + ph) * 14;
        else if (p.kind === 'firefly') {
          const b = Math.max(0, Math.sin(t * 1.7 + ph));
          s.alpha = (this.baseAlpha[i] ?? 1) * (0.15 + 0.85 * b * b * b);
        } else if (p.kind === 'ember') {
          s.alpha = (this.baseAlpha[i] ?? 1) * (0.7 + 0.3 * Math.sin(t * 13 + ph));
        }
      }
      let x = s.x + ((this.driftX[i] ?? 0) * speed + sway + kx) * dtSec;
      let y = s.y + ((this.driftY[i] ?? 0) * speed + ky) * dtSec;
      if (p?.kind === 'petal') {
        // Off the frame: back to a blossom edge, never wrapping across the sky.
        if (y > h + WRAP_PX || x < -WRAP_PX || x > w + WRAP_PX) {
          this.spawnPetal(i, w, h, (this.driftX[i] ?? 0) > 0, false);
          s.scale.x = s.scale.y;
          continue;
        }
        // Gusted: a two-frame smear along the travel — the petal turns into
        // its velocity and stretches with it, settling back as the gust dies.
        if (this.gustT > 0) {
          const vx = (this.driftX[i] ?? 0) * speed + sway + kx;
          const vy = (this.driftY[i] ?? 0) * speed + ky;
          const g = this.gustT / GUST_S;
          s.rotation = Math.atan2(vy, vx);
          s.scale.x =
            s.scale.y *
            (1 + Math.min(2.5, (Math.hypot(vx, vy) * dtSec * 2) / Math.max(1, s.height)) * g);
        } else if (s.scale.x !== s.scale.y) {
          s.scale.x = s.scale.y;
        }
        s.position.set(x, y);
        continue;
      }
      if (x < -WRAP_PX) x = w + WRAP_PX;
      else if (x > w + WRAP_PX) x = -WRAP_PX;
      if (y < -WRAP_PX) y = h + WRAP_PX;
      else if (y > h + WRAP_PX) y = -WRAP_PX;
      s.position.set(x, y);
    }
  }

  private applyTint(h: number): void {
    this.lastTintHeat = h;
    const cool = lerpColor(COOL_TINT, WARM_TINT, h);
    const accent = lerpColor(PALETTE.accent, WARM_TINT, h);
    for (let i = 0; i < this.count; i++) {
      const s = this.sprites[i];
      if (s) s.tint = this.accentIdx[i] ? accent : cool;
    }
  }
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}
