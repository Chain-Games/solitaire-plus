import {
  Assets,
  ColorMatrixFilter,
  Container,
  Geometry,
  Graphics,
  Mesh,
  Shader,
  Sprite,
  type Texture,
} from 'pixi.js';
import { assetUrl } from '../assets.js';
import type { QualitySettings } from './quality.js';
import { PALETTE } from './palette.js';
import type { Textures } from './textures.js';

/**
 * The world: a painted environment in depth layers behind the board, picked
 * from the seed (world-table.ts) and lit by the game clock (docs/worlds.md).
 *
 * The scene owns four containers, one per camera plane, that the playfield
 * parents where they belong:
 *
 *   back   planeBack  (-1)     sky (gradient-tinted mesh) or flat, the sun
 *   far    planeFar   (-0.9)   far.webp with the sun's warm multiply on it
 *   mid    planeMotes (-0.75)  mid.webp, mid-lit.webp (the `lanterns` event)
 *   near   planeFloor (-0.5)   near.webp, then the READABILITY SCRIM
 *
 * Everything is allocated on load (once per world) and `update()` only sets
 * transforms, tints and alphas. Determinism: which world = f(seed) (the
 * caller), time of day = f(game clock) (`setTime`), events = f(sim events)
 * (`trigger`); the only wall-time dependence is the load itself, which the
 * playfield awaits before the first frame so a recording sees the same
 * cross-fade on the same frames.
 *
 * Tiers (`worldLayers`): 4 = sky/far/mid/near with parallax, 2 = flat + near,
 * 1 = flat only, no parallax (the low tier). `worldScrim` is the darkening
 * behind the plate; the sub-pixel soften outside the table column lives in post.ts.
 */

/** Manifest written by tools/worldgen/process.ts. */
export interface WorldManifest {
  id: string;
  name: string;
  /**
   * `clock` (the default): time of day sweeps the sky stops, the sun's arc,
   * the far layer's warm multiply and the ambient over the game clock.
   * `fixed`: the painting carries its own light (a baked sunset, a night
   * sky) and is shown as painted — no regrade, no arc, no ambient sweep;
   * only the exposure, the scrim and the events apply, and `sun.fixed` is
   * the sunburst's source. `painted-noon` (the default for clock worlds —
   * every painting so far carries its own daylight): the clock sweeps, but
   * the procedural disc only shows low on the horizon at dawn and dusk;
   * above elevation 0.6 the painting's own light is the sun and only the
   * warm multiply follows the arc.
   */
  light?: 'clock' | 'painted-noon' | 'fixed';
  focal: { x: number; y: number; portrait?: PortraitWindow };
  /**
   * Per-layer portrait windows (each defaults to `focal.portrait`): `far`
   * frames the landmark for the band above the HUD (mid shares it — the
   * horizon must line up — and the 16:9 fit, the sun and the lanterns follow
   * it); `near` frames the foreground band on its own, so a phone gets both
   * the landmark up top and rail / rocks at the bottom.
   */
  portrait?: { far?: PortraitWindow; mid?: PortraitWindow; near?: PortraitWindow };
  sun: { riseX: number; setX: number; colour: string; fixed?: { x: number; y: number } };
  sky: {
    dawn: [string, string];
    noon: [string, string];
    dusk: [string, string];
    night: [string, string];
  };
  particles: { kind: ParticleKind; rate: number; tint: string };
  events: {
    streak3?: WorldEvent;
    streak4?: WorldEvent;
    multiline?: WorldEvent;
    /** Every fifth level (no manifest maps it yet: a no-op until one does). */
    levelUp?: WorldEvent;
  };
  /** Layer tints at the ends of the day and at noon; `desaturate` (0..1) pulls far / mid toward grey. */
  ambient: { cool: string; warm: string; desaturate?: number };
  /**
   * Room-soften factor for this world (0..1, default 1): the pipeline emits
   * 1 - (near objects' area / frame area) so a world framed by whole trees
   * or palms keeps its leaf edges while one framed by a rail stays soft.
   */
  nearSoften?: number;
  /** Lantern emitters for the `lanterns` event, 0..1 of the frame (drawn procedurally, three sprites each). */
  lanterns?: { x: number; y: number }[];
  frame: { w: number; h: number };
  /** The 9:16 companion frame, when any of the `*Portrait` layers exist. */
  portraitFrame?: { w: number; h: number };
  sizes: number[];
  overscan: number;
  layers: Partial<Record<LayerKey, { rect: [number, number, number, number]; alpha: boolean }>>;
}

/** A portrait framing: object-position focal (0..1) and a zoom past cover. */
export interface PortraitWindow {
  x: number;
  y: number;
  zoom?: number;
}

export type ParticleKind = 'petal' | 'snow' | 'ember' | 'firefly' | 'none';
export type WorldEvent = 'lanterns' | 'sunburst' | 'gust';
export type WorldTrigger = 'streak3' | 'streak4' | 'multiline' | 'levelUp';
type LayerKey =
  | 'sky'
  | 'far'
  | 'mid'
  | 'near'
  | 'flat'
  | 'midLit'
  | 'nearPortrait'
  | 'midPortrait'
  | 'farPortrait'
  | 'skyPortrait';
const LAYER_FILE: Record<LayerKey, string> = {
  sky: 'sky',
  far: 'far',
  mid: 'mid',
  near: 'near',
  flat: 'flat',
  midLit: 'mid-lit',
  nearPortrait: 'near-portrait',
  midPortrait: 'mid-portrait',
  farPortrait: 'far-portrait',
  skyPortrait: 'sky-portrait',
};
/** The 9:16 companions: cut from the master layers for portrait screens, framing baked in. */
const PORTRAIT_KEYS: readonly LayerKey[] = [
  'nearPortrait',
  'midPortrait',
  'farPortrait',
  'skyPortrait',
];

/** Seconds for the world to cross-fade in once its textures are there (inside the countdown). */
const REVEAL_S = 1.2;
/** The sun's arc: peak height above the horizon as a fraction of the frame height. */
const SUN_ARC = 0.26;
/** Sun glow radius as a fraction of the frame height (the spotlight texture's soft disc). */
const SUN_RADIUS = 0.42;
/** The warm multiply the sun lays on the far layer: radius (frame heights) and strength. */
const SUN_WARM_RADIUS = 0.9;
const SUN_WARM_K = 0.55;
/** How far the layers' ambient tint goes toward the manifest's cool/warm colour. */
const AMBIENT_K = 0.5;
/**
 * The world's exposure: paintings arrive at full brightness and the board
 * must stay the brightest object on screen, so every layer (the sky's stops
 * included) runs at this fraction of the painted value.
 */
const WORLD_EXPOSURE = 0.8;
/** `sunburst`: the sun flares this much, for this long. */
const SUNBURST_GAIN = 1.8;
const SUNBURST_S = 0.5;
/**
 * The dawn sweep (GO): one band of the sun's light, this fraction of the
 * frame wide, crossing the far layer from the sun's rising side in this
 * long at this peak alpha (additive, feathered — the sweep frame's core).
 */
const DAWN_SWEEP_S = 0.45;
const DAWN_SWEEP_W = 0.28;
const DAWN_SWEEP_ALPHA = 0.55;
/** `lanterns`: the emissive layer's fade in/out; they stay while heat >= 0.5 (3X eases up to 0.5, so with a tolerance). */
const LANTERN_S = 0.6;
const LANTERN_HEAT = 0.5;
/** The scrim's feather beyond the plate: sideways and vertically, in cells (post.ts's room feather is the vertical one). */
const SCRIM_FEATHER_X_CELLS = 4;
const SCRIM_FEATHER_Y_CELLS = 2.4;
/** The text band's end fade, inside the plate's width, in cells. */
const TEXT_BAND_END_CELLS = 0.5;
/**
 * The radial pool under the scrim: a whole-frame darkening falling off from
 * the column (2.4 x its size, so it reaches the frame's edges) that gives
 * the eye no flat reference against which the feather's start could read as
 * a straight edge.
 */
const SCRIM_POOL_ALPHA = 0.42;
const SCRIM_POOL_RADIUS = 2.4;
/** The local text band under the HUD numerals: its peak alpha at the baseline. */
const TEXT_BAND_ALPHA = 0.3;
/** The sun disc: radius as a fraction of the frame height; its near glow's alpha. */
const SUN_DISC_R = 0.02;
const SUN_NEAR_ALPHA = 0.32;
/** The wide glow never exceeds this alpha (a painted daylight sky blows out above it). */
const SUN_GLOW_MAX = 0.3;
/** `painted-noon`: the disc fades out between these elevations. */
const PAINTED_DISC_FADE = [0.4, 0.6] as const;
/** The ground multiply on far / mid / near: this at dawn and dusk, 1 at noon. */
const GROUND_END = 0.7;
/** Warm bias of the ground at dusk, cool bias at dawn (multiplied in with the ground). */
const GROUND_DUSK = { r: 1, g: 0.9, b: 0.8 };
const GROUND_DAWN = { r: 0.96, g: 0.95, b: 1 };
/** The sky grade sweeps only this part of dawn..dusk over the clock (the ends were too extreme). */
const SWEEP = [0.2, 0.8] as const;
/** Dawn / dusk defaults blended in when a world's own stops are too alike (pink-cool / orange-warm). */
const DAWN_DEFAULT: [string, string] = ['#4c3c96', '#ffa8c8'];
const DUSK_DEFAULT: [string, string] = ['#5c2a3c', '#ff7a2a'];
const STOP_BIAS = 0.8;
/** Dawn and dusk closer than this (RGB units, 0..255) count as "the same stop" and get the defaults. */
const STOPS_ALIKE = 12;
/** The soft lift of the sky around the sun: radius (frame heights) and alpha. */
const SUN_LIFT_R = 0.25;
const SUN_LIFT_ALPHA = 0.18;
/** The sun's disc centre stays at least this far (frame widths) outside the table column. */
const SUN_COLUMN_MARGIN = 0.05;
/** A painted (fixed) sun slides a little further, so its halo clears more of the plate's feather. */
const SUN_FIXED_EXTRA = 0.02;
/** Lantern sprite radii in master-frame px (scaled with the fit) and alphas: core, halo, glow. */
const LANTERN_R = [5, 5, 14, 40] as const;
const LANTERN_A = [1, 1, 0.7, 0.25] as const;
const LANTERN_N = LANTERN_R.length;
/** `lanterns` flicker: 1.5 Hz, +-10%. */
const LANTERN_FLICKER_HZ = 1.5;
const LANTERN_FLICKER = 0.1;
/** The 1280 variant is used when a layer would draw at or under this many device px wide. */
const SMALL_MAX_PX = 1400;
/**
 * The 2560 master is used up to this many device px wide; over it (a retina
 * desktop: 1808x1050 CSS at dpr 2 plus the parallax overscan is ~3760) the
 * 3840 tier, where the world ships one (docs/worlds.md, Sizes). Below the
 * master's width a layer is downsampled and reads crisp; a master stretched
 * 1.4x is a 2.2x upscale of the painting it was cut from and reads soft.
 */
const MID_MAX_PX = 2400;

const SKY_VERT = /* glsl */ `
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

/**
 * The sky: the painted noon sky multiplied by the time-of-day gradient,
 * expressed as the ratio of the current stops to the noon stops so at noon
 * the painting is untouched and at dawn the top goes deep and the horizon
 * warm. `uColor` is the mesh's own colour/alpha (Pixi's local uniforms), so
 * the cross-fade reaches this mesh too.
 */
const SKY_FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uNoonTop;
uniform vec3 uNoonBottom;
// x: how close to noon (1 = the painting as is), y: sun x in layer UV, z: exposure, w: sun-side warmth
uniform vec4 uDay;
uniform vec4 uColor;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec3 tex = texture(uTexture, vUV).rgb;
  float v = smoothstep(0.0, 1.0, vUV.y);
  vec3 stop = mix(uTop, uBottom, v);
  vec3 noon = mix(uNoonTop, uNoonBottom, v);
  // Hue-preserving grade: away from noon the sky takes the STOP's colour,
  // modulated by the painting's luminance (clouds stay clouds), instead of
  // a per-channel product that drifts a blue sky through magenta.
  vec3 graded = stop * (luma(tex) / max(0.05, luma(noon)));
  // The horizon glow leans toward the sun's side of the frame.
  float side = 1.0 - clamp(abs(vUV.x - uDay.y) * 1.6, 0.0, 1.0);
  graded *= 1.0 + uDay.w * side * v;
  vec3 col = mix(graded, tex, uDay.x) * uDay.z;
  finalColor = vec4(clamp(col, 0.0, 1.0) * uColor.a, uColor.a);
}
`;

/**
 * The scrim as one quad per part with the feather computed per fragment —
 * no stacked bands, so no stripes on a bright sky. Mode 0 (the column):
 * alpha = uAlpha x (1 - smoothstep of the exterior distance to the rect in
 * feather units, elliptical at the corners). Mode 1 (the text band): alpha
 * = uAlpha x a vertical profile peaking at the baseline (rising over
 * `above`, falling over `below`) x an end fade INSIDE the rect's width.
 * `uColor` is Pixi's mesh colour/alpha (the cross-fade).
 */
const SCRIM_FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;

uniform vec2 uSize;      // quad size in px
uniform vec4 uRect;      // x0 y0 x1 y1 in quad px
uniform vec2 uFeather;   // column: feather px (x, y); band: (above, below) px
uniform float uAlpha;
uniform vec3 uTint;
uniform float uMode;     // 0 column, 1 band, 2 pool
uniform vec2 uBand;      // band: baseline y (quad px), end fade px
uniform vec4 uColor;

void main() {
  vec2 p = vUV * uSize;
  float a;
  if (uMode < 0.5) {
    vec2 c = (uRect.xy + uRect.zw) * 0.5;
    vec2 hs = (uRect.zw - uRect.xy) * 0.5;
    vec2 q = (abs(p - c) - hs) / uFeather;
    float d = length(max(q, 0.0));
    a = uAlpha * (1.0 - smoothstep(0.0, 1.0, d));
  } else if (uMode > 1.5) {
    // The pool: an elliptical falloff, quadratic-soft like the spotlight texture but analytic.
    vec2 c = (uRect.xy + uRect.zw) * 0.5;
    vec2 hs = (uRect.zw - uRect.xy) * 0.5;
    float d = length((p - c) / hs);
    float k = 1.0 - smoothstep(0.0, 1.0, d);
    a = uAlpha * k * k;
  } else {
    float v = p.y <= uBand.x
      ? smoothstep(0.0, 1.0, 1.0 - (uBand.x - p.y) / uFeather.x)
      : smoothstep(0.0, 1.0, 1.0 - (p.y - uBand.x) / uFeather.y);
    float h = smoothstep(0.0, 1.0, min(p.x - uRect.x, uRect.z - p.x) / uBand.y);
    a = uAlpha * v * h;
  }
  a *= uColor.a;
  finalColor = vec4(uTint * a, a);
}
`;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexRgb(hex: string): Rgb {
  const v = parseInt(hex.replace('#', ''), 16);
  return { r: ((v >> 16) & 0xff) / 255, g: ((v >> 8) & 0xff) / 255, b: (v & 0xff) / 255 };
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

function rgbInt(c: Rgb): number {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (q(c.r) << 16) | (q(c.g) << 8) | q(c.b);
}

function smooth(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/** A placed layer: the sprite (or mesh) and its rect inside the frame. */
interface Layer {
  node: Sprite | Mesh<Geometry, Shader>;
  rect: [number, number, number, number];
}

export class WorldScene {
  readonly back = new Container();
  readonly far = new Container();
  readonly mid = new Container();
  readonly near = new Container();

  manifest: WorldManifest | null = null;
  private loaded = false;
  private revealed = false;
  private fade = 0;
  private wantLayers = 4;
  private loadedLayers = 0;
  private scrimK = 0.5;

  private readonly sunGlow: Sprite;
  private readonly sunWarm: Sprite;
  /** The sun's visible source between far and mid: a hard disc and a tight glow (fix: the flare needs an origin). */
  private readonly sunDisc = new Graphics();
  private readonly sunNear: Sprite;
  private readonly sunLift: Sprite;
  /** The dawn sweep's band on the far layer and its clock (-1 idle). */
  private readonly dawnBand: Sprite;
  private dawnT = -1;
  /** Lanterns: three additive sprites each (core, halo, glow), a phase per lantern. */
  private readonly lanternSprites: Sprite[] = [];
  private readonly lanternPhase: number[] = [];
  private readonly lanternPos: { x: number; y: number }[] = [];
  private readonly lanternRoot = new Container();
  private readonly glowTex: Texture;
  /** Effective dawn / dusk stops (the manifest's, or biased apart when too alike). */
  private dawnStops: [Rgb, Rgb] = [
    { r: 0, g: 0, b: 0 },
    { r: 0, g: 0, b: 0 },
  ];
  private duskStops: [Rgb, Rgb] = [
    { r: 0, g: 0, b: 0 },
    { r: 0, g: 0, b: 0 },
  ];
  /** Room-soften factor for this world (note 6). */
  softenK = 1;
  /** Whether the sky grade sweeps the whole dawn..dusk (a manifest with distinct stops) or SWEEP. */
  private fullSweep = false;
  private readonly scrim = new Container();
  private scrimColumn: Mesh<Geometry, Shader> | null = null;
  private scrimBand: Mesh<Geometry, Shader> | null = null;
  private scrimPoolMesh: Mesh<Geometry, Shader> | null = null;
  private readonly scrimPool: Sprite;
  private timeSec = 0;
  private skyMesh: Mesh<Geometry, Shader> | null = null;
  private skyShader: Shader | null = null;
  private readonly layers = new Map<LayerKey, Layer>();
  private readonly textures: Texture[] = [];

  /** Frame placement from the last layout (canvas px, before the camera). */
  private fit = { ox: 0, oy: 0, scale: 1, w: 1, h: 1, margin: 0 };
  private time = 0;
  private sunburstT = -1;
  private lanternA = 0;
  private lanternOn = false;
  /** Seconds since the lanterns were lit (the heat eases up to 0.5 after the trigger). */
  private lanternT = 0;

  /** Sun colour as 0..1 rgb, for the god rays. */
  sunColour: readonly [number, number, number] = [1, 0.85, 0.63];
  /** Sun centre in canvas px (the far plane's local space). */
  sunX = 0;
  sunY = 0;

  constructor(tex: Textures) {
    this.sunGlow = new Sprite(tex.spotlight);
    this.sunGlow.anchor.set(0.5);
    this.sunGlow.blendMode = 'add';
    this.sunGlow.visible = false;
    this.sunWarm = new Sprite(tex.spotlight);
    this.sunWarm.anchor.set(0.5);
    this.sunWarm.blendMode = 'multiply';
    this.sunWarm.visible = false;
    this.sunNear = new Sprite(tex.spotlight);
    this.sunNear.anchor.set(0.5);
    this.sunNear.blendMode = 'add';
    this.sunNear.visible = false;
    this.sunLift = new Sprite(tex.spotlight);
    this.sunLift.anchor.set(0.5);
    this.sunLift.blendMode = 'add';
    this.sunLift.visible = false;
    // A soft wash (the 40-band spotlight, stretched tall): a bar with a hard
    // core across a painting is a beam, not a dawn.
    this.dawnBand = new Sprite(tex.spotlight);
    this.dawnBand.anchor.set(0.5);
    this.dawnBand.blendMode = 'add';
    this.dawnBand.visible = false;
    this.sunDisc.visible = false;
    this.glowTex = tex.glow;
    this.lanternRoot.visible = false;
    this.scrimPool = new Sprite(tex.spotlight);
    this.scrimPool.anchor.set(0.5);
    this.scrimPool.tint = PALETTE.bgDeep;
    this.scrimPool.visible = false;
    this.scrim.visible = false;
    this.back.visible = false;
    this.far.visible = false;
    this.mid.visible = false;
    this.near.visible = false;
  }

  /** Tier numbers; safe before and after load. A layer-count change needs a reload. */
  setQuality(q: QualitySettings): void {
    this.wantLayers = q.worldLayers;
    this.scrimK = q.worldScrim;
    if (this.loaded) this.layoutScrim(this.lastPlate);
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Layer count the loaded textures were built for (0 = nothing loaded). */
  get layerCount(): number {
    return this.loadedLayers;
  }

  /** The cross-fade, 0 (backdrop only) .. 1 (the world). */
  get opacity(): number {
    return this.loaded ? smooth(this.fade) : 0;
  }

  /**
   * Load a world's manifest and textures (lazily, once per world) and build
   * its layers. Resolves when the textures are on the GPU; rejects if the
   * manifest is missing (the caller keeps the procedural backdrop).
   */
  async load(id: string, base: string, devicePx: number, portrait = false): Promise<void> {
    const dir = `worlds/${id}/`;
    const res = await fetch(assetUrl(`${dir}world.json`, base));
    if (!res.ok) throw new Error(`world ${id}: ${res.status}`);
    const m = (await res.json()) as WorldManifest;
    const zoom = portrait ? ((m.portrait?.far ?? m.focal.portrait)?.zoom ?? 1) : 1;
    // The master (the frame's width) is the unsuffixed file; the 1280 variant
    // and the 3840 tier carry their width. The 3840 tier is a desktop thing:
    // a portrait screen never takes it (its companions already draw ~1:1,
    // and a 16:9 layer it falls back to is not worth the phone's bytes).
    const master = m.frame.w;
    const size = pickSize(m.sizes, devicePx * zoom, portrait ? master : Infinity);
    const suffix = size === master ? '' : `.${size}`;
    // Portrait screens take the 9:16 companions for every layer the world
    // ships them for: their framing is baked in (no zoom), and their variant
    // is picked by the width the companion frame covers on this screen.
    // `devicePx` is the 16:9 frame's covering width (set by the height on a
    // phone); the companion covers pf.w/pf.h of that height, and its sizes
    // are named by the master widths they were halved from, so the covering
    // width is expressed in master-width units: x (fh / pf.h). The companions
    // are never shipped above the master's width.
    const pf = m.portraitFrame ?? m.frame;
    const pDevicePx = devicePx * (m.frame.h / pf.h);
    const pSize = pickSize(m.sizes, pDevicePx, master);
    const pSuffix = pSize === master ? '' : `.${pSize}`;
    const nearKey: LayerKey = portrait && m.layers.nearPortrait ? 'nearPortrait' : 'near';
    const midKey: LayerKey = portrait && m.layers.midPortrait ? 'midPortrait' : 'mid';
    const farKey: LayerKey = portrait && m.layers.farPortrait ? 'farPortrait' : 'far';
    const skyKey: LayerKey = portrait && m.layers.skyPortrait ? 'skyPortrait' : 'sky';
    const want: LayerKey[] =
      this.wantLayers >= 4
        ? [skyKey, farKey, midKey, nearKey]
        : this.wantLayers >= 2
          ? ['flat', nearKey]
          : ['flat'];
    if (this.wantLayers >= 4 && m.layers.midLit) want.push('midLit');
    // `flat` skips the master: the low tier draws one plate at 1280, or at
    // the 3840 tier on a retina desktop when the world ships it.
    const flatSuffix = `.${size > master ? size : Math.min(...m.sizes)}`;
    const files = want.map((k) =>
      assetUrl(
        `${dir}${LAYER_FILE[k]}${k === 'flat' ? flatSuffix : PORTRAIT_KEYS.includes(k) ? pSuffix : suffix}.webp`,
        base,
      ),
    );
    const loaded = (await Assets.load<Texture>(files)) as Record<string, Texture>;
    this.manifest = m;
    this.dawnStops = biasedStops(m.sky.dawn, m.sky.dusk, DAWN_DEFAULT);
    this.duskStops = biasedStops(m.sky.dusk, m.sky.dawn, DUSK_DEFAULT);
    // A manifest with its own distinct dawn and dusk is used verbatim, over
    // the full sweep; the narrowed sweep only tames the defaults.
    this.fullSweep = stopsDistance(m.sky.dawn, m.sky.dusk) >= STOPS_ALIKE;
    this.sunColour = (() => {
      const c = hexRgb(m.sun.colour);
      return [c.r, c.g, c.b] as const;
    })();

    for (let i = 0; i < want.length; i++) {
      const key = want[i]!;
      const texture = loaded[files[i]!];
      const info = m.layers[key];
      if (!texture || !info) continue;
      texture.source.style.addressMode = 'clamp-to-edge';
      this.textures.push(texture);
      if (key === 'sky' || key === 'skyPortrait') {
        const geometry = new Geometry({
          attributes: { aPosition: [0, 0, 1, 0, 1, 1, 0, 1], aUV: [0, 0, 1, 0, 1, 1, 0, 1] },
          indexBuffer: [0, 1, 2, 0, 2, 3],
        });
        this.skyShader = Shader.from({
          gl: { vertex: SKY_VERT, fragment: SKY_FRAG, name: 'blockari-world-sky' },
          resources: {
            uTexture: texture.source,
            skyUniforms: {
              uTop: { value: [1, 1, 1], type: 'vec3<f32>' },
              uBottom: { value: [1, 1, 1], type: 'vec3<f32>' },
              uNoonTop: { value: [1, 1, 1], type: 'vec3<f32>' },
              uNoonBottom: { value: [1, 1, 1], type: 'vec3<f32>' },
              uDay: { value: [1, 0.5, WORLD_EXPOSURE, 0], type: 'vec4<f32>' },
            },
          },
        });
        this.skyMesh = new Mesh({ geometry, shader: this.skyShader });
        this.back.addChild(this.skyMesh);
        this.layers.set(key, { node: this.skyMesh, rect: info.rect });
        continue;
      }
      const sprite = new Sprite(texture);
      if (key === 'midLit') {
        sprite.blendMode = 'add';
        sprite.alpha = 0;
      }
      this.layers.set(key, { node: sprite, rect: info.rect });
      switch (key) {
        case 'flat':
          this.back.addChild(sprite);
          break;
        case 'far':
        case 'farPortrait':
          this.far.addChild(sprite);
          break;
        case 'mid':
        case 'midPortrait':
        case 'midLit':
          this.mid.addChild(sprite);
          break;
        case 'near':
        case 'nearPortrait':
          this.near.addChild(sprite);
          break;
      }
    }
    // The sun: over the sky (under the far layer) on the layered tiers, over
    // the flat scene otherwise; its warm multiply lies on the far layer.
    this.sunGlow.tint = rgbInt(hexRgb(m.sun.colour));
    this.sunWarm.tint = rgbInt(hexRgb(m.sun.colour));
    this.back.addChild(this.sunGlow);
    this.sunGlow.visible = true;
    if (this.layers.has('far')) {
      this.far.addChild(this.sunWarm);
      this.sunWarm.visible = true;
    }
    // The dawn sweep rides over whichever container carries the far painting.
    this.dawnBand.tint = rgbInt(hexRgb(m.sun.colour));
    (this.layers.has('far') ? this.far : this.back).addChild(this.dawnBand);
    // The sun's source sits between far and mid (over Fuji, under the pagoda).
    this.sunNear.tint = rgbInt(hexRgb(m.sun.colour));
    this.sunLift.tint = rgbInt(hexRgb(m.sun.colour));
    this.mid.addChildAt(this.sunLift, 0);
    this.mid.addChildAt(this.sunNear, 1);
    this.mid.addChildAt(this.sunDisc, 2);
    this.sunNear.visible = true;
    this.sunLift.visible = true;
    this.sunDisc.visible = true;
    // Lanterns: procedural emitters at the manifest's points, over the mid layer.
    this.lanternPos.length = 0;
    for (const l of m.lanterns ?? []) {
      this.lanternPos.push({ x: l.x, y: l.y });
      this.lanternPhase.push((this.lanternPhase.length * 2.399) % (Math.PI * 2));
      for (let k = 0; k < LANTERN_N; k++) {
        const sp = new Sprite(this.glowTex);
        sp.anchor.set(0.5);
        sp.blendMode = 'add';
        sp.tint = k < 2 ? 0xfff4dc : 0xffb050;
        sp.alpha = 0;
        this.lanternRoot.addChild(sp);
        this.lanternSprites.push(sp);
      }
    }
    // Room soften by the near objects' size: the manifest's factor, else
    // 1 - 2.5 x the near layer's opaque coverage of the frame (a rail ~0.08
    // -> 0.8; whole trees ~0.3 -> 0.3), so leaf edges resolve.
    const nearTex = this.layers.get(nearKey);
    this.softenK =
      m.nearSoften ??
      (nearTex
        ? Math.max(
            0.3,
            Math.min(1, 1 - 2.5 * coverage(nearTex.node as Sprite, m.layers[nearKey]!.rect)),
          )
        : 1);
    // A per-world saturation pull on far / mid (Red Canyon's orange rock vs the tiles).
    const desat = m.ambient.desaturate ?? 0;
    if (desat > 0) {
      const f = new ColorMatrixFilter();
      f.saturate(-desat, false);
      for (const k of ['far', midKey] as const) {
        const l = this.layers.get(k);
        if (l) l.node.filters = [f];
      }
    }
    this.near.addChild(this.scrimPool, this.scrim);
    // Lanterns draw on top of every world layer (a painted lantern may sit
    // in the near layer) and after the scrim, so nothing dims the points.
    if (this.wantLayers >= 4 && this.lanternPos.length > 0) {
      this.near.addChild(this.lanternRoot);
      this.lanternRoot.visible = true;
    }
    this.scrimPool.visible = true;
    this.scrim.visible = true;
    this.loaded = true;
    this.loadedLayers = this.wantLayers;
    this.back.visible = true;
    this.far.visible = true;
    this.mid.visible = true;
    this.near.visible = true;
    this.setAlpha(this.revealed ? smooth(this.fade) : 0);
    if (this.fit.w > 1) this.layout(this.fit.w, this.fit.h, this.fit.margin, this.lastPlate);
  }

  /**
   * Prewarm: the first rendered frame must compile the sky program, so the
   * containers draw at a whisker of alpha for that frame and go back after.
   */
  prewarm(before: boolean): void {
    if (!this.loaded) return;
    this.setAlpha(before ? 0.01 : smooth(this.fade));
  }

  /** Drop the layers and textures (a tier change with another layer count reloads). */
  unload(): void {
    for (const layer of this.layers.values()) {
      layer.node.parent?.removeChild(layer.node);
      layer.node.destroy();
    }
    this.layers.clear();
    this.skyShader?.destroy();
    this.skyShader = null;
    this.skyMesh = null;
    for (const t of this.textures) t.destroy(true);
    this.textures.length = 0;
    for (const n of [
      this.sunGlow,
      this.sunWarm,
      this.sunNear,
      this.sunLift,
      this.sunDisc,
      this.scrimPool,
      this.scrim,
      this.lanternRoot,
    ]) {
      n.parent?.removeChild(n);
      n.visible = false;
    }
    for (const sp of this.lanternSprites) sp.destroy();
    this.lanternSprites.length = 0;
    this.lanternPhase.length = 0;
    this.lanternPos.length = 0;
    this.loaded = false;
    this.loadedLayers = 0;
    this.manifest = null;
  }

  private lastPlate = { x: 0, y: 0, size: 0, cell: 1, hudY: 0, hudBaseline: 0, trayBottom: 0 };

  /**
   * Cover-fit every layer to the viewport plus the overscan margin, centred
   * on the manifest's focal point; lay the scrim over the plate rect.
   */
  layout(
    w: number,
    h: number,
    margin: number,
    plate: {
      x: number;
      y: number;
      size: number;
      cell: number;
      hudY: number;
      hudBaseline: number;
      trayBottom: number;
    },
  ): void {
    this.fit.w = w;
    this.fit.h = h;
    this.fit.margin = margin;
    this.lastPlate = plate;
    const m = this.manifest;
    if (!m) return;
    const W = w + margin * 2;
    const H = h + margin * 2;
    // Portrait: the manifest's portrait focal, with an optional zoom past
    // cover so a landmark can be brought into the top band (a 16:9 layer
    // has no vertical slack on a phone otherwise).
    // The far window (the landmark's) drives the 16:9 fit, the sun and the lanterns.
    const portrait = h > w ? (m.portrait?.far ?? m.focal.portrait ?? null) : null;
    let scale = Math.max(W / m.frame.w, H / m.frame.h) * (portrait?.zoom ?? 1);
    let fw = m.frame.w * scale;
    let fh = m.frame.h * scale;
    // object-position semantics: the overflow is split by the focal point.
    const focal = portrait ?? m.focal;
    let ox = -margin + (W - fw) * focal.x;
    let oy = -margin + (H - fh) * focal.y;
    // Fixed light: the painted sun must clear the table column by the same
    // margin as the procedural one, so the frame slides (zooming just enough
    // to keep covering) until `sun.fixed` sits outside it.
    if (m.light === 'fixed' && m.sun.fixed && plate.size > 0 && h <= w) {
      const f = m.sun.fixed;
      const onRight = f.x >= 0.5;
      let z = 1;
      for (let i = 0; i < 40; i++) {
        const fwz = fw * z;
        const fhz = fh * z;
        const need = (SUN_COLUMN_MARGIN + SUN_FIXED_EXTRA) * fwz;
        const target = onRight ? plate.x + plate.size + need : plate.x - need;
        const want = target - f.x * fwz; // ox that puts the sun on target
        const lo = -margin + (W - fwz); // right edge aligned (max left slide)
        const hi = -margin; // left edge aligned (max right slide)
        const oxz = Math.max(lo, Math.min(hi, onRight ? Math.max(ox, want) : Math.min(ox, want)));
        const sxz = oxz + f.x * fwz;
        if ((onRight && sxz >= target - 0.5) || (!onRight && sxz <= target + 0.5) || z >= 1.4) {
          scale *= z;
          fw = fwz;
          fh = fhz;
          ox = oxz;
          oy = Math.max(-margin + (H - fhz), Math.min(-margin, -margin + (H - fhz) * focal.y));
          break;
        }
        z += 0.01;
      }
    }
    this.fit.ox = ox;
    this.fit.oy = oy;
    this.fit.scale = scale;
    // The 9:16 companions cover-fit on their own frame (no zoom: they are
    // made for this shape); the overflow is split by their own window's focal.
    const pf = m.portraitFrame ?? m.frame;
    const pScale = Math.max(W / pf.w, H / pf.h);
    const pfw = pf.w * pScale;
    const pfh = pf.h * pScale;
    const winFor = (key: LayerKey): PortraitWindow =>
      (key === 'nearPortrait' ? m.portrait?.near : m.portrait?.far) ?? m.focal.portrait ?? m.focal;
    for (const [key, layer] of this.layers) {
      const [rx, ry, rw, rh] = layer.rect;
      const node = layer.node;
      const own = PORTRAIT_KEYS.includes(key);
      const win = winFor(key);
      const pox = -margin + (W - pfw) * win.x;
      const poy = -margin + (H - pfh) * win.y;
      const [X, Y, FW, FH] = own ? [pox, poy, pfw, pfh] : [ox, oy, fw, fh];
      node.position.set(X + rx * FW, Y + ry * FH);
      if (node instanceof Sprite) {
        node.width = rw * FW;
        node.height = rh * FH;
      } else {
        node.scale.set(rw * FW, rh * FH);
      }
    }
    this.sunGlow.scale.set((fh * SUN_RADIUS * 2) / 256);
    this.sunWarm.scale.set((fh * SUN_WARM_RADIUS * 2) / 256);
    this.sunNear.scale.set((fh * SUN_DISC_R * 10.5) / 256);
    this.sunLift.scale.set((fh * SUN_LIFT_R * 2) / 256);
    // Lanterns sit on the mid layer's frame; sizes follow the fit.
    const glowPx = Math.max(1, this.glowTex.width);
    const k = scale / (m.frame.h / 1440);
    for (let i = 0; i < this.lanternPos.length; i++) {
      const l = this.lanternPos[i]!;
      for (let j = 0; j < LANTERN_N; j++) {
        const sp = this.lanternSprites[i * LANTERN_N + j]!;
        sp.position.set(ox + l.x * fw, oy + l.y * fh);
        sp.scale.set((LANTERN_R[j]! * 2 * k) / glowPx);
      }
    }
    this.sunDisc
      .clear()
      .circle(0, 0, fh * SUN_DISC_R)
      .fill({ color: 0xffffff });
    this.layoutScrim(plate);
    this.applyTime();
  }

  /**
   * The readability scrim: a darkening plateau (`worldScrim`) over the table
   * column — the plate rect extended up through the HUD band, so the score
   * and clock always sit on a dark ground whatever the sky does — feathered
   * to nothing over 4 cells sideways and 2.4 cells vertically, as stacked
   * rounded rects whose alphas compound to a smoothstep and whose corners
   * round off as they grow, blended with a radial pool so the halo never
   * reads as a rectangle. Redrawn on layout only.
   */
  private layoutScrim(plate: {
    x: number;
    y: number;
    size: number;
    cell: number;
    hudY: number;
    hudBaseline: number;
    trayBottom: number;
  }): void {
    if (plate.size <= 0) return;
    if (!this.scrimColumn || !this.scrimBand || !this.scrimPoolMesh) {
      this.scrimPoolMesh = scrimMesh(2);
      this.scrimColumn = scrimMesh(0);
      this.scrimBand = scrimMesh(1);
      this.scrim.addChild(this.scrimPoolMesh, this.scrimColumn, this.scrimBand);
      this.scrimPool.visible = false;
    }
    const FX = plate.cell * SCRIM_FEATHER_X_CELLS;
    const FY = plate.cell * SCRIM_FEATHER_Y_CELLS;
    // The column: the plate rect down through the hand trays, darkened by
    // `worldScrim`, feathered over 4 cells sideways and 2.4 vertically from
    // the plate's own edges (elliptical at the corners), per fragment.
    const top = plate.y;
    const bottom = Math.max(plate.y + plate.size, plate.trayBottom);
    {
      const x0 = plate.x - FX;
      const y0 = top - FY;
      const w = plate.size + FX * 2;
      const h = bottom - top + FY * 2;
      this.scrimColumn.position.set(x0, y0);
      this.scrimColumn.scale.set(w, h);
      const u = scrimUniforms(this.scrimColumn);
      u['uSize'] = [w, h];
      u['uRect'] = [FX, FY, FX + plate.size, FY + (bottom - top)];
      u['uFeather'] = [FX, FY];
      u['uAlpha'] = this.scrimK;
    }
    // Above the plate there is NO column: only a local text band under the
    // HUD numerals — the plate's width exactly, TEXT_BAND_ALPHA at the
    // numerals' baseline falling to nothing over 28 px above and 12 px
    // below, its ends fading over half a cell INSIDE that width — so the
    // sky over the board stays the sky (the numerals carry their own stroke).
    {
      const above = 28;
      const below = 12;
      const y0 = plate.hudBaseline - above;
      const h = above + below;
      this.scrimBand.position.set(plate.x, y0);
      this.scrimBand.scale.set(plate.size, h);
      const u = scrimUniforms(this.scrimBand);
      u['uSize'] = [plate.size, h];
      u['uRect'] = [0, 0, plate.size, h];
      u['uFeather'] = [above, below];
      u['uAlpha'] = TEXT_BAND_ALPHA;
      u['uBand'] = [above, plate.cell * TEXT_BAND_END_CELLS];
    }
    // The pool: wide (no lateral flat reference) but no taller than the
    // column, its soft edge ending at the HUD's top so nothing above the
    // text band is darkened.
    const cx = plate.x + plate.size / 2;
    const height = bottom - top;
    const cy = top + height / 2;
    const poolUp = Math.max(1, cy - (plate.hudY - 12));
    const prx = ((plate.size + FX * 2) * SCRIM_POOL_RADIUS) / 2;
    {
      const w = prx * 2;
      const h = poolUp * 2;
      this.scrimPoolMesh.position.set(cx - prx, cy - poolUp);
      this.scrimPoolMesh.scale.set(w, h);
      const u = scrimUniforms(this.scrimPoolMesh);
      u['uSize'] = [w, h];
      u['uRect'] = [0, 0, w, h];
      u['uAlpha'] = SCRIM_POOL_ALPHA * 0.57; // the spotlight texture's centre alpha, matched
    }
  }

  /** Start the cross-fade (called at the countdown; a no-op until the textures are in). */
  reveal(): void {
    this.revealed = true;
  }

  /** Time of day, 0 = dawn, 0.5 = noon, 1 = dusk; > 1 runs into night. */
  setTime(t: number): void {
    this.time = Math.max(0, Math.min(1.35, t));
  }

  /**
   * GO: the dawn breaks — a horizontal sweep of the sun's light across the
   * far layer from its rising side. Returns false when no world is up (the
   * caller pulses the procedural backdrop instead). Reduced motion: a still
   * lift in place of the travel.
   */
  dawnSweep(reduced: boolean): boolean {
    const m = this.manifest;
    if (!this.loaded || !m) return false;
    this.dawnT = 0;
    this.dawnDir = m.sun.riseX <= 0.5 ? 1 : -1;
    this.dawnStill = reduced;
    return true;
  }

  private dawnDir = 1;
  private dawnStill = false;

  /** A sim milestone; returns the world's event for it, if it has one. */
  trigger(kind: WorldTrigger): WorldEvent | null {
    const ev = this.manifest?.events[kind] ?? null;
    if (!ev || !this.loaded) return null;
    if (ev === 'sunburst') this.sunburstT = 0;
    if (ev === 'lanterns') {
      this.lanternOn = true;
      this.lanternT = 0;
    }
    return ev;
  }

  /** Per frame on the presentation clock. `heat` keeps the lanterns lit from LANTERN_HEAT. */
  update(dt: number, heat: number): void {
    if (!this.loaded) return;
    this.timeSec += dt;
    if (this.revealed && this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / REVEAL_S);
      this.setAlpha(smooth(this.fade));
    }
    if (this.sunburstT >= 0) {
      this.sunburstT += dt;
      if (this.sunburstT >= SUNBURST_S) this.sunburstT = -1;
    }
    if (this.dawnT >= 0) {
      this.dawnT += dt;
      const p = Math.min(1, this.dawnT / DAWN_SWEEP_S);
      const f = this.fit;
      const W = f.w + f.margin * 2;
      const bandW = W * DAWN_SWEEP_W;
      const band = this.dawnBand;
      band.visible = true;
      band.scale.set(
        bandW / band.texture.width,
        ((f.h + f.margin * 2) * 1.4) / band.texture.height,
      );
      const x0 = -f.margin - bandW / 2;
      const x1 = W - f.margin + bandW / 2;
      const k = this.dawnStill ? 0.5 : 1 - Math.pow(1 - p, 2);
      band.position.set(this.dawnDir > 0 ? x0 + (x1 - x0) * k : x1 - (x1 - x0) * k, f.h / 2);
      band.alpha = DAWN_SWEEP_ALPHA * Math.sin(p * Math.PI) * this.opacity;
      if (p >= 1) {
        this.dawnT = -1;
        band.visible = false;
      }
    }
    this.lanternT += dt;
    // Off once the heat has fallen under 0.5 — after the ease-in that follows the trigger.
    if (this.lanternOn && heat < LANTERN_HEAT - 0.02 && this.lanternT > LANTERN_S)
      this.lanternOn = false;
    const la = this.lanternOn ? 1 : 0;
    if (this.lanternA !== la) {
      this.lanternA += Math.sign(la - this.lanternA) * Math.min(1, dt / LANTERN_S);
      this.lanternA = Math.max(0, Math.min(1, this.lanternA));
      if (Math.abs(this.lanternA - la) < 0.002) this.lanternA = la;
    }
    this.applyTime();
  }

  private setAlpha(a: number): void {
    this.back.alpha = a;
    this.far.alpha = a;
    this.mid.alpha = a;
    this.near.alpha = a;
  }

  /** Time of day onto the layers: sky stops, sun, warm multiply, ambient. */
  private applyTime(): void {
    const m = this.manifest;
    if (!m) return;
    const t = this.time;
    // Fixed light: the painting as is — the sky at noon-ness 1, no arc, no
    // warm multiply, a white ambient; the sun sprites only carry the 4X flare.
    const fixed = m.light === 'fixed';
    const painted = !fixed && m.light !== 'clock';
    // Sky stops: dawn -> noon -> dusk -> night. The clock sweeps only the
    // middle of the grade (SWEEP), so the ends never reach the full stop.
    const stops = (k: keyof WorldManifest['sky']) => [hexRgb(m.sky[k][0]), hexRgb(m.sky[k][1])];
    const noon = stops('noon');
    const tg = this.fullSweep ? Math.min(1, t) : Math.min(1, t) * (SWEEP[1] - SWEEP[0]) + SWEEP[0];
    let top: Rgb;
    let bottom: Rgb;
    if (t < 0.5) {
      const [a0, a1] = this.dawnStops;
      const u = smooth(tg / 0.5);
      top = mixRgb(a0, noon[0]!, u);
      bottom = mixRgb(a1, noon[1]!, u);
    } else if (t <= 1) {
      const [d0, d1] = this.duskStops;
      const u = smooth((tg - 0.5) / 0.5);
      top = mixRgb(noon[0]!, d0, u);
      bottom = mixRgb(noon[1]!, d1, u);
    } else {
      const [d0, d1] = stops('dusk');
      const [n0, n1] = stops('night');
      const u = smooth((t - 1) / 0.35);
      top = mixRgb(d0!, n0!, u);
      bottom = mixRgb(d1!, n1!, u);
    }
    const day = Math.min(1, t);
    if (this.skyShader) {
      const u = (this.skyShader.resources as { skyUniforms: { uniforms: Record<string, unknown> } })
        .skyUniforms.uniforms;
      const v = (c: Rgb) => [c.r, c.g, c.b];
      u['uTop'] = v(top);
      u['uBottom'] = v(bottom);
      u['uNoonTop'] = v(noon[0]!);
      u['uNoonBottom'] = v(noon[1]!);
      // Noon-ness: 1 at noon (the painting untouched), 0 at dawn / dusk.
      const noonK = fixed ? 1 : smooth(1 - Math.abs(tg - 0.5) / 0.5);
      const sunU = m.sun.riseX + (m.sun.setX - m.sun.riseX) * day;
      u['uDay'] = [noonK, sunU, WORLD_EXPOSURE, 0.35 * (1 - noonK)];
    }
    // The sun along its arc from riseX to setX, dipping below the horizon past dusk.
    const fit = this.fit;
    const fw = m.frame.w * fit.scale;
    const fh = m.frame.h * fit.scale;
    const horizonY = fit.oy + m.focal.y * fh;
    let sx = fit.ox + (m.sun.riseX + (m.sun.setX - m.sun.riseX) * day) * fw;
    // The disc never goes behind the table column: on whichever side the arc
    // lives, its centre stays a margin outside the column (so the sunburst
    // always has a visible origin on any aspect).
    const plate = this.lastPlate;
    if (plate.size > 0 && !fixed) {
      const margin = SUN_COLUMN_MARGIN * fw;
      const onRight = (m.sun.riseX + m.sun.setX) / 2 >= 0.5;
      sx = onRight ? Math.max(sx, plate.x + plate.size + margin) : Math.min(sx, plate.x - margin);
    }
    let elev = Math.sin(Math.PI * day) - (t > 1 ? (t - 1) * 0.6 : 0);
    let sy = horizonY - elev * SUN_ARC * fh;
    if (fixed) {
      // The painted source (a sun disc, the aurora's brightest point): the
      // flare sits on it; nothing else of the arc is drawn.
      const f = m.sun.fixed ?? { x: (m.sun.riseX + m.sun.setX) / 2, y: m.focal.y };
      sx = fit.ox + f.x * fw;
      sy = fit.oy + f.y * fh;
      elev = 1;
    }
    this.sunX = sx;
    this.sunY = sy;
    const flare =
      this.sunburstT >= 0
        ? 1 + (SUNBURST_GAIN - 1) * Math.sin((Math.PI * this.sunburstT) / SUNBURST_S)
        : 1;
    const low = 0.35 + 0.65 * Math.max(0, elev); // dim near the horizon, full at noon
    // Fixed light: only the flare's excess over the resting state is drawn.
    const burst = fixed ? Math.max(0, flare - 1) / (SUNBURST_GAIN - 1) : 1;
    // `painted-noon`: the painting's own daylight is the sun once the arc is
    // high; the procedural source shows only low on the horizon.
    const paintedK = painted
      ? 1 - smooth((elev - PAINTED_DISC_FADE[0]) / (PAINTED_DISC_FADE[1] - PAINTED_DISC_FADE[0]))
      : 1;
    this.sunGlow.position.set(sx, sy);
    this.sunGlow.alpha =
      Math.max(0, Math.min(SUN_GLOW_MAX * flare, (0.55 * low + 0.12) * flare)) *
      burst *
      (painted ? Math.max(paintedK, 0.35) : 1);
    this.sunGlow.scale.set(((fh * SUN_RADIUS * 2) / 256) * (0.9 + 0.1 * flare));
    // The visible source: on the horizon at dawn and dusk (half-set, still
    // an origin for the sunburst), gone only once the arc dips below it.
    const up = fixed
      ? 0
      : smooth((elev + 0.05) / 0.07) * Math.max(paintedK, this.sunburstT >= 0 ? 1 : 0);
    const sunC = hexRgb(m.sun.colour);
    // The disc keeps the manifest's hue (at most 15% toward white when high),
    // drawn normally at 0.85 so it never saturates to a moon.
    // Low on the horizon the disc is the sun's own colour and its near glow
    // triples (the setting sun, not a moon); high it whitens by 15% at most.
    const lowSun = 1 - smooth(Math.max(0, elev) / 0.25);
    this.sunDisc.tint = rgbInt(
      mixRgb(sunC, { r: 1, g: 1, b: 1 }, 0.15 * Math.max(0, elev) * (1 - lowSun)),
    );
    this.sunDisc.position.set(sx, sy);
    this.sunDisc.alpha = up * Math.min(1, 0.85 * flare);
    this.sunDisc.scale.set(0.9 + 0.1 * flare);
    this.sunNear.position.set(sx, sy);
    this.sunNear.alpha = fixed
      ? SUN_NEAR_ALPHA * burst
      : up * SUN_NEAR_ALPHA * flare * (1 + 2 * lowSun);
    this.sunNear.tint = rgbInt(mixRgb(sunC, { r: 1, g: 0.6, b: 0.3 }, 0.4 * lowSun));
    this.sunLift.position.set(sx, sy);
    this.sunLift.alpha = fixed ? SUN_LIFT_ALPHA * burst : up * SUN_LIFT_ALPHA * flare;
    // Lanterns: per-lantern phase, 1.5 Hz +-10%.
    for (let i = 0; i < this.lanternPos.length; i++) {
      const fl =
        this.lanternA *
        (1 +
          LANTERN_FLICKER *
            Math.sin(
              this.timeSec * LANTERN_FLICKER_HZ * Math.PI * 2 + (this.lanternPhase[i] ?? 0),
            ));
      for (let j = 0; j < LANTERN_N; j++)
        this.lanternSprites[i * LANTERN_N + j]!.alpha = LANTERN_A[j]! * fl;
    }
    // Warm multiply on the far layer, following the sun, strongest at the horizon.
    this.sunWarm.position.set(sx, sy + fh * 0.1);
    this.sunWarm.alpha = fixed ? 0 : SUN_WARM_K * (0.6 + 0.4 * (1 - Math.max(0, elev)));
    // Ambient: cool at dawn, warm at noon, WARMER (orange-biased) at dusk —
    // and a ground multiply that drops to GROUND_END at both ends of the day
    // with a warm bias at dusk / cool at dawn, so grass and rock are never
    // noon-lit under a violet sky.
    const warm = hexRgb(m.ambient.warm);
    const duskWarm = {
      r: warm.r * GROUND_DUSK.r,
      g: warm.g * GROUND_DUSK.g,
      b: warm.b * GROUND_DUSK.b,
    };
    const amb =
      t < 0.5
        ? mixRgb(hexRgb(m.ambient.cool), warm, Math.max(0, elev))
        : mixRgb(duskWarm, warm, Math.max(0, elev));
    const amb1 = fixed ? { r: 1, g: 1, b: 1 } : mixRgb({ r: 1, g: 1, b: 1 }, amb, AMBIENT_K);
    const groundK = fixed ? 1 : GROUND_END + (1 - GROUND_END) * Math.max(0, elev);
    const bias = fixed ? { r: 1, g: 1, b: 1 } : t < 0.5 ? GROUND_DAWN : GROUND_DUSK;
    const biasK = 1 - Math.max(0, elev);
    const tint = rgbInt({
      r: amb1.r * WORLD_EXPOSURE * groundK * (1 + (bias.r - 1) * biasK),
      g: amb1.g * WORLD_EXPOSURE * groundK * (1 + (bias.g - 1) * biasK),
      b: amb1.b * WORLD_EXPOSURE * groundK * (1 + (bias.b - 1) * biasK),
    });
    for (const [key, layer] of this.layers) {
      if (key === 'sky' || key === 'midLit') continue;
      (layer.node as Sprite).tint = tint;
    }
    const lit = this.layers.get('midLit');
    if (lit)
      (lit.node as Sprite).alpha =
        this.lanternA *
        (1 + LANTERN_FLICKER * Math.sin(this.timeSec * LANTERN_FLICKER_HZ * Math.PI * 2));
  }

  destroy(): void {
    this.unload();
    this.sunGlow.destroy();
    this.sunWarm.destroy();
    this.sunNear.destroy();
    this.sunLift.destroy();
    this.sunDisc.destroy();
    this.lanternRoot.destroy();
    this.scrimPool.destroy();
    this.scrim.destroy({ children: true });
  }
}

/** A unit-quad mesh running the scrim fragment in the given mode. */
function scrimMesh(mode: 0 | 1 | 2): Mesh<Geometry, Shader> {
  const geometry = new Geometry({
    attributes: { aPosition: [0, 0, 1, 0, 1, 1, 0, 1], aUV: [0, 0, 1, 0, 1, 1, 0, 1] },
    indexBuffer: [0, 1, 2, 0, 2, 3],
  });
  const c = hexRgb(`#${PALETTE.bgDeep.toString(16).padStart(6, '0')}`);
  const shader = Shader.from({
    gl: { vertex: SKY_VERT, fragment: SCRIM_FRAG, name: `blockari-world-scrim-${mode}` },
    resources: {
      scrimUniforms: {
        uSize: { value: [1, 1], type: 'vec2<f32>' },
        uRect: { value: [0, 0, 1, 1], type: 'vec4<f32>' },
        uFeather: { value: [1, 1], type: 'vec2<f32>' },
        uAlpha: { value: 0, type: 'f32' },
        uTint: { value: [c.r, c.g, c.b], type: 'vec3<f32>' },
        uMode: { value: mode, type: 'f32' },
        uBand: { value: [0, 1], type: 'vec2<f32>' },
      },
    },
  });
  return new Mesh({ geometry, shader });
}

function scrimUniforms(mesh: Mesh<Geometry, Shader>): Record<string, unknown> {
  return (mesh.shader!.resources as { scrimUniforms: { uniforms: Record<string, unknown> } })
    .scrimUniforms.uniforms;
}

/** RGB distance in 0..255 units between two stop pairs (top and bottom summed). */
function stopsDistance(a: [string, string], b: [string, string]): number {
  let d = 0;
  for (let i = 0; i < 2; i++) {
    const p = hexRgb(a[i]!);
    const q = hexRgb(b[i]!);
    d += Math.hypot(p.r - q.r, p.g - q.g, p.b - q.b) * 255;
  }
  return d / 2;
}

/**
 * A world's dawn or dusk stops, blended 40% toward the default (pink-cool
 * dawn, orange-warm dusk) when its dawn and dusk are too alike to tell apart.
 */
function biasedStops(
  own: [string, string],
  other: [string, string],
  dflt: [string, string],
): [Rgb, Rgb] {
  const k = stopsDistance(own, other) < STOPS_ALIKE ? STOP_BIAS : 0;
  return [mixRgb(hexRgb(own[0]), hexRgb(dflt[0]), k), mixRgb(hexRgb(own[1]), hexRgb(dflt[1]), k)];
}

/** Opaque fraction of the frame a layer's texture covers (alpha > 50%), read once at 1/8 scale. */
function coverage(sprite: Sprite, rect: [number, number, number, number]): number {
  try {
    const src = sprite.texture.source.resource as CanvasImageSource | undefined;
    if (!src) return 0;
    const w = 128;
    const h = Math.max(1, Math.round((w * rect[3]) / Math.max(1e-3, rect[2])));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 0;
    ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 128) n++;
    return (n / (w * h)) * rect[2] * rect[3];
  } catch {
    return 0;
  }
}

/** How far each shipped width may be stretched before the next one is taken. */
const MAX_PX: Readonly<Record<number, number>> = { 1280: SMALL_MAX_PX, 2560: MID_MAX_PX };

/**
 * The smallest shipped width (at most `maxSize`) that covers `devicePx`:
 * phones and dpr 1 get the 1280 variant, a 1080p-class desktop the 2560
 * master, a retina desktop the 3840 tier.
 */
function pickSize(sizes: number[], devicePx: number, maxSize = Infinity): number {
  const sorted = sizes.filter((s) => s <= maxSize).sort((a, b) => a - b);
  for (const s of sorted) if (devicePx <= (MAX_PX[s] ?? s)) return s;
  return sorted[sorted.length - 1] ?? 2560;
}
