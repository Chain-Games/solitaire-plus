import { Filter, GlProgram, Texture, TexturePool } from 'pixi.js';
import type { FilterSystem, RenderSurface } from 'pixi.js';
import type { QualitySettings } from '../quality.js';

/**
 * Multi-pass post chain. The world container carries this one filter; inside
 * `apply()` it drives its own intermediate passes through Pixi's filter
 * system the same way `BlurFilter` drives its two `BlurFilterPass`es, then
 * composites everything in a final full-resolution pass.
 *
 * Passes on Ultra at 1080p (frame F = 1920x1080 at renderer resolution 1;
 * every target scales with the renderer's resolution, so a 2x supersampled
 * desktop or a DPR-3 phone runs the same chain at 4x / 9x the pixels):
 *
 *   1  bright pass         F * bloomScale (0.5)   960x540    0.52 MP   4 taps
 *   2  kawase down 0->1    1/4                    480x270    0.13 MP   5 taps
 *   3  kawase down 1->2    1/8                    240x135    0.03 MP   5 taps
 *   4  kawase down 2->3    1/16                   120x68     0.01 MP   5 taps
 *   5  kawase up   3->2    additive into level 2  240x135    0.03 MP   8 taps
 *   6  kawase up   2->1    additive into level 1  480x270    0.13 MP   8 taps
 *   7  kawase up   1->0    additive into level 0  960x540    0.52 MP   8 taps
 *   8  streak bright pass  F * bloomScale * 0.5   480x270    0.13 MP   4 taps
 *   9  streak blur, stride 1                      480x270    0.13 MP   9 taps
 *  10  streak blur, stride 3                      480x270    0.13 MP   9 taps
 *  11  streak blur, stride 9                      480x270    0.13 MP   9 taps
 *  12  composite (scene + bloom + streak + lens)  1920x1080  2.07 MP   ~9 taps
 *
 * That is 12 passes, ~3.9 MP of fragments and ~30 MP of texture taps per
 * frame; the composite alone is over half of it. High drops passes 8-11
 * (8 passes), medium also drops one bloom level (6 passes). Every pass is
 * bandwidth-trivial for a discrete GPU (the whole chain measures well under a
 * millisecond at 1080p), and the level count, render-target scale, threshold,
 * strength and streak strength all come from the quality tier.
 *
 * Bloom: the bright pass thresholds with a soft knee, the down chain is the
 * dual-Kawase 5-tap kernel, and the up chain is the 8-tap tent kernel blended
 * additively into the level above it, so the result is the sum of four blur
 * radii from 2 px to 32 px: a bright core with a wide, soft tail rather than a
 * tight halo. Level 0 (half res) is what the composite samples.
 *
 * Lens (composite): 2% barrel distortion pinned at the corners, colour fringe
 * only in the outer 15% band of the frame, and on Ultra an anamorphic
 * horizontal streak from a second, much higher threshold so only near-white
 * pixels (the clear flash, the countdown GO, the banner edge, the streak
 * set-piece) throw one. Chroma, grain, vignette, shockwave and flash are the
 * single-pass code, unchanged, now living in the composite.
 *
 * Grade, exposure and tonemap (composite, in that order, after every additive
 * light and before grain and vignette):
 *
 *   grade      three stops keyed to streak heat: cold = the scene as lit;
 *              0.5 = a warm-white lift; 0.75+ = high-key: a quarter stop more
 *              gain biased toward warm white #ffe8c8, and a saturation push
 *              (saturation only ever rises; floor 0.85) — no hue rotation
 *              toward brown, no further pedestal, so the blue ground stays
 *              blue. Interpolated by heat, scaled by the tier.
 *   exposure   `uExposure` = the tier's base exposure, and on the ROOM only
 *              (everything outside the plate rect, feathered 2.4 cells) the
 *              eye-adaptation factor: the 4X supernova drops it ≤ 0.3 EV
 *              (ramping in over 80 ms so the flash frame itself lands at full
 *              brightness), holds 300 ms and recovers over 700 ms, on the
 *              presentation clock. Adaptation dims the room, never the
 *              emitters: tiles, rim band, hot line, banner keep their light,
 *              and the rays and flash are added after it.
 *   tonemap    ACES-fitted filmic shoulder. The scene is display-referred LDR
 *              (the critic scored it without a tonemap), and the ACES fit is an
 *              S-curve: applied whole, no exposure scale keeps the quiet frame's
 *              mid-tones (mean +18% at E 0.8, p10 -50% at E 0.6). So the body of
 *              the frame sits on the identity up to a knee (0.82) and above it
 *              the ACES fit's own shoulder segment (from its upper fixed point
 *              0.728, re-normalised to slope 1 at the knee and an asymptote of
 *              1) rolls the overshoot off: bloom + rays + flash sums no longer
 *              clip per channel to flat white, 1.0 lands at ~0.90 and only
 *              extreme sums approach paper white. Measured on f00168: mean
 *              luminance and every percentile up to p99 unchanged.
 *
 * Depth of field (results): when `uDof.x` > 0 the scene is also dual-Kawase
 * downsampled two levels (the same passes as the bloom chain, unthresholded)
 * and the composite samples that with a 13-tap disc whose radius is the tier's
 * bokeh radius x the focus pull x a vertical depth ramp (the near edge of the
 * tilted table defocuses more), weighted by brightness so lit tiles bloom into
 * discs rather than smearing. The HUD (the results panel) is outside the chain
 * and stays sharp. It costs nothing while the amount is 0.
 *
 * World soften (docs/worlds.md, readability): while a world is showing, the
 * ROOM — everything outside the table column (the plate rect down through
 * the hand trays), feathered 2.4 cells outward like the adaptation mask —
 * is read through a 13-tap disc over the FULL-RES scene at the tier's
 * `worldBokehPx`: 0.4 px, a sub-pixel settle, not a blur, the same right up
 * to the plate (the 1.5 px it once was took the painting's edges off a 1080p
 * desktop; the 4 px feather beside the plate that followed it made the
 * temple-bay statue and the aurora cliff — where the eye rests — the softest
 * thing on the screen). The plate's separation is the scrim's and the
 * plate's own shadow. Inside the column the mix is exactly 0: no tile,
 * socket, hand piece or reflection is ever resampled. Grain runs at a
 * quarter amplitude on the room while a world is up (the painting carries
 * its own texture).
 *
 * Intermediate textures come from Pixi's `TexturePool` and go back every
 * frame; after the first frame nothing is allocated. Every program (streak
 * included, on every tier) runs at least once on the first `apply()`, so the
 * prewarm frame compiles all of them.
 *
 * WebGL notes: each pass owns its uniform group (no UBO batching needed), and
 * `finalColor` is declared for WebGL2. The intermediate passes use a vertex
 * shader that always fills the output target, because Pixi sizes the filter
 * quad from the *input* frame and would otherwise draw a half-res pass into
 * the top-left quarter of its target.
 */

// Look constants. Not tier numbers: none of them cost anything.
const BLOOM_KNEE = 0.25;
const STREAK_THRESHOLD = 0.9;
const STREAK_KNEE = 0.08;
const STREAK_STRIDES = [1, 3, 9];
const BARREL = 0.02;
const FRINGE_BAND = 0.15;
const UP_SPREAD = 1.0;
/** Tonemap knee: identity below it, the ACES shoulder above. */
const TONE_KNEE = 0.82;
/**
 * Eye adaptation after the supernova, seconds: ramp in, hold, recover. The
 * dip depth (EV) comes from the tier.
 */
const ADAPT_IN_S = 0.08;
const ADAPT_HOLD_S = 0.3;
const ADAPT_OUT_S = 0.7;
/** A room dim (the results' loss) ramps in and out over this long at each end of its hold. */
const DIM_RAMP_S = 0.12;
/** Bokeh: levels of the scene chain below half res (2 = a 1/4-res source, tent-filtered back to 1/2). */
const DOF_LEVELS = 2;

/** Vertex shader for the final pass: Pixi's standard filter quad. */
const VERT = /* glsl */ `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void) {
  return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
}
`;

/**
 * Vertex shader for the intermediate passes: fill the whole output target
 * (whatever its size) while reading the whole input frame.
 */
const VERT_FILL = /* glsl */ `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

void main(void) {
  vec2 clip = aPosition * 2.0 - 1.0;
  clip.y *= uOutputTexture.z;
  gl_Position = vec4(clip, 0.0, 1.0);
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}
`;

const PASS_HEAD = /* glsl */ `
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uInputClamp;

vec3 tap(vec2 uv) {
  return texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw)).rgb;
}
`;

/**
 * Bright pass, rendered at a fraction of the frame. Four bilinear taps a texel
 * out on the diagonals average a 4x4 block of scene pixels, so one-pixel
 * speculars do not flicker at the lower resolution.
 */
const FRAG_BRIGHT = /* glsl */ `
${PASS_HEAD}
uniform float uThreshold;
uniform float uKnee;

void main(void) {
  vec2 px = uInputSize.zw;
  vec3 c = tap(vTextureCoord + vec2(-1.0, -1.0) * px) + tap(vTextureCoord + vec2(1.0, -1.0) * px) +
    tap(vTextureCoord + vec2(-1.0, 1.0) * px) + tap(vTextureCoord + vec2(1.0, 1.0) * px);
  c *= 0.25;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  finalColor = vec4(c * smoothstep(uThreshold, uThreshold + uKnee, l), 1.0);
}
`;

/**
 * Dual-Kawase downsample: centre weighted 4, four diagonals at one input
 * texel. (`uSpread` is also why this pass is never an empty uniform group:
 * Pixi hashes an empty group's signature to the empty string, which shares an
 * id table with every other Pixi id and collides with the filter globals.)
 */
const FRAG_DOWN = /* glsl */ `
${PASS_HEAD}
uniform float uSpread;

void main(void) {
  vec2 px = uInputSize.zw * uSpread;
  vec3 c = tap(vTextureCoord) * 4.0;
  c += tap(vTextureCoord + vec2(-1.0, -1.0) * px);
  c += tap(vTextureCoord + vec2(1.0, -1.0) * px);
  c += tap(vTextureCoord + vec2(-1.0, 1.0) * px);
  c += tap(vTextureCoord + vec2(1.0, 1.0) * px);
  finalColor = vec4(c * (1.0 / 8.0), 1.0);
}
`;

/**
 * Dual-Kawase upsample: 8-tap tent. Blended additively into the larger level
 * it is written to, so every level's blur radius contributes to the result.
 */
const FRAG_UP = /* glsl */ `
${PASS_HEAD}
uniform float uSpread;

void main(void) {
  vec2 px = uInputSize.zw * 0.5 * uSpread;
  vec3 c = tap(vTextureCoord + vec2(-2.0, 0.0) * px);
  c += tap(vTextureCoord + vec2(-1.0, 1.0) * px) * 2.0;
  c += tap(vTextureCoord + vec2(0.0, 2.0) * px);
  c += tap(vTextureCoord + vec2(1.0, 1.0) * px) * 2.0;
  c += tap(vTextureCoord + vec2(2.0, 0.0) * px);
  c += tap(vTextureCoord + vec2(1.0, -1.0) * px) * 2.0;
  c += tap(vTextureCoord + vec2(0.0, -2.0) * px);
  c += tap(vTextureCoord + vec2(-1.0, -1.0) * px) * 2.0;
  finalColor = vec4(c * (1.0 / 12.0), 1.0);
}
`;

/**
 * Horizontal 9-tap blur for the anamorphic streak. Run three times with
 * growing strides (1, 3, 9 texels at quarter res) it reaches ~200 px each side
 * at 1080p with a bright core and a long tail.
 */
const FRAG_HBLUR = /* glsl */ `
${PASS_HEAD}
uniform float uStride;

void main(void) {
  vec2 step = vec2(uInputSize.z * uStride, 0.0);
  vec3 c = tap(vTextureCoord) * 0.2;
  c += (tap(vTextureCoord + step) + tap(vTextureCoord - step)) * 0.175;
  c += (tap(vTextureCoord + step * 2.0) + tap(vTextureCoord - step * 2.0)) * 0.125;
  c += (tap(vTextureCoord + step * 3.0) + tap(vTextureCoord - step * 3.0)) * 0.075;
  c += (tap(vTextureCoord + step * 4.0) + tap(vTextureCoord - step * 4.0)) * 0.025;
  finalColor = vec4(c, 1.0);
}
`;

const FRAG_COMPOSITE = /* glsl */ `
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uInputClamp;
uniform vec4 uOutputFrame;

uniform sampler2D uBloomTexture;
uniform sampler2D uStreakTexture;
uniform sampler2D uDofTexture;
uniform vec4 uBloomUv; // xy: frame/source scale, zw: half texel in source UV
uniform vec4 uStreakUv;
uniform vec4 uDofUv;

uniform float uTime;
// x: room exposure (base x the adaptation dip), y: plate exposure (base)
uniform vec2 uExposure;
// x: tonemap strength (tier), y: knee, z: shoulder scale a (ACES x per unit overshoot), w: shoulder normaliser
uniform vec4 uTone;
uniform float uGrade;
uniform vec3 uRayColor;
// x: focus pull 0..1, y: bokeh radius (frame px), z: focal plane y (frame UV), w: depth gain per unit y
uniform vec4 uDof;
// World soften over the room outside uColumnRect (frame UV, x0 y0 x1 y1):
// x: radius px (the same everywhere in the room), y: unused, z: room grain factor, w: on (0/1)
uniform vec4 uWorldSoft;
uniform vec4 uColumnRect;
// Room lift cap: bloom and flash on the room are scaled by this (1 = as the plate; 0.6 on portrait).
uniform float uRoomLift;
uniform float uBloomStrength;
uniform float uStreak;
uniform float uStreakEdge; // frame-UV width of the fade to nothing at the plate's side rims
uniform float uBarrel;
uniform float uFringeBand;
uniform float uChroma;
uniform float uGrain;
uniform float uVignette;
uniform float uFlash;
uniform vec4 uBoardRect; // x0,y0,x1,y1 in frame UV
uniform float uHeat;
// End of the game: x = desaturation, y = darkening, over the whole frame
// (room AND board — the one place the board may dim: play is over). Applied
// after the exposure; the rays and the flash are emitters and go on top.
uniform vec2 uEndGrade;
uniform vec4 uShock; // centre x, centre y (frame UV), progress 0..1, strength
uniform vec4 uRays; // centre x, centre y (frame UV), progress 0..1, strength
// Ray masks (frame UV): xy = the HUD fade (0 at x, full at y); zw = the banner band's y range
// (rays run at 60% inside it; zw < 0 = no band).
uniform vec4 uRayMask;
// Tile mask for the rays (the level-up's cool rays light sockets, rim and
// room only): the board's cell grid in frame UV (origin, pitch), the cell's
// share of a pitch, and the ten rows' occupancy as 10-bit masks in three
// vec4s (ANGLE refuses a dynamic index into a uniform here, so the row is
// selected with an equality mask).
// uRayTileMask 0 = off (the results sting's rays cross the plate; the level and 4X rays mask the tiles).
uniform float uRayTileMask;
uniform vec4 uRayGrid;
uniform float uRayCell;
uniform vec4 uRayRows0;
uniform vec4 uRayRows1;
uniform vec4 uRayRows2;

vec3 sampleClamped(vec2 uv) {
  return texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw)).rgb;
}

vec3 bloomAt(vec2 frameUV) {
  vec2 uv = clamp(frameUV * uBloomUv.xy, uBloomUv.zw, uBloomUv.xy - uBloomUv.zw);
  return texture(uBloomTexture, uv).rgb;
}

vec3 streakAt(vec2 frameUV) {
  vec2 uv = clamp(frameUV * uStreakUv.xy, uStreakUv.zw, uStreakUv.xy - uStreakUv.zw);
  return texture(uStreakTexture, uv).rgb;
}

vec3 dofAt(vec2 frameUV) {
  vec2 uv = clamp(frameUV * uDofUv.xy, uDofUv.zw, uDofUv.xy - uDofUv.zw);
  return texture(uDofTexture, uv).rgb;
}

// Bokeh: a 13-tap disc (centre + two rings of six) over the pre-blurred scene,
// a plain average so the blur keeps the frame's mean (a brightness-weighted
// disc lifted the backdrop ~8 RGB into a wash).
vec3 bokehAt(vec2 frameUV, float radiusUV, float aspect) {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  vec3 c = dofAt(frameUV);
  float w = 1.0;
  acc += c * w;
  wsum += w;
  for (int i = 0; i < 6; i++) {
    float a = float(i) * 1.0471976;
    vec2 d = vec2(cos(a) * aspect, sin(a)) * radiusUV;
    c = dofAt(frameUV + d);
    w = 1.0;
    acc += c * w;
    wsum += w;
    vec2 d2 = vec2(cos(a + 0.5235988) * aspect, sin(a + 0.5235988)) * radiusUV * 0.55;
    c = dofAt(frameUV + d2);
    w = 1.0;
    acc += c * w;
    wsum += w;
  }
  return acc / wsum;
}

// ACES fitted curve (Narkowicz 2015).
float acesFit(float x) {
  return (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
}

// Filmic shoulder: identity to the knee, then the ACES fit's own roll-off
// (its segment above the upper fixed point 0.728) re-normalised to leave the
// knee at slope 1 and reach 1 asymptotically. Per channel.
float shoulder(float x) {
  float knee = uTone.y;
  if (x <= knee) return x;
  float u = (x - knee) / (1.0 - knee);
  float s = (acesFit(0.728 + uTone.z * u) - 0.728) * uTone.w;
  return knee + (1.0 - knee) * s;
}

float hash(vec2 p) {
  p = fract(p * vec2(443.8975, 397.2973));
  p += dot(p.xy, p.yx + 19.19);
  return fract(p.x * p.y);
}

float hash1(float x) {
  return fract(sin(x * 127.1 + 311.7) * 43758.5453);
}

// 1-D value noise that wraps at period lattice points, for seamless angular noise.
float pnoise(float x, float period) {
  float i = floor(x);
  float f = x - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash1(mod(i, period)), hash1(mod(i + 1.0, period)), f);
}

void main(void) {
  // Output-frame coordinate (0..1 across the visible frame): where this pixel
  // sits on the lens. Grain, vignette and the fringe band live here.
  vec2 outUV = vTextureCoord * uInputSize.xy / uOutputFrame.zw;
  vec2 centre = outUV - 0.5;
  float r2 = dot(centre, centre);

  // Barrel distortion, pinned at the corners so nothing samples outside the
  // frame: the centre is magnified by 1/(1+k), the corners stay put.
  float rn = r2 * 2.0; // 1 at the corners
  vec2 frameUV = 0.5 + centre * (1.0 + uBarrel * rn) / (1.0 + uBarrel);

  // Shockwave (3X+ clears): a ring of radial displacement expanding from the
  // cleared line, fading as it grows. Runs before the channel split so the
  // fringe rides the wave.
  vec2 baseUV = frameUV * uOutputFrame.zw * uInputSize.zw;
  if (uShock.w > 0.0 && uShock.z < 1.0) {
    vec2 sc = uShock.xy;
    vec2 d = frameUV - sc;
    d.x *= uOutputFrame.z / uOutputFrame.w;
    float dist = length(d);
    float radius = uShock.z * 0.7;
    // One cell wide (~0.05 frame), three-cell falloff; never more than ~2.5 px
    // of displacement so tiles bend as light, not as geometry.
    float ring = exp(-pow((dist - radius) * 30.0, 2.0));
    float amt = ring * uShock.w * (1.0 - uShock.z) * 0.0024;
    baseUV -= normalize(d + 1e-5) * amt * vec2(uOutputFrame.z / uInputSize.x, uOutputFrame.w / uInputSize.y);
  }

  // Chromatic aberration: split channels radially, more at the edges, and only
  // in the outer band of the frame.
  float edge = min(min(outUV.x, 1.0 - outUV.x), min(outUV.y, 1.0 - outUV.y));
  float fringe = 1.0 - smoothstep(0.0, uFringeBand, edge);
  vec2 dir = centre * uChroma * uInputSize.zw * r2 * 3.0 * fringe;
  vec3 col;
  col.r = sampleClamped(baseUV + dir).r;
  col.g = sampleClamped(baseUV).g;
  col.b = sampleClamped(baseUV - dir).b;

  // World soften: the room outside the table column (plate through trays)
  // is read through a 13-tap disc over the full-res scene at one sub-pixel
  // radius — no heavier band beside the plate — and the column's mix is
  // exactly 0, so the tiles, hand and reflection are never resampled.
  float room = 0.0;
  {
    vec2 fpx = frameUV * uOutputFrame.zw;
    vec4 r = uColumnRect * uOutputFrame.zwzw;
    float F = uStreakEdge * uOutputFrame.z * 4.8;
    // Distance outside the column rect in px (0 inside).
    float dOut = max(max(r.x - fpx.x, fpx.x - r.z), max(r.y - fpx.y, fpx.y - r.w));
    room = smoothstep(0.0, F, dOut);
    if (uWorldSoft.w > 0.0 && room > 0.001) {
      vec2 step = uWorldSoft.x * uInputSize.zw;
      vec3 acc = sampleClamped(baseUV);
      for (int i = 0; i < 6; i++) {
        float a = float(i) * 1.0471976;
        vec2 d = vec2(cos(a), sin(a)) * step;
        acc += sampleClamped(baseUV + d);
        vec2 d2 = vec2(cos(a + 0.5235988), sin(a + 0.5235988)) * step * 0.55;
        acc += sampleClamped(baseUV + d2);
      }
      col = mix(col, acc / 13.0, room);
    }
  }

  // Depth of field (results focus pull): the table falls out of focus while
  // the panel, outside the chain, snaps in. Radius grows toward the near edge.
  if (uDof.x > 0.0) {
    float coc = uDof.y * uDof.x * (1.0 + uDof.w * (frameUV.y - uDof.z));
    float aspect = uOutputFrame.w / uOutputFrame.z;
    vec3 bokeh = bokehAt(frameUV, coc / uOutputFrame.w, aspect);
    col = mix(col, bokeh, min(1.0, uDof.x * 1.25));
  }

  // Bloom: the additive sum of the up chain, sampled at the lens position so it
  // follows the distortion.
  // The room's lift (bloom, flash) can be capped: on a phone the sky band
  // above the plate would otherwise go white under a 4X.
  float roomLift = mix(1.0, uRoomLift, room);
  col += bloomAt(frameUV) * uBloomStrength * roomLift;

  // Anamorphic streak: near-white pixels only, cool-tinted like a real lens.
  if (uStreak > 0.0) {
    // A lens artefact, but it stays on the table: feathered to nothing at the
    // plate's left and right rims, so on a phone (where the plate is the
    // screen) a clear's streak never runs to the screen edge.
    float onPlate = smoothstep(uBoardRect.x, uBoardRect.x + uStreakEdge, frameUV.x) *
      smoothstep(uBoardRect.z, uBoardRect.z - uStreakEdge, frameUV.x);
    col += streakAt(frameUV) * uStreak * onPlate * vec3(0.8, 0.93, 1.0);
  }


  // Streak heat grade, three stops: cold = as lit; 0.5 = a warm LIFT (never a
  // tint multiply, so saturation never collapses to sepia at the edges) with a
  // small saturation push; 0.75+ = high-key: a quarter stop more exposure and
  // a warm gain on top (no further pedestal, so the blue ground stays blue
  // rather than going brown), more saturation, so the frame reads lit from
  // inside.
  if (uGrade > 0.0 && uHeat > 0.0) {
    float hA = min(1.0, uHeat * 2.0);
    float hB = clamp((uHeat - 0.5) * 4.0, 0.0, 1.0);
    // Warm-white (#ffe8c8 = 1, .91, .78) lift and gain: warmer, never browner.
    vec3 warmWhite = vec3(1.0, 0.91, 0.784);
    vec3 lift = vec3(0.04, 0.031, 0.022) * hA;
    vec3 gain = mix(vec3(1.0), warmWhite, 0.12 * hA + 0.3 * hB) * (1.0 + 0.26 * hB);
    // Saturation only ever goes up (the floor of 0.85 is never reached).
    float sat = max(0.85, 1.0 + 0.08 * hA + 0.08 * hB);
    vec3 g = col * gain + lift;
    float luma = dot(g, vec3(0.299, 0.587, 0.114));
    g = mix(vec3(luma), g, sat);
    col = mix(col, g, uGrade);
  }

  // Exposure: the tier's base, and the eye-adaptation dip on the ROOM only —
  // backdrop, floor, trays, leaks — never the plate: tiles, rim band, hot line
  // and banner keep their light. The plate rect is feathered outward so the
  // dip has no edge. Rays and the flash are added after it: emitters.
  {
    vec2 fpx = frameUV * uOutputFrame.zw;
    vec4 r = uBoardRect * uOutputFrame.zwzw;
    // Feather 2.4 cells outward (uStreakEdge is half a cell in frame UV).
    float F = uStreakEdge * uOutputFrame.z * 4.8;
    float plate = smoothstep(-F, 0.0, fpx.x - r.x) * smoothstep(-F, 0.0, r.z - fpx.x) *
      smoothstep(-F, 0.0, fpx.y - r.y) * smoothstep(-F, 0.0, r.w - fpx.y);
    col *= mix(uExposure.x, uExposure.y, plate);
  }

  // End-of-game grade: the board and the room desaturate and darken together
  // as the results come in (held through them).
  if (uEndGrade.x > 0.0 || uEndGrade.y > 0.0) {
    float endLuma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(endLuma), uEndGrade.x) * (1.0 - uEndGrade.y);
  }


  // God rays (4X supernova): procedural radial rays from the board centre —
  // two layers of seamless angular noise rotating against each other, an
  // outward-growing radial envelope, warm white. Pure ALU, no extra taps.
  if (uRays.w > 0.0) {
    vec2 rd = frameUV - uRays.xy;
    rd.x *= uOutputFrame.z / uOutputFrame.w;
    float rdist = length(rd);
    float ang = (atan(rd.y, rd.x) / 6.2831853 + 0.5);
    float p = uRays.z;
    float n1 = pnoise(ang * 18.0 + p * 1.5, 18.0);
    float n2 = pnoise(ang * 42.0 - p * 2.5 + 7.0, 42.0);
    float rays = pow(n1 * 0.65 + n2 * 0.35, 2.4) * 1.6;
    float reach = 0.15 + p * 0.85;
    float env = smoothstep(reach, reach * 0.35, rdist) * smoothstep(0.0, 0.06, rdist);
    float core = exp(-rdist * rdist * 60.0) * 0.2;
    float amt = uRays.w * sin(p * 3.14159);
    // Keep the HUD clear (fade to nothing across its band) and the banner text legible.
    amt *= smoothstep(uRayMask.x, uRayMask.y, frameUV.y);
    if (uRayMask.z >= 0.0) {
      float inBand = step(uRayMask.z, frameUV.y) * step(frameUV.y, uRayMask.w) *
        step(uBoardRect.x, frameUV.x) * step(frameUV.x, uBoardRect.z);
      amt *= 1.0 - 0.4 * inBand;
    }
    if (uRayTileMask > 0.0) {
      vec2 gp = (frameUV - uRayGrid.xy) / uRayGrid.zw;
      if (gp.x >= 0.0 && gp.y >= 0.0 && gp.x < 10.0 && gp.y < 10.0) {
        // The tile's silhouette, not its cell: a rounded rect (corner radius
        // 0.18 of the tile, textures.ts) feathered over ~0.05 tile, so the
        // beam wraps the tile's corners instead of cutting square notches
        // into the wash (round 64: "sticker cut-outs").
        vec2 fr = fract(gp) - vec2(uRayCell * 0.5);
        float rr = uRayCell * 0.18;
        vec2 q = abs(fr) - vec2(uRayCell * 0.5 - rr);
        float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rr;
        float cover = 1.0 - smoothstep(-0.025 * uRayCell, 0.05 * uRayCell, sd);
        if (cover > 0.0) {
          // Select the row's mask without indexing (ANGLE refuses dynamic indices here).
          vec4 fy = vec4(floor(gp.y));
          float rowMask = dot(uRayRows0, vec4(equal(fy, vec4(0.0, 1.0, 2.0, 3.0)))) +
            dot(uRayRows1, vec4(equal(fy, vec4(4.0, 5.0, 6.0, 7.0)))) +
            dot(uRayRows2, vec4(equal(fy, vec4(8.0, 9.0, 10.0, 11.0))));
          float bit = mod(floor(rowMask / pow(2.0, floor(gp.x))), 2.0);
          amt *= 1.0 - uRayTileMask * bit * cover;
        }
      }
    }
    col += (rays * env + core) * amt * uRayColor;
  }

  // Full-screen flash on big moments, decays in JS.
  col += uFlash * vec3(1.0, 0.96, 0.9) * roomLift;

  // Filmic tonemap: identity through the knee, the ACES shoulder above it.
  if (uTone.x > 0.0) {
    vec3 tm = vec3(shoulder(col.r), shoulder(col.g), shoulder(col.b));
    col = mix(col, tm, uTone.x);
  }

  // Grain: cheap animated hash, kept subtle so it reads as texture not noise.
  float g = hash(outUV * 1000.0 + fract(uTime * 7.0) * 100.0) - 0.5;
  float inBoard = step(uBoardRect.x, frameUV.x) * step(frameUV.x, uBoardRect.z) * step(uBoardRect.y, frameUV.y) * step(frameUV.y, uBoardRect.w);
  // A quarter of the grain on the room while a world is up (the painting carries its own texture).
  col += g * uGrain * (1.0 - inBoard) * mix(1.0, uWorldSoft.z, room * uWorldSoft.w);

  // Vignette.
  col *= 1.0 - smoothstep(0.15, 0.7, r2) * uVignette;

  finalColor = vec4(col, 1.0);
}
`;

type Uniforms = Record<string, unknown>;
type UniformDecls = Record<string, { value: unknown; type: string }>;

/** One intermediate pass: a program plus its own uniform group. */
class Pass extends Filter {
  constructor(name: string, fragment: string, uniforms: UniformDecls) {
    super({
      glProgram: GlProgram.from({ vertex: VERT_FILL, fragment, name }),
      resources: { passUniforms: uniforms },
    });
  }

  get u(): Uniforms {
    return (this.resources as { passUniforms: { uniforms: Uniforms } }).passUniforms.uniforms;
  }
}

/** Largest bloom level count the pool of pass instances is sized for. */
const MAX_LEVELS = 4;

/**
 * Shoulder constants from the ACES fit: its upper fixed point x0 (where the
 * fit crosses the identity on the way into its roll-off), the asymptote
 * 2.51/2.43, and the slope there, so the shoulder leaves the knee at slope 1.
 */
const ACES_X0 = 0.72794;
const ACES_TOP = 2.51 / 2.43;
const acesFit = (x: number): number => (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
const ACES_SLOPE_X0 = (acesFit(ACES_X0 + 1e-4) - acesFit(ACES_X0 - 1e-4)) / 2e-4;
/** ACES-x travelled per unit of overshoot above the knee. */
const SHOULDER_SCALE = (ACES_TOP - acesFit(ACES_X0)) / ACES_SLOPE_X0;
/** Normaliser so the shoulder spans 0..1. */
const SHOULDER_NORM = 1 / (ACES_TOP - acesFit(ACES_X0));

export class PostFilter extends Filter {
  private flash = 0;
  private q: QualitySettings;
  private warmed = false;
  /** Eye adaptation clock (seconds since the trigger; >= total = idle). */
  private adaptT = ADAPT_IN_S + ADAPT_HOLD_S + ADAPT_OUT_S;
  /** Room dim: the fraction taken off the room's exposure, its clock and its total length (idle when t >= s). */
  private dimAmount = 0;
  private dimT = 0;
  private dimS = 0;
  private dofAmount = 0;
  /** World soften radius over the room in px at 1080p (0 = off); scaled to the frame in apply(). */
  private worldBokeh = 0;
  /** Grain amplitude on the room while a world is up, as a fraction of the tier's. */
  private static readonly ROOM_GRAIN = 0.25;

  private readonly bright: Pass;
  private readonly down: Pass[] = [];
  private readonly up: Pass[] = [];
  private readonly streakBright: Pass;
  private readonly hblur: Pass[] = [];

  constructor(q: QualitySettings) {
    super({
      glProgram: GlProgram.from({ vertex: VERT, fragment: FRAG_COMPOSITE, name: 'blockari-post' }),
      // Pixi's default filter resolution is 1: the world container (the
      // board, the tiles, every spark) would render into a CSS-px texture and
      // be upscaled to the canvas, on a DPR-3 phone and under supersampling
      // alike. Inherit the renderer's (quality.ts `maxResolution` / `ssaa`);
      // the playfield then caps it at `WORLD_RESOLUTION_CAP` (2) and its
      // governor may step it lower on a phone.
      resolution: 'inherit',
      resources: {
        uBloomTexture: Texture.EMPTY.source,
        uStreakTexture: Texture.EMPTY.source,
        uDofTexture: Texture.EMPTY.source,
        postUniforms: {
          uBloomUv: { value: [1, 1, 0, 0], type: 'vec4<f32>' },
          uStreakUv: { value: [1, 1, 0, 0], type: 'vec4<f32>' },
          uDofUv: { value: [1, 1, 0, 0], type: 'vec4<f32>' },
          uTime: { value: 0, type: 'f32' },
          uExposure: { value: [q.exposure, q.exposure], type: 'vec2<f32>' },
          uTone: {
            value: [q.tonemap, TONE_KNEE, SHOULDER_SCALE, SHOULDER_NORM],
            type: 'vec4<f32>',
          },
          uGrade: { value: q.heatGrade, type: 'f32' },
          uRayColor: { value: [1, 0.93, 0.8], type: 'vec3<f32>' },
          uDof: { value: [0, q.dof, 0.5, 0.6], type: 'vec4<f32>' },
          uWorldSoft: { value: [0, 0, PostFilter.ROOM_GRAIN, 0], type: 'vec4<f32>' },
          uRoomLift: { value: 1, type: 'f32' },
          uColumnRect: { value: [0, 0, 0, 0], type: 'vec4<f32>' },
          uBloomStrength: { value: q.bloomStrength, type: 'f32' },
          uStreak: { value: q.streak, type: 'f32' },
          uStreakEdge: { value: 0.01, type: 'f32' },
          uBarrel: { value: BARREL, type: 'f32' },
          uFringeBand: { value: FRINGE_BAND, type: 'f32' },
          uChroma: { value: q.chroma, type: 'f32' },
          uGrain: { value: q.grain, type: 'f32' },
          uVignette: { value: q.vignette, type: 'f32' },
          uFlash: { value: 0, type: 'f32' },
          uBoardRect: { value: [0, 0, 0, 0], type: 'vec4<f32>' },
          uHeat: { value: 0, type: 'f32' },
          uEndGrade: { value: [0, 0], type: 'vec2<f32>' },
          uShock: { value: [0.5, 0.5, 1, 0], type: 'vec4<f32>' },
          uRays: { value: [0.5, 0.5, 1, 0], type: 'vec4<f32>' },
          uRayMask: { value: [0, 0, -1, -1], type: 'vec4<f32>' },
          uRayTileMask: { value: 0, type: 'f32' },
          uRayGrid: { value: [0, 0, 1, 1], type: 'vec4<f32>' },
          uRayCell: { value: 0.9, type: 'f32' },
          uRayRows0: { value: [0, 0, 0, 0], type: 'vec4<f32>' },
          uRayRows1: { value: [0, 0, 0, 0], type: 'vec4<f32>' },
          uRayRows2: { value: [0, 0, 0, 0], type: 'vec4<f32>' },
        },
      },
    });
    this.q = q;
    this.bright = new Pass('blockari-post-bright', FRAG_BRIGHT, {
      uThreshold: { value: q.bloomThreshold, type: 'f32' },
      uKnee: { value: BLOOM_KNEE, type: 'f32' },
    });
    for (let i = 0; i < MAX_LEVELS; i++) {
      this.down.push(
        new Pass('blockari-post-down', FRAG_DOWN, { uSpread: { value: 1, type: 'f32' } }),
      );
      const up = new Pass('blockari-post-up', FRAG_UP, {
        uSpread: { value: UP_SPREAD, type: 'f32' },
      });
      up.blendMode = 'add';
      this.up.push(up);
    }
    this.streakBright = new Pass('blockari-post-streak-bright', FRAG_BRIGHT, {
      uThreshold: { value: STREAK_THRESHOLD, type: 'f32' },
      uKnee: { value: STREAK_KNEE, type: 'f32' },
    });
    for (const stride of STREAK_STRIDES) {
      this.hblur.push(
        new Pass('blockari-post-hblur', FRAG_HBLUR, { uStride: { value: stride, type: 'f32' } }),
      );
    }
  }

  private get u(): Uniforms {
    return (this.resources as { postUniforms: { uniforms: Uniforms } }).postUniforms.uniforms;
  }

  private get textures(): {
    uBloomTexture: unknown;
    uStreakTexture: unknown;
    uDofTexture: unknown;
  } {
    return this.resources as {
      uBloomTexture: unknown;
      uStreakTexture: unknown;
      uDofTexture: unknown;
    };
  }

  override apply(
    filterManager: FilterSystem,
    input: Texture,
    output: RenderSurface,
    clearMode: boolean,
  ): void {
    const q = this.q;
    const res = input.source.resolution;
    const fw = input.frame.width;
    const fh = input.frame.height;
    // The first apply is the prewarm frame: run every pass once, whatever the
    // tier, so no program compiles later when the player changes tier.
    const warm = !this.warmed;
    this.warmed = true;
    const levels = Math.min(MAX_LEVELS, warm ? Math.max(1, q.bloomLevels) : q.bloomLevels);
    const bloomScale = q.bloomScale > 0 ? q.bloomScale : warm ? 0.5 : 0;
    const runStreak = q.streak > 0 || warm;
    const borrowed: Texture[] = [];
    const borrow = (w: number, h: number): Texture => {
      const t = TexturePool.getOptimalTexture(
        Math.max(1, Math.ceil(w)),
        Math.max(1, Math.ceil(h)),
        res,
        false,
      );
      borrowed.push(t);
      return t;
    };
    const uvRect = (t: Texture): number[] => [
      t.frame.width / t.source.width,
      t.frame.height / t.source.height,
      0.5 / t.source.pixelWidth,
      0.5 / t.source.pixelHeight,
    ];

    // Bloom: bright pass, then the dual-Kawase chain down and additively up.
    let bloomTex: Texture = Texture.EMPTY;
    if (bloomScale > 0) {
      const chain: Texture[] = [borrow(fw * bloomScale, fh * bloomScale)];
      this.bright.apply(filterManager, input, chain[0]!, true);
      for (let i = 0; i < levels; i++) {
        const prev = chain[i]!;
        const next = borrow(prev.frame.width / 2, prev.frame.height / 2);
        chain.push(next);
        this.down[i]!.apply(filterManager, prev, next, true);
      }
      for (let i = levels - 1; i >= 0; i--) {
        this.up[i]!.apply(filterManager, chain[i + 1]!, chain[i]!, false);
      }
      bloomTex = chain[0]!;
    }

    // Anamorphic streak: its own, much higher threshold at quarter res, then
    // three horizontal blurs ping-ponging between two targets.
    let streakTex: Texture = Texture.EMPTY;
    if (runStreak && bloomScale > 0) {
      const sw = fw * bloomScale * 0.5;
      const sh = fh * bloomScale * 0.5;
      let ping = borrow(sw, sh);
      let pong = borrow(sw, sh);
      this.streakBright.apply(filterManager, input, ping, true);
      for (const pass of this.hblur) {
        pass.apply(filterManager, ping, pong, true);
        const t = ping;
        ping = pong;
        pong = t;
      }
      streakTex = ping;
    }

    // Depth of field (results only, or the prewarm frame): the unthresholded
    // scene down two levels from half res and tent-filtered back up to it, the
    // same passes as the bloom chain. The composite's disc reads level 0.
    let dofTex: Texture = Texture.EMPTY;
    const runDof = (this.dofAmount > 0 && q.dof > 0) || warm;
    if (runDof) {
      const chain: Texture[] = [borrow(fw * 0.5, fh * 0.5)];
      this.down[0]!.apply(filterManager, input, chain[0]!, true);
      for (let i = 0; i < DOF_LEVELS; i++) {
        const prev = chain[i]!;
        const next = borrow(prev.frame.width / 2, prev.frame.height / 2);
        chain.push(next);
        this.down[i + 1]!.apply(filterManager, prev, next, true);
      }
      for (let i = DOF_LEVELS - 1; i >= 0; i--) {
        // Additive blend onto a cleared target is a plain write.
        this.up[i]!.apply(filterManager, chain[i + 1]!, chain[i]!, true);
      }
      dofTex = chain[0]!;
    }

    // Composite at full resolution into the real output.
    this.textures.uBloomTexture = bloomTex.source;
    this.textures.uStreakTexture = streakTex.source;
    this.textures.uDofTexture = dofTex.source;
    this.u['uBloomUv'] = uvRect(bloomTex);
    this.u['uStreakUv'] = uvRect(streakTex);
    this.u['uDofUv'] = uvRect(dofTex);
    // Normalise the additive chain: level 0 plus one contribution per level.
    this.u['uBloomStrength'] = bloomScale > 0 ? q.bloomStrength / (levels + 1) : 0;
    this.u['uStreak'] = streakTex === Texture.EMPTY ? 0 : q.streak;
    const dof = this.u['uDof'] as number[];
    dof[0] = dofTex === Texture.EMPTY ? 0 : this.dofAmount;
    dof[1] = (q.dof * Math.min(fw, fh)) / 1080;
    this.u['uDof'] = dof;
    // Radii are specified at 1080p; scale by the SHORTER frame dimension so a
    // tall phone frame (2532 px high at dpr 3) does not multiply them by 2.3.
    const k = Math.min(fw, fh) / 1080;
    this.u['uWorldSoft'] = [
      this.worldBokeh * k,
      0,
      PostFilter.ROOM_GRAIN,
      this.worldBokeh > 0 ? 1 : 0,
    ];
    filterManager.applyFilter(this, input, output, clearMode);

    // Release the intermediates only after the composite has read them.
    this.textures.uBloomTexture = Texture.EMPTY.source;
    this.textures.uStreakTexture = Texture.EMPTY.source;
    this.textures.uDofTexture = Texture.EMPTY.source;
    for (const t of borrowed) TexturePool.returnTexture(t);
  }

  override destroy(destroyPrograms = false): void {
    for (const p of [this.bright, this.streakBright, ...this.down, ...this.up, ...this.hblur])
      p.destroy(destroyPrograms);
    super.destroy(destroyPrograms);
  }

  applyQuality(q: QualitySettings): void {
    this.q = q;
    this.bright.u['uThreshold'] = q.bloomThreshold;
    this.u['uChroma'] = q.chroma;
    this.u['uGrain'] = q.grain;
    this.u['uVignette'] = q.vignette;
    this.u['uGrade'] = q.heatGrade;
    const tone = this.u['uTone'] as number[];
    tone[0] = q.tonemap;
    this.u['uTone'] = tone;
  }

  /** Frame-UV rect of the board plate; grain is masked out of it. The table column (plate through trays) stays sharp under the world soften. */
  setBoardRect(
    L: {
      boardX: number;
      boardY: number;
      boardSize: number;
      gap: number;
      hudY: number;
      cell: number;
      handY: number;
      handHeight: number;
    },
    w: number,
    h: number,
  ): void {
    const pad = L.gap * 3;
    this.u['uBoardRect'] = [
      (L.boardX - pad) / w,
      (L.boardY - pad) / h,
      (L.boardX + L.boardSize + pad) / w,
      (L.boardY + L.boardSize + pad) / h,
    ];
    const pitch = L.cell + L.gap;
    this.u['uRayGrid'] = [L.boardX / w, L.boardY / h, pitch / w, pitch / h];
    this.u['uRayCell'] = L.cell / pitch;
    this.u['uColumnRect'] = [
      (L.boardX - pad) / w,
      (L.boardY - pad) / h,
      (L.boardX + L.boardSize + pad) / w,
      (L.handY + L.handHeight) / h,
    ];
    this.u['uStreakEdge'] = (L.cell * 0.5) / w;
    // God rays fade to nothing from the board's top up to 60 px into the HUD band.
    const m = this.u['uRayMask'] as number[];
    m[0] = (L.hudY + 60) / h;
    m[1] = L.boardY / h;
    this.u['uRayMask'] = m;
  }

  /** Frame-UV y range of the banner band (rays attenuate inside it); pass -1 to clear. */
  setBannerBand(y0: number, y1: number): void {
    const m = this.u['uRayMask'] as number[];
    if (m[2] === y0 && m[3] === y1) return;
    m[2] = y0;
    m[3] = y1;
    this.u['uRayMask'] = m;
  }

  private shockT = 1;
  private shockStrength = 0;
  private shockX = 0.5;
  private shockY = 0.5;
  private raysT = 1;
  private raysStrength = 0;
  private raysX = 0.5;
  private raysY = 0.5;
  /** Seconds the god-ray pass lasts (the supernova; the results sting passes its own). */
  private static readonly RAYS_S = 0.32;
  private raysS = PostFilter.RAYS_S;

  setHeat(h: number): void {
    this.u['uHeat'] = h;
  }

  /** End of the game: desaturate (0..1) and darken (0..1) the whole frame, room and board, and hold it. */
  setEndGrade(desat: number, darken: number): void {
    const g = this.u['uEndGrade'] as number[];
    g[0] = Math.max(0, Math.min(1, desat));
    g[1] = Math.max(0, Math.min(1, darken));
    this.u['uEndGrade'] = g;
  }

  /** Start a shockwave from a frame-UV point. */
  shock(x: number, y: number, strength: number): void {
    this.shockX = x;
    this.shockY = y;
    this.shockT = 0;
    this.shockStrength = strength;
  }

  /**
   * Start a god-ray pass from a frame-UV point (4X supernova; the results
   * sting). `color` is the ray tint, warm white by default; `seconds` the
   * pass length.
   */
  rays(
    x: number,
    y: number,
    strength: number,
    color?: readonly [number, number, number],
    seconds = PostFilter.RAYS_S,
    maskTiles = false,
  ): void {
    this.raysX = x;
    this.raysY = y;
    this.raysT = 0;
    this.raysStrength = strength;
    this.raysS = seconds;
    this.u['uRayTileMask'] = maskTiles ? 1 : 0;
    const c = this.u['uRayColor'] as number[];
    const [r, g, b] = color ?? [1, 0.93, 0.8];
    c[0] = r;
    c[1] = g;
    c[2] = b;
    this.u['uRayColor'] = c;
  }

  /** Whether a ray pass with the tile mask is running (the caller feeds `setRayTiles`). */
  get raysMaskingTiles(): boolean {
    return this.raysT < 1 && (this.u['uRayTileMask'] as number) > 0;
  }

  /** Occupancy of the 100 cells for the rays' tile mask (only while `raysMaskingTiles`). */
  setRayTiles(filled: (i: number) => boolean): void {
    for (let g = 0; g < 3; g++) {
      const key = `uRayRows${g}`;
      const v = this.u[key] as number[];
      for (let k = 0; k < 4; k++) {
        const r = g * 4 + k;
        let mask = 0;
        if (r < 10) for (let c = 0; c < 10; c++) if (filled(r * 10 + c)) mask += 1 << c;
        v[k] = mask;
      }
      this.u[key] = v;
    }
  }

  /**
   * Eye adaptation: the exposure dips `eyeAdapt` EV (tier) after the supernova,
   * ramping in over 80 ms, holding 300 ms, recovering over 700 ms.
   */
  adapt(): void {
    if (this.q.eyeAdapt <= 0) return;
    this.adaptT = 0;
  }

  /**
   * Dim the ROOM (everything outside the plate, the same mask as the
   * adaptation) by `amount` (0..1 of its exposure) for `seconds`, ramping in
   * and out over DIM_RAMP_S — the results' loss cools the backdrop; the panel
   * and its text are emitters and keep their light. Never on the plate.
   */
  roomDim(amount: number, seconds: number): void {
    this.dimAmount = Math.max(0, Math.min(0.5, amount));
    this.dimT = 0;
    this.dimS = Math.max(DIM_RAMP_S * 2, seconds);
  }

  /**
   * Results focus pull: 0 = sharp, 1 = the full bokeh radius. `focalY` is the
   * frame-UV row in focus (the panel's centre); the radius grows below it.
   */
  setDof(amount: number, focalY = 0.5): void {
    this.dofAmount = Math.max(0, Math.min(1, amount));
    const dof = this.u['uDof'] as number[];
    dof[2] = focalY;
    this.u['uDof'] = dof;
  }

  /** Cap on the room's bloom + flash relative to the plate (1 = none; 0.6 on portrait). */
  setRoomLift(k: number): void {
    this.u['uRoomLift'] = Math.max(0, Math.min(1, k));
  }

  /** World soften: the room's disc radius in px at 1080p (a sub-pixel settle; 0 = off). */
  setWorldBokeh(px: number): void {
    this.worldBokeh = Math.max(0, px);
  }

  kick(strength: number): void {
    this.flash = Math.min(0.35, this.flash + strength);
  }

  update(timeSec: number, dtSec: number): void {
    this.flash = Math.max(0, this.flash - dtSec * 1.4);
    this.u['uTime'] = timeSec;
    this.u['uFlash'] = this.flash;
    // Exposure: base x the adaptation envelope (ramp in, hold, ease out).
    const total = ADAPT_IN_S + ADAPT_HOLD_S + ADAPT_OUT_S;
    let env = 0;
    if (this.adaptT < total) {
      this.adaptT = Math.min(total, this.adaptT + dtSec);
      const t = this.adaptT;
      if (t < ADAPT_IN_S) env = t / ADAPT_IN_S;
      else if (t < ADAPT_IN_S + ADAPT_HOLD_S) env = 1;
      else {
        const p = (t - ADAPT_IN_S - ADAPT_HOLD_S) / ADAPT_OUT_S;
        env = 1 - p * p * (3 - 2 * p);
      }
    }
    let dim = 1;
    if (this.dimT < this.dimS) {
      this.dimT = Math.min(this.dimS, this.dimT + dtSec);
      const t = this.dimT;
      const e =
        t < DIM_RAMP_S
          ? t / DIM_RAMP_S
          : t > this.dimS - DIM_RAMP_S
            ? (this.dimS - t) / DIM_RAMP_S
            : 1;
      dim = 1 - this.dimAmount * e;
    }
    this.u['uExposure'] = [
      this.q.exposure * Math.pow(2, -this.q.eyeAdapt * env) * dim,
      this.q.exposure,
    ];
    if (this.shockT < 1) this.shockT = Math.min(1, this.shockT + dtSec / 0.18);
    this.u['uShock'] = [
      this.shockX,
      this.shockY,
      this.shockT,
      this.shockT < 1 ? this.shockStrength : 0,
    ];
    if (this.raysT < 1) this.raysT = Math.min(1, this.raysT + dtSec / this.raysS);
    this.u['uRays'] = [this.raysX, this.raysY, this.raysT, this.raysT < 1 ? this.raysStrength : 0];
  }
}
