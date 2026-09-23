import { levelThreshold } from '@solitaire-plus/sim';
import {
  Container,
  FillGradient,
  Graphics,
  Sprite,
  Text,
  type Renderer,
  type TextStyle,
} from 'pixi.js';
import { easeInOutQuad, easeOutCubic } from './effects.js';
import { Odometer } from './hud-fx.js';
import { PALETTE } from './palette.js';
import type { Textures } from './textures.js';

/**
 * The HUD level pill: "LV 3" docked to the score in the mode pill's weight
 * (a solid plate fill, a 1 px rim stroke, white bold text with the HUD's
 * stroke) with the progress as a 2 px underline along its bottom edge — an
 * indigo → mint gradient track filling left to right with the score's
 * progress to the next threshold, eased (never a jump). The earlier α 0.4
 * wash over the whole plate washed the pill teal and read "muted" next to
 * the mode pill's dark plate (the owner's iPhone screenshot); the underline
 * keeps the plate as dark as its neighbour's. The number rolls with the
 * odometer's split-flap on a level-up and the pill pops (1 → 1.25 → 1) with
 * a mint glow at 1.6× its radius; no rings anywhere (round 21). Levels are
 * COOL, indigo → mint, against the streaks' heat. The text is rasterised at
 * the HUD's resolution (playfield.ts `hudRes`, the renderer's own, not the
 * big numerals' cap) and seated on whole device pixels, so it is as crisp
 * as the mode pill on a 3× phone. Tier gating lives in quality.ts
 * (`levelFx`): 0 draws the pill as plain text.
 */

/** Score progress inside a level, 0..1. */
export function levelProgress(score: number, level: number): number {
  const lo = levelThreshold(level);
  const hi = levelThreshold(level + 1);
  return Math.max(0, Math.min(1, (score - lo) / (hi - lo)));
}

/** The level colour at progress `p`: indigo at the start of a level, mint at its end. */
export function levelColor(p: number): number {
  return lerp(PALETTE.indigo, PALETTE.accent, Math.max(0, Math.min(1, p)));
}

/** The pop: up to 1.25 over the first 30% (cubic out), back to 1 over the rest. */
const POP_S = 0.36;
const POP_PEAK = 0.25;
/** The glow behind the pill on a pop (1.6× the pill's radius), fading over this long. */
const POP_GLOW_S = 0.55;
const POP_GLOW_SCALE = 1.6;
/** Progress eases toward the score at this rate (per second). */
const PROGRESS_RATE = 5;
/** The fill redraws only when the quantised progress moves (1/120). */
const FILL_STEPS = 120;
/** The progress underline: its height, its inset from the pill's bottom edge and from the caps. */
const TRACK_H = 2;
const TRACK_BOTTOM_INSET = 4;
const TRACK_SIDE_INSET = 9;
/** The empty track's alpha (white) under the fill. */
const TRACK_ALPHA = 0.14;
/** Progress under this draws no fill (a lone dot on the track). */
const FILL_MIN = 0.04;
/** The text's centre above the pill's centre, so it is centred over the track. */
const TEXT_LIFT = 3;
/** The pill is never narrower than this, so a half-level fill is ≥ 30 px. */
const MIN_W = 84;

export class LevelPill {
  readonly container = new Container();
  private readonly glow: Sprite;
  private readonly bg = new Graphics();
  private readonly fill = new Graphics();
  private readonly label: Text;
  private readonly odometer: Odometer;
  private readonly plain: Text;
  private readonly texSize: number;
  private readonly res: number;
  private gradient: FillGradient | null = null;
  private level = 1;
  private progress = 0;
  private progressTarget = 0;
  private drawn = -1;
  private popT = -1;
  private w = MIN_W;
  private h = 26;
  private textOnly = false;
  /** While a streak pill is up the pop waits (one emphasised pill at a time). */
  private popWaiting = false;
  private hold = false;

  constructor(tex: Textures, labelStyle: TextStyle, numberStyle: TextStyle, res: number) {
    this.texSize = tex.size;
    this.glow = new Sprite(tex.glow);
    this.glow.anchor.set(0.5);
    this.glow.blendMode = 'add';
    this.glow.tint = PALETTE.accent;
    this.glow.alpha = 0;
    this.label = new Text({ text: 'LV', style: labelStyle, resolution: res });
    this.res = res;
    this.odometer = new Odometer(numberStyle, 3, res);
    this.plain = new Text({ text: 'LV 1', style: numberStyle, resolution: res });
    this.plain.anchor.set(0.5);
    this.plain.visible = false;
    this.container.addChild(
      this.glow,
      this.bg,
      this.fill,
      this.label,
      this.odometer.container,
      this.plain,
    );
  }

  /** Plain text (low tier) or the full pill. */
  setTextOnly(on: boolean): void {
    this.textOnly = on;
    this.plain.visible = on;
    this.label.visible = this.odometer.container.visible = !on;
    this.fill.visible = !on;
    if (on) {
      this.glow.alpha = 0;
      this.popT = -1;
      this.popWaiting = false;
      this.container.scale.set(1);
    }
    this.drawn = -1;
  }

  /** Font sizes for the row (the number style is shared with the odometer's digits). */
  setSizes(labelPx: number, numberPx: number): void {
    this.label.style.fontSize = labelPx;
    this.plain.style.fontSize = numberPx;
  }

  /** Re-render the digits and measure the pill at the current styles (on resize / tier). */
  layout(renderer: Renderer): void {
    this.odometer.layout(renderer);
    this.odometer.reset(this.level);
    this.plain.text = `LV ${this.level}`;
    this.measure();
  }

  /** The level shown. `roll` flips the digits split-flap style; otherwise they snap. */
  setLevel(level: number, roll: boolean): void {
    if (level === this.level) return;
    this.level = level;
    if (roll) this.odometer.set(level);
    else this.odometer.reset(level);
    this.plain.text = `LV ${level}`;
    // A new level starts its fill from empty; it eases up to the score from there.
    this.progress = 0;
    this.drawn = -1;
    this.measure();
  }

  get shownLevel(): number {
    return this.level;
  }

  /** Score progress to the next threshold (0..1); eased on update(). */
  setProgress(p: number): void {
    this.progressTarget = Math.max(0, Math.min(1, p));
  }

  /**
   * Whether another pill holds the row's emphasis (the streak pill is up):
   * the pop and its glow wait until it retires.
   */
  setHold(on: boolean): void {
    this.hold = on;
  }

  /** The level-up pop: scale 1 → 1.25 → 1 with a mint glow (deferred while held). */
  pop(): void {
    if (this.textOnly) return;
    if (this.hold) {
      this.popWaiting = true;
      return;
    }
    this.popWaiting = false;
    this.popT = 0;
    this.glow.alpha = 0.9;
  }

  /** The pill's size (for the HUD row). */
  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }

  update(dt: number): void {
    // The fill eases toward the score; a fresh level rises from empty.
    this.progress += (this.progressTarget - this.progress) * Math.min(1, dt * PROGRESS_RATE);
    if (Math.abs(this.progressTarget - this.progress) < 0.0015) this.progress = this.progressTarget;
    this.odometer.update(dt);
    if (this.textOnly) return;
    const step = Math.round(this.progress * FILL_STEPS);
    if (step !== this.drawn) {
      this.drawn = step;
      this.drawFill(step / FILL_STEPS);
    }
    if (this.popWaiting && !this.hold) this.pop();
    if (this.popT >= 0) {
      this.popT += dt;
      const u = Math.min(1, this.popT / POP_S);
      const k = u < 0.3 ? easeOutCubic(u / 0.3) : 1 - easeInOutQuad((u - 0.3) / 0.7);
      this.container.scale.set(1 + POP_PEAK * k);
      const g = Math.max(0, 1 - this.popT / POP_GLOW_S);
      this.glow.alpha = 0.9 * g * g;
      if (this.popT >= Math.max(POP_S, POP_GLOW_S)) {
        this.popT = -1;
        this.container.scale.set(1);
        this.glow.alpha = 0;
      }
    }
  }

  private measure(): void {
    const gap = Math.round(this.label.style.fontSize * 0.4);
    const nw = this.odometer.width;
    const lw = this.label.width;
    const total = this.textOnly ? this.plain.width : lw + gap + nw;
    // Every offset lands on a device pixel (the container itself is placed on
    // whole CSS px): a text texture drawn off the pixel grid is resampled soft.
    const snap = (v: number) => Math.round(v * this.res) / this.res;
    // The text is centred in the room above the underline track (TEXT_LIFT
    // up from the pill's centre; the label a pixel lower than the digits, as
    // the 12/15 px pair sits on one baseline).
    this.label.x = snap(-total / 2);
    this.label.y = snap(1 - TEXT_LIFT - this.label.height / 2);
    this.odometer.container.x = snap(-total / 2 + lw + gap);
    this.odometer.container.y = snap(-TEXT_LIFT - this.odometer.height / 2);
    this.plain.y = -TEXT_LIFT;
    const padX = Math.round(this.label.style.fontSize * 0.9);
    const ref = this.textOnly ? this.plain.height : this.odometer.height;
    this.w = Math.max(MIN_W, Math.ceil(total + padX * 2));
    // The mode pill's height (its 12 px text + 6) plus the track's room.
    this.h = Math.ceil(ref * 0.7 + 10);
    const w = this.w;
    const h = this.h;
    // The mode pill's weight: a solid plate, a rim stroke. No world pixel
    // shows through, and nothing washes the plate: the progress is the
    // underline track along the bottom edge.
    this.bg
      .clear()
      .roundRect(-w / 2, -h / 2, w, h, h / 2)
      .fill({ color: PALETTE.plateTop, alpha: 1 })
      .stroke({ color: PALETTE.plateRim, width: 1, alpha: 0.9 });
    if (!this.textOnly)
      this.bg
        .roundRect(
          -w / 2 + TRACK_SIDE_INSET,
          h / 2 - TRACK_BOTTOM_INSET - TRACK_H,
          w - TRACK_SIDE_INSET * 2,
          TRACK_H,
          TRACK_H / 2,
        )
        .fill({ color: 0xffffff, alpha: TRACK_ALPHA });
    // The progress gradient spans the whole track in the pill's own space, so
    // a part-filled track shows indigo → its current colour, mint at the end.
    this.gradient = new FillGradient({
      type: 'linear',
      start: { x: -w / 2 + TRACK_SIDE_INSET, y: 0 },
      end: { x: w / 2 - TRACK_SIDE_INSET, y: 0 },
      colorStops: [
        { offset: 0, color: PALETTE.indigo },
        { offset: 1, color: PALETTE.accent },
      ],
      textureSpace: 'global',
    });
    // Glow at 1.6× the pill's radius (the soft texture's visible disc is ~0.5 of its size).
    this.glow.scale.set(
      ((w + h) * POP_GLOW_SCALE) / this.texSize,
      (h * 2 * POP_GLOW_SCALE) / this.texSize,
    );
    this.drawn = -1;
  }

  private drawFill(p: number): void {
    const g = this.fill;
    g.clear();
    // Under FILL_MIN the fill is a lone dot at the track's end (a stray bullet at 4×).
    if (p < FILL_MIN || !this.gradient) return;
    const w = this.w;
    const h = this.h;
    // The underline growing from the track's left end (at least a full cap wide).
    const tw = w - TRACK_SIDE_INSET * 2;
    const fw = Math.max(TRACK_H, p * tw);
    g.roundRect(
      -w / 2 + TRACK_SIDE_INSET,
      h / 2 - TRACK_BOTTOM_INSET - TRACK_H,
      fw,
      TRACK_H,
      TRACK_H / 2,
    ).fill({ fill: this.gradient, alpha: 1 });
  }
}

function lerp(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}
