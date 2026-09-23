import {
  CanvasTextMetrics,
  Color,
  Container,
  Graphics,
  Sprite,
  Text,
  type Renderer,
  type TextStyle,
  type Texture,
} from 'pixi.js';
import { easeOutBack } from './effects.js';
import { GlyphCache } from './glyph-text.js';

/**
 * HUD motion: the score odometer and the per-letter banner. Both are pooled
 * Text objects allocated once at build; play only changes strings and
 * transforms. Tier gating lives in quality.ts (`odometer`, `bannerLetters`).
 */

/** Digit columns (the score never needs more). */
const ODO_COLUMNS = 7;
/** Squash-and-stretch on a big hit: duration and peak deformation. */
const ODO_SQUASH_S = 0.32;
const ODO_SQUASH_X = 0.1;
const ODO_STRETCH_Y = 0.18;
/** Column advance as a fraction of the widest digit's measured width (which includes stroke padding). */
const ODO_ADVANCE = 0.92;
/** A digit change plays as a 90 ms flip: the old glyph holds, then the new one rises into its seat. */
const ODO_ROLL_S = 0.09;
/**
 * The flip's phases, as fractions of ODO_ROLL_S: the old glyph HOLDS solid
 * (40 ms, so no frame shows an empty slot), then the new glyph takes the
 * slot SOLID and rises the last ODO_SLIDE of a row into its seat — a
 * split-flap, no alpha anywhere. Nothing squashes: a squashed glyph in a
 * still read as a wrong digit three critique rounds running (round 21:
 * "5 3 5", "33 8 5"); a blank slot was round 22's; and a crossfade (old
 * fading out over the new fading in) was round 53's — a still in the
 * overlap showed the whole score GREY ("20", "5 80"), because two glyphs at
 * α 0.3 are one glyph at α 0.5. Every frame of the flip is one solid digit.
 */
const ODO_HOLD = 0.44;
/** How far (in rows) the arriving digit rises into its seat, so the flip has a direction. */
const ODO_SLIDE = 0.12;

interface Column {
  /** The digit leaving (rising, fading out) and the one arriving (rising in from below). */
  a: Sprite;
  b: Sprite;
  /** Digit shown, the one it is leaving, and the roll's age (>= ODO_ROLL_S = settled). */
  cur: number;
  prev: number;
  t: number;
  /** Whether the column was on screen last frame (a column that appears snaps, it does not flip from 0). */
  on: boolean;
}

/**
 * The score as a mechanical odometer. Whenever a column's digit changes it
 * flips over 90 ms: the old glyph holds 40 ms, then the new one takes the
 * slot solid and rises the last 0.12 row into its seat — full size, full
 * alpha, one glyph at a time, never an empty slot, so a still always reads
 * as one solid digit in the HUD text colour, never a faint, squashed or
 * clipped fragment.
 * A column that changes again mid-flip snaps instead (a count-up counts, it
 * does not smear), so the flip is seen on the digit that finally settles.
 * The ten digits are rendered to textures at layout
 * only — a roll is sprite transforms and alpha, never text rendering.
 */
export class Odometer {
  readonly container = new Container();
  /** Scaled from its bottom-left for the squash so the baseline stays put. */
  private readonly scaler = new Container();
  /** The drum's window: a glyph rising into its seat is clipped to the row (it crossed the LV pill under a phone's score). */
  private readonly window = new Graphics();
  private readonly cols: Column[] = [];
  private readonly probe: Text;
  private digits: Texture[] = [];
  private advance = 30;
  private rowH = 60;
  private value = 0;
  private squashT = -1;
  private readonly columns: number;
  /** Columns on screen after the last apply (the drum's width is shown x advance). */
  private shown = 1;
  /** Each column's digit before this frame's change (for a carry's synced flip). */
  private wasCur: number[] = [];

  /** `res`: the text rasterisation resolution (the renderer's, capped; playfield.ts). */
  constructor(style: TextStyle, columns = ODO_COLUMNS, res = 1) {
    this.columns = columns;
    this.probe = new Text({ text: '8', style, resolution: res });
    this.container.addChild(this.scaler);
    this.scaler.addChild(this.window);
    this.scaler.mask = this.window;
    for (let i = 0; i < columns; i++) {
      const a = new Sprite();
      const b = new Sprite();
      // Digits sit centred in a fixed-advance column, like a real drum; the
      // flip fades about the glyph's middle.
      a.anchor.set(0.5, 0.5);
      b.anchor.set(0.5, 0.5);
      a.visible = b.visible = false;
      this.scaler.addChild(a, b);
      this.cols.push({ a, b, cur: 0, prev: 0, t: ODO_ROLL_S, on: false });
    }
  }

  /** Render the ten digits at the current style (font size); the widest sets the column advance. */
  layout(renderer: Renderer): void {
    // The measured width carries the stroke and shadow padding; the drum's
    // advance trims it so the digits sit as close as the plain text did.
    this.probe.text = '8';
    this.advance = this.probe.width * ODO_ADVANCE;
    this.rowH = this.probe.height;
    for (const t of this.digits) t.destroy(true);
    this.digits = [];
    for (let d = 0; d < 10; d++) {
      this.probe.text = String(d);
      this.digits.push(
        renderer.generateTexture({ target: this.probe, resolution: this.probe.resolution }),
      );
    }
    this.scaler.pivot.set(0, this.rowH);
    this.scaler.position.set(0, this.rowH);
    // The window is the row (every column): it scales with the squash.
    this.window
      .clear()
      .rect(0, 0, this.columns * this.advance, this.rowH)
      .fill({ color: 0xffffff });
    this.apply(0);
  }

  /** Place a settled glyph so its texture's top-left lands on a device pixel (at the texture's resolution). */
  private seat(sprite: Sprite, cx: number, cy: number): void {
    const t = sprite.texture;
    const r = t.source.resolution || 1;
    const left = Math.round((cx - t.width / 2) * r) / r;
    const top = Math.round((cy - t.height / 2) * r) / r;
    sprite.position.set(left + t.width / 2, top + t.height / 2);
  }

  /** Width of the digits on screen (columns shown x the drum's advance), and the row height. */
  get width(): number {
    return this.shown * this.advance;
  }

  get height(): number {
    return this.rowH;
  }

  /** Jump without rolling (initial sync). */
  reset(value: number): void {
    this.value = value;
    this.squashT = -1;
    this.scaler.scale.set(1);
    for (const col of this.cols) {
      col.cur = col.prev = this.digitAt(this.cols.indexOf(col));
      col.t = ODO_ROLL_S;
      col.on = false;
    }
    this.apply(0);
  }

  /** The continuous displayed value (a count-up eases it every frame); applied on update(). */
  set(value: number): void {
    this.value = value;
  }

  /** Squash-and-stretch on a big hit. */
  squash(): void {
    this.squashT = 0;
  }

  update(dt: number): void {
    this.apply(dt);
    if (this.squashT < 0) return;
    this.squashT += dt;
    const u = Math.min(1, this.squashT / ODO_SQUASH_S);
    // Damped sine: stretch up fast, dip under, settle.
    const k = Math.exp(-4 * u) * Math.sin(u * Math.PI * 2 * 1.25);
    this.scaler.scale.set(1 - ODO_SQUASH_X * k, 1 + ODO_STRETCH_Y * k);
    if (u >= 1) {
      this.squashT = -1;
      this.scaler.scale.set(1);
    }
  }

  private digitAt(i: number): number {
    return Math.floor(Math.max(0, this.value) / Math.pow(10, i)) % 10;
  }

  private apply(dt: number): void {
    if (this.digits.length < 10) return;
    const v = Math.max(0, this.value);
    const shown = Math.min(this.columns, Math.max(1, String(Math.floor(v)).length));
    this.shown = shown;
    // A carry flips as ONE number: when a column starts a flip, every column
    // below it flips in step (old glyphs out together, new ones in together)
    // instead of snapping ahead — a still of 576 → 580 read "570" while the
    // tens held its old glyph over an already-snapped ones column.
    let carryFrom = -1;
    for (let i = 0; i < this.columns; i++) {
      const col = this.cols[i]!;
      if (i >= shown) {
        col.a.visible = col.b.visible = false;
        col.on = false;
        continue;
      }
      const digit = this.digitAt(i);
      this.wasCur[i] = col.on ? col.cur : digit;
      if (!col.on) {
        col.on = true;
        col.cur = col.prev = digit;
        col.t = ODO_ROLL_S;
      } else if (digit !== col.cur) {
        if (col.t < ODO_ROLL_S) {
          // Changed again mid-flip (a count-up): snap. A column that changes
          // every frame counts, it does not smear — a still never catches a
          // perpetual half-faded glyph in the fast column.
          col.prev = col.cur = digit;
          col.t = ODO_ROLL_S;
        } else {
          col.prev = col.cur;
          col.cur = digit;
          col.t = 0;
          carryFrom = i;
        }
      } else {
        col.t = Math.min(ODO_ROLL_S, col.t + dt);
      }
    }
    if (carryFrom > 0) {
      for (let j = 0; j < carryFrom; j++) {
        const col = this.cols[j]!;
        const digit = this.digitAt(j);
        const was = this.wasCur[j] ?? digit;
        if (was === digit && col.t >= ODO_ROLL_S) continue;
        col.prev = was;
        col.cur = digit;
        col.t = 0;
      }
    }
    for (let i = 0; i < shown; i++) {
      const col = this.cols[i]!;
      // Left-aligned columns, most significant first.
      const x = (shown - 1 - i) * this.advance + this.advance / 2;
      const u = col.t / ODO_ROLL_S;
      const mid = this.rowH / 2;
      if (u >= 1) {
        col.a.visible = false;
        col.b.texture = this.digits[col.cur]!;
        col.b.visible = true;
        // A settled digit sits on whole device pixels (its texture's own
        // grid): a glyph seated half a pixel off is resampled soft, which
        // showed on the 15 px level pill next to the mode pill's crisp text.
        this.seat(col.b, x, mid);
        col.b.scale.set(1);
        col.b.alpha = 1;
        continue;
      }
      // Always full size and full alpha, one glyph at a time. Old glyph:
      // held solid in its seat. New glyph: solid from the switch, rising the
      // last 0.12 row into the seat.
      if (u < ODO_HOLD) {
        col.a.texture = this.digits[col.prev]!;
        col.a.visible = true;
        col.a.position.set(x, mid);
        col.a.scale.set(1);
        col.a.alpha = 1;
        col.b.visible = false;
      } else {
        const k = smooth((u - ODO_HOLD) / (1 - ODO_HOLD));
        col.a.visible = false;
        col.b.texture = this.digits[col.cur]!;
        col.b.visible = true;
        col.b.position.set(x, mid + (1 - k) * ODO_SLIDE * this.rowH);
        col.b.scale.set(1);
        col.b.alpha = 1;
      }
    }
  }
}

function smooth(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
}

// ---------------------------------------------------------------------------

/** Letters slam in this far apart, each over this long. */
const LETTER_STAGGER_S = 0.018;
const LETTER_IN_S = 0.15;
/** Back-ease strength for the slam: ~6% overshoot past the resting size. */
const LETTER_BACK = 1.3;
/** Slam start scale. */
const LETTER_FROM = 2.0;
const LETTER_CAP = 14;
/** Every letter a banner can show (streaks, multilines, levels), baked ahead. */
const BANNER_ALPHABET = '0123456789XSTREAKMULINV';

/**
 * Banner text one glyph per letter, centred as a word, each letter slamming
 * in from 2x, 18 ms apart, overshooting 6% and settling. The group transform
 * (hold wobble, the out) is the caller's, on `container`. The letters are
 * cached glyphs (glyph-text.ts): a body sprite over a glow sprite that takes
 * the banner's colour as a tint, so a banner never rasterises text on the
 * clear frame. `step()` once a frame bakes the alphabet ahead (again after
 * a font-size change; a letter outside it bakes when first shown).
 */
export class LetterBanner {
  readonly container = new Container();
  private readonly letters: Container[] = [];
  private readonly bodies: Sprite[] = [];
  private readonly glows: Sprite[] = [];
  private readonly adv = new Float32Array(LETTER_CAP);
  private n = 0;
  private readonly cache: GlyphCache;
  private readonly style: TextStyle;

  /** `res`: the text rasterisation resolution (the renderer's, capped; playfield.ts). */
  constructor(renderer: Renderer, style: TextStyle, res = 1) {
    this.style = style;
    this.cache = new GlyphCache(renderer, style, res, {
      shadow: true,
      stroke: false,
      fill: false,
      body: true,
    });
    this.cache.setAlphabet(BANNER_ALPHABET);
    for (let i = 0; i < LETTER_CAP; i++) {
      const letter = new Container();
      const glow = new Sprite();
      const body = new Sprite();
      glow.anchor.set(0.5);
      body.anchor.set(0.5);
      letter.addChild(glow, body);
      letter.visible = false;
      this.container.addChild(letter);
      this.letters.push(letter);
      this.bodies.push(body);
      this.glows.push(glow);
    }
  }

  /** Whether glyphs of the alphabet are still waiting to be baked. */
  get pending(): boolean {
    return this.cache.pending;
  }

  /** Bake the next glyph of the alphabet. */
  step(): void {
    this.cache.step(1);
  }

  /** Lay the word out centred on the container origin (measures with the current style); the glow in `color` (the style's shadow colour by default). */
  show(text: string, color?: number): void {
    const chars = Array.from(text).slice(0, LETTER_CAP);
    this.n = chars.length;
    const style = this.style;
    const spacing = style.letterSpacing;
    const glowAlpha = style.dropShadow?.alpha ?? 0;
    const glowColor =
      color ?? (style.dropShadow ? Color.shared.setValue(style.dropShadow.color).toNumber() : 0);
    // A word gap is not a glyph: nothing is rendered for it.
    const gap = style.fontSize * 0.28;
    // Glyph advances, not the glyph box: that carries the stroke and glow padding.
    let total = 0;
    for (let i = 0; i < LETTER_CAP; i++) {
      const t = this.letters[i]!;
      const ch = chars[i];
      if (ch === undefined || ch === ' ') {
        t.visible = false;
        this.adv[i] = ch === ' ' ? gap : 0;
      } else {
        const g = this.cache.get(ch);
        const body = this.bodies[i]!;
        const glow = this.glows[i]!;
        if (g.body) body.texture = g.body;
        if (g.shadow) {
          glow.texture = g.shadow;
          glow.tint = glowColor;
          glow.alpha = glowAlpha;
          glow.visible = true;
        } else glow.visible = false;
        t.visible = true;
        t.alpha = 0;
        t.scale.set(LETTER_FROM);
        this.adv[i] = CanvasTextMetrics.measureText(ch, style).width;
      }
      if (i < this.n) total += (this.adv[i] ?? 0) + spacing;
    }
    total -= spacing;
    let x = -total / 2;
    for (let i = 0; i < this.n; i++) {
      const t = this.letters[i]!;
      const w = this.adv[i] ?? 0;
      t.x = x + w / 2;
      t.y = 0;
      x += w + spacing;
    }
    this.container.visible = true;
  }

  hide(): void {
    this.container.visible = false;
    for (const t of this.letters) t.visible = false;
  }

  /** Per-letter slam at banner time `t` (seconds since the banner started). */
  update(t: number): void {
    for (let i = 0; i < this.n; i++) {
      const l = this.letters[i]!;
      const u = Math.max(0, Math.min(1, (t - i * LETTER_STAGGER_S) / LETTER_IN_S));
      const k = easeOutBack(u, LETTER_BACK);
      l.scale.set(LETTER_FROM + (1 - LETTER_FROM) * k);
      l.alpha = Math.min(1, u * 2.5);
    }
  }
}
