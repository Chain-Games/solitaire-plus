import { Buffer, BufferUsage, Container, Geometry, Mesh, Shader, Sprite } from 'pixi.js';
import { easeOutCubic } from './effects.js';
import type { Textures } from './textures.js';

/**
 * Streak VFX: the systems that make a streak the most beautiful thing in the
 * game. Every one of them reads the renderer's single heat value (or fires as
 * a one-shot from a streak event) and is pooled once at build time; nothing
 * here allocates per frame. Tier numbers come from quality.ts.
 *
 *   RimBand   a flowing plasma band along the plate rim while hot: a small
 *             GLSL mesh (four thin strips, no corner overlap) with a
 *             travelling, flickering noise gradient; brightness and speed
 *             from heat, white-hot at 4X.
 *   Ribbons   curling light ribbons on streak clears: a pool of cubic-bezier
 *             strips in ONE mesh with dynamic vertex buffers and per-vertex
 *             colour, additive, a soft core and a fading tail.
 *   TileGlow  per-tile overlays: an additive rim light in the heat colour
 *             from heat 0.5 (breathing with the pill), a diagonal specular
 *             sheen sweep on 4X clears, and a white-hot flash for the
 *             supernova.
 */

// ---------------------------------------------------------------------------
// Rim energy band

const RIM_VERT = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}
`;

const RIM_FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;

uniform float uTime;
uniform float uHeat;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uSize;   // px: the mesh square (plate + 2 * margin)
uniform float uHalf;   // px: half the plate size
uniform float uRadius; // px: plate corner radius
uniform float uWidth;  // px: band core width
uniform float uMargin; // px: how far the strips reach from the rim
uniform float uPulse;  // 0..1 extra brightness (rim pulse on clears)
uniform int uOctaves;
uniform float uSpot;   // perimeter position (0..4) of a travelling pulse; < 0 = none
uniform float uSpotA;  // its brightness
uniform float uSpotLift; // a whole-perimeter brightening in the spot colour (the level beat)
uniform vec3 uSpotColor;

float hash1(float x) {
  return fract(sin(x * 127.1 + 311.7) * 43758.5453);
}

// 1-D value noise wrapping at period lattice points, so the band is seamless
// around the perimeter.
float pnoise(float x, float period) {
  float i = floor(x);
  float f = x - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash1(mod(i, period)), hash1(mod(i + 1.0, period)), f);
}

float sdRoundRect(vec2 p, float h, float r) {
  vec2 q = abs(p) - vec2(h - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 p = (vUV - 0.5) * uSize;
  float d = sdRoundRect(p, uHalf, uRadius);

  // Perimeter coordinate 0..4 (one unit per edge), clockwise from the top-left.
  vec2 q = p / uHalf;
  float per;
  if (abs(q.y) >= abs(q.x)) per = q.y < 0.0 ? (q.x + 1.0) * 0.5 : 2.0 + (1.0 - q.x) * 0.5;
  else per = q.x > 0.0 ? 1.0 + (q.y + 1.0) * 0.5 : 3.0 + (1.0 - q.y) * 0.5;

  // Flow: packets of light travelling around the rim, faster and busier hot.
  float speed = 0.9 + uHeat * 2.6;
  float flow = pnoise(per * 6.0 - uTime * speed, 24.0);
  if (uOctaves > 1) {
    flow = flow * 0.62 + pnoise(per * 15.0 + uTime * speed * 1.7 + 3.0, 60.0) * 0.38;
  }
  // 9 Hz flicker shared with the pill and the rim stroke.
  float flicker = 0.88 + 0.12 * sin(uTime * 56.5) * sin(uTime * 2.3);

  float w = uWidth * (0.5 + 1.5 * flow);
  float glow = exp(-(d * d) / (w * w * 6.0));
  float band = exp(-(d * d) / (w * w));
  float core = exp(-(d * d) / (uWidth * uWidth * 0.12));
  float bright = flow * flow * 2.2;
  // Packets over a dim base: peaks near 1.2, troughs near 0.15, so the light
  // visibly travels; it saturates to white only when hot.
  float i = glow * 0.14 * (0.3 + bright) + band * (0.08 + 0.55 * bright) + core * (0.12 + 0.55 * flow);
  i *= flicker * (1.0 + uPulse * 0.8);

  // Hot spots whiten with heat: amber packets at 2X, white flecks at 3X, a
  // white-hot band with a warm halo at 4X. Cooling takes the white away first.
  float hot = smoothstep(0.5, 0.92, flow);
  float white = clamp(hot * smoothstep(0.1, 0.8, uHeat) * 0.95 + smoothstep(0.68, 1.0, uHeat) * 0.5, 0.0, 1.0);
  vec3 c = mix(uColor, vec3(1.0, 0.97, 0.9), white);

  // A travelling spot (the level-up's cool pulse): one soft packet, 0.6 of an
  // edge long with a short bright head, going round once in its own colour
  // over whatever the band is doing — it adds light, it never recolours the
  // heat. dp is the wrap-aware perimeter distance behind the head.
  float spot = 0.0;
  if (uSpot >= 0.0) {
    float dp = mod(uSpot - per + 4.0, 4.0);
    float tail = exp(-dp * dp / 0.16) * 0.7;
    float head = exp(-dp * dp / 0.012);
    spot = ((tail + head) * uSpotA + uSpotLift * (0.4 + 0.6 * flow)) * (glow * 0.35 + band * 0.75 + core * 0.9);
    c = mix(c, uSpotColor, clamp(spot * 2.0, 0.0, 1.0) * 0.85);
  }
  // Fade to nothing well inside the strips' outer edges, so the mesh boundary
  // (and the four strips' joins at the corners) can never show as a line.
  float a = (i * uAlpha * (0.55 + 0.45 * uHeat) + spot) * smoothstep(uMargin, uMargin * 0.55, abs(d));
  // End-cap: the last 4% of each edge eases to 70% so the corners stay continuous.
  float edgeK = min(fract(per), 1.0 - fract(per));
  a *= mix(0.7, 1.0, smoothstep(0.0, 0.04, edgeK));
  finalColor = vec4(c * a, a);
}
`;

export class RimBand {
  readonly mesh: Mesh<Geometry, Shader>;
  private readonly shader: Shader;
  private readonly geometry: Geometry;
  private readonly positions: Buffer;
  private readonly uvs: Buffer;
  private readonly posData = new Float32Array(16 * 2);
  private readonly uvData = new Float32Array(16 * 2);

  constructor(octaves: number) {
    this.positions = new Buffer({
      data: this.posData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    this.uvs = new Buffer({ data: this.uvData, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    // Four strips: top and bottom span the full width; left and right sit
    // between them so no pixel is drawn twice (additive would double it).
    const idx: number[] = [];
    for (let s = 0; s < 4; s++) {
      const b = s * 4;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    this.geometry = new Geometry({
      attributes: {
        aPosition: { buffer: this.positions, format: 'float32x2' },
        aUV: { buffer: this.uvs, format: 'float32x2' },
      },
      indexBuffer: new Uint16Array(idx),
    });
    this.shader = Shader.from({
      gl: { vertex: RIM_VERT, fragment: RIM_FRAG, name: 'blockari-rim-band' },
      resources: {
        rimUniforms: {
          uTime: { value: 0, type: 'f32' },
          uHeat: { value: 0, type: 'f32' },
          uColor: { value: [1, 0.72, 0.3], type: 'vec3<f32>' },
          uAlpha: { value: 0, type: 'f32' },
          uSize: { value: 1, type: 'f32' },
          uHalf: { value: 0.5, type: 'f32' },
          uRadius: { value: 0.1, type: 'f32' },
          uWidth: { value: 4, type: 'f32' },
          uMargin: { value: 20, type: 'f32' },
          uPulse: { value: 0, type: 'f32' },
          uOctaves: { value: octaves, type: 'i32' },
          uSpot: { value: -1, type: 'f32' },
          uSpotA: { value: 0, type: 'f32' },
          uSpotLift: { value: 0, type: 'f32' },
          uSpotColor: { value: [0.49, 0.42, 1.0], type: 'vec3<f32>' },
        },
      },
    });
    this.mesh = new Mesh({ geometry: this.geometry, shader: this.shader });
    this.mesh.blendMode = 'add';
    this.mesh.visible = false;
  }

  private get u(): Record<string, unknown> {
    return (this.shader.resources as { rimUniforms: { uniforms: Record<string, unknown> } })
      .rimUniforms.uniforms;
  }

  setOctaves(n: number): void {
    this.u['uOctaves'] = n;
  }

  /** Plate rect (px, py, size), corner radius, and the band's core width in px. */
  layout(px: number, py: number, ps: number, radius: number, width: number): void {
    // Margin: the widest glow (sigma ~2.5 core widths at full flow) is faded
    // out by the shader before it reaches the strip edge.
    const m = width * 8;
    const x0 = px - m;
    const y0 = py - m;
    const full = ps + m * 2;
    const t = m * 2; // strip thickness
    const P = this.posData;
    const U = this.uvData;
    let k = 0;
    const quad = (x: number, y: number, w: number, h: number) => {
      const corners = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ] as const;
      for (const [cx, cy] of corners) {
        P[k * 2] = cx;
        P[k * 2 + 1] = cy;
        U[k * 2] = (cx - x0) / full;
        U[k * 2 + 1] = (cy - y0) / full;
        k++;
      }
    };
    quad(x0, y0, full, t); // top
    quad(x0, y0 + full - t, full, t); // bottom
    quad(x0, y0 + t, t, full - t * 2); // left
    quad(x0 + full - t, y0 + t, t, full - t * 2); // right
    this.positions.update();
    this.uvs.update();
    this.u['uSize'] = full;
    this.u['uHalf'] = ps / 2;
    this.u['uRadius'] = radius;
    this.u['uWidth'] = width;
    this.u['uMargin'] = m;
  }

  /**
   * Per frame. `color` is 0xRRGGBB; `alpha` 0 hides the mesh entirely unless
   * a spot is travelling. `spot` (optional): a bright packet at perimeter
   * position `at` (0..4 clockwise from the top-left corner; 0.5 = top
   * centre) at brightness `k`, in its own colour; `lift` brightens the whole
   * band in that colour (the level beat's filled pulse).
   */
  set(
    timeSec: number,
    heat: number,
    color: number,
    alpha: number,
    pulse: number,
    spot?: { at: number; k: number; color: number; lift?: number },
  ): void {
    const spotOn = spot !== undefined && (spot.k > 0.004 || (spot.lift ?? 0) > 0.004);
    const visible = alpha > 0.004 || spotOn;
    this.mesh.visible = visible;
    if (!visible) return;
    const u = this.u;
    u['uSpot'] = spotOn ? spot.at % 4 : -1;
    u['uSpotA'] = spotOn ? spot.k : 0;
    u['uSpotLift'] = spotOn ? (spot.lift ?? 0) : 0;
    if (spotOn) {
      const sc = u['uSpotColor'] as number[];
      sc[0] = ((spot.color >> 16) & 0xff) / 255;
      sc[1] = ((spot.color >> 8) & 0xff) / 255;
      sc[2] = (spot.color & 0xff) / 255;
      u['uSpotColor'] = sc;
    }
    u['uTime'] = timeSec;
    u['uHeat'] = heat;
    const c = u['uColor'] as number[];
    c[0] = ((color >> 16) & 0xff) / 255;
    c[1] = ((color >> 8) & 0xff) / 255;
    c[2] = (color & 0xff) / 255;
    u['uColor'] = c;
    u['uAlpha'] = alpha;
    u['uPulse'] = pulse;
  }
}

// ---------------------------------------------------------------------------
// Ribbons

const RIBBON_VERT = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
in vec4 aColor;
out vec2 vUV;
out vec4 vColor;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
  vColor = aColor;
}
`;

const RIBBON_FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
in vec4 vColor;
out vec4 finalColor;

void main() {
  // Across the strip: a soft halo with a hard bright core. Along it: the
  // tail (u = 0) fades in, the head (u = 1) is soft-capped.
  float across = 1.0 - abs(vUV.y * 2.0 - 1.0);
  float halo = across * across * 0.55;
  float core = smoothstep(0.55, 0.95, across);
  float along = smoothstep(0.0, 0.55, vUV.x) * smoothstep(1.0, 0.92, vUV.x);
  float i = (halo + core) * along;
  // The core goes white so the ribbon reads as light in the line's colour.
  vec3 c = mix(vColor.rgb, vec3(1.0), core * 0.55 * along);
  float a = i * vColor.a;
  finalColor = vec4(c * a, a);
}
`;

interface Ribbon {
  alive: boolean;
  life: number;
  ttl: number;
  width: number;
  /** Cubic bezier control points. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  r: number;
  g: number;
  b: number;
}

/** Segments per ribbon: enough for a smooth curl at board scale. */
const RIBBON_SEGS = 18;

export class Ribbons {
  readonly container = new Container();
  private readonly mesh: Mesh<Geometry, Shader>;
  private readonly positions: Buffer;
  private readonly colors: Buffer;
  private readonly posData: Float32Array;
  private readonly colData: Float32Array;
  private readonly pool: Ribbon[] = [];
  private next = 0;
  private anyAlive = false;

  constructor(cap: number) {
    const verts = cap * RIBBON_SEGS * 2;
    this.posData = new Float32Array(verts * 2);
    this.colData = new Float32Array(verts * 4);
    const uvData = new Float32Array(verts * 2);
    const idx = new Uint16Array(cap * (RIBBON_SEGS - 1) * 6);
    let k = 0;
    for (let r = 0; r < cap; r++) {
      for (let s = 0; s < RIBBON_SEGS; s++) {
        const v = (r * RIBBON_SEGS + s) * 2;
        const u = s / (RIBBON_SEGS - 1);
        uvData[v * 2] = u;
        uvData[v * 2 + 1] = 0;
        uvData[(v + 1) * 2] = u;
        uvData[(v + 1) * 2 + 1] = 1;
        if (s < RIBBON_SEGS - 1) {
          idx[k++] = v;
          idx[k++] = v + 1;
          idx[k++] = v + 2;
          idx[k++] = v + 1;
          idx[k++] = v + 3;
          idx[k++] = v + 2;
        }
      }
      this.pool.push({
        alive: false,
        life: 0,
        ttl: 1,
        width: 1,
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        x3: 0,
        y3: 0,
        r: 1,
        g: 1,
        b: 1,
      });
    }
    this.positions = new Buffer({
      data: this.posData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    this.colors = new Buffer({
      data: this.colData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: this.positions, format: 'float32x2' },
        aUV: {
          buffer: new Buffer({ data: uvData, usage: BufferUsage.VERTEX }),
          format: 'float32x2',
        },
        aColor: { buffer: this.colors, format: 'float32x4' },
      },
      indexBuffer: idx,
    });
    const shader = Shader.from({
      gl: { vertex: RIBBON_VERT, fragment: RIBBON_FRAG, name: 'blockari-ribbon' },
      resources: {
        ribbonUniforms: { uDummy: { value: 0, type: 'f32' } },
      },
    });
    this.mesh = new Mesh({ geometry, shader });
    this.mesh.blendMode = 'add';
    this.mesh.visible = false;
    this.container.addChild(this.mesh);
  }

  /**
   * A ribbon flying along the cubic bezier P0→P3 over `ttl` seconds: the
   * head eases out along the curve, the tail eases in behind it, so it
   * stretches to ~75% of the path at mid-life and collapses into the end.
   */
  spawn(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    color: number,
    width: number,
    ttl: number,
    delayS = 0,
  ): void {
    const rb = this.pool[this.next];
    if (!rb) return;
    this.next = (this.next + 1) % this.pool.length;
    rb.alive = true;
    rb.life = -delayS;
    rb.ttl = ttl;
    rb.width = width;
    rb.x0 = x0;
    rb.y0 = y0;
    rb.x1 = x1;
    rb.y1 = y1;
    rb.x2 = x2;
    rb.y2 = y2;
    rb.x3 = x3;
    rb.y3 = y3;
    rb.r = ((color >> 16) & 0xff) / 255;
    rb.g = ((color >> 8) & 0xff) / 255;
    rb.b = (color & 0xff) / 255;
    this.anyAlive = true;
  }

  update(dt: number): void {
    if (!this.anyAlive) return;
    const P = this.posData;
    const C = this.colData;
    let any = false;
    for (let i = 0; i < this.pool.length; i++) {
      const rb = this.pool[i]!;
      const base = i * RIBBON_SEGS * 2;
      if (rb.alive) {
        rb.life += dt;
        if (rb.life >= rb.ttl) rb.alive = false;
      }
      if (!rb.alive || rb.life < 0) {
        // Collapse the strip to zero area; the vertex colour is irrelevant then.
        for (let s = 0; s < RIBBON_SEGS * 2; s++) {
          P[(base + s) * 2] = rb.x0;
          P[(base + s) * 2 + 1] = rb.y0;
          C[(base + s) * 4 + 3] = 0;
        }
        if (rb.alive) any = true;
        continue;
      }
      any = true;
      const t = rb.life / rb.ttl;
      const head = easeOutCubic(t);
      const tail = t * t * t;
      const alpha = 0.6 * (t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4);
      const wEnv = 0.55 + 0.45 * Math.sin(Math.min(1, t * 1.6) * Math.PI);
      for (let s = 0; s < RIBBON_SEGS; s++) {
        const k = s / (RIBBON_SEGS - 1);
        const u = tail + (head - tail) * k;
        const mu = 1 - u;
        const a0 = mu * mu * mu;
        const a1 = 3 * mu * mu * u;
        const a2 = 3 * mu * u * u;
        const a3 = u * u * u;
        const x = a0 * rb.x0 + a1 * rb.x1 + a2 * rb.x2 + a3 * rb.x3;
        const y = a0 * rb.y0 + a1 * rb.y1 + a2 * rb.y2 + a3 * rb.y3;
        // Tangent for the strip normal.
        const d0 = 3 * mu * mu;
        const d1 = 6 * mu * u;
        const d2 = 3 * u * u;
        let tx = d0 * (rb.x1 - rb.x0) + d1 * (rb.x2 - rb.x1) + d2 * (rb.x3 - rb.x2);
        let ty = d0 * (rb.y1 - rb.y0) + d1 * (rb.y2 - rb.y1) + d2 * (rb.y3 - rb.y2);
        const len = Math.hypot(tx, ty) || 1;
        tx /= len;
        ty /= len;
        const hw = rb.width * wEnv * (0.25 + 0.75 * k) * 0.5;
        const v = (base + s * 2) * 2;
        P[v] = x - ty * hw;
        P[v + 1] = y + tx * hw;
        P[v + 2] = x + ty * hw;
        P[v + 3] = y - tx * hw;
        const c = (base + s * 2) * 4;
        C[c] = rb.r;
        C[c + 1] = rb.g;
        C[c + 2] = rb.b;
        C[c + 3] = alpha;
        C[c + 4] = rb.r;
        C[c + 5] = rb.g;
        C[c + 6] = rb.b;
        C[c + 7] = alpha;
      }
    }
    this.positions.update();
    this.colors.update();
    this.mesh.visible = any;
    this.anyAlive = any;
  }
}

// ---------------------------------------------------------------------------
// Tile overlays

/** Sheen sweep duration (s) and the diagonal width of the bright bar (in 0..1 diagonal units). */
const SHEEN_S = 0.35;
/**
 * Peak alpha of the sheen bar, and of the supernova flash, on a tile; they
 * sum to ~0.55 at most — and that sum is the cap on how far a RESTING tile
 * goes toward white, because the sheen sprites are composited (normal
 * blend), not added: an additive white at 0.55 lifted a pink tile's dark
 * channel by +140 and the resting tiles hit 248 under the 4X hit (round
 * 53); mixed, the lift is 0.55 of the distance to white and no more.
 */
const SHEEN_PEAK = 0.25;
const NOVA_PEAK = 0.3;
const SHEEN_W = 0.14;
/** Supernova white-hot flash on the tiles: settle time. */
const NOVA_S = 0.25;

export class TileGlow {
  readonly container = new Container();
  private readonly rim: Sprite[] = [];
  private readonly sheen: Sprite[] = [];
  private readonly cols: number;
  private readonly rows: number;
  private readonly texSize: number;
  private readonly haloInner: number;
  private sheenT = -1;
  private novaT = -1;
  private rimOn = false;
  /** The current sweep's axis (diagonal, or top-to-bottom) and peak. */
  private sheenVertical = false;
  private sheenPeak = SHEEN_PEAK;

  constructor(tex: Textures, rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.texSize = tex.size;
    this.haloInner = tex.haloInner;
    this.container.blendMode = 'add';
    for (let i = 0; i < rows * cols; i++) {
      const r = new Sprite(tex.halo);
      r.anchor.set(0.5);
      r.blendMode = 'add';
      r.visible = false;
      this.container.addChild(r);
      this.rim.push(r);
    }
    for (let i = 0; i < rows * cols; i++) {
      const s = new Sprite(tex.flat);
      s.anchor.set(0.5);
      // Composited over the tile (the white 4X pass): alpha IS the fraction
      // toward white. A tinted level sweep switches to additive (a mix toward
      // mint would darken a yellow tile; that pass is light, not a veil).
      s.blendMode = 'normal';
      s.tint = 0xffffff;
      s.visible = false;
      this.container.addChild(s);
      this.sheen.push(s);
    }
  }

  /** Cell i sits at (x, y) with this sprite scale. */
  place(i: number, x: number, y: number, cellPx: number): void {
    const r = this.rim[i];
    const s = this.sheen[i];
    const scale = cellPx / this.texSize;
    if (r) {
      // The halo's inner square matches the tile; its glow spills into the gaps.
      r.position.set(x, y);
      r.scale.set(cellPx / this.haloInner);
    }
    if (s) {
      s.position.set(x, y);
      s.scale.set(scale * 0.94);
    }
  }

  /**
   * Start the sheen sweep, once: diagonal (top-left to bottom-right, white,
   * the 4X language) or, for the level-up, vertical in a cool tint at the
   * given peak (the tile lifts at most that far toward the tint).
   */
  sweep(color = 0xffffff, vertical = false, peak = SHEEN_PEAK): void {
    this.sheenT = 0;
    this.sheenVertical = vertical;
    this.sheenPeak = peak;
    const blend = color === 0xffffff || this.novaT >= 0 ? 'normal' : 'add';
    for (const s of this.sheen) {
      s.tint = color;
      s.blendMode = blend;
    }
  }

  /** Every filled tile lifts toward white (at most ~0.55 with the sheen — a mix, never a sum) and settles over 250 ms. */
  flash(): void {
    this.novaT = 0;
    for (const s of this.sheen) s.blendMode = 'normal';
  }

  /**
   * Per frame. `filled(i)` says whether cell i shows a tile right now;
   * `breathe` is the pill flicker (0..1) so the rim light breathes with it.
   */
  update(
    dt: number,
    heat: number,
    color: number,
    breathe: number,
    rimEnabled: boolean,
    filled: (i: number) => boolean,
  ): void {
    const rimK = rimEnabled ? Math.max(0, (heat - 0.5) / 0.5) : 0;
    const rimA = rimK * (0.5 + 0.35 * breathe) * (0.7 + 0.3 * heat);
    const rimOn = rimA > 0.004;
    if (rimOn || this.rimOn) {
      for (let i = 0; i < this.rim.length; i++) {
        const r = this.rim[i]!;
        const on = rimOn && filled(i);
        r.visible = on;
        if (on) {
          r.alpha = rimA;
          r.tint = color;
        }
      }
    }
    this.rimOn = rimOn;

    if (this.sheenT >= 0) this.sheenT += dt;
    if (this.novaT >= 0) this.novaT += dt;
    const sheenOn = this.sheenT >= 0 && this.sheenT < SHEEN_S;
    const novaOn = this.novaT >= 0 && this.novaT < NOVA_S;
    if (sheenOn || novaOn) {
      // The bar runs across the diagonal from -0.2 to 1.2 so every tile gets a full pass.
      const pos = sheenOn ? -0.2 + (this.sheenT / SHEEN_S) * 1.4 : -10;
      const nova = novaOn ? Math.pow(1 - this.novaT / NOVA_S, 2) * NOVA_PEAK : 0;
      const diagMax = this.rows + this.cols - 2;
      const vertical = this.sheenVertical;
      for (let i = 0; i < this.sheen.length; i++) {
        const s = this.sheen[i]!;
        if (!filled(i)) {
          s.visible = false;
          continue;
        }
        const r = Math.floor(i / this.cols);
        const c = i % this.cols;
        const d = vertical ? r / (this.rows - 1) : (r + c) / diagMax;
        const k = (d - pos) / SHEEN_W;
        const a = Math.exp(-k * k) * this.sheenPeak + nova;
        s.visible = a > 0.004;
        s.alpha = Math.min(1, a);
      }
    } else if (this.sheenT >= SHEEN_S || this.novaT >= NOVA_S) {
      for (const s of this.sheen) s.visible = false;
      if (this.sheenT >= SHEEN_S) {
        this.sheenT = -1;
        // Back to the 4X language for the next diagonal pass.
        this.sheenVertical = false;
        this.sheenPeak = SHEEN_PEAK;
        for (const s of this.sheen) {
          s.tint = 0xffffff;
          s.blendMode = 'normal';
        }
      }
      if (this.novaT >= NOVA_S) this.novaT = -1;
    }
  }
}
