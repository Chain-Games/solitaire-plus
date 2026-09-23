import { Geometry, Mesh, Shader } from 'pixi.js';
import { PALETTE } from '../palette.js';

/**
 * Full-screen animated backdrop: layered value-noise fbm drifting slowly
 * through the palette's deep blues, with a faint isometric grid and a soft
 * radial falloff so the board reads as the brightest thing on screen.
 *
 * Two slow parallax light shafts (soft additive bands leaning about -20 deg)
 * drift across on top of the noise: a narrow, dim "far" one and a wider, a
 * touch brighter "near" one moving faster, so the backdrop has depth. Streak
 * heat warms them and doubles their speed. They are evaluated in the same
 * fragment pass, so they cost a few ALU ops and no extra draw.
 *
 * Octave count comes from the quality tier. Everything else is constant.
 */

const VERT = /* glsl */ `
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

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;

uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform float uPulse;
uniform int uOctaves;
uniform float uHeat;
// Shaft drift, accumulated on the CPU (1 unit = one full crossing at heat 0)
// so a heat change speeds the shafts up instead of scrubbing them.
uniform float uShaftPhase;

// Hash and value noise. Cheap, tileable enough for a backdrop; no texture fetch.
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// One soft shaft per period along s: a gaussian across the band, no hard edge.
float shaft(float s, float halfWidth) {
  float f = fract(s) - 0.5;
  return exp(-(f * f) / (halfWidth * halfWidth));
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  // Rotate each octave so the lattice never lines up and shows as a grid.
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 6; i++) {
    if (i >= uOctaves) break;
    v += amp * vnoise(p);
    p = rot * p * 2.03 + 11.7;
    amp *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = vUV;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2(uv.x * aspect, uv.y);

  // Streak heat speeds the drift and warms the veins.
  float t = uTime * 0.035 * (1.0 + uHeat * 2.0);
  float n1 = fbm(p * 2.2 + vec2(t, -t * 0.7));
  float n2 = fbm(p * 4.5 - vec2(t * 0.5, t * 0.9) + n1 * 0.6);

  // Two-tone base, then a third colour breathing through the brighter veins.
  vec3 col = mix(uColorA, uColorB, smoothstep(0.25, 0.85, n1));
  // Warm light, never smoke: past heat 0.8 the veins go warm-white.
  vec3 veins = mix(uColorC, vec3(0.85, 0.55, 0.25), uHeat);
  veins = mix(veins, vec3(1.0, 0.886, 0.72), smoothstep(0.8, 1.0, uHeat) * 0.3);
  // Clamp chroma so the fbm can never resolve to brown: pull toward its own luma.
  float vl = dot(veins, vec3(0.299, 0.587, 0.114));
  veins = mix(vec3(vl), veins, 0.75);
  col = mix(col, veins, smoothstep(0.62, 0.95, n2) * (0.55 + uHeat * 0.35));

  // Subtle grid, fading with distance from centre.
  vec2 g = abs(fract(p * 7.0 + 0.5) - 0.5);
  float grid = 1.0 - smoothstep(0.0, 0.04, min(g.x, g.y));
  float d = distance(uv, vec2(0.5));
  col += grid * 0.015 * (1.0 - smoothstep(0.1, 0.7, d));

  // Parallax light shafts. Band coordinate along the normal of a line tilted
  // -20 deg from vertical; the far shaft is narrow and slow, the near one wide
  // and faster (parallax by depth). Haze (n1) breaks them up, and they fade
  // towards the bottom so they read as light falling from above.
  vec2 shaftN = vec2(0.9397, -0.3420);
  float sc = dot(p, shaftN) / (aspect + 0.6);
  float far = shaft(sc - uShaftPhase * 0.55 + 0.15, 0.055);
  float nearS = sc * 0.8 - uShaftPhase * 0.7 + 0.62;
  // Wide soft body with a narrower core, so it reads as a shaft, not a lift.
  float near = shaft(nearS, 0.12) * 0.6 + shaft(nearS, 0.045) * 0.6;
  float haze = 0.6 + 0.4 * n1;
  float fromAbove = 1.0 - uv.y * 0.55;
  vec3 shaftCool = vec3(0.30, 0.36, 0.78);
  vec3 shaftWarm = vec3(0.95, 0.72, 0.45);
  vec3 shaftCol = mix(shaftCool, shaftWarm, uHeat);
  // Visible at heat 0 (the outer thirds must not read as black), stronger hot.
  float shafts = (far * 0.2 + near * 0.3) * haze * fromAbove * (1.0 + uHeat * 0.6);
  col += shaftCol * shafts;

  // Pulse on big clears: a brief lift in the veins.
  col += uColorC * uPulse * smoothstep(0.5, 0.9, n2) * 0.35;

  // Radial falloff so the edges sink away.
  col *= 1.0 - smoothstep(0.35, 1.1, d) * 0.75;

  finalColor = vec4(col, 1.0);
}
`;

/** Seconds for the near shaft to cross the screen once at heat 0. */
const SHAFT_PERIOD_S = 40;

function rgb(color: number): [number, number, number] {
  return [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255];
}

export class Background {
  readonly mesh: Mesh<Geometry, Shader>;
  private readonly shader: Shader;
  private pulse = 0;
  private heat = 0;
  /** Shaft drift in crossings; one crossing takes SHAFT_PERIOD_S at heat 0. */
  private shaftPhase = 0;

  constructor(octaves: number) {
    const geometry = new Geometry({
      attributes: {
        aPosition: [0, 0, 1, 0, 1, 1, 0, 1],
        aUV: [0, 0, 1, 0, 1, 1, 0, 1],
      },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });
    this.shader = Shader.from({
      gl: { vertex: VERT, fragment: FRAG, name: 'blockari-background' },
      resources: {
        bgUniforms: {
          uTime: { value: 0, type: 'f32' },
          uResolution: { value: [1, 1], type: 'vec2<f32>' },
          uColorA: { value: rgb(PALETTE.bgDeep), type: 'vec3<f32>' },
          uColorB: { value: rgb(0x151a3a), type: 'vec3<f32>' },
          uColorC: { value: rgb(0x2b2f6e), type: 'vec3<f32>' },
          uPulse: { value: 0, type: 'f32' },
          uOctaves: { value: octaves, type: 'i32' },
          uHeat: { value: 0, type: 'f32' },
          uShaftPhase: { value: 0, type: 'f32' },
        },
      },
    });
    this.mesh = new Mesh({ geometry, shader: this.shader });
  }

  private get u(): Record<string, unknown> {
    return (this.shader.resources as { bgUniforms: { uniforms: Record<string, unknown> } })
      .bgUniforms.uniforms;
  }

  /** Fill the viewport, overscanning by `margin` px on every side (for the camera's parallax). */
  resize(width: number, height: number, margin = 0): void {
    this.mesh.position.set(-margin, -margin);
    this.mesh.scale.set(width + margin * 2, height + margin * 2);
    this.u['uResolution'] = [width + margin * 2, height + margin * 2];
  }

  setOctaves(n: number): void {
    this.u['uOctaves'] = n;
  }

  setHeat(h: number): void {
    this.heat = h;
    this.u['uHeat'] = h;
  }

  kick(strength: number): void {
    this.pulse = Math.min(1, this.pulse + strength);
  }

  update(timeSec: number, dtSec: number): void {
    this.pulse = Math.max(0, this.pulse - dtSec * 1.6);
    // Heat doubles the shaft speed. Keep the phase bounded; the shader only
    // ever sees fract() of it (at 0.55x it repeats every 20 crossings).
    this.shaftPhase = (this.shaftPhase + (dtSec / SHAFT_PERIOD_S) * (1 + this.heat)) % 20;
    this.u['uTime'] = timeSec;
    this.u['uPulse'] = this.pulse;
    this.u['uShaftPhase'] = this.shaftPhase;
  }
}
