import {
  BlurFilter,
  Buffer,
  BufferUsage,
  Container,
  Geometry,
  Graphics,
  Mesh,
  Rectangle,
  RenderTexture,
  Shader,
  Sprite,
  Texture,
  type Renderer,
} from 'pixi.js';
import { PIECE_COLORS } from './palette.js';
import { bakeChunks, type Textures } from './textures.js';

/**
 * Tile material: the filled board tiles as objects on a surface.
 *
 *   TileMaterial  one mesh of up to rows*cols quads, each sampling the tile
 *                 albedo atlas and a baked normal map, lit per fragment by a
 *                 fixed key (top-left, elevated) and a moving light that is
 *                 the dragged piece, with a two-lobe Blinn specular and a
 *                 per-tile rim light from the hot line and the plate's rim
 *                 band. Tier numbers come from quality.ts; the look constants
 *                 live here.
 *   ContactAO     one contact-shadow / occlusion stamp per filled tile,
 *                 darkening the gaps and the socket edges beside it; stamps
 *                 accumulate where tiles neighbour each other.
 *   PieceShadow   the dragged piece's shadow as its true shape, gaussian
 *                 blurred with a penumbra that grows with lift height.
 *
 * Nothing here allocates per frame: the vertex data is written into
 * preallocated typed arrays and uploaded once per frame.
 */

// --- Look constants (not tier numbers: none of them cost anything) ----------

/** Ambient and key-light terms: a flat top face under the fixed key multiplies to ~1.0. */
const AMBIENT = 0.78;
const DIFFUSE = 0.42;
/**
 * Specular lobes (exponent, strength): a broad satin sheen across the face, a
 * mid lobe that pools where the dome faces the light (the old baked glint),
 * and a very sharp glint that only the fillet's sweeping normals satisfy, so
 * it is a thin line travelling along the bevel and never a blob on the face.
 */
const SPEC_SOFT_POW = 20.0;
const SPEC_SOFT = 0.04;
const SPEC_MID_POW = 60.0;
const SPEC_MID = 0.06;
const SPEC_SHARP_POW = 260.0;
const SPEC_SHARP = 1.04;
/**
 * Gem glint: a tight white highlight on the top face, placed by the light the
 * way the old painted ellipse was placed by its implied key. The geometric
 * dome is too shallow to catch a lobe this tight anywhere on the face, so it
 * reflects off a virtual cushion instead: a normal that tilts (curvature x, y)
 * per unit of face offset, which puts the key's glint at ~(0.28, 0.19) of the
 * face (where the painted ellipse sat) and lets the drag light walk it
 * across. Exponent 400 gives a ~0.08 cell core with a short skirt; strength is its alpha (it
 * clears the bloom threshold on every colour, so it also blooms).
 */
const GEM_CURV_X = 0.9;
const GEM_CURV_Y = 0.85;
const GEM_POW = 400.0;
const GEM_STRENGTH = 0.6;
/**
 * The drag light's gem glint on resting tiles is the secondary pip: 0.6 of
 * the key's and fading with horizontal distance from the piece (the fade
 * reach is set per frame in cells), so a tile under the piece shows one
 * dominant pip and a soft second, never two equals.
 */
const GEM_PIECE_SCALE = 0.6;

/**
 * The fixed key light: offset from the board's top-left in board sizes (x, y,
 * height) and its falloff range in board sizes. The playfield lights the mesh
 * with it and the lit sprite bake reproduces it for a board-centre tile.
 */
export const KEY_RIG = { x: -0.9, y: -1.2, z: 2.0, range: 8 } as const;
/** The piece light's specular relative to the key's (it sits right over the tiles). */
const PIECE_SPEC = 0.35;
/** Rim light on the bevels: strength and how much of it is directional. */
const RIM_STRENGTH = 0.9;
/** Rose flash on a blocking tile: how far toward the danger colour it goes. */
const FLASH_MIX = 0.6;

const VERT = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
in vec4 aTile;
in vec4 aRim;
in vec3 aRimColor;
out vec2 vUV;
out vec2 vAlbUV;
out vec2 vPos;
out vec4 vTile;
out vec4 vRim;
out vec3 vRimColor;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uAtlas; // pad, step, tile, width (px)

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
  vPos = aPosition;
  vAlbUV = vec2((uAtlas.x + aTile.x * uAtlas.y + aUV.x * uAtlas.z) / uAtlas.w, aUV.y);
  vTile = aTile;
  vRim = aRim;
  vRimColor = aRimColor;
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
in vec2 vAlbUV;
in vec2 vPos;
in vec4 vTile;     // colour index, alpha, occlusion, flash
in vec4 vRim;      // direction toward the rim light (xy), intensity
in vec3 vRimColor;
out vec4 finalColor;

uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform vec3 uKeyPos;     // fixed key, px (z = height above the board)
uniform float uKeyK;
uniform float uKeyRange;
uniform vec3 uLightPos;   // the dragged piece
uniform vec3 uLightColor;
uniform float uLightK;
uniform float uLightRange;
uniform float uSpec;      // 1 = Blinn specular on
uniform vec3 uDanger;
uniform float uAmbient;
uniform float uDiffuse;
uniform vec4 uSpecLobes;  // soft pow, soft k, sharp pow, sharp k
uniform vec2 uSpecMid;    // mid pow, mid k
uniform float uRimK;
uniform float uFlashMix;
uniform float uPieceSpec;
uniform vec4 uGem;        // curvature x, curvature y, exponent, strength
uniform vec2 uGemPiece;   // drag-light glint: scale, fade reach (px)

// Diffuse and Blinn specular from one point light with a soft range falloff;
// gem is the tight glint off the virtual cushion normal ng.
vec3 light(vec3 n, vec3 ng, vec3 lp, float range, out float spec, out float gem) {
  vec3 d = lp - vec3(vPos, 0.0);
  float dist = max(length(d), 1.0);
  vec3 ld = d / dist;
  float att = 1.0 / (1.0 + (dist * dist) / (range * range));
  float nd = max(dot(n, ld), 0.0);
  vec3 hv = normalize(ld + vec3(0.0, 0.0, 1.0));
  float nh = max(dot(n, hv), 0.0);
  spec = (pow(nh, uSpecLobes.x) * uSpecLobes.y + pow(nh, uSpecMid.x) * uSpecMid.y + pow(nh, uSpecLobes.z) * uSpecLobes.w) * att;
  gem = pow(max(dot(ng, hv), 0.0), uGem.z) * uGem.w * att;
  return vec3(nd * att);
}

void main() {
  vec4 alb = texture(uAlbedo, vAlbUV);
  if (alb.a < 0.003) discard;
  vec3 n = normalize(texture(uNormal, vUV).xyz * 2.0 - 1.0);

  // Virtual cushion for the gem glint: the face only (the side band and the
  // fillet are masked by the real normal's tilt).
  vec3 ng = normalize(vec3((vUV - 0.5) * uGem.xy, 1.0));
  float face = smoothstep(0.55, 0.9, n.z);
  float specKey;
  float specPiece;
  float gemKey;
  float gemPiece;
  vec3 diff = light(n, ng, uKeyPos, uKeyRange, specKey, gemKey) * uKeyK;
  vec3 pieceCol = uLightColor;
  diff += light(n, ng, uLightPos, uLightRange, specPiece, gemPiece) * pieceCol * uLightK;
  // Albedo is premultiplied (a render texture), so the lit colour stays premultiplied.
  vec3 col = alb.rgb * (uAmbient + uDiffuse * diff);
  // Specular: white from the key, tinted halfway to the piece colour from the
  // piece and damped, since a light straight above a flat face would otherwise
  // fire the sharp lobe on every tile under it.
  vec3 spec = vec3(specKey * uKeyK) + mix(vec3(1.0), pieceCol, 0.5) * specPiece * uLightK * uPieceSpec;
  col += spec * uSpec * alb.a;
  // The gem glint: white, from both lights, on the face only.
  float gemNear = 1.0 - smoothstep(0.0, uGemPiece.y, length(uLightPos.xy - vPos));
  col += vec3(gemKey * uKeyK + gemPiece * uLightK * uGemPiece.x * gemNear) * face * uSpec * alb.a;
  // Rim light on the bevels facing the source (a little all round), in its colour.
  float nz = clamp(n.z, 0.0, 1.0);
  float grazing = pow(1.0 - nz, 1.3);
  vec2 nxy = n.xy / max(length(n.xy), 1e-4);
  float facing = max(dot(nxy, vRim.xy), 0.0);
  col += vRimColor * grazing * (0.3 + 0.7 * facing * facing) * vRim.z * uRimK * alb.a;
  // Soft occlusion under the hovering piece, then the rejected-drop rose flash.
  col *= 1.0 - vTile.z;
  col = mix(col, uDanger * alb.a, vTile.w * uFlashMix);
  finalColor = vec4(col, alb.a) * vTile.y;
}
`;

function rgb(color: number): [number, number, number] {
  return [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255];
}

export class TileMaterial {
  readonly mesh: Mesh<Geometry, Shader>;
  private readonly shader: Shader;
  private readonly positions: Buffer;
  private readonly tiles: Buffer;
  private readonly rims: Buffer;
  private readonly rimColors: Buffer;
  private readonly posData: Float32Array;
  private readonly tileData: Float32Array;
  private readonly rimData: Float32Array;
  private readonly rimColData: Float32Array;
  private readonly tex: Textures;
  private lit = 0;
  private level: 1 | 2 = 2;

  constructor(tex: Textures, count: number) {
    this.tex = tex;
    this.posData = new Float32Array(count * 4 * 2);
    this.tileData = new Float32Array(count * 4 * 4);
    this.rimData = new Float32Array(count * 4 * 4);
    this.rimColData = new Float32Array(count * 4 * 3);
    const uvData = new Float32Array(count * 4 * 2);
    const idx = new Uint16Array(count * 6);
    for (let i = 0; i < count; i++) {
      const v = i * 4;
      uvData.set([0, 0, 1, 0, 1, 1, 0, 1], v * 2);
      idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    const dyn = BufferUsage.VERTEX | BufferUsage.COPY_DST;
    this.positions = new Buffer({ data: this.posData, usage: dyn });
    this.tiles = new Buffer({ data: this.tileData, usage: dyn });
    this.rims = new Buffer({ data: this.rimData, usage: dyn });
    this.rimColors = new Buffer({ data: this.rimColData, usage: dyn });
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: this.positions, format: 'float32x2' },
        aUV: {
          buffer: new Buffer({ data: uvData, usage: BufferUsage.VERTEX }),
          format: 'float32x2',
        },
        aTile: { buffer: this.tiles, format: 'float32x4' },
        aRim: { buffer: this.rims, format: 'float32x4' },
        aRimColor: { buffer: this.rimColors, format: 'float32x3' },
      },
      indexBuffer: idx,
    });
    this.shader = Shader.from({
      gl: { vertex: VERT, fragment: FRAG, name: 'blockari-tile-material' },
      resources: {
        uAlbedo: tex.tileAtlasLit.source,
        uNormal: tex.tileNormal.source,
        tileUniforms: {
          uAtlas: {
            value: [tex.atlasPad, tex.atlasStep, tex.size, tex.atlasWidth],
            type: 'vec4<f32>',
          },
          uKeyPos: { value: [-1000, -1000, 1000], type: 'vec3<f32>' },
          uKeyK: { value: 1, type: 'f32' },
          uKeyRange: { value: 4000, type: 'f32' },
          uLightPos: { value: [0, 0, 100], type: 'vec3<f32>' },
          uLightColor: { value: [1, 1, 1], type: 'vec3<f32>' },
          uLightK: { value: 0, type: 'f32' },
          uLightRange: { value: 200, type: 'f32' },
          uSpec: { value: 1, type: 'f32' },
          uDanger: { value: [1, 0.36, 0.54], type: 'vec3<f32>' },
          uAmbient: { value: AMBIENT, type: 'f32' },
          uDiffuse: { value: DIFFUSE, type: 'f32' },
          uSpecLobes: {
            value: [SPEC_SOFT_POW, SPEC_SOFT, SPEC_SHARP_POW, SPEC_SHARP],
            type: 'vec4<f32>',
          },
          uSpecMid: { value: [SPEC_MID_POW, SPEC_MID], type: 'vec2<f32>' },
          uRimK: { value: RIM_STRENGTH, type: 'f32' },
          uFlashMix: { value: FLASH_MIX, type: 'f32' },
          uPieceSpec: { value: PIECE_SPEC, type: 'f32' },
          uGem: { value: [GEM_CURV_X, GEM_CURV_Y, GEM_POW, GEM_STRENGTH], type: 'vec4<f32>' },
          uGemPiece: { value: [GEM_PIECE_SCALE, 100], type: 'vec2<f32>' },
        },
      },
    });
    this.mesh = new Mesh({ geometry, shader: this.shader });
    this.mesh.visible = false;
  }

  private get u(): Record<string, unknown> {
    return (this.shader.resources as { tileUniforms: { uniforms: Record<string, unknown> } })
      .tileUniforms.uniforms;
  }

  /** 1 = painted albedo, no specular (medium); 2 = flat albedo + Blinn (ultra/high). */
  setQuality(level: 1 | 2): void {
    if (level === this.level) return;
    this.level = level;
    const src = level === 2 ? this.tex.tileAtlasLit.source : this.tex.tileAtlasPainted.source;
    (this.shader.resources as Record<string, unknown>)['uAlbedo'] = src;
    this.u['uSpec'] = level === 2 ? 1 : 0;
  }

  setDanger(color: number): void {
    this.u['uDanger'] = rgb(color);
  }

  /** The fixed key light: position (z above the board), falloff range, strength. */
  setKey(x: number, y: number, z: number, range: number, k: number): void {
    const p = this.u['uKeyPos'] as number[];
    p[0] = x;
    p[1] = y;
    p[2] = z;
    this.u['uKeyPos'] = p;
    this.u['uKeyRange'] = range;
    this.u['uKeyK'] = k;
  }

  /**
   * The moving light (the dragged piece): position, colour, range, strength
   * (0 = off), and how far (px) its gem glint reaches across resting tiles.
   */
  setLight(
    x: number,
    y: number,
    z: number,
    color: number,
    range: number,
    k: number,
    gemFade: number,
  ): void {
    const p = this.u['uLightPos'] as number[];
    p[0] = x;
    p[1] = y;
    p[2] = z;
    this.u['uLightPos'] = p;
    const c = this.u['uLightColor'] as number[];
    c[0] = ((color >> 16) & 0xff) / 255;
    c[1] = ((color >> 8) & 0xff) / 255;
    c[2] = (color & 0xff) / 255;
    this.u['uLightColor'] = c;
    this.u['uLightRange'] = range;
    this.u['uLightK'] = k;
    const g = this.u['uGemPiece'] as number[];
    g[1] = gemFade;
    this.u['uGemPiece'] = g;
  }

  /** Quad i: centre and half extents in mesh-local px. */
  place(i: number, cx: number, cy: number, hw: number, hh: number): void {
    const P = this.posData;
    const o = i * 8;
    P[o] = cx - hw;
    P[o + 1] = cy - hh;
    P[o + 2] = cx + hw;
    P[o + 3] = cy - hh;
    P[o + 4] = cx + hw;
    P[o + 5] = cy + hh;
    P[o + 6] = cx - hw;
    P[o + 7] = cy + hh;
  }

  /**
   * Quad i shows tile `color` (piece colour index; < 0 hides it), darkened by
   * `occl` (0..1) and pushed toward the danger colour by `flash` (0..1).
   */
  setTile(i: number, color: number, occl: number, flash: number): void {
    const T = this.tileData;
    const o = i * 16;
    const on = color >= 0;
    if (on) this.lit++;
    for (let v = 0; v < 4; v++) {
      T[o + v * 4] = on ? color : 0;
      T[o + v * 4 + 1] = on ? 1 : 0;
      T[o + v * 4 + 2] = occl;
      T[o + v * 4 + 3] = flash;
    }
  }

  /** Rim light for quad i: unit direction toward the source, intensity 0..1, colour. */
  setRim(i: number, dx: number, dy: number, k: number, r: number, g: number, b: number): void {
    const R = this.rimData;
    const C = this.rimColData;
    const o = i * 16;
    const oc = i * 12;
    for (let v = 0; v < 4; v++) {
      R[o + v * 4] = dx;
      R[o + v * 4 + 1] = dy;
      R[o + v * 4 + 2] = k;
      R[o + v * 4 + 3] = 0;
      C[oc + v * 3] = r;
      C[oc + v * 3 + 1] = g;
      C[oc + v * 3 + 2] = b;
    }
  }

  /** Call before the per-cell writes of a frame. */
  begin(): void {
    this.lit = 0;
  }

  /** Upload the frame's vertex data; the mesh draws only if any tile is lit. */
  commit(): void {
    this.mesh.visible = this.lit > 0;
    if (!this.mesh.visible) return;
    this.positions.update();
    this.tiles.update();
    this.rims.update();
    this.rimColors.update();
  }
}

// ---------------------------------------------------------------------------

/** Peak alpha of one AO stamp; the texture carries the falloff. */
const AO_ALPHA = 0.85;

export class ContactAO {
  readonly container = new Container();
  private readonly stamps: Sprite[] = [];
  private readonly inner: number;

  constructor(tex: Textures, count: number) {
    this.inner = tex.aoInner;
    for (let i = 0; i < count; i++) {
      const s = new Sprite(tex.aoStamp);
      s.anchor.set(0.5);
      s.visible = false;
      this.container.addChild(s);
      this.stamps.push(s);
    }
  }

  /** Stamp i sits under the cell centred at (x, y), `cellPx` wide. */
  place(i: number, x: number, y: number, cellPx: number): void {
    const s = this.stamps[i];
    if (!s) return;
    s.position.set(x, y);
    s.scale.set(cellPx / this.inner);
  }

  /** Stamp i at strength k (0 hides it). */
  set(i: number, k: number): void {
    const s = this.stamps[i];
    if (!s) return;
    const on = k > 0.004;
    s.visible = on;
    if (on) s.alpha = Math.min(1, k) * AO_ALPHA;
  }

  hideAll(): void {
    for (const s of this.stamps) s.visible = false;
  }
}

// ---------------------------------------------------------------------------

/** Shadow alpha at lift 0 and how much it fades as the piece rises. */
const SHADOW_ALPHA = 0.85;
const SHADOW_LIFT_FADE = 0.15;
/** Penumbra blur in cells at lift 0 and per unit of lift. */
const SHADOW_BLUR_BASE = 0.06;
const SHADOW_BLUR_LIFT = 0.18;
/** Shadow offset in cells (x, y) at lift 0 and per unit of lift: light from the top-left. */
const SHADOW_OFF_X = 0.3;
const SHADOW_OFF_X_LIFT = 0.5;
const SHADOW_OFF_Y = 0.3;
const SHADOW_OFF_Y_LIFT = 0.7;

/** Where the lifted piece's shadow lands relative to the piece, in px (also where its occlusion falls). */
export function shadowShiftX(lift: number, cellPx: number): number {
  return cellPx * (SHADOW_OFF_X + SHADOW_OFF_X_LIFT * lift);
}
export function shadowShiftY(lift: number, cellPx: number): number {
  return cellPx * (SHADOW_OFF_Y + SHADOW_OFF_Y_LIFT * lift);
}

export class PieceShadow {
  readonly container = new Container();
  private readonly shape = new Graphics();
  private readonly blur = new BlurFilter({ strength: 6, quality: 3 });

  constructor() {
    this.blur.padding = 64;
    this.shape.filters = [this.blur];
    this.container.addChild(this.shape);
    this.container.visible = false;
  }

  /** Redraw the shape: cells at their drag-layer-local centres, `cellPx` wide. */
  setShape(cells: readonly { x: number; y: number }[], cellPx: number): void {
    const g = this.shape;
    g.clear();
    const r = cellPx * 0.18;
    for (const c of cells) {
      g.roundRect(c.x - cellPx / 2, c.y - cellPx / 2, cellPx, cellPx, r);
    }
    g.fill({ color: 0x000000 });
  }

  /**
   * Per frame: the piece's top-left, grab pivot, tilt and scale, with `lift`
   * 0 (on the board) .. 1 (fully lifted). The shadow is the piece's size,
   * falls down-right of it (the key is top-left) and further, softer, as the
   * piece rises.
   */
  set(
    topLeftX: number,
    topLeftY: number,
    pivotX: number,
    pivotY: number,
    rotation: number,
    pieceScale: number,
    lift: number,
    cellPx: number,
    alphaMul: number,
  ): void {
    const a = (SHADOW_ALPHA - SHADOW_LIFT_FADE * lift) * alphaMul;
    this.container.visible = a > 0.004;
    if (!this.container.visible) return;
    // The shadow is the piece's size: a near key throws a shadow no smaller
    // than the object, and a smaller one reads as pulled toward the pivot.
    const s = pieceScale;
    this.container.position.set(
      topLeftX + pivotX * s + shadowShiftX(lift, cellPx),
      topLeftY + pivotY * s + shadowShiftY(lift, cellPx),
    );
    this.container.pivot.set(pivotX, pivotY);
    this.container.rotation = rotation;
    this.container.scale.set(s);
    this.container.alpha = a;
    this.blur.strength = Math.max(1, cellPx * (SHADOW_BLUR_BASE + SHADOW_BLUR_LIFT * lift));
  }

  hide(): void {
    this.container.visible = false;
  }
}

// ---------------------------------------------------------------------------

/** Padding between tiles in the lit bake strip, so bilinear sampling never bleeds. */
const BAKE_PAD = 4;
/** Nominal board size the bake's key is placed against (a board-centre tile's lighting). */
const BAKE_BOARD = 640;

/**
 * The lit look baked into sprite textures, so the hand, the dragged and
 * landing piece, the results chips and the fracture chunks are the same
 * material as the resting tiles: the nine tiles rendered through the same
 * shader, under the same key as a board-centre tile, into one strip. `tiles`
 * and `chunks` mirror `Textures.tiles` / `Textures.tileChunks` and stay valid
 * across re-bakes (the frames point at the one render texture).
 */
export class LitBake {
  readonly tiles: Texture[] = [];
  readonly chunks: Texture[][][] = [];
  readonly size: number;
  private readonly material: TileMaterial;
  private readonly target: RenderTexture;
  private readonly renderer: Renderer;
  private level: 1 | 2 | 0 = 0;

  constructor(renderer: Renderer, tex: Textures) {
    this.renderer = renderer;
    this.size = tex.size;
    const n = tex.tiles.length;
    const step = tex.size + BAKE_PAD * 2;
    this.material = new TileMaterial(tex, n);
    this.target = RenderTexture.create({ width: step * n, height: step, antialias: true });
    for (let i = 0; i < n; i++) {
      const t = new Texture({
        source: this.target.source,
        frame: new Rectangle(BAKE_PAD + i * step, BAKE_PAD, tex.size, tex.size),
      });
      this.tiles.push(t);
    }
  }

  /** Render the strip at this material level (1 = painted albedo, 2 = flat + specular). */
  bake(level: 1 | 2): void {
    if (level === this.level) return;
    this.level = level;
    const m = this.material;
    const step = this.size + BAKE_PAD * 2;
    const half = this.size / 2;
    m.setQuality(level);
    m.begin();
    for (let i = 0; i < this.tiles.length; i++) {
      m.place(i, BAKE_PAD + i * step + half, BAKE_PAD + half, half, half);
      m.setTile(i, i, 0, 0);
      m.setRim(i, 0, 0, 0, 0, 0, 0);
    }
    m.commit();
    m.setLight(0, 0, 100, 0xffffff, 100, 0, 100);
    m.mesh.visible = true;
    // One tile at a time: the key sits where a board-centre tile sees it.
    const B = BAKE_BOARD;
    for (let i = 0; i < this.tiles.length; i++) {
      const cx = BAKE_PAD + i * step + half;
      const cy = BAKE_PAD + half;
      m.setKey(
        cx + (KEY_RIG.x - 0.5) * B,
        cy + (KEY_RIG.y - 0.5) * B,
        KEY_RIG.z * B,
        KEY_RIG.range * B,
        1,
      );
      // Only quad i is drawn this pass: the others collapse to nothing.
      for (let j = 0; j < this.tiles.length; j++) m.setTile(j, j === i ? j : -1, 0, 0);
      m.commit();
      this.renderer.render({ container: m.mesh, target: this.target, clear: i === 0 });
    }
    m.mesh.visible = false;
    // Chunks are baked FROM the lit strip (thickness drawn over the lit
    // face), so they are re-baked whenever the strip is. Frames of the old
    // atlases are dropped; the fracture pool reads `tex.tileChunks` at spawn.
    for (const pats of this.chunks) for (const row of pats) for (const t of row) t.destroy(false);
    this.chunks.length = 0;
    for (let i = 0; i < this.tiles.length; i++)
      this.chunks.push(bakeChunks(this.renderer, this.tiles[i]!, PIECE_COLORS[i]!));
  }
}

/**
 * Point the shared texture set at the lit bake (or back at the painted bake
 * with `null`): everything that builds a piece from `tex.tiles`,
 * `tex.tilesHand` or `tex.tileChunks` from here on gets that look.
 */
export function applyTileLook(tex: Textures, lit: LitBake | null): void {
  tex.tiles = lit ? lit.tiles : tex.tilesPainted;
  tex.tileChunks = lit ? lit.chunks : tex.tileChunksPainted;
  tex.tilesHand = lit ? lit.tiles : tex.tilesHandPainted;
  tex.tilesHandPx = lit ? lit.size : tex.tilesHandPaintedPx;
}
