import {
  Buffer,
  BufferUsage,
  Geometry,
  Matrix,
  Mesh,
  RenderTexture,
  Shader,
  Texture,
  type Container,
  type Renderer,
} from 'pixi.js';

/**
 * Floor reflection: the table under the plate is a dark gloss, so the board
 * mirrors into it — the rim band, the hot line, the tile faces, every glow on
 * the plate — flipped about the plate's bottom edge, sharp for the first band
 * then blurred more with distance, fading to nothing within ~1.6 cells and
 * never crossing the trays.
 *
 * Once per frame the source layers (the plate's rim lights and the tile
 * layer) are rendered into ONE small render texture covering only the band
 * of the board that can still show below the edge, at a fraction of the frame
 * resolution (`reflectionScale` from the tier). A single mesh then samples it
 * flipped: the vertical blur, the fade, the luma knee (only light reflects,
 * not the dark sockets) and the tray cut-outs are all in the fragment shader,
 * so the whole effect is two tiny render passes and one draw — no
 * filters, no masks. Nothing here allocates per frame.
 *
 * Look constants (not tier numbers) live at the top of this file; the
 * strength is ~45% at the edge for the tile faces, so the bottom row's
 * colours are unmistakably mirrored, and the surface is drawn as a plane: a
 * 1 px lighter horizon line along the plate's bottom edge and a sharp first
 * band (SHARP_PX) before the blur takes over.
 */

/** Strength at the plate edge, cold and hot. */
const EDGE_ALPHA_COLD = 0.55;
const EDGE_ALPHA_HOT = 0.6;
/** The reflection is gone this many cells below the plate edge. */
const FADE_CELLS = 1.6;
/** Band of the board that is rendered: the fade plus room for the blur to sample. */
const REACH_CELLS = 2.0;
/**
 * Vertical foreshortening of the mirror image: the table is seen from above,
 * so the reflection is squashed toward the edge the way a floor reflection
 * is, and the bottom row's faces surface in the strip between the plate and
 * the trays instead of vanishing under them.
 */
const SQUASH = 0.35;
/** Vertical blur radius at the far end of the fade, in canvas px. */
const BLUR_PX = 6;
/** The first band below the edge is nearly sharp (this fraction of the far blur), then it ramps up. */
const SHARP_PX = 12;
const SHARP_BLUR = 0.15;
/** Horizon: a 1 px lighter line along the plate's bottom edge, its alpha and tint. */
const HORIZON_ALPHA = 0.22;
const HORIZON_TINT = [0.72, 0.78, 1.0] as const;
/** Luma below which a source pixel reflects nothing (the sockets) and above which it reflects fully. */
const KNEE_LO = 0.12;
const KNEE_HI = 0.3;
/** Feather on the tray cut-outs, px. */
const TRAY_FEATHER = 2.5;

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

uniform sampler2D uTexture;
uniform vec2 uTexel;    // one source texel in UV
uniform float uAlpha;   // strength at the plate edge
uniform float uFade;    // v at which the reflection has faded out
uniform float uBlur;    // blur radius at the far end, in texels
uniform int uTaps;      // odd tap count, 1 = none
uniform vec4 uRect;     // the mesh in canvas px: x, y, w, h
uniform vec4 uTray0;    // tray cut-outs in canvas px: x, y, w, h
uniform vec4 uTray1;
uniform vec4 uTray2;
uniform float uTrayR;   // tray corner radius
uniform float uFeather;
uniform vec2 uKnee;     // luma knee lo, hi
uniform float uSharpPx; // px below the edge that stay nearly sharp
uniform float uSharpK;  // blur fraction inside that band
uniform vec4 uHorizon;  // rgb tint, alpha of the 1 px horizon line
uniform vec2 uEdge;     // the plate's flat bottom edge in canvas px: x0, x1

float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// 1 outside the tray, 0 inside, feathered at the edge.
float outside(vec2 px, vec4 t) {
  float d = sdRoundRect(px - (t.xy + t.zw * 0.5), t.zw * 0.5, uTrayR);
  return smoothstep(-uFeather * 0.5, uFeather, d);
}

void main() {
  float v = vUV.y; // 0 at the plate edge, 1 at the far end of the band
  vec2 px = uRect.xy + vUV * uRect.zw;
  float mask = outside(px, uTray0) * outside(px, uTray1) * outside(px, uTray2);
  float fade = 1.0 - smoothstep(0.08, uFade, v);
  fade *= sqrt(fade);
  float a = uAlpha * fade * mask;
  float below = v * uRect.w; // px below the plate edge
  // The horizon: one lighter pixel row where the slab meets its mirror image.
  float horizon = (1.0 - smoothstep(0.6, 1.6, below)) * uHorizon.a * mask;
  // Only along the slab's flat edge, easing out into the rounded corners.
  horizon *= smoothstep(uEdge.x - 4.0, uEdge.x + 6.0, px.x) * smoothstep(uEdge.y + 4.0, uEdge.y - 6.0, px.x);
  if (a < 0.002 && horizon < 0.002) {
    finalColor = vec4(0.0);
    return;
  }
  // The texture holds the band ABOVE the edge, so the mirror image reads it bottom-up.
  float sy = 1.0 - v;
  // Nearly sharp for the first band, then the blur grows with distance.
  float radius = uBlur * mix(uSharpK, 0.4 + 0.6 * v, smoothstep(uSharpPx, uSharpPx * 3.0, below));
  // Float arithmetic only: this compiles as GLSL ES 1.00 (no int max/abs).
  float hw = floor(float(uTaps) * 0.5);
  vec3 c = vec3(0.0);
  float wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    float fi = float(i);
    if (abs(fi) > hw) continue;
    float o = fi / max(hw, 1.0);
    float w = exp(-o * o * 2.0);
    float y = clamp(sy + o * radius * uTexel.y, uTexel.y * 0.5, 1.0 - uTexel.y * 0.5);
    c += texture(uTexture, vec2(vUV.x, y)).rgb * w;
    wsum += w;
  }
  c /= wsum;
  // Only light reflects: the sockets and the plate face stay in the floor.
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  // Normal (not additive) blending, so an orange tile mirrors orange on the
  // blue floor instead of lifting to pink; the knee drives the alpha too, so
  // what does not reflect leaves the floor untouched.
  float ka = a * smoothstep(uKnee.x, uKnee.y, l);
  float ha = horizon * (1.0 - ka);
  finalColor = vec4(c * ka + uHorizon.rgb * ha, ka + ha);
}
`;

export interface TrayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class FloorReflection {
  readonly mesh: Mesh<Geometry, Shader>;
  private readonly shader: Shader;
  private readonly positions: Buffer;
  private readonly posData = new Float32Array(8);
  private rt: RenderTexture | null = null;
  private readonly transform = new Matrix();
  private scale = 0;

  constructor() {
    this.positions = new Buffer({
      data: this.posData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: this.positions, format: 'float32x2' },
        aUV: [0, 0, 1, 0, 1, 1, 0, 1],
      },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });
    this.shader = Shader.from({
      gl: { vertex: VERT, fragment: FRAG, name: 'blockari-floor-reflection' },
      resources: {
        uTexture: Texture.EMPTY.source,
        floorUniforms: {
          uTexel: { value: [1, 1], type: 'vec2<f32>' },
          uAlpha: { value: 0, type: 'f32' },
          uFade: { value: FADE_CELLS / REACH_CELLS, type: 'f32' },
          uBlur: { value: BLUR_PX, type: 'f32' },
          uTaps: { value: 1, type: 'i32' },
          uRect: { value: [0, 0, 1, 1], type: 'vec4<f32>' },
          uTray0: { value: [0, 0, 0, 0], type: 'vec4<f32>' },
          uTray1: { value: [0, 0, 0, 0], type: 'vec4<f32>' },
          uTray2: { value: [0, 0, 0, 0], type: 'vec4<f32>' },
          uTrayR: { value: 1, type: 'f32' },
          uFeather: { value: TRAY_FEATHER, type: 'f32' },
          uKnee: { value: [KNEE_LO, KNEE_HI], type: 'vec2<f32>' },
          uSharpPx: { value: SHARP_PX, type: 'f32' },
          uSharpK: { value: SHARP_BLUR, type: 'f32' },
          uHorizon: { value: [...HORIZON_TINT, HORIZON_ALPHA], type: 'vec4<f32>' },
          uEdge: { value: [0, 1], type: 'vec2<f32>' },
        },
      },
    });
    this.mesh = new Mesh({ geometry, shader: this.shader });
    this.mesh.blendMode = 'normal';
    this.mesh.visible = false;
  }

  private get u(): Record<string, unknown> {
    return (this.shader.resources as { floorUniforms: { uniforms: Record<string, unknown> } })
      .floorUniforms.uniforms;
  }

  /** Whether the tier has it on and a frame has been captured. */
  get enabled(): boolean {
    return this.scale > 0;
  }

  /**
   * Plate rect (px, py, size), the cell size, the tray rects to cut out (and
   * their corner radius), the plate's corner radius, the render-texture scale
   * (0 disables) and the blur tap count.
   */
  layout(
    px: number,
    py: number,
    ps: number,
    cell: number,
    trays: readonly TrayRect[],
    trayRadius: number,
    plateRadius: number,
    scale: number,
    taps: number,
  ): void {
    this.scale = scale;
    if (scale <= 0) {
      this.mesh.visible = false;
      return;
    }
    const reach = cell * REACH_CELLS;
    const drawn = reach * SQUASH;
    // Room at the sides for the rim band's glow to mirror too.
    const m = cell * 0.6;
    const x0 = px - m;
    const w = ps + m * 2;
    const yEdge = py + ps;
    const P = this.posData;
    P[0] = x0;
    P[1] = yEdge;
    P[2] = x0 + w;
    P[3] = yEdge;
    P[4] = x0 + w;
    P[5] = yEdge + drawn;
    P[6] = x0;
    P[7] = yEdge + drawn;
    this.positions.update();

    const tw = Math.max(1, Math.ceil(w * scale));
    const th = Math.max(1, Math.ceil(reach * scale));
    if (!this.rt) {
      this.rt = RenderTexture.create({
        width: tw,
        height: th,
        resolution: 1,
        antialias: false,
        scaleMode: 'linear',
      });
    } else if (this.rt.width !== tw || this.rt.height !== th) {
      this.rt.resize(tw, th);
    }
    (this.shader.resources as { uTexture: unknown }).uTexture = this.rt.source;
    // Source band: the `reach` above the plate edge, scaled into the texture.
    this.transform
      .identity()
      .translate(-x0, -(yEdge - reach))
      .scale(scale, scale);

    const u = this.u;
    u['uTexel'] = [1 / tw, 1 / th];
    // The blur is specified in canvas px; the texture is `scale` of that.
    u['uBlur'] = BLUR_PX * scale;
    u['uTaps'] = Math.max(1, taps | 1);
    u['uRect'] = [x0, yEdge, w, drawn];
    u['uEdge'] = [px + plateRadius, px + ps - plateRadius];
    const t = [u['uTray0'], u['uTray1'], u['uTray2']] as number[][];
    for (let i = 0; i < 3; i++) {
      const tr = trays[i];
      const v = t[i]!;
      v[0] = tr?.x ?? 0;
      v[1] = tr?.y ?? 0;
      v[2] = tr?.w ?? 0;
      v[3] = tr?.h ?? 0;
    }
    u['uTray0'] = t[0];
    u['uTray1'] = t[1];
    u['uTray2'] = t[2];
    u['uTrayR'] = trayRadius;
  }

  /** Per frame: strength from the streak heat (0..1). */
  set(heat: number): void {
    if (this.scale <= 0) return;
    this.u['uAlpha'] = EDGE_ALPHA_COLD + (EDGE_ALPHA_HOT - EDGE_ALPHA_COLD) * heat;
  }

  /**
   * Render the source layers into the texture, in order, the first one
   * clearing it. Call once per frame before the stage renders (the layers
   * are drawn again, normally, by the stage).
   */
  capture(renderer: Renderer, layers: readonly Container[]): void {
    if (this.scale <= 0 || !this.rt) return;
    let cleared = false;
    for (const c of layers) {
      if (!c.visible) continue;
      renderer.render({
        container: c,
        target: this.rt,
        clear: !cleared,
        clearColor: [0, 0, 0, 0],
        transform: this.transform,
      });
      cleared = true;
    }
    if (!cleared) renderer.clear({ target: this.rt, clearColor: [0, 0, 0, 0] });
    this.mesh.visible = true;
  }

  destroy(): void {
    this.rt?.destroy(true);
    this.rt = null;
    this.mesh.destroy();
  }
}
