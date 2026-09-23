import { Buffer, BufferUsage, Geometry, Mesh, Shader } from 'pixi.js';
import { easeInOutQuad, easeOutCubic } from './effects.js';
import { PALETTE } from './palette.js';

/**
 * The streak pill's PRESSURE RING: one shader-drawn quad (a child of the pill,
 * so it enters, pulses and scales with it) that draws a stadium track 9 px
 * outside the pill's outline in the game's lit-tube language.
 *
 *   track     a signed-distance rounded rect parameterised by ARC LENGTH, so
 *             the fill drains at constant speed along the track, clockwise
 *             from 12 o'clock, continuously (no quantisation).
 *   tube      the filled part: a 4.5 px tube lit from the top of the screen
 *             (a highlight band 1 px inside its top edge, a shadow along its
 *             bottom, a faint 1 px core line) in a tight halo that tightens
 *             and brightens as the pressure runs out.
 *   groove    the depleted part: a 3 px inset groove in ink with a 1 px
 *             lighter lower lip. Not additive — it is a cut, not a light.
 *   comet     the leading edge: a warm-white core disc with a tapering tail
 *             back along the track, pulsing below 35 %, shedding sparks.
 *   sweep     on a refill: one bright packet runs from the old head to
 *             12 o'clock over the newly filled part, and the head flashes.
 *
 * Every pixel is computed in the pill's local space from the SDF; the
 * anti-aliased edge is measured in device pixels (fwidth), so the ring is the
 * same width on every resolution and through the pill's own scale.
 */

/** Track offset outside the pill's rounded-rect outline, px. */
export const RING_INSET = 9;
/** Tube width, px (device-independent). */
export const RING_W = 4.5;
/** Anti-aliased edge width, device px. */
const RING_AA = 1.25;
/**
 * Tube lighting: the top highlight band (a mix toward warm-white, never an
 * add — the calm amber tube clipped at 251–255 and lost its hue), its centre
 * across the tube (1 = the top edge), the bottom shadow, and the base tube's
 * brightness cap so the core line has headroom.
 */
const TUBE_TOP_LIGHT = 0.22;
const TUBE_TOP_AT = 0.68;
const TUBE_BOTTOM_SHADOW = 0.42;
const TUBE_BASE_MAX = 0.9;
/** The inner core line: alpha and width px (its edge is half the tube's AA so it stays a line). */
const TUBE_CORE_A = 0.75;
const TUBE_CORE_W = 1;
/** Depleted groove: width px, ink alpha, lower lip width px and alpha. */
const GROOVE_W = 3;
const GROOVE_A = 0.48;
const GROOVE_LIP_W = 1;
const GROOVE_LIP_A = 0.14;
/**
 * The comet head: reach px (its glow), a hot core radius px and a gaussian
 * shoulder sigma px (a bead was a flat clipped disc); the tail behind it
 * (fraction of the perimeter, alpha, end width px).
 */
const HEAD_R = 3;
const HEAD_CORE_R = 1.5;
const HEAD_SIGMA = 3;
/** The core's colour cap and the shoulder's peak alpha (0.36 at r = sigma); the pulse scales the shoulder alpha only. */
const HEAD_CORE_COLOR = 0xffeec4;
const HEAD_SHOULDER_A = 0.6;
const PULSE_SHOULDER_GAIN = 0.6;
const TAIL_FRAC = 0.14;
const TAIL_A = 0.6;
const TAIL_W_END = 1;
/** Halo around the filled tube: alpha and gaussian sigma (px), calm → urgent. */
const HALO_A_CALM = 0.25;
const HALO_A_URGENT = 0.45;
const HALO_SIGMA_CALM = 5;
const HALO_SIGMA_URGENT = 3;
/** The halo fades in over this fraction of the perimeter past 12 o'clock, so the gauge's origin is not a hard edge in the sky. */
const HALO_START_FRAC = 0.015;
/** Urgency: the head pulses below this pressure, period calm → empty (the depth is PULSE_SHOULDER_GAIN). */
const URGENT_BELOW = 0.35;
const PULSE_S_CALM = 0.5;
const PULSE_S_EMPTY = 0.25;
/**
 * Refill: the sweep's travel time and packet length (fraction of the
 * perimeter), the wake it leaves (fades over this fraction of the perimeter
 * behind the packet), the packet's core and skirt widths px, the skirt's
 * alpha; the head's warm-white flash.
 */
const SWEEP_S = 0.28;
const SWEEP_LEN = 0.045;
const WAKE_FRAC = 0.25;
const PACKET_CORE_W = 2;
const PACKET_SKIRT_W = 6;
const PACKET_SKIRT_A = 0.6;
/** Along the track: the core's half-length px (it leads), and how far behind it the skirt's centre sits px. */
const PACKET_CORE_LEN = 2;
const PACKET_HALO_LAG = 1;
const HEAD_FLASH_S = 0.08;
/** Refill detection: a target this far above the eased pressure is a refill (matches the old two-frame flash). */
const REFILL_STEP = 0.3;
/** The head fades in over this much of the shown fill below full (the ring rests whole with no head). */
const HEAD_IN_FRAC = 0.01;
/** A refilled ring rests whole (no head, no origin) this long — counted only while the pill can be seen. */
const REST_HOLD_S = 0.4;
/**
 * After the hold the shown fill catches the pressure up over this window
 * (linearly), so the ring never drains faster than ~1.5× nominal; the gap it
 * may carry is capped (a longer cover lands the remainder while unseen).
 */
const CATCHUP_S = 1.5;
const REST_K_MAX = 0.15;
/** A gap beyond the cap (a long cover on the compact HUD) settles over this instead of popping. */
const CATCHUP_SNAP_S = 0.25;
/** Sparks shed from the head while draining: cadence, life, size px, outward drift px, pool. */
const SPARK_EVERY_S = 0.25;
const SPARK_LIFE_S = 0.35;
const SPARK_R_MIN = 1;
const SPARK_R_MAX = 2;
/** Each spark's soft skirt beyond its core (px) and its stretch along the drift. */
const SPARK_SKIRT = 2;
const SPARK_SKIRT_A = 0.35;
const SPARK_STRETCH = 1.8;
const SPARK_DRIFT_MIN = 6;
const SPARK_DRIFT_MAX = 10;
const SPARK_SPREAD_RAD = 0.7;
const SPARK_POOL = 6;
/** Quad margin outside the track: halo reach + spark drift + spark radius. */
const QUAD_MARGIN = RING_W / 2 + HALO_SIGMA_CALM * 3 + SPARK_DRIFT_MAX + SPARK_R_MAX + SPARK_SKIRT;

// `#version 300 es` on both stages: without it Pixi compiles the program as
// ES 1.00 (shimming in/out with defines), where fwidth() does not exist.
const VERT = /* glsl */ `#version 300 es
in vec2 aPosition;
out vec2 vPos;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vPos = aPosition;
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vPos;
out vec4 finalColor;

uniform vec4 uRect;      // hx, hy (the arcs' centre rect half-extents), corner radius, perimeter
uniform float uFill;     // 0..1 filled fraction of the perimeter
uniform vec2 uHead;      // head position, local px
uniform vec3 uTint;
uniform vec3 uWhite;
uniform vec3 uInk;
uniform vec2 uHalo;      // alpha, sigma px
uniform float uPulse;    // 0..1 head pulse
uniform vec2 uSweep;     // packet position (perimeter fraction; < 0 none), alpha
uniform float uHeadFlash;
uniform float uComet;    // 1 = tail on
uniform float uAlpha;
uniform vec4 uMat;       // tube width, aa device px, groove width, head radius
uniform vec4 uLight;     // top light, top band centre, bottom shadow, core alpha
uniform vec4 uGroove;    // groove alpha, lip width, lip alpha, core width
uniform vec4 uTail;      // tail fraction, tail alpha, tail end width, halo start fraction
uniform float uSweepLen; // sweep packet length, perimeter fraction
uniform float uBase;     // base tube brightness cap
uniform float uHeadA;    // head visibility (0 while the ring rests whole)
uniform vec4 uHeadShape; // core radius, shoulder sigma, spark skirt, spark stretch
uniform vec2 uHeadShoulder; // shoulder peak alpha, its pulse gain
uniform vec3 uCore;      // the head core's colour cap
uniform float uWakeLen;  // the refill wake's length, perimeter fraction
uniform vec3 uPacket;    // refill packet: core width, skirt width, skirt alpha
uniform float uSparkSkirtA;
uniform vec2 uPacketLen; // packet core half-length px, skirt lag px
uniform vec2 uSparkDir[${SPARK_POOL}]; // drift direction per spark
uniform vec4 uSparks[${SPARK_POOL}]; // x, y, radius, life 0..1 (>= 1 dead)

const float PI = 3.14159265;
const float HALF_PI = 1.57079633;

float sdRoundRect(vec2 p, vec2 h, float r) {
  vec2 q = abs(p) - h;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Arc length along the track, clockwise from 12 o'clock (y down).
float perimeterS(vec2 p, float hx, float hy, float r) {
  float qa = HALF_PI * r;
  if (abs(p.x) <= hx) {
    if (p.y <= 0.0) return p.x >= 0.0 ? p.x : 4.0 * hx + 4.0 * hy + 4.0 * qa + p.x;
    return hx + 2.0 * qa + 2.0 * hy + (hx - p.x);
  }
  if (abs(p.y) <= hy) {
    return p.x > 0.0 ? hx + qa + (p.y + hy) : 3.0 * hx + 3.0 * qa + 2.0 * hy + (hy - p.y);
  }
  vec2 c = vec2(sign(p.x) * hx, sign(p.y) * hy);
  float a = atan(p.y - c.y, p.x - c.x);
  if (p.x > 0.0 && p.y < 0.0) return hx + (a + HALF_PI) * r;
  if (p.x > 0.0) return hx + qa + 2.0 * hy + a * r;
  if (p.y > 0.0) return 3.0 * hx + 2.0 * qa + 2.0 * hy + (a - HALF_PI) * r;
  return 3.0 * hx + 3.0 * qa + 4.0 * hy + (a + PI) * r;
}

float disc(float dist, float radius, float aa) {
  return 1.0 - smoothstep(radius - aa, radius + aa, dist);
}

void main() {
  vec2 p = vPos;
  vec2 h = uRect.xy;
  float r = uRect.z;
  float per = uRect.w;
  float d = sdRoundRect(p, h, r);
  float aa = fwidth(d) * uMat.y;
  float ad = abs(d);
  float hw = uMat.x * 0.5;
  float f = perimeterS(p, h.x, h.y, r) / per;
  float filled = step(f, uFill);

  // Outward normal of the track (the arcs' centre rect is far inside the tube).
  vec2 toC = p - clamp(p, -h, h);
  float tl = length(toC);
  vec2 n = tl > 0.001 ? toC / tl : vec2(0.0, -1.0);
  // Which side of the track the pixel is on, in screen-y: +1 = below it.
  float side = n.y * sign(d);

  vec3 col = vec3(0.0);
  float a = 0.0;

  // --- groove: the depleted part, an inset cut with a lighter lower lip.
  float gw = uMat.z * 0.5;
  float groove = disc(ad, gw, aa) * (1.0 - filled);
  float lipBand = disc(ad, gw + uGroove.y, aa) - disc(ad, gw, aa);
  float lip = lipBand * smoothstep(0.15, 0.7, side) * (1.0 - filled);
  col += uInk * groove * uGroove.x + uWhite * lip * uGroove.z;
  a += groove * uGroove.x + lip * uGroove.z;

  // --- tube: the filled part, a rounded tube lit from the top of the screen.
  // The filled tube, with a round cap at the origin (12 o'clock) so the
  // gauge starts on a rounded end, not a butt cut.
  float tube = max(disc(ad, hw, aa) * filled, disc(length(p - vec2(0.0, -(h.y + r))), hw, aa));
  float cx = clamp(d / hw, -1.0, 1.0);
  float up = -n.y * cx;
  // A vertical gradient down the tube (full at its top edge, 1 - shadow at
  // its bottom), a touch of roundness, a highlight band mixed toward
  // warm-white 1 px inside the top, and the core line — all under the base
  // cap so the tint keeps its hue instead of clipping.
  float grad = mix(1.0 - uLight.z, 1.0, clamp((up + 1.0) / 1.6, 0.0, 1.0));
  float rnd = uBase * grad * (0.9 + 0.1 * sqrt(max(0.0, 1.0 - cx * cx)));
  float upD = (up - uLight.y) / 0.26; // no pow(): a negative base is undefined in GLSL
  float top = uLight.x * exp(-upD * upD);
  float core = uLight.w * disc(ad, uGroove.w * 0.5, aa * 0.5);
  vec3 tubeCol = mix(uTint * rnd, uWhite, top);
  tubeCol = mix(tubeCol, uWhite, core);
  col = col * (1.0 - tube) + tubeCol * tube;
  a = a * (1.0 - tube) + tube;

  // --- halo: light spilling off the filled tube, tighter and brighter when urgent.
  float spill = max(0.0, ad - hw);
  float halo = uHalo.x * exp(-(spill * spill) / (2.0 * uHalo.y * uHalo.y)) * filled;
  // Soft origin at 12 o'clock while draining (a whole ring has no origin), never on the tube itself.
  float whole = step(0.999, uFill);
  halo *= mix(smoothstep(0.0, uTail.w, f), 1.0, whole) * (1.0 - tube);
  col += uTint * halo;

  // --- comet tail: behind the head along the track, tapering to 1 px.
  float back = uFill - f;
  float t = clamp(back / uTail.x, 0.0, 1.0);
  float tw = mix(uMat.x, uTail.z, t) * 0.5;
  float tail = disc(ad, tw, aa) * (1.0 - t) * step(0.0, back) * filled * uTail.y * uComet;
  tail *= smoothstep(1.0, 0.96, uFill); // at rest (full) the comet has no tail
  // Composited over the tube, not added: the tail brightens toward warm-white without clipping at the head.
  vec3 tailCol = mix(uWhite, uTint, 0.5);
  col = col * (1.0 - tail) + tailCol * tail;
  a = a * (1.0 - tail) + tail;

  // --- refill sweep: one bright packet running to 12 o'clock over the new fill.
  if (uSweep.x >= 0.0) {
    // A 2 px white core in a 6 px skirt in the tube's hue, composited over
    // the tube (never added — the old slab clipped), with a wake fading
    // behind it over uWakeLen of the perimeter.
    // The core LEADS: a tight spot at the head; the skirt's centre sits
    // uPacketLen.y behind it and only the wake trails, so the leading edge
    // reads as the core, not the halo.
    float ds = f - uSweep.x;
    float dsPx = ds * per;
    float lenPx = uSweepLen * per;
    float cl = uPacketLen.x;
    float tight = exp(-(dsPx * dsPx) / (2.0 * cl * cl));
    float lag = dsPx + uPacketLen.y;
    float skirtAlong = lag > 0.0 ? exp(-(lag * lag) / (2.0 * cl * cl)) : exp(-(lag * lag) / (2.0 * lenPx * lenPx));
    float wake = ds < 0.0 ? max(0.0, 1.0 + ds / uWakeLen) : 0.0;
    float kSkirt = max(skirtAlong, wake * 0.75) * uSweep.y * uPacket.z;
    float pskirt = disc(ad, uPacket.y * 0.5, aa) * kSkirt;
    float pcore = disc(ad, uPacket.x * 0.5, aa) * tight * uSweep.y;
    vec3 sk = uTint * uBase;
    col = col * (1.0 - pskirt) + sk * pskirt;
    a = a * (1.0 - pskirt) + pskirt;
    col = col * (1.0 - pcore) + uWhite * pcore;
    a = a * (1.0 - pcore) + pcore;
  }

  // --- head: a warm-white core disc, pulsing when urgent, flashing on a refill.
  float hd = length(p - uHead);
  float sig = uHeadShape.y;
  // A hot core (fixed size and colour) inside a gaussian shoulder whose alpha
  // pulses: light with a core, never a bead. Nothing here is additive but the
  // refill flash, so the head cannot clip at the pulse peak.
  float hcore = disc(hd, uHeadShape.x, aa);
  float shoulderA = min(1.0, uHeadShoulder.x * (1.0 + uHeadShoulder.y * uPulse));
  float shoulder = exp(-(hd * hd) / (2.0 * sig * sig)) * shoulderA;
  float head = max(hcore, shoulder) * uHeadA;
  vec3 headCol = mix(mix(uTint, uWhite, 0.45), uCore, hcore);
  headCol = mix(headCol, uWhite, uHeadFlash);
  col = col * (1.0 - head) + headCol * head;
  a = a * (1.0 - head) + head;
  float hr = uMat.w;
  float flashGlow = exp(-(hd * hd) / (2.0 * hr * hr * 3.0)) * 0.6 * uHeadFlash * uHeadA;
  col += uWhite * flashGlow * (1.0 - head);

  // --- sparks: tiny motes shed from the head, warm-white cooling to the tint.
  for (int i = 0; i < ${SPARK_POOL}; i++) {
    vec4 s = uSparks[i];
    if (s.w >= 1.0) continue;
    // Stretched along its drift: a hot core in a soft skirt.
    vec2 q = p - s.xy;
    vec2 dir = uSparkDir[i];
    float along = dot(q, dir) / uHeadShape.w;
    float across = dot(q, vec2(-dir.y, dir.x));
    float sd = sqrt(along * along + across * across);
    float k = disc(sd, s.z, aa) * (1.0 - s.w * s.w);
    vec3 sc = mix(uWhite, uTint, s.w);
    col = col * (1.0 - k) + sc * k;
    a = a * (1.0 - k) + k;
    // The skirt is composited too: a spark born on the head must not stack light on it.
    float skirt = s.z + uHeadShape.z;
    float ks = exp(-(sd * sd) / (2.0 * skirt * skirt)) * uSparkSkirtA * (1.0 - s.w) * (1.0 - k);
    col = col * (1.0 - ks) + sc * ks;
    a = a * (1.0 - ks) + ks;
  }

  finalColor = vec4(col, min(a, 1.0)) * uAlpha;
}
`;

interface Spark {
  age: number;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  drift: number;
  r: number;
}

function rgb(c: number): [number, number, number] {
  return [((c >> 16) & 0xff) / 255, ((c >> 8) & 0xff) / 255, (c & 0xff) / 255];
}

export class PressureRing {
  readonly mesh: Mesh<Geometry, Shader>;
  private readonly shader: Shader;
  private readonly positions: Buffer;
  private readonly posData = new Float32Array(8);
  private readonly sparkData = new Float32Array(SPARK_POOL * 4);
  private readonly sparkDir = new Float32Array(SPARK_POOL * 2);
  private readonly sparks: Spark[] = [];
  /** Track geometry (px): rx/ry to the track, the arcs' centre half-extents, the corner radius, the perimeter. */
  private hx = 0;
  private hy = 0;
  private r = 1;
  private perimeter = 1;
  private pulsePhase = 0;
  private sparkAcc = 0;
  private sweepT = -1;
  private sweepFrom = 0;
  private headFlashT = -1;
  private lastShown = 1;
  /**
   * The refill choreography: 'drain' (the eased pressure, remapped so the ring
   * empties when the pressure does), 'pending' (a refill happened while the
   * pill was covered — the sweep waits until it is seen), 'sweep' (the head
   * rides back to 12 o'clock), 'hold' (whole, no head, for REST_HOLD_S of
   * uncovered time). catchG is the pressure already gone when the hold ended;
   * the drain starts from a whole ring and closes that gap over CATCHUP_S.
   */
  private phase: 'drain' | 'pending' | 'sweep' | 'hold' = 'hold';
  private holdT = 0;
  private catchG = 0;
  private catchX = 0;
  private catchT = CATCHUP_S;
  /** Tier: motes per SPARK_EVERY_S while draining (the tail is a uniform). */
  private sparkRate = 0;
  private reducedMotion = false;

  constructor() {
    this.positions = new Buffer({
      data: this.posData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const geometry = new Geometry({
      attributes: { aPosition: { buffer: this.positions, format: 'float32x2' } },
      indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
    });
    this.shader = Shader.from({
      gl: { vertex: VERT, fragment: FRAG, name: 'blockari-pressure-ring' },
      resources: {
        ringUniforms: {
          uRect: { value: [1, 0, 1, 1], type: 'vec4<f32>' },
          uFill: { value: 1, type: 'f32' },
          uHead: { value: [0, 0], type: 'vec2<f32>' },
          uTint: { value: rgb(PALETTE.accentWarm), type: 'vec3<f32>' },
          uWhite: { value: rgb(PALETTE.warmWhite), type: 'vec3<f32>' },
          uInk: { value: rgb(PALETTE.bgDeep), type: 'vec3<f32>' },
          uHalo: { value: [HALO_A_CALM, HALO_SIGMA_CALM], type: 'vec2<f32>' },
          uPulse: { value: 0, type: 'f32' },
          uSweep: { value: [-1, 0], type: 'vec2<f32>' },
          uHeadFlash: { value: 0, type: 'f32' },
          uComet: { value: 1, type: 'f32' },
          uAlpha: { value: 1, type: 'f32' },
          uMat: { value: [RING_W, RING_AA, GROOVE_W, HEAD_R], type: 'vec4<f32>' },
          uLight: {
            value: [TUBE_TOP_LIGHT, TUBE_TOP_AT, TUBE_BOTTOM_SHADOW, TUBE_CORE_A],
            type: 'vec4<f32>',
          },
          uGroove: {
            value: [GROOVE_A, GROOVE_LIP_W, GROOVE_LIP_A, TUBE_CORE_W],
            type: 'vec4<f32>',
          },
          uTail: { value: [TAIL_FRAC, TAIL_A, TAIL_W_END, HALO_START_FRAC], type: 'vec4<f32>' },
          uSweepLen: { value: SWEEP_LEN, type: 'f32' },
          uBase: { value: TUBE_BASE_MAX, type: 'f32' },
          uHeadA: { value: 0, type: 'f32' },
          uHeadShape: {
            value: [HEAD_CORE_R, HEAD_SIGMA, SPARK_SKIRT, SPARK_STRETCH],
            type: 'vec4<f32>',
          },
          uSparkDir: { value: this.sparkDir, type: 'vec2<f32>', size: SPARK_POOL },
          uHeadShoulder: { value: [HEAD_SHOULDER_A, PULSE_SHOULDER_GAIN], type: 'vec2<f32>' },
          uCore: { value: rgb(HEAD_CORE_COLOR), type: 'vec3<f32>' },
          uWakeLen: { value: WAKE_FRAC, type: 'f32' },
          uPacket: { value: [PACKET_CORE_W, PACKET_SKIRT_W, PACKET_SKIRT_A], type: 'vec3<f32>' },
          uSparkSkirtA: { value: SPARK_SKIRT_A, type: 'f32' },
          uPacketLen: { value: [PACKET_CORE_LEN, PACKET_HALO_LAG], type: 'vec2<f32>' },
          uSparks: { value: this.sparkData, type: 'vec4<f32>', size: SPARK_POOL },
        },
      },
    });
    this.sparkData.fill(1);
    this.mesh = new Mesh({ geometry, shader: this.shader });
    for (let i = 0; i < SPARK_POOL; i++)
      this.sparks.push({ age: SPARK_LIFE_S, x0: 0, y0: 0, dx: 0, dy: 0, drift: 0, r: 1 });
  }

  private get u(): Record<string, unknown> {
    return (this.shader.resources as { ringUniforms: { uniforms: Record<string, unknown> } })
      .ringUniforms.uniforms;
  }

  /** Tier: sparks per cadence (0 = none) and whether the comet tail is drawn. */
  setQuality(sparkRate: number, comet: boolean, reducedMotion: boolean): void {
    this.sparkRate = sparkRate;
    this.reducedMotion = reducedMotion;
    this.u['uComet'] = comet ? 1 : 0;
    if (sparkRate === 0) this.killSparks();
  }

  /** The pill's size; the track sits RING_INSET outside its stadium outline. */
  layout(pillW: number, pillH: number): void {
    const rx = pillW / 2 + RING_INSET;
    const ry = pillH / 2 + RING_INSET;
    const r = ry;
    this.hx = Math.max(0, rx - r);
    this.hy = Math.max(0, ry - r);
    this.r = r;
    this.perimeter = 4 * this.hx + 4 * this.hy + 2 * Math.PI * r;
    const W = rx + QUAD_MARGIN;
    const H = ry + QUAD_MARGIN;
    const P = this.posData;
    P[0] = -W;
    P[1] = -H;
    P[2] = W;
    P[3] = -H;
    P[4] = W;
    P[5] = H;
    P[6] = -W;
    P[7] = H;
    this.positions.update();
    const rect = this.u['uRect'] as number[];
    rect[0] = this.hx;
    rect[1] = this.hy;
    rect[2] = r;
    rect[3] = this.perimeter;
    this.u['uRect'] = rect;
  }

  /** Reset for a fresh pill (no stale sweep, sparks or pulse). */
  reset(fill: number): void {
    this.sweepT = -1;
    this.headFlashT = -1;
    this.pulsePhase = 0;
    this.sparkAcc = 0;
    this.lastShown = fill;
    this.phase = 'drain';
    this.catchG = 0;
    this.catchX = 0;
    this.catchT = CATCHUP_S;
    this.killSparks();
  }

  private killSparks(): void {
    for (const s of this.sparks) s.age = SPARK_LIFE_S;
    this.sparkData.fill(1);
    this.u['uSparks'] = this.sparkData;
  }

  /** Point on the track and its outward normal at perimeter fraction `f` (clockwise from 12 o'clock). */
  private pointAt(f: number, out: { x: number; y: number; nx: number; ny: number }): void {
    const { hx, hy, r } = this;
    const qa = (Math.PI / 2) * r;
    let s = ((f % 1) + 1) % 1;
    s *= this.perimeter;
    const arc = (cx: number, cy: number, a0: number, along: number) => {
      const a = a0 + along / r;
      out.nx = Math.cos(a);
      out.ny = Math.sin(a);
      out.x = cx + out.nx * r;
      out.y = cy + out.ny * r;
    };
    if (s < hx) {
      out.x = s;
      out.y = -r - hy;
      out.nx = 0;
      out.ny = -1;
      return;
    }
    s -= hx;
    if (s < qa) return arc(hx, -hy, -Math.PI / 2, s);
    s -= qa;
    if (s < 2 * hy) {
      out.x = hx + r;
      out.y = -hy + s;
      out.nx = 1;
      out.ny = 0;
      return;
    }
    s -= 2 * hy;
    if (s < qa) return arc(hx, hy, 0, s);
    s -= qa;
    if (s < 2 * hx) {
      out.x = hx - s;
      out.y = hy + r;
      out.nx = 0;
      out.ny = 1;
      return;
    }
    s -= 2 * hx;
    if (s < qa) return arc(-hx, hy, Math.PI / 2, s);
    s -= qa;
    if (s < 2 * hy) {
      out.x = -hx - r;
      out.y = hy - s;
      out.nx = -1;
      out.ny = 0;
      return;
    }
    s -= 2 * hy;
    if (s < qa) return arc(-hx, -hy, Math.PI, s);
    s -= qa;
    out.x = -hx + s;
    out.y = -r - hy;
    out.nx = 0;
    out.ny = -1;
  }

  private readonly head = { x: 0, y: 0, nx: 0, ny: -1 };

  /**
   * Per frame. `fill` is the eased pressure (0..1), `target` the un-eased
   * pressure the drain is heading for (a jump above the eased value is a
   * refill), `tint` 0xRRGGBB, `covered` true while the pill is hidden (the
   * compact HUD yields it to the banner): a refill then waits, whole, until
   * the pill is seen again.
   */
  update(
    dt: number,
    fill: number,
    target: number,
    tint: number,
    alpha: number,
    covered: boolean,
  ): void {
    const u = this.u;
    // Refill: the sweep leaves from where the head was and the head flashes —
    // once the pill can be seen. Under reduced motion the ring simply lands.
    if (target > fill + REFILL_STEP && this.phase === 'drain') {
      this.sweepFrom = this.lastShown;
      this.phase = this.reducedMotion ? 'hold' : 'pending';
      this.holdT = 0;
    }
    if (this.phase === 'pending' && !covered) {
      this.phase = 'sweep';
      this.sweepT = 0;
      this.headFlashT = 0;
    }
    let shown: number;
    const sw = u['uSweep'] as number[];
    if (this.phase === 'sweep') {
      // The head rides back to 12 o'clock over SWEEP_S, then the ring holds whole.
      this.sweepT += dt;
      const k = Math.min(1, this.sweepT / SWEEP_S);
      // From where the head was seen last — not the eased pressure, which
      // has already caught up when the refill waited under a banner.
      const pos = this.sweepFrom + (1 - this.sweepFrom) * easeInOutQuad(k);
      shown = pos;
      sw[0] = Math.min(0.9999, pos);
      sw[1] = 1 - k;
      if (k >= 1) {
        this.phase = 'hold';
        this.holdT = 0;
      }
    } else if (this.phase === 'hold') {
      // Whole, no head, for REST_HOLD_S of uncovered time; then the drain
      // starts from here and closes the gap to the pressure over CATCHUP_S.
      shown = 1;
      sw[0] = -1;
      sw[1] = 0;
      if (!covered) this.holdT += dt;
      if (this.holdT >= REST_HOLD_S) {
        this.phase = 'drain';
        this.catchG = Math.min(REST_K_MAX, 1 - fill);
        this.catchX = 1 - fill - this.catchG;
        this.catchT = 0;
      }
    } else if (this.phase === 'pending') {
      shown = this.lastShown;
    } else {
      this.catchT = Math.min(CATCHUP_S, this.catchT + dt);
      shown = Math.min(
        1,
        fill +
          this.catchG * (1 - this.catchT / CATCHUP_S) +
          this.catchX * Math.max(0, 1 - this.catchT / CATCHUP_SNAP_S),
      );
    }
    u['uSweep'] = sw;
    shown = Math.min(0.9999, shown);
    this.lastShown = shown;
    u['uFill'] = shown;
    // No head while the ring rests whole; it appears as the drain begins.
    u['uHeadA'] = Math.max(0, Math.min(1, (0.9999 - shown) / HEAD_IN_FRAC));
    this.pointAt(shown, this.head);
    const hp = u['uHead'] as number[];
    hp[0] = this.head.x;
    hp[1] = this.head.y;
    u['uHead'] = hp;
    const c = u['uTint'] as number[];
    const [tr, tg, tb] = rgb(tint);
    c[0] = tr;
    c[1] = tg;
    c[2] = tb;
    u['uTint'] = c;
    // Urgency: the halo tightens and the head pulses faster as the ring empties.
    const urgent = Math.max(0, Math.min(1, (URGENT_BELOW - shown) / URGENT_BELOW));
    const halo = u['uHalo'] as number[];
    halo[0] = HALO_A_CALM + (HALO_A_URGENT - HALO_A_CALM) * urgent;
    halo[1] = HALO_SIGMA_CALM + (HALO_SIGMA_URGENT - HALO_SIGMA_CALM) * urgent;
    u['uHalo'] = halo;
    if (urgent > 0 && !this.reducedMotion) {
      const period = PULSE_S_CALM + (PULSE_S_EMPTY - PULSE_S_CALM) * urgent;
      this.pulsePhase = (this.pulsePhase + dt / period) % 1;
      const s = Math.sin(this.pulsePhase * Math.PI);
      u['uPulse'] = s * s * urgent;
    } else {
      this.pulsePhase = 0;
      u['uPulse'] = 0;
    }
    // The head's warm-white flash on a refill.
    if (this.headFlashT >= 0) {
      this.headFlashT += dt;
      const k = Math.min(1, this.headFlashT / HEAD_FLASH_S);
      u['uHeadFlash'] = 1 - k;
      if (k >= 1) this.headFlashT = -1;
    }
    // Sparks shed from the head while the ring is draining.
    const draining =
      this.phase === 'drain' && shown < 0.999 && this.sparkRate > 0 && !this.reducedMotion;
    if (draining) {
      this.sparkAcc += dt;
      while (this.sparkAcc >= SPARK_EVERY_S) {
        this.sparkAcc -= SPARK_EVERY_S;
        for (let i = 0; i < this.sparkRate; i++) this.spawnSpark();
      }
    } else {
      this.sparkAcc = 0;
    }
    for (let i = 0; i < SPARK_POOL; i++) {
      const s = this.sparks[i]!;
      if (s.age >= SPARK_LIFE_S) continue;
      s.age += dt;
      const k = Math.min(1, s.age / SPARK_LIFE_S);
      const e = easeOutCubic(k);
      this.sparkData[i * 4] = s.x0 + s.dx * s.drift * e;
      this.sparkData[i * 4 + 1] = s.y0 + s.dy * s.drift * e;
      this.sparkData[i * 4 + 2] = s.r;
      this.sparkData[i * 4 + 3] = k;
      this.sparkDir[i * 2] = s.dx;
      this.sparkDir[i * 2 + 1] = s.dy;
    }
    u['uSparks'] = this.sparkData;
    u['uSparkDir'] = this.sparkDir;
    u['uAlpha'] = alpha;
  }

  private spawnSpark(): void {
    const s = this.sparks.find((x) => x.age >= SPARK_LIFE_S);
    if (!s) return;
    const spread = (Math.random() - 0.5) * 2 * SPARK_SPREAD_RAD;
    const a = Math.atan2(this.head.ny, this.head.nx) + spread;
    s.age = 0;
    s.x0 = this.head.x;
    s.y0 = this.head.y;
    s.dx = Math.cos(a);
    s.dy = Math.sin(a);
    s.drift = SPARK_DRIFT_MIN + Math.random() * (SPARK_DRIFT_MAX - SPARK_DRIFT_MIN);
    s.r = SPARK_R_MIN + Math.random() * (SPARK_R_MAX - SPARK_R_MIN);
  }
}
