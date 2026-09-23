import { Buffer, BufferUsage, Geometry, Mesh, Shader } from 'pixi.js';

/**
 * The holographic drop preview. Two small GLSL meshes, pooled once, nothing
 * allocated per frame; every number that varies by tier comes from quality.ts.
 *
 *   HoloGhost  a scanned projection of the piece (or of a line it would
 *              clear) in the piece's own hue, never a generic cyan: an SDF
 *              union of the footprint's rounded cells with an edge glow and
 *              halo, a faint fill scanlined at 40%, a scanline sweep travelling down the footprint on a
 *              1.1 s loop of the game clock, a lock-in flash the moment the
 *              placement becomes legal, and a red-tinted, dimmer variant
 *              while it is not. One quad per instance.
 *   HoloBeam   the projection: a column of light under the dragged piece, in
 *              the piece hue, additive, feathered at the sides and fading to
 *              nothing by the plate's bottom rim, with slow striations — the
 *              ghost reads as light cast by the piece, never a shadow.
 */

const HOLO_VERT = /* glsl */ `
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

const GHOST_FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;

uniform vec2 uSize;    // px: the quad
uniform float uMargin; // px: quad edge to the footprint's top-left
uniform vec2 uCell;    // px: one cell of the footprint (a whole line for line previews)
uniform float uPitch;  // px: cell pitch
uniform float uRadius; // px: cell corner radius
uniform float uSpan;   // px: footprint height, the sweep's travel
uniform int uCols;
uniform int uRows;
uniform float uMask;   // bit r * uCols + c set = cell present (<= 9 bits, exact in float; ES 1.00 has no >>)
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
uniform float uFlash;  // 0..1 lock-in flash
uniform float uSweep;  // sweep strength (0 while illegal)
uniform float uFill;   // fill strength (lines use less)
uniform float uEdge;   // px: edge core width
uniform float uScan;   // px: scanline period

float sdRoundRect(vec2 p, vec2 h, float r) {
  vec2 q = abs(p) - h + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 p = vUV * uSize - uMargin;
  float d = 1e5;
  for (int r = 0; r < 10; r++) {
    if (r >= uRows) break;
    for (int c = 0; c < 10; c++) {
      if (c >= uCols) break;
      if (mod(floor(uMask / exp2(float(r * uCols + c))), 2.0) < 0.5) continue;
      vec2 centre = vec2(float(c), float(r)) * uPitch + uCell * 0.5;
      d = min(d, sdRoundRect(p - centre, uCell * 0.5, uRadius));
    }
  }
  float inside = 1.0 - smoothstep(-1.0, 1.0, d);
  float w = uEdge;
  float edge = exp(-d * d / (w * w));
  float halo = exp(-d * d / (w * w * 14.0)) * 0.4;
  // Scanlines at 40% contrast, a soft line every uScan px.
  float f = fract(p.y / uScan);
  float scan = smoothstep(0.3, 0.5, f) * smoothstep(0.7, 0.5, f);
  float fill = inside * 0.14 * (0.6 + 0.4 * scan) * uFill;
  // The sweep: a band travelling down the footprint, 1.1 s per loop.
  float band = min(uCell.x, uCell.y) * 0.45;
  float ys = mix(-band, uSpan + band, fract(uTime / 1.1));
  float sw = exp(-(p.y - ys) * (p.y - ys) / (band * band)) * uSweep;
  // Holographic instability: a slow 7% shimmer, never a strobe.
  float flicker = 0.93 + 0.07 * sin(uTime * 37.0) * sin(uTime * 11.3);
  // Everything stays in the piece's own hue (the edge is not lifted toward
  // white, so bloom cannot bleach it to cyan); only the lock-in flash whitens.
  float i = fill + edge * 0.6 + halo + sw * (inside * 0.3 * uFill + edge * 0.7 + halo);
  i += uFlash * (inside * 0.4 + edge * 1.3 + halo * 2.0);
  float a = i * uAlpha * flicker;
  vec3 c = mix(uColor, vec3(1.0), uFlash * 0.7);
  finalColor = vec4(c * a, a);
}
`;

const BEAM_FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;

uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
uniform float uFlash;
uniform vec2 uSize;    // px: the quad
uniform float uFeather; // px: side feather
uniform float uHead;    // px: fade-in below the top edge

void main() {
  vec2 p = vUV * uSize;
  // A column of light under the piece: feathered sides, fading in just below
  // the piece and to nothing by the plate's bottom rim. Additive only — it can
  // never darken the sockets.
  float side = smoothstep(0.0, uFeather, p.x) * smoothstep(uSize.x, uSize.x - uFeather, p.x);
  float head = smoothstep(0.0, uHead, p.y);
  float along = 1.0 - vUV.y;
  // Slow striations drifting down the column.
  float stria = 0.9 + 0.1 * sin(vUV.x * 19.0 - vUV.y * 11.0 + uTime * 1.8);
  float a = uAlpha * side * head * along * stria * (1.0 + uFlash * 1.5);
  vec3 c = mix(uColor, vec3(1.0), uFlash * 0.5);
  finalColor = vec4(c * a, a);
}
`;

type U = Record<string, unknown>;

function uniformsOf(shader: Shader, group: string): U {
  return (shader.resources as Record<string, { uniforms: U }>)[group]!.uniforms;
}

function setColor(u: U, key: string, color: number): void {
  const c = u[key] as number[];
  c[0] = ((color >> 16) & 0xff) / 255;
  c[1] = ((color >> 8) & 0xff) / 255;
  c[2] = (color & 0xff) / 255;
  u[key] = c;
}

export class HoloGhost {
  readonly mesh: Mesh<Geometry, Shader>;
  private readonly shader: Shader;
  private readonly positions: Buffer;
  private readonly posData = new Float32Array(8);
  private readonly u: U;

  constructor() {
    this.positions = new Buffer({
      data: this.posData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: this.positions, format: 'float32x2' },
        aUV: {
          buffer: new Buffer({
            data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
            usage: BufferUsage.VERTEX,
          }),
          format: 'float32x2',
        },
      },
      indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
    });
    this.shader = Shader.from({
      gl: { vertex: HOLO_VERT, fragment: GHOST_FRAG, name: 'blockari-holo-ghost' },
      resources: {
        ghostUniforms: {
          uSize: { value: [1, 1], type: 'vec2<f32>' },
          uMargin: { value: 0, type: 'f32' },
          uCell: { value: [1, 1], type: 'vec2<f32>' },
          uPitch: { value: 1, type: 'f32' },
          uRadius: { value: 0, type: 'f32' },
          uSpan: { value: 1, type: 'f32' },
          uCols: { value: 1, type: 'i32' },
          uRows: { value: 1, type: 'i32' },
          uMask: { value: 1, type: 'f32' },
          uColor: { value: [1, 1, 1], type: 'vec3<f32>' },
          uAlpha: { value: 0, type: 'f32' },
          uTime: { value: 0, type: 'f32' },
          uFlash: { value: 0, type: 'f32' },
          uSweep: { value: 1, type: 'f32' },
          uFill: { value: 1, type: 'f32' },
          uEdge: { value: 2, type: 'f32' },
          uScan: { value: 6, type: 'f32' },
        },
      },
    });
    this.u = uniformsOf(this.shader, 'ghostUniforms');
    this.mesh = new Mesh({ geometry, shader: this.shader });
    this.mesh.blendMode = 'add';
    this.mesh.visible = false;
  }

  /**
   * Show a footprint: `cols` x `rows` cells of `cellW` x `cellH` px at
   * `pitch`, top-left at (x, y), cells present where bit (r * cols + c) of
   * `mask` is set. `fill` and `sweep` scale those two layers; `legal` picks
   * the colour treatment.
   */
  show(
    x: number,
    y: number,
    cols: number,
    rows: number,
    mask: number,
    cellW: number,
    cellH: number,
    pitch: number,
    color: number,
    alpha: number,
    edgePx: number,
    scanPx: number,
    fill: number,
    sweep: number,
  ): void {
    const w = (cols - 1) * pitch + cellW;
    const h = (rows - 1) * pitch + cellH;
    const margin = Math.max(edgePx * 5, Math.min(cellW, cellH) * 0.35);
    const P = this.posData;
    P[0] = x - margin;
    P[1] = y - margin;
    P[2] = x + w + margin;
    P[3] = y - margin;
    P[4] = x + w + margin;
    P[5] = y + h + margin;
    P[6] = x - margin;
    P[7] = y + h + margin;
    this.positions.update();
    const u = this.u;
    const size = u['uSize'] as number[];
    size[0] = w + margin * 2;
    size[1] = h + margin * 2;
    u['uSize'] = size;
    u['uMargin'] = margin;
    const cell = u['uCell'] as number[];
    cell[0] = cellW;
    cell[1] = cellH;
    u['uCell'] = cell;
    u['uPitch'] = pitch;
    u['uRadius'] = Math.min(cellW, cellH) * 0.18;
    u['uSpan'] = h;
    u['uCols'] = cols;
    u['uRows'] = rows;
    u['uMask'] = mask;
    setColor(u, 'uColor', color);
    u['uAlpha'] = alpha;
    u['uEdge'] = edgePx;
    u['uScan'] = scanPx;
    u['uFill'] = fill;
    u['uSweep'] = sweep;
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  /** Per frame while visible. */
  set(timeSec: number, flash: number): void {
    this.u['uTime'] = timeSec;
    this.u['uFlash'] = flash;
  }
}

export class HoloBeam {
  readonly mesh: Mesh<Geometry, Shader>;
  private readonly shader: Shader;
  private readonly positions: Buffer;
  private readonly posData = new Float32Array(8);
  private readonly u: U;

  constructor() {
    this.positions = new Buffer({
      data: this.posData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: this.positions, format: 'float32x2' },
        aUV: {
          buffer: new Buffer({
            data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
            usage: BufferUsage.VERTEX,
          }),
          format: 'float32x2',
        },
      },
      indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
    });
    this.shader = Shader.from({
      gl: { vertex: HOLO_VERT, fragment: BEAM_FRAG, name: 'blockari-holo-beam' },
      resources: {
        beamUniforms: {
          uColor: { value: [1, 1, 1], type: 'vec3<f32>' },
          uAlpha: { value: 0, type: 'f32' },
          uTime: { value: 0, type: 'f32' },
          uFlash: { value: 0, type: 'f32' },
          uSize: { value: [1, 1], type: 'vec2<f32>' },
          uFeather: { value: 1, type: 'f32' },
          uHead: { value: 1, type: 'f32' },
        },
      },
    });
    this.u = uniformsOf(this.shader, 'beamUniforms');
    this.mesh = new Mesh({ geometry, shader: this.shader });
    this.mesh.blendMode = 'add';
    this.mesh.visible = false;
  }

  /**
   * The light column: from the piece's span (x0..x1, already including the
   * feather) at `y0` (just inside the piece) down to `y1` (the plate's bottom
   * rim), feathered `feather` px at the sides and fading in over `head` px.
   */
  show(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    feather: number,
    head: number,
    color: number,
    alpha: number,
    timeSec: number,
    flash: number,
  ): void {
    const P = this.posData;
    P[0] = x0;
    P[1] = y0;
    P[2] = x1;
    P[3] = y0;
    P[4] = x1;
    P[5] = y1;
    P[6] = x0;
    P[7] = y1;
    this.positions.update();
    const size = this.u['uSize'] as number[];
    size[0] = x1 - x0;
    size[1] = y1 - y0;
    this.u['uSize'] = size;
    this.u['uFeather'] = feather;
    this.u['uHead'] = head;
    setColor(this.u, 'uColor', color);
    this.u['uAlpha'] = alpha;
    this.u['uTime'] = timeSec;
    this.u['uFlash'] = flash;
    this.mesh.visible = y1 > y0 + 1;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}
