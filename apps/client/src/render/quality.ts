/**
 * Quality tiers. Every expensive system reads its numbers from here and
 * nowhere else, so "make it prettier" and "make it faster" are the same edit.
 *
 * Targets: ultra holds 1440p144 on a desktop GPU; medium is the 1080p60 floor
 * for laptops and phones; low is a rescue tier with no post-processing.
 */
export type QualityTier = 'ultra' | 'high' | 'medium' | 'low';

export interface QualitySettings {
  /** Background fbm octaves. */
  bgOctaves: number;
  /**
   * Bloom render-target scale relative to the frame: the bright pass renders at
   * `frame * bloomScale` (0.5 = half resolution). 0 disables bloom.
   */
  bloomScale: number;
  /**
   * Dual-Kawase levels below the bright pass. Each level halves the target
   * again, so 3 levels at half res reach 1/16 of the frame; every level is one
   * downsample pass plus one additive upsample pass.
   */
  bloomLevels: number;
  /** Bloom brightness threshold (0..1). */
  bloomThreshold: number;
  /** Bloom intensity added back over the scene. */
  bloomStrength: number;
  /**
   * Anamorphic streak strength. 0 skips the streak passes entirely; it only
   * fires on near-white pixels (clear flash, GO, banner edge, streak set-piece).
   */
  streak: number;
  /**
   * Chromatic aberration in pixels at the screen edge. 0 disables. Kept well
   * under a pixel: on a dpr-1 desktop a 1 px split fringed every edge in the
   * outer band and read as soft focus, not as a lens.
   */
  chroma: number;
  /** Film grain amount (0..1). */
  grain: number;
  /** Vignette darkness (0..1). */
  vignette: number;
  /** Whether the post-processing filter runs at all. */
  post: boolean;
  /**
   * Filmic tonemap strength (0..1): identity through the knee, the ACES fit's
   * shoulder above it, so overshoot rolls off instead of clipping (needs `post`).
   */
  tonemap: number;
  /** Base exposure of the composite; 1 leaves the LDR scene on the identity. */
  exposure: number;
  /** Strength (0..1) of the three-stop streak-heat colour grade (cold / warm / high-key). */
  heatGrade: number;
  /** Eye adaptation after the 4X supernova: exposure dip in EV on the room outside the plate (0 disables). */
  eyeAdapt: number;
  /** Results depth of field: bokeh radius in px at 1080p (0 disables). */
  dof: number;
  /** Particle pool size, allocated once at startup. */
  particleCap: number;
  /** Particles spawned per cleared cell. */
  particlesPerCell: number;
  /**
   * Renderer resolution multiplier cap (devicePixelRatio is clamped to this).
   * Phones are DPR 2–3: anything below native renders the whole game soft and
   * lets the browser upscale it — the owner's iPhone read as blurry at the old
   * cap of 2 (high) / 1.5 (medium). Native everywhere but low.
   */
  maxResolution: number;
  /**
   * Supersampling: the LEAST renderer resolution on a fine-pointer screen. A
   * 1080p monitor is DPR 1 — every tile edge, shadow, spark and glyph drawn
   * at one sample per pixel, three times coarser per inch than a DPR-3
   * phone — so the desktop tiers render at 2x and let the browser filter it
   * down. Effective resolution = clamp(max(dpr, coarse ? dpr : ssaa),
   * maxResolution), then held under RESOLUTION_BUDGET_PX (a 1440p monitor
   * gets the largest factor that fits). Coarse-pointer devices stay at
   * native; see `effectiveResolution` and the governor in playfield.ts.
   */
  ssaa: number;
  /** MSAA on the main render target. See also WORLD_RESOLUTION_CAP below. */
  antialias: boolean;

  // Streak VFX (streak-fx.ts). All of it reads the one heat value and dies with it.
  /**
   * Plate rim while hot: 0 = the tinted stroke plus a chase dot, 1 = a flowing
   * energy band (one noise octave), 2 = the band with a second octave.
   */
  rimBand: 0 | 1 | 2;
  /** Embers per second rising off the tiles at 4X (ramping in from heat 0.3). 0 disables. */
  emberRate: number;
  /** Sparks per second jumping off the rim at 4X. */
  rimSparks: number;
  /** Streak pill pressure ring: motes shed from its head every 0.25 s while draining (0 = none). */
  ringSparks: 0 | 1 | 2;
  /** Whether the ring's comet has its tail (the low tier draws the tube and head only). */
  ringComet: boolean;
  /** Light shards in the 4X streak-increment burst (2X/3X use 6/14 and 10/14 of it). 0 skips the burst. */
  burstShards: number;
  /** Curling light ribbon per cleared line while on a streak (0 or 1). */
  ribbons: number;
  /** Additive rim light on filled tiles from heat 0.5, breathing with the pill. */
  tileRim: boolean;
  /** Diagonal specular sheen crossing every tile once on 4X clears. */
  tileSheen: boolean;
  /** God rays in the post composite on 4X clears (needs `post`). */
  godRays: boolean;
  /** Coins thrown from the score when a challenge is WON on the results (results-scene.ts). 0 skips the burst. */
  outcomeCoins: number;

  // Ghost and secondary motion (ghost-fx.ts, hud-fx.ts). Low keeps the pre-holo behaviour.
  /**
   * Drop preview as a scanned hologram (GLSL: edge glow, scanlines, a 1.1 s
   * sweep, lock-in flash) instead of the flat fill + outline sprites.
   */
  holoGhost: boolean;
  /** Peak alpha of the projection beam from the dragged piece down to its sockets. 0 disables. */
  ghostBeam: number;
  /** Grab lift back-ease strength (overshoot). 0 = instant lift. */
  grabOvershoot: number;
  /** Score as an odometer (digits slide) with squash-and-stretch on hits >= 250. */
  odometer: boolean;
  /** Banner text slams in per letter (18 ms stagger, 6% overshoot). */
  bannerLetters: boolean;
  /**
   * The level-up (level-hud.ts, docs/art-direction.md "Levels"): 0 = the HUD
   * pill as plain text (no ring, no ceremony beyond the number rolling),
   * 1 = the pill with its progress ring, the pop and the LEVEL banner,
   * 2 = the full ceremony — the cool burst from the pill (hairline ring,
   * lobed shards, a mote impulse), the rim pulse travelling the perimeter,
   * the vertical sheen over the tiles, and the fifth-level god rays.
   */
  levelFx: 0 | 1 | 2;
  // The clear and the heat (fracture.ts, post.ts).
  /**
   * Fracture on clear: the most chunks a cleared tile breaks into (4 at 1X, 6
   * from 2X, capped here; never 9 — a ninth of a cell is confetti at 1080p).
   * 0 = the flash-and-dissolve clear only.
   */
  fractureChunks: number;
  /** Chunk sprite pool, allocated once: a 4-line clear (40 tiles) at the chunk cap. */
  fracturePool: number;
  /** Additive copy of every chunk: the facing glint, and the heat colour from heat 0.5. */
  fractureGlow: boolean;
  // Tile material (tile-material.ts).
  /**
   * Filled board tiles as a lit mesh: 0 = the baked sprites, 1 = normal-mapped
   * diffuse + rim light over the painted albedo (no specular), 2 = the flat
   * albedo with a two-lobe Blinn specular that follows the lights.
   */
  tileLight: 0 | 1 | 2;
  /**
   * Contact shadows: AO stamps in the gaps beside filled tiles, the dragged
   * piece's shape-true shadow with a penumbra that grows with lift, and its
   * soft occlusion on the tiles under it.
   */
  contactShadow: boolean;
  // Camera and floor (camera.ts, floor.ts).
  /**
   * Floor reflection under the plate: the board layer is rendered once per
   * frame into a render texture at this fraction of the frame resolution and
   * drawn back flipped, blurred and fading onto the table. 0 disables it.
   */
  reflectionScale: number;
  /** Vertical blur taps for the reflection (odd; 1 = no blur). */
  reflectionTaps: number;
  /**
   * 2.5D parallax: the largest offset in px between the nearest and the
   * reference (tile) plane, driven by the pointer or the phone's tilt. 0 = a
   * fixed camera.
   */
  parallax: number;
  // The world behind the board (world.ts, docs/worlds.md).
  /**
   * Painted world layers: 4 = sky / far / mid / near on their own planes
   * (parallax), 2 = the flattened scene plus the near framing, 1 = the
   * flattened scene only, no parallax (the low tier).
   */
  worldLayers: 4 | 2 | 1;
  /** Darkening of the world behind the plate rect (feathered 2.4 cells out); the readability rule says >= 0.3. */
  worldScrim: number;
  /**
   * World soften: the 13-tap disc radius in px at 1080p read over the room
   * outside the table column (needs `post`; 0 = off) — a sub-pixel settle
   * of the painting, the same right up to the plate. It was 4 / 3 / 2 px in
   * a feather beside the plate, which put the softest pixels on the desktop
   * exactly where the eye rests (docs/art-direction.md, Worlds).
   */
  worldBokehPx: number;

  // In-game feel (playfield.ts "feel" constants; docs/art-direction.md "Feel").
  /**
   * Landing weight: the LIGHT-only pressure ripple across the neighbouring
   * tiles' faces after a piece lands (a brightness / AO modulation radiating
   * two cells over 220 ms; no geometry moves). OFF on every tier since
   * 2026-09-19 — the owner found it too much; the squash, dust and rim flash
   * carry the landing. The code path stays for a lighter return.
   */
  landRipple: boolean;
  /**
   * Line-clear choreography by count: 0 = the base clear (flash, stagger,
   * fracture) on every count; 1 = the directional sweep (one line), the
   * two-tone crossing sweeps (two) and the lift-and-shatter (three+) with no
   * flare core and no light column; 2 = everything.
   */
  clearChoreo: 0 | 1 | 2;
  /** Tray idle float amplitude in mm (2 mm on a 4 s cycle, a shadow breathing with it); 0 = still. */
  trayFloatMm: number;
  /**
   * The 3-2-1-GO: 0 = numerals only; 1 = numerals with their flash cores
   * and the grid lighting row by row on GO; 2 = plus the HUD slide-in and
   * the world's dawn sweep.
   */
  countdownFx: 0 | 1 | 2;
  /**
   * End-of-game slow-mo: the last landing's dust and ripple at 0.25x for
   * 400 ms while the HUD dims and the board desaturates and darkens (the
   * post filter; without it only the dilation and the HUD dim run).
   */
  endSlow: boolean;
}

export const QUALITY: Readonly<Record<QualityTier, QualitySettings>> = {
  ultra: {
    bgOctaves: 5,
    bloomScale: 0.5,
    bloomLevels: 3,
    bloomThreshold: 0.72,
    bloomStrength: 0.85,
    streak: 0.55,
    chroma: 0.4,
    grain: 0.02,
    vignette: 0.45,
    post: true,
    tonemap: 1,
    exposure: 1,
    heatGrade: 1,
    eyeAdapt: 0.3,
    dof: 14,
    particleCap: 800,
    particlesPerCell: 6,
    maxResolution: 3,
    ssaa: 2,
    antialias: true,
    rimBand: 2,
    emberRate: 22,
    rimSparks: 14,
    ringSparks: 2,
    ringComet: true,
    burstShards: 14,
    ribbons: 1,
    tileRim: true,
    tileSheen: true,
    godRays: true,
    outcomeCoins: 18,
    holoGhost: true,
    ghostBeam: 0.12,
    grabOvershoot: 1.7,
    odometer: true,
    bannerLetters: true,
    levelFx: 2,
    fractureChunks: 6,
    fracturePool: 240,
    fractureGlow: true,
    tileLight: 2,
    contactShadow: true,
    reflectionScale: 1,
    reflectionTaps: 7,
    parallax: 6,
    worldLayers: 4,
    worldScrim: 0.5,
    worldBokehPx: 0.4,
    landRipple: false,
    clearChoreo: 2,
    trayFloatMm: 2,
    countdownFx: 2,
    endSlow: true,
  },
  high: {
    bgOctaves: 4,
    bloomScale: 0.5,
    bloomLevels: 3,
    bloomThreshold: 0.74,
    bloomStrength: 0.8,
    streak: 0,
    chroma: 0.3,
    grain: 0.018,
    vignette: 0.45,
    post: true,
    tonemap: 1,
    exposure: 1,
    heatGrade: 1,
    eyeAdapt: 0.3,
    dof: 12,
    particleCap: 500,
    particlesPerCell: 4,
    maxResolution: 3,
    ssaa: 2,
    antialias: true,
    rimBand: 2,
    emberRate: 14,
    rimSparks: 10,
    ringSparks: 2,
    ringComet: true,
    burstShards: 14,
    ribbons: 1,
    tileRim: true,
    tileSheen: true,
    godRays: true,
    outcomeCoins: 14,
    holoGhost: true,
    ghostBeam: 0.12,
    grabOvershoot: 1.7,
    odometer: true,
    bannerLetters: true,
    levelFx: 2,
    fractureChunks: 6,
    fracturePool: 240,
    fractureGlow: true,
    tileLight: 2,
    contactShadow: true,
    reflectionScale: 0.75,
    reflectionTaps: 5,
    parallax: 6,
    worldLayers: 4,
    worldScrim: 0.5,
    worldBokehPx: 0.4,
    landRipple: false,
    clearChoreo: 2,
    trayFloatMm: 2,
    countdownFx: 2,
    endSlow: true,
  },
  medium: {
    bgOctaves: 3,
    bloomScale: 0.5,
    bloomLevels: 2,
    bloomThreshold: 0.76,
    bloomStrength: 0.7,
    streak: 0,
    chroma: 0.2,
    grain: 0.012,
    vignette: 0.4,
    post: true,
    tonemap: 1,
    exposure: 1,
    heatGrade: 1,
    eyeAdapt: 0,
    dof: 8,
    particleCap: 250,
    particlesPerCell: 3,
    maxResolution: 3,
    ssaa: 1,
    antialias: false,
    rimBand: 1,
    emberRate: 6,
    rimSparks: 4,
    ringSparks: 1,
    ringComet: true,
    burstShards: 10,
    ribbons: 1,
    tileRim: true,
    tileSheen: false,
    godRays: false,
    outcomeCoins: 10,
    holoGhost: true,
    ghostBeam: 0.08,
    grabOvershoot: 1.4,
    odometer: true,
    bannerLetters: true,
    levelFx: 1,
    fractureChunks: 6,
    fracturePool: 240,
    fractureGlow: false,
    tileLight: 1,
    contactShadow: true,
    reflectionScale: 0.5,
    reflectionTaps: 3,
    parallax: 4,
    worldLayers: 2,
    worldScrim: 0.5,
    worldBokehPx: 0.4,
    landRipple: false,
    clearChoreo: 1,
    trayFloatMm: 1.5,
    countdownFx: 1,
    endSlow: true,
  },
  low: {
    bgOctaves: 2,
    bloomScale: 0,
    bloomLevels: 0,
    bloomThreshold: 1,
    bloomStrength: 0,
    streak: 0,
    chroma: 0,
    grain: 0,
    vignette: 0,
    post: false,
    tonemap: 0,
    exposure: 1,
    heatGrade: 0,
    eyeAdapt: 0,
    dof: 0,
    particleCap: 100,
    particlesPerCell: 2,
    maxResolution: 2,
    ssaa: 1,
    antialias: false,
    rimBand: 0,
    emberRate: 0,
    rimSparks: 0,
    ringSparks: 0,
    ringComet: false,
    burstShards: 0,
    ribbons: 0,
    tileRim: false,
    tileSheen: false,
    godRays: false,
    outcomeCoins: 0,
    holoGhost: false,
    ghostBeam: 0,
    grabOvershoot: 0,
    odometer: false,
    bannerLetters: false,
    levelFx: 0,
    fractureChunks: 0,
    fracturePool: 0,
    fractureGlow: false,
    tileLight: 0,
    contactShadow: false,
    reflectionScale: 0,
    reflectionTaps: 1,
    parallax: 0,
    worldLayers: 1,
    worldScrim: 0.5,
    worldBokehPx: 0,
    landRipple: false,
    clearChoreo: 0,
    trayFloatMm: 0,
    countdownFx: 0,
    endSlow: false,
  },
};

export const QUALITY_TIERS: readonly QualityTier[] = ['ultra', 'high', 'medium', 'low'];

/**
 * Backing-store budget for supersampling, in pixels: 3840 x 2160 plus a
 * margin. Native resolution is never held under it (the phone rule above);
 * only the supersampling factor is.
 */
export const RESOLUTION_BUDGET_PX = 9.5e6;

/**
 * The world container's own resolution cap: the board, the tiles, every
 * spark and the painted world render through the post filter
 * (`shaders/post.ts`) at min(renderer resolution, this), while the HUD and
 * its text, outside the filter, stay at the renderer's. Why 2: a DPR-3 phone
 * at native would pay 9x the fill the world had before the filter inherited
 * the renderer's resolution (it was 1x — see post.ts); at 2 it pays 4x, and
 * draws the same tile geometry as the desktop's 2x supersample — the board's
 * hairlines are already half a device pixel there, which is what the
 * sharpness measurements turn on. The in-game governor (playfield.ts)
 * steps this 2 -> 1.5 -> 1 on a coarse-pointer device that cannot hold
 * 60 fps; on a fine pointer it steps the renderer instead.
 */
export const WORLD_RESOLUTION_CAP = 2;

/**
 * The renderer resolution for a tier on a screen of `width` x `height` CSS px
 * at `dpr`: native on a coarse pointer, at least `ssaa` on a fine one, never
 * above `maxResolution`, and the supersampling held under the pixel budget.
 * `cap` is the session's governor cap (playfield.ts), if it has stepped down.
 * Fractional factors are fine (Pixi resizes the backing store, autoDensity
 * keeps the CSS size); the result is floored to 1/100.
 */
export function effectiveResolution(
  q: Pick<QualitySettings, 'ssaa' | 'maxResolution'>,
  dpr: number,
  coarse: boolean,
  width: number,
  height: number,
  cap = Infinity,
): number {
  const native = Math.min(Math.max(1, dpr), q.maxResolution);
  if (coarse) return native;
  const budget = Math.sqrt(RESOLUTION_BUDGET_PX / Math.max(1, width * height));
  const want = Math.min(Math.max(native, q.ssaa), q.maxResolution, cap, budget);
  // Under a quarter over native the extra samples buy nothing worth the fill.
  if (want < native + 0.25) return native;
  return Math.floor(want * 100) / 100;
}

/** Sensible starting tier for the device; the player can change it in settings. */
export function defaultTier(): QualityTier {
  if (typeof navigator === 'undefined') return 'medium';
  const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency ?? 4;
  if (coarse) return cores >= 8 ? 'high' : 'medium';
  return cores >= 8 ? 'ultra' : 'high';
}
