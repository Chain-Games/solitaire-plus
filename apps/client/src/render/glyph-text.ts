import {
  CanvasSource,
  CanvasTextGenerator,
  CanvasTextMetrics,
  Container,
  fontStringFromTextStyle,
  Sprite,
  Texture,
  type Renderer,
  type StrokeStyle,
  type TextStyle,
} from 'pixi.js';

/**
 * Pre-rasterised text for the clear frame.
 *
 * A Pixi `Text` re-rasterises its whole string on a canvas and uploads it
 * whenever the string or the style changes. On the clear-trigger frame that
 * was the banner's eight letters (a 22 px canvas shadow at resolution 2),
 * the streak pill and the float score at once: 13–15 ms of JS on an RTX
 * 2080, one dropped vsync per clear. Here every glyph a banner, pill or
 * float can show is rasterised ONCE — during the countdown, one glyph a
 * frame — through the very same canvas path (`CanvasTextGenerator`, the
 * style's font, stroke, letter spacing and shadow geometry), split into the
 * layers Pixi draws in sequence: the shadow (white, tinted and alpha'd at
 * show time — the banner takes the heat colour without a re-raster), the
 * stroke and the fill (white where the fill is tinted). A string is then
 * sprites placed at Pixi's own advances (`measureText` of the remaining
 * substring, so kerning holds), drawn shadow / stroke / fill in that order
 * exactly as one canvas would have composited them. Nothing rasterises or
 * uploads during play once the alphabet is in; a glyph outside it bakes on
 * demand.
 */

export interface GlyphLayers {
  shadow: boolean;
  stroke: boolean;
  fill: boolean;
  /** Stroke and fill composited in one texture (a letter that animates on its own). */
  body: boolean;
}

export interface Glyph {
  shadow: Texture | null;
  stroke: Texture | null;
  fill: Texture | null;
  body: Texture | null;
  /** Canvas size in CSS px (the same box a `Text` of this one char would have). */
  w: number;
  h: number;
}

/** Copy the text's frame out of a pooled (power-of-two) canvas into one of our own; the pool takes its canvas back. */
function copyCanvas(
  src: HTMLCanvasElement | OffscreenCanvas,
  w: number,
  h: number,
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(src as CanvasImageSource, 0, 0, w, h, 0, 0, w, h);
  return c;
}

/** The style's stroke when it is a stroke object (the only form the game uses). */
function strokeOf(style: TextStyle): StrokeStyle | null {
  const st = style.stroke;
  return st && typeof st === 'object' && 'width' in st ? (st as StrokeStyle) : null;
}

/**
 * What the baked pixels depend on: the font, size, spacing, fill, stroke,
 * padding and the shadow's geometry — not the shadow's colour or alpha,
 * which the sprites carry, so a banner recolouring its glow re-bakes nothing.
 */
function fingerprint(style: TextStyle, res: number): string {
  const st = strokeOf(style);
  const ds = style.dropShadow;
  const fill = style.fill;
  return [
    res,
    style.fontFamily,
    style.fontSize,
    style.fontWeight,
    style.fontStyle,
    style.letterSpacing,
    style.padding,
    typeof fill === 'object' ? JSON.stringify(fill) : String(fill),
    st ? `${String(st.color)}/${st.width}/${st.join}/${st.alpha ?? 1}` : '',
    ds ? `${ds.blur}/${ds.distance}/${ds.angle}` : '',
  ].join('|');
}

function textureOf(canvas: HTMLCanvasElement, res: number): Texture {
  return new Texture({
    source: new CanvasSource({
      resource: canvas,
      resolution: res,
      alphaMode: 'premultiply-alpha-on-upload',
    }),
  });
}

export class GlyphCache {
  private readonly glyphs = new Map<string, Glyph>();
  private queue: string[] = [];
  private alphabet = '';
  private measure: CanvasRenderingContext2D | null = null;
  private strokeStyle: TextStyle | null = null;
  private fillStyle: TextStyle | null = null;
  private key = '';

  /**
   * `style` is the live style (a font-size change at layout re-bakes every
   * glyph, ahead); `res` the text rasterisation resolution.
   */
  constructor(
    private readonly renderer: Renderer,
    readonly style: TextStyle,
    readonly res: number,
    readonly layers: GlyphLayers,
  ) {}

  /** The glyphs to bake ahead (one per `step()`); a char outside it bakes on first use. */
  setAlphabet(chars: string): void {
    this.alphabet = chars;
    this.requeue();
  }

  /** Re-bake when anything the pixels depend on has changed (the font size at layout). */
  private check(): void {
    const k = fingerprint(this.style, this.res);
    if (k === this.key) return;
    this.key = k;
    this.invalidate();
  }

  /** Every texture is stale: drop them and bake the alphabet again, ahead. */
  invalidate(): void {
    for (const g of this.glyphs.values()) {
      g.shadow?.destroy(true);
      g.stroke?.destroy(true);
      g.fill?.destroy(true);
      g.body?.destroy(true);
    }
    this.glyphs.clear();
    this.strokeStyle = null;
    this.fillStyle = null;
    this.measure = null;
    this.requeue();
  }

  private requeue(): void {
    this.queue = Array.from(new Set(Array.from(this.alphabet))).filter(
      (ch) => ch !== ' ' && !this.glyphs.has(ch),
    );
  }

  /** Whether glyphs are still waiting to be baked. */
  get pending(): boolean {
    this.check();
    return this.queue.length > 0;
  }

  /** Bake queued glyphs, at least one, until `budgetMs` has gone. */
  step(budgetMs = 2): void {
    this.check();
    if (this.queue.length === 0) return;
    const t0 = performance.now();
    do {
      const ch = this.queue.shift();
      if (ch === undefined) break;
      if (!this.glyphs.has(ch)) this.bake(ch);
    } while (this.queue.length > 0 && performance.now() - t0 < budgetMs);
  }

  /** The glyph for `ch`, baked now if it is not in yet. */
  get(ch: string): Glyph {
    this.check();
    let g = this.glyphs.get(ch);
    if (!g) {
      g = this.bake(ch);
      const i = this.queue.indexOf(ch);
      if (i >= 0) this.queue.splice(i, 1);
    }
    return g;
  }

  /**
   * Pixi's advance for char `i` of `text` (the remaining substring's width
   * less the rest's, plus the letter spacing): kerning against what follows
   * is kept, so a string composed of glyphs sits where one canvas put it.
   */
  advance(text: string, i: number): number {
    this.check();
    const ctx = this.measureContext();
    const rest = text.slice(i + 1);
    const here = text.slice(i);
    const w = ctx.measureText(here).width - (rest ? ctx.measureText(rest).width : 0);
    return w + this.style.letterSpacing;
  }

  /** The box a `Text` of this whole string would have, in CSS px (its anchor geometry). */
  box(text: string): { w: number; h: number } {
    const m = CanvasTextMetrics.measureText(text, this.style);
    return { w: Math.ceil(m.width), h: Math.ceil(m.height) };
  }

  private measureContext(): CanvasRenderingContext2D {
    if (!this.measure) {
      this.measure = document.createElement('canvas').getContext('2d')!;
      this.measure.font = fontStringFromTextStyle(this.style);
      this.measure.letterSpacing = '0px';
    }
    return this.measure;
  }

  /** Stroke-only and fill-only styles: the other pass transparent, the shadow silent, every measure identical. */
  private layerStyles(): { stroke: TextStyle; fill: TextStyle } {
    if (!this.strokeStyle || !this.fillStyle) {
      const s = this.style;
      const ds = s.dropShadow;
      const quiet = ds ? { ...ds, alpha: 0 } : false;
      const stroke = s.clone();
      stroke.fill = { color: 0xffffff, alpha: 0 };
      stroke.dropShadow = quiet;
      const fill = s.clone();
      const st = strokeOf(s);
      if (st) fill.stroke = { ...st, alpha: 0 };
      fill.dropShadow = quiet;
      this.strokeStyle = stroke;
      this.fillStyle = fill;
    }
    return { stroke: this.strokeStyle, fill: this.fillStyle };
  }

  private raster(text: string, style: TextStyle): HTMLCanvasElement {
    const { canvasAndContext, frame } = CanvasTextGenerator.getCanvasAndContext({
      text,
      style,
      resolution: this.res,
    });
    const c = copyCanvas(canvasAndContext.canvas as HTMLCanvasElement, frame.width, frame.height);
    CanvasTextGenerator.returnCanvasAndContext(canvasAndContext);
    return c;
  }

  private bake(ch: string): Glyph {
    const { stroke, fill } = this.layerStyles();
    const res = this.res;
    const sc = this.raster(ch, stroke);
    const fc = this.raster(ch, fill);
    const W = sc.width;
    const H = sc.height;
    const g: Glyph = { shadow: null, stroke: null, fill: null, body: null, w: W / res, h: H / res };
    const upload = (t: Texture): Texture => {
      this.renderer.texture.initSource(t.source);
      return t;
    };
    if (this.layers.body) {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(sc, 0, 0);
      ctx.drawImage(fc, 0, 0);
      g.body = upload(textureOf(c, res));
    }
    const ds = this.style.dropShadow;
    if (this.layers.shadow && ds) {
      // Pixi's shadow pass: the stroke then the fill drawn off-canvas so only
      // their shadows land — here from the two silhouettes, in white, the
      // alpha left to the sprite.
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d')!;
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = ds.blur * res;
      ctx.shadowOffsetX = Math.cos(ds.angle) * ds.distance * res;
      ctx.shadowOffsetY = Math.sin(ds.angle) * ds.distance * res + H;
      ctx.drawImage(sc, 0, -H);
      ctx.drawImage(fc, 0, -H);
      g.shadow = upload(textureOf(c, res));
    }
    if (this.layers.stroke) g.stroke = upload(textureOf(sc, res));
    if (this.layers.fill) g.fill = upload(textureOf(fc, res));
    this.glyphs.set(ch, g);
    return g;
  }
}

/**
 * A string of cached glyphs standing in for one `Text` with `anchor 0.5`:
 * `container` is positioned at the text's centre; scale, alpha and tint on
 * it work as they did on the Text. Three layers, shadow / stroke / fill,
 * each all the glyphs, drawn in that order.
 */
export class GlyphString {
  readonly container = new Container();
  private readonly shadows = new Container();
  private readonly strokes = new Container();
  private readonly fills = new Container();
  private readonly sprites: { shadow: Sprite; stroke: Sprite; fill: Sprite }[] = [];
  /** The text box in CSS px, unscaled. */
  width = 0;
  height = 0;
  private text = '';

  constructor(
    private readonly cache: GlyphCache,
    maxGlyphs: number,
  ) {
    this.container.addChild(this.shadows, this.strokes, this.fills);
    for (let i = 0; i < maxGlyphs; i++) {
      const shadow = new Sprite();
      const stroke = new Sprite();
      const fill = new Sprite();
      shadow.visible = stroke.visible = fill.visible = false;
      this.shadows.addChild(shadow);
      this.strokes.addChild(stroke);
      this.fills.addChild(fill);
      this.sprites.push({ shadow, stroke, fill });
    }
  }

  /** Shadow alpha (the style's, baked out of the texture) and colour. */
  setShadow(alpha: number, color: number): void {
    this.shadows.alpha = alpha;
    this.shadows.tint = color;
  }

  /** Tint on the fill only (the stroke keeps its colour). */
  setFill(color: number): void {
    this.fills.tint = color;
  }

  set(text: string): void {
    if (text === this.text) return;
    this.text = text;
    const chars = Array.from(text);
    const box = this.cache.box(text);
    this.width = box.w;
    this.height = box.h;
    this.container.pivot.set(box.w / 2, box.h / 2);
    let x = 0;
    let n = 0;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      const adv = this.cache.advance(text, i);
      if (ch !== ' ' && n < this.sprites.length) {
        const g = this.cache.get(ch);
        const s = this.sprites[n++]!;
        for (const [sp, t] of [
          [s.shadow, g.shadow],
          [s.stroke, g.stroke],
          [s.fill, g.fill],
        ] as const) {
          if (t) {
            sp.texture = t;
            sp.position.set(x, 0);
            sp.visible = true;
          } else sp.visible = false;
        }
      }
      x += adv;
    }
    for (let i = n; i < this.sprites.length; i++) {
      const s = this.sprites[i]!;
      s.shadow.visible = s.stroke.visible = s.fill.visible = false;
    }
  }
}
