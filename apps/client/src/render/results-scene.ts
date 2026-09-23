import type { ScoreBreakdown } from '@solitaire-plus/sim';
import {
  BlurFilter,
  Container,
  Graphics,
  Point,
  Sprite,
  Text,
  TextStyle,
  Texture,
  type Renderer,
} from 'pixi.js';
import { easeInOutQuad, easeOutBack, easeOutCubic, OneShots, type Particles } from './effects.js';
import { LetterBanner } from './hud-fx.js';
import type { Layout } from './layout.js';
import { levelColor } from './level-hud.js';
import { PALETTE, pieceColor, shade } from './palette.js';
import {
  RESULTS_METRICS,
  ROW_INSET,
  endReasonCopy,
  outcomeCopy,
  resultsFit,
  resultsPanelRect,
  rowsStart,
  type Fit,
  type HeroKind,
  type ResultsOutcome,
} from './results-layout.js';
import { formatScore } from '../share/layout.js';
import type { PostFilter } from './shaders/post.js';
import type { Textures } from './textures.js';
import { drawCoin } from '../shell/chain-mark.js';

export { resultsPanelRect, type ResultsOutcome } from './results-layout.js';

/**
 * The results as a cinematic beat, in-engine (idea 10).
 *
 * The DOM card told you the score; this makes the end of a game a payoff:
 *   0.00 s  the table tilts back (0.35 s) and the camera dollies in 4% over
 *           0.9 s (ease-out); the focus pulls off the table — the world goes
 *           to a bokeh blur in the post chain over 0.7 s from 0.15 s — while
 *           the panel, outside the chain, snaps into focus (a blur filter on
 *           it runs 10 px → 0 as it fades in, then detaches)
 *   0.20 s  every tile on the board lifts off, bottom row first, sweeping up;
 *           each becomes a lit chip in the HUD (above the panel) that arcs
 *           outward and then dives INTO the score, timed so the chips land as
 *           the number ticks (a glow pulse per arrival)
 *   0.90 s  the final score counts up in 96 px type with a bloom pulse per
 *           digit change
 *   1.40 s  the count lands: the grade sting keyed to the streak heat reached
 *           (≥ 0.75 a warm-white flourish with god rays behind the panel and
 *           a warm breath of grade; ≥ 0.5 amber; else cool)
 *   1.70 s  the breakdown rows slam in from alternating sides on a beat
 *   ~3.0 s  done — React shows the buttons only
 *
 * A CHALLENGE with its outcome known (the opponent already played) plays the
 * OUTCOME hero instead of the plain title (docs/art-direction.md "Outcome"):
 * the end reason is a small eyebrow, and 1.82 s in "YOU WON" (mint) / "YOU
 * LOST" (rose) slams in letter by letter; at the banner's landing a win
 * throws a fan of $CHAIN coins from the score under a warm-white flare and
 * a mint pulse on the panel's edge while the STAKE LINE ("+20 $CHAIN", the
 * coin at cap height) counts up over 0.6 s; a loss cools the room, lands
 * without the flash and shows the stake lost in rose. The VS line ("8,470
 * vs 5,120 · LV 8 vs LV 4") follows, then the rows. The outcome may arrive
 * late (the server settles it after the game is submitted): the beat waits
 * for it, and the rows wait for the beat.
 *
 * The panel's height is its content's, and the shell's docked tray must fit
 * under it: `fitResults` takes the tray's measured height (before the count
 * starts — the shell measures a hidden tray from the first frame) and the
 * pure `resultsFit` decides the compression (results-layout.ts).
 *
 * Everything it touches is handed in through `ResultsHandles`; it allocates its
 * text and chip pools once and nothing per frame. It is also recordable by
 * tools/shot, which the DOM card never was.
 */

export interface ResultsHandles {
  /** The board group: plate, tiles, effects. Tilted and pushed in. */
  table: Container;
  /** Everything under the post chain. Scaled for the push-in. */
  world: Container;
  /** The HUD group (outside the post chain), where the score and rows live. */
  hud: Container;
  /** One entry per board cell, row-major; `color` is -1 when empty. */
  cells: readonly { sprite: Sprite; color: number }[];
  layout: () => Layout;
  particles: Particles;
  oneShots: OneShots;
  tex: Textures;
  /** Called on every tile burst and digit change, for audio. */
  onBeat?: ((kind: ResultsBeatKind) => void) | undefined;
  /** Personal best before this game, if known. */
  best?: number | undefined;
  /** The post chain (depth of field, rays, flash); null on the low tier. */
  post?: PostFilter | null | undefined;
  /** Canvas size in CSS px, for frame-UV conversions. */
  screen?: (() => { width: number; height: number }) | undefined;
  /** Hold the post grade at a heat value (the sting); 0 releases it. */
  setGrade?: ((heat: number) => void) | undefined;
  /** Headline for a forfeit; the shell says RUN OVER for a solo run the player ended. */
  forfeitTitle?: string | undefined;
  /**
   * The challenge's outcome: known now, `'pending'` (the opponent has played;
   * the server settles it once this game is submitted — `setOutcome` brings
   * it), or null (solo, or a creator waiting for a challenger: the plain title).
   */
  outcome?: ResultsOutcome | 'pending' | null | undefined;
  /** Coins in the win's burst (tier `outcomeCoins`); 0 skips it. */
  coins?: number | undefined;
  /** `prefers-reduced-motion`: the banner as a still, no coins, the stake shown, not counted. */
  reducedMotion?: boolean | undefined;
}

export type ResultsBeatKind =
  | 'burst'
  | 'digit'
  | 'row'
  | 'done'
  | 'outcome-win'
  | 'outcome-loss'
  | 'outcome-burst'
  /** The shell's XP beat may start: the rows are in and, on a win, the coins are gone (the scene's clock, not the wall's). */
  | 'xp-go';

/** What the shell needs to dock its tray: the panel's edge after the fit and the shift. */
export interface ResultsDock {
  x: number;
  y: number;
  w: number;
  r: number;
  inset: number;
  shift: number;
  /** The fit's last stage, for tooling. */
  stage: Fit['stage'];
  fits: boolean;
}

export interface FitRequest {
  /** The docked tray's measured height (it overlaps the panel's bottom by its radius). */
  trayH: number;
  viewportH: number;
  safeTop: number;
  safeBottom: number;
  /** True once the tray has everything it will show (the XP beat, the waiting strip); the rows wait for it. */
  final: boolean;
}

const TILT_S = 0.35;
/** The shell's rank-up: a halo behind the panel in the rank colour, this long, peaking at this alpha 45 ms in. */
const RANK_GLOW_S = 0.9;
const RANK_GLOW_ALPHA = 0.35;
/** The halo reaches this far past the panel's edge (in cells), feathered over this many additive bands. */
const RANK_GLOW_MARGIN_CELLS = 3;
const RANK_GLOW_BANDS = 24;
/** Band gain: the bands' alphas sum to ~1 at the panel's edge (Σ(1−u)² over the bands ≈ BANDS/3). */
const RANK_GLOW_GAIN = 3;
/** Camera dolly-in: 4% over 900 ms, ease-out. */
const DOLLY_S = 0.9;
const DOLLY = 0.04;
/** Focus pull off the table. */
const FOCUS_START_S = 0.15;
const FOCUS_S = 0.7;
/** The panel snaps into focus as it fades in. */
const SNAP_START_S = 0.5;
const SNAP_S = 0.3;
const BURST_START_S = 0.2;
const BURST_ROW_S = 0.04;
/** How long a lifted tile pops before it is gone (the chip carries on). */
const POP_S = 0.22;
const BURST_COL_S = 0.008;
const SCORE_START_S = 0.9;
/**
 * The count runs this long: it lands 0.9 s after the panel starts to fade
 * in (0.5 s) — round 53 caught the plate still counting (3,859 of 7,660) a
 * beat after the hero had read the total. The chips' landings ride the count
 * (CHIP_LAND_FROM), so they compress with it.
 */
const SCORE_COUNT_S = 0.5;
const ROWS_START_S = 1.7;
const ROW_STEP_S = 0.09;
const ROW_IN_S = 0.22;
/** Lit chips flying into the score: pool size (tiles beyond it just pop). */
const CHIP_CAP = 64;
/** Chips land across this part of the count-up (first one at 5%, last at 100%). */
const CHIP_LAND_FROM = 0.05;
/** The rows wait this long past their nominal start for the shell's final tray measurement, then go anyway. */
const FIT_GRACE_S = 0.6;

// The outcome hero (docs/art-direction.md "Outcome").
/**
 * The banner slams in here (the sting's punch first, then the word): an
 * absolute beat, so shortening the count (SCORE_COUNT_S) moved nothing in
 * the outcome hero — the banner, its landing, the stake, the VS line and the
 * rows keep their times.
 */
const OUTCOME_START_S = 1.82;
/** A pending outcome is waited for this long past the beat's start before the headline goes plain. */
const OUTCOME_WAIT_MAX_S = 6;
/** The banner has landed (every letter in: 8 letters × 18 ms + 150 ms) this long after it starts. */
const BANNER_LAND_S = 0.28;
/** The stake counts from 0 over this long from the landing (a win). */
const STAKE_COUNT_S = 0.6;
/** The stake line fades up over this long; the VS line follows, this long after the landing. */
const STAKE_IN_S = 0.15;
const VS_AFTER_S = 0.12;
const VS_IN_S = 0.3;
/** On a WIN the shell's XP beat may start this long after the banner: the last coin is gone. */
const XP_GO_AFTER_BANNER_S = 1.15;
/** The rows start this long after the banner: the stake has counted (landing + 0.6 s) and the coins are landing. */
const ROWS_AFTER_OUTCOME_S = 0.45;
/** From the banner's landing the row LABELS are already in place at this alpha (structure under the hero); the values slam in. */
const LABEL_PRE_ALPHA = 0.35;
const LABEL_PRE_IN_S = 0.2;
/**
 * The win's flare at the score: warm white, filled, α 1 → 0 over this long —
 * a smooth bloom this big (in board units) UNDER the digits and a tight core
 * OVER them (the digits take the hit white for a few frames, like a score
 * float), so the landing frame shows a core, not a wash behind the number.
 */
const FLARE_S = 0.25;
const FLARE_SIZE = 0.6;
/**
 * The flare's tints: the bloom under the digits is a warm amber-white (an
 * additive near-white over the cool panel sums to neutral grey — the lift
 * must be warmer than the ground is cool), the core over them a hot
 * warm-white.
 */
const FLARE_BLOOM_COLOR = 0xffc98a;
const FLARE_CORE_COLOR = 0xfff0d8;
/** The core holds at α 1, then goes out — it outlives the coins' birth. */
const FLARE_CORE_SIZE = 0.3;
const FLARE_CORE_ALPHA = 1;
const FLARE_CORE_HOLD_S = 0.12;
const FLARE_CORE_OUT_S = 0.2;
/** The score's mint glow dips under the flare (it recovers over the hold + out) so the bloom stays warm. */
const FLARE_GLOW_DIP = 0.15;
/** The win's pulse on the panel's edge: mint, the rank-up halo's language at this alpha. */
const WIN_PULSE_ALPHA = 0.3;
/** The loss: the room's exposure drops by this for this long. */
const LOSS_DIM = 0.15;
const LOSS_DIM_S = 0.6;
/** Coin burst: the fan's half-angle from straight up, launch speed and gravity (board units/s, /s²). */
const COIN_FAN_RAD = 0.62;
const COIN_SPEED_MIN = 1.15;
const COIN_SPEED_MAX = 1.9;
/** On a phone (the board ≥ this share of the viewport's width) the fan narrows so no coin leaves the screen sideways. */
const COIN_NARROW_FROM = 0.85;
const COIN_FAN_RAD_NARROW = 0.45;
const COIN_SPEED_MAX_NARROW = 1.55;
const COIN_GRAVITY = 3.4;
/**
 * HEADROOM: a coin's rise is capped so its apex stays under the chrome's row
 * (the ✕ / gear: the safe top + 8 px + a 44 px tap target) by half the
 * largest coin; when the cap engages the fan widens to this and the launch
 * speed is at least the floor (the horizontal keeps the fan alive — only
 * the vertical component is capped — so the throw fans instead of boiling
 * behind the score).
 */
const CHROME_BOTTOM_PX = 8 + 44;
const COIN_FAN_RAD_CAPPED = 0.8;
const COIN_SPEED_FLOOR = 1.3;
/** With no headroom at all, the coins are born beside the number and leave outward at least this fast (B/s). */
const COIN_SIDE_SPEED_MIN = 0.5;
/** A coin edge-on keeps this much of its width (a 1 px sliver is a hairline, not a coin); the smallest size keeps more. */
const COIN_EDGE_MIN = 0.18;
const COIN_EDGE_MIN_SMALL = 0.25;
/**
 * Coins are BORN ON THE RULE, not on the number: one coin radius above the
 * accent rule between the banner and the score (never inside the numeral's
 * box), spread sideways this much (board units), and invisible for the
 * first 60 ms — body and halo fade up over the next 100 ms — so the landing
 * frame is the flare alone and the score never wears a hat of coins.
 */
const COIN_SPAWN_SPREAD = 0.12;
const COIN_SPAWN_JITTER_Y = 0.015;
const COIN_BORN_S = 0.06;
const COIN_IN_S = 0.1;
/**
 * A coin never lands on the ledger: it fades to nothing by the FLOOR —
 * half a coin above the VS line (or the first row) — over this band above
 * it, and a rise-capped throw (a short screen) lives at most this long.
 */
const COIN_FLOOR_FADE = 0.08;
const COIN_LIFE_CAPPED_MIN = 0.55;
const COIN_LIFE_CAPPED_MAX = 0.6;
/** A capped throw falls at this share of gravity: born beside the number with no rise, it would otherwise reach the floor in 0.3 s. */
const COIN_GRAVITY_CAPPED = 0.5;
/** Each coin leaves up to this long after the landing, so the burst passes the eyebrow as a stream, not a pile. */
const COIN_LAUNCH_JITTER_S = 0.12;
/** A coin inside the eyebrow's line box dips to this alpha (it is under the text; the word stays legible). */
const COIN_UNDER_EYEBROW_ALPHA = 0.6;
/** Coin life; a coin fades over its last 35%. All are gone by 1.1 s. */
const COIN_LIFE_MIN = 0.8;
const COIN_LIFE_MAX = 1.1;
const COIN_FADE_FROM = 0.65;
/** Coin sizes (three, in board units) and the halo under each (× the coin), spin and flip rates (rad/s). */
const COIN_SIZES = [0.062, 0.048, 0.036] as const;
/** On a desktop board (≥ this many px) the coins are this much larger, so they read as coins, not a sprinkle. */
const COIN_BIG_FROM_PX = 560;
const COIN_BIG_SCALE = 1.25;
const COIN_HALO = 2.4;
const COIN_HALO_ALPHA = 0.55;
const COIN_SPIN = 6;
const COIN_FLIP_MIN = 5;
const COIN_FLIP_MAX = 9;
/** The coin bake's size in px (drawn once; sprites scale it). */
const COIN_TEX_PX = 96;
const COIN_CAP = 18;
/** Type: the banner, the stake and the eyebrow / VS line, in board units (with floors in px). */
const BANNER_FONT = 0.08;
const BANNER_FONT_MIN = 22;
/** Each banner letter's canvas is padded this much for its glow. */
const BANNER_PAD = 20;
/** The rule under the banner: this far below its centre (× the font) and this wide (× the board). */
const RULE_BELOW = 0.78;
const RULE_W = 0.16;
const STAKE_FONT = 0.1;
/** The stake lost is quieter than the stake won ("without punishing"). */
const STAKE_FONT_LOSS = 0.08;
const STAKE_FONT_MIN = 22;
const SMALL_FONT = 0.034;
const SMALL_FONT_MIN = 13;
/** NEW BEST beside the score: a small amber chip, its text this big, this far right of the digits. */
const BEST_CHIP_FONT = 0.03;
const BEST_CHIP_GAP = 0.02;

/** Breakdown rows: base, streak, colour, lines, pieces, clock, level. */
const ROW_COUNT = 7;
/** Row indices that may collapse under `resultsFit`, least important first: COLOUR LINES (at 0), PIECES PLACED, CLOCK USED. */
const ROW_COLOUR = 2;
const ROW_PIECES = 4;
const ROW_CLOCK = 5;

interface Row {
  label: Text;
  value: Text;
  fromLeft: boolean;
}

interface Chip {
  glow: Sprite;
  tile: Sprite;
  /** Launch time and landing time on the scene clock; t0 < 0 = idle. */
  t0: number;
  t1: number;
  x0: number;
  y0: number;
  /** Bezier control point. */
  cx: number;
  cy: number;
  spin: number;
  color: number;
}

interface Coin {
  halo: Sprite;
  coin: Sprite;
  /** Age (-1 idle), life, position and velocity in px, spin and flip rates. */
  t: number;
  life: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  flip: number;
  phase: number;
  size: number;
  /** The narrowest this coin goes edge-on (a fraction of its width). */
  edge: number;
  /** The coin is gone by this y (root space): half a coin above the VS line / the first row. */
  floor: number;
  /** Launch delay (s) after the throw, and this coin's share of gravity (a capped throw falls slower). */
  launch: number;
  gravity: number;
}

/** Sting tiers, from the streak heat reached. */
function stingTier(heat: number): 'white' | 'amber' | 'cool' {
  return heat >= 0.75 ? 'white' : heat >= 0.5 ? 'amber' : 'cool';
}

/** The $CHAIN coin for the burst, baked once from the shell's mark. */
function bakeCoin(px: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (ctx) drawCoin(ctx, 0, 0, px);
  return Texture.from(canvas);
}

export class ResultsScene {
  /** While true the scene's clock does not advance (the playfield's end-of-game slow-mo). */
  paused = false;
  private readonly root = new Container();
  private readonly title: Text;
  private readonly score: Text;
  private readonly scoreGlow: Sprite;
  private readonly rows: Row[] = [];
  /** Rows in use this game (6, or 7 with LEVEL REACHED). */
  private rowCount = 6;
  /** A cool glow under the LEVEL REACHED row from level 5 (-1 = none). */
  private readonly levelGlow: Sprite;
  private glowRow = -1;
  private readonly panel = new Graphics();
  /** The rank-up's halo behind the panel (the shell's ceremony reaching the table); the win's pulse shares it. */
  private rankGlow!: Graphics;
  private rankGlowT = -1;
  private rankGlowAlpha = RANK_GLOW_ALPHA;
  /** Tooling: the halo held at a fixed time (the capture harness pins a frame). */
  private rankGlowHold = false;
  private readonly rule = new Graphics();
  private readonly chipLayer = new Container();
  private readonly chips: Chip[] = [];
  private readonly fx: OneShots;
  /** The win's flare core, above the score's digits. */
  private readonly flareFx: OneShots;
  private readonly snap = new BlurFilter({ strength: 0, quality: 3 });
  private readonly tmp = new Point();
  /** Per-cell pop clocks (-1 idle) for the lift-off. */
  private popT: Float32Array = new Float32Array(0);
  private t = -1;
  /** Vertical shift of the whole ceremony (px), eased: the shell asks for it when its button tray would not fit below the panel. */
  private shiftTarget = 0;
  private shiftNow = 0;
  private breakdown: ScoreBreakdown | null = null;
  private burstOrder: number[] = [];
  private burstNext = 0;
  /** Which burst indices get a chip (every `chipStride`-th), and the next chip slot. */
  private chipStride = 1;
  private chipCount = 0;
  private chipNext = 0;
  private lastShown = -1;
  private stung = false;
  private done: (() => void) | null = null;
  private handles: ResultsHandles | null = null;
  private readonly tex: Textures;

  // The outcome hero.
  private hero: HeroKind = 'plain';
  private outcome: ResultsOutcome | null = null;
  /** True while a challenge's outcome is expected but not yet here; `outcomeGone` once the shell gave up on it. */
  private outcomePending = false;
  private outcomeGone = false;
  private readonly bannerStyle: TextStyle;
  private readonly banner: LetterBanner;
  /** The banner's clock (seconds since it started; -1 = not yet). */
  private bannerT = -1;
  private bannerLanded = false;
  private readonly stake: Text;
  private readonly stakeCoin: Sprite;
  private readonly vsLine: Text;
  private readonly bestChip = new Container();
  private readonly bestChipBg = new Graphics();
  private readonly bestChipText: Text;
  private readonly coinLayer = new Container();
  private readonly coins: Coin[] = [];
  private readonly coinTex: Texture;
  private stakeShown = -1;
  /** The stake's position: the line's centre and its width, so the coin sits at cap height on the left. */
  private stakeCx = 0;
  /** The accent rule's y (root space): the coins are born on it. */
  private ruleY = 0;

  // The fit (results-layout.ts): the shell's tray height decides the compression.
  private fitReq: FitRequest | null = null;
  private fit: Fit | null = null;
  /** The hero's spacing and VS line lock when the count starts; the rows' pitch and collapse when they slam in. */
  private heroLocked = false;
  private rowsLocked = false;
  private kNow = 1;
  private vsNow = true;
  private eyebrowNow = true;
  private pitchNow = 0;
  private hiddenNow: readonly number[] = [];
  private panelH = 0;
  /** Where the rows started (scene clock) once they have; -1 until then. */
  private rowsAt = -1;
  /** The shell has been told (the tray shows as the rows start; the scene keeps running to their end). */
  private doneFired = false;
  /** Outcome hero: the row labels are in place from the banner's landing (the values slam later). */
  private labelsPre = false;
  /** The 'xp-go' beat has been sent (once per play). */
  private xpGoFired = false;
  /** Whether this win threw coins (the XP beat then waits for them). */
  private coinsThrown = false;
  /** The flare's clock (-1 idle): the score's glow dips under it. */
  private flareT = -1;

  /** `res`: the text rasterisation resolution (the renderer's, capped; playfield.ts). */
  constructor(renderer: Renderer, tex: Textures, res = 1) {
    this.tex = tex;
    const style = (size: number, weight: '600' | '700', fill: number, spacing = 2) =>
      new TextStyle({
        fontFamily: 'Rajdhani, "Space Grotesk", sans-serif',
        fontSize: size,
        fontWeight: weight,
        fill,
        letterSpacing: spacing,
        stroke: { color: PALETTE.bgDeep, width: 4, join: 'round' },
        dropShadow: { alpha: 0.6, blur: 4, color: 0x000000, distance: 2, angle: Math.PI / 2 },
      });
    this.scoreGlow = new Sprite(tex.spotlight);
    this.scoreGlow.anchor.set(0.5);
    this.scoreGlow.blendMode = 'add';
    this.scoreGlow.tint = PALETTE.accent;
    this.scoreGlow.alpha = 0;
    this.title = new Text({ text: '', style: style(28, '700', PALETTE.text, 6), resolution: res });
    this.title.anchor.set(0.5);
    this.score = new Text({
      text: '0',
      style: style(96, '700', PALETTE.accent, 0),
      resolution: res,
    });
    this.score.anchor.set(0.5);
    // The outcome banner: the HUD banner's letter-slam in the outcome's colour with its own glow.
    this.bannerStyle = new TextStyle({
      fontFamily: 'Rajdhani, "Space Grotesk", sans-serif',
      fontSize: 48,
      fontWeight: '700',
      fill: PALETTE.accent,
      letterSpacing: 6,
      stroke: { color: PALETTE.bgDeep, width: 5, join: 'round' },
      dropShadow: { alpha: 0.6, blur: 14, color: PALETTE.accent, distance: 0 },
      // Room for the glow: each letter is its own canvas, and a clipped glow reads as a box behind the letter.
      padding: BANNER_PAD,
    });
    this.banner = new LetterBanner(renderer, this.bannerStyle, res);
    this.banner.container.visible = false;
    this.stake = new Text({
      text: '',
      style: style(40, '700', PALETTE.accentWarm, 2),
      resolution: res,
    });
    this.stake.anchor.set(0, 0.5);
    this.stake.alpha = 0;
    this.coinTex = bakeCoin(COIN_TEX_PX);
    this.stakeCoin = new Sprite(this.coinTex);
    this.stakeCoin.anchor.set(0.5);
    this.stakeCoin.alpha = 0;
    this.vsLine = new Text({
      text: '',
      style: style(16, '600', PALETTE.textDim, 2),
      resolution: res,
    });
    this.vsLine.anchor.set(0.5);
    this.vsLine.alpha = 0;
    this.bestChipText = new Text({
      text: 'NEW BEST',
      style: new TextStyle({
        fontFamily: 'Rajdhani, "Space Grotesk", sans-serif',
        fontSize: 14,
        fontWeight: '700',
        fill: PALETTE.accentWarm,
        letterSpacing: 2,
      }),
      resolution: res,
    });
    this.bestChipText.anchor.set(0.5);
    this.bestChip.addChild(this.bestChipBg, this.bestChipText);
    this.bestChip.visible = false;
    // Chips: a soft additive glow under a tile sprite, above the panel and
    // under the score text, so they fly over the scrim and vanish into the number.
    for (let i = 0; i < CHIP_CAP; i++) {
      const glow = new Sprite(tex.glow);
      glow.anchor.set(0.5);
      glow.blendMode = 'add';
      glow.visible = false;
      const tile = new Sprite(tex.tiles[0]);
      tile.anchor.set(0.5);
      tile.visible = false;
      this.chipLayer.addChild(glow, tile);
      this.chips.push({
        glow,
        tile,
        t0: -1,
        t1: 0,
        x0: 0,
        y0: 0,
        cx: 0,
        cy: 0,
        spin: 0,
        color: 0,
      });
    }
    // Coins: a lit coin (normal blend — an object, not light) over an
    // additive amber halo, so each has a bright centre and a soft rim.
    for (let i = 0; i < COIN_CAP; i++) {
      const halo = new Sprite(tex.glow);
      halo.anchor.set(0.5);
      halo.blendMode = 'add';
      halo.tint = PALETTE.accentWarm;
      halo.visible = false;
      const coin = new Sprite(this.coinTex);
      coin.anchor.set(0.5);
      coin.visible = false;
      this.coinLayer.addChild(halo, coin);
      this.coins.push({
        halo,
        coin,
        t: -1,
        life: 1,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        spin: 0,
        flip: 0,
        phase: 0,
        size: 1,
        edge: COIN_EDGE_MIN,
        floor: 1e9,
        launch: 0,
        gravity: 1,
      });
    }
    this.fx = new OneShots(12, tex);
    this.flareFx = new OneShots(2, tex);
    // Normal blend (an additive Graphics under the root's snap filter trips the
    // batcher): over the dark room, a soft fill in the rank colour reads as light.
    this.rankGlow = new Graphics();
    this.rankGlow.alpha = 0;
    this.rankGlow.visible = false;
    this.root.addChild(
      this.rankGlow,
      this.panel,
      this.scoreGlow,
      this.chipLayer,
      this.coinLayer,
      this.fx.container,
      this.title,
      this.rule,
      this.banner.container,
      this.score,
      this.flareFx.container,
      this.bestChip,
      this.stakeCoin,
      this.stake,
      this.vsLine,
    );
    this.levelGlow = new Sprite(tex.glow);
    this.levelGlow.anchor.set(0.5);
    this.levelGlow.blendMode = 'add';
    this.levelGlow.tint = PALETTE.indigo;
    this.levelGlow.alpha = 0;
    this.levelGlow.visible = false;
    this.root.addChild(this.levelGlow);
    for (let i = 0; i < ROW_COUNT; i++) {
      const label = new Text({
        text: '',
        style: style(20, '600', PALETTE.textDim, 2),
        resolution: res,
      });
      label.anchor.set(0, 0.5);
      const value = new Text({
        text: '',
        style: style(24, '700', PALETTE.text, 0),
        resolution: res,
      });
      value.anchor.set(1, 0.5);
      this.root.addChild(label, value);
      this.rows.push({ label, value, fromLeft: i % 2 === 0 });
    }
    this.root.visible = false;
  }

  /** Call once from the playfield's build(). */
  attach(hud: Container): void {
    hud.addChild(this.root);
  }

  /**
   * Move the ceremony up (negative) so the shell's button tray fits under it
   * on short screens; the panel and tray then read as one centred block.
   * Eased over a few frames; reset to 0 on the next play().
   */
  setShift(dy: number): void {
    this.shiftTarget = dy;
  }

  /**
   * The shell's docked tray was measured: decide the panel's compression
   * (results-layout.ts `resultsFit`) and answer with the panel's edge so the
   * tray docks to it. Called from the shell's first frame (a hidden tray,
   * before the count starts), again whenever the tray grows (the XP beat
   * arrives; a rank-up reserves its stage) and once more when it is final.
   * The hero's spacing locks when the count starts and the rows' pitch when
   * they slam in, so nothing on screen re-flows; the shift keeps easing.
   */
  fitResults(req: FitRequest): ResultsDock | null {
    const h = this.handles;
    if (!h) return null;
    this.fitReq = req;
    const L = h.layout();
    const P = resultsPanelRect(L);
    this.fit = resultsFit({
      viewportH: req.viewportH,
      safeTop: req.safeTop,
      safeBottom: req.safeBottom,
      panelY: P.y,
      plateH: P.h,
      B: L.boardSize,
      trayH: req.trayH,
      overlap: P.r,
      hero: this.hero,
      rows: this.rowCount,
      collapsible: this.collapsible(),
    });
    this.applyFit();
    return {
      x: P.x,
      y: P.y + this.panelH + this.shiftTarget,
      w: P.w,
      r: P.r,
      inset: P.inset,
      shift: this.shiftTarget,
      stage: this.fit.stage,
      fits: this.fit.fits,
    };
  }

  /** Row indices that may collapse, least important first (COLOUR LINES only while it says +0). */
  private collapsible(): number[] {
    const b = this.breakdown;
    const out: number[] = [];
    if (b && b.colorLines === 0) out.push(ROW_COLOUR);
    out.push(ROW_PIECES, ROW_CLOCK);
    return out;
  }

  /** Take the fit's numbers, respecting the locks, and re-lay the panel. */
  private applyFit(): void {
    const h = this.handles;
    const f = this.fit;
    if (!h || !f) return;
    const L = h.layout();
    const B = L.boardSize;
    const P = resultsPanelRect(L);
    if (!this.heroLocked) {
      this.kNow = f.k;
      this.vsNow = f.vs;
      this.eyebrowNow = f.eyebrow;
    }
    if (!this.rowsLocked) {
      this.pitchNow = f.pitch;
      this.hiddenNow = f.hidden;
    }
    const shown = this.rowCount - this.hiddenNow.length;
    const content =
      rowsStart(this.hero, this.kNow, this.vsNow, this.eyebrowNow) * B +
      Math.max(0, shown - 1) * this.pitchNow +
      RESULTS_METRICS.bottom * B;
    // Natural and shifted fits keep the plate's panel; a compressed one is the content's.
    this.panelH = f.stage === 'natural' || f.stage === 'shift' ? Math.max(P.h, content) : content;
    this.shiftTarget = f.shift;
    this.layoutTexts();
  }

  /**
   * The challenge's outcome arrived (or, with null, will not): the hero
   * plays it from here, or falls back to the plain headline.
   */
  setOutcome(o: ResultsOutcome | null): void {
    if (this.hero !== 'outcome' || this.t < 0 || this.outcome || this.bannerT >= 0) return;
    if (o) {
      this.outcomePending = false;
      this.outcome = o;
      if (this.outcomeGone) {
        // It came after all (late): the eyebrow again, the banner from here.
        this.outcomeGone = false;
        this.title.style.fill = PALETTE.textDim;
      }
      this.prepareOutcome();
      return;
    }
    if (!this.outcomePending) return;
    // No outcome after all: the headline takes the banner's slot, in the plain style.
    this.outcomePending = false;
    this.outcomeGone = true;
    this.title.style.fill = PALETTE.text;
    this.layoutTexts();
  }

  /**
   * The shell's RANK-UP ceremony reaches the table: one soft halo in the rank
   * colour blooms behind the panel — deliberately on both sides of its edge,
   * through the panel's 15% and out past it by three cells — and settles over
   * 0.9 s. Under the panel the rim band and sheen would only leak as slits,
   * so this is the whole of the engine's part; no rays, no shake, no whiteout.
   */
  rankUp(color: number): void {
    this.haloPulse(color, RANK_GLOW_ALPHA);
  }

  /** The filled halo at the panel's edge (the rank-up's language; the win's pulse shares it in mint). */
  private haloPulse(color: number, alpha: number): void {
    const h = this.handles;
    if (!h) return;
    const L = h.layout();
    const P = resultsPanelRect(L);
    const H = this.panelH || P.h;
    const m = L.cell * RANK_GLOW_MARGIN_CELLS;
    // A feathered halo shaped like the panel: additive bands inflating the
    // panel rect out to the margin, each fainter (quadratic), so the light
    // is brightest at the panel's edge and gone three cells out. The bands
    // sum to ~1 at the edge; the sprite's alpha carries the envelope.
    const g = this.rankGlow.clear();
    for (let i = 0; i < RANK_GLOW_BANDS; i++) {
      const u = i / RANK_GLOW_BANDS;
      const d = m * u;
      g.roundRect(P.x - d, P.y - d, P.w + d * 2, H + d * 2, P.r + d).fill({
        color,
        alpha: Math.min(1, ((1 - u) * (1 - u) * RANK_GLOW_GAIN) / RANK_GLOW_BANDS),
      });
    }
    this.rankGlow.visible = true;
    this.rankGlowHold = false;
    this.rankGlowAlpha = alpha;
    this.rankGlowT = 0;
  }

  /** Tooling hook: hold the rank-up halo at `sec` into its envelope (a frozen frame for the harness). */
  rankUpSeek(sec: number): void {
    if (!this.rankGlow.visible) return;
    this.rankGlowT = Math.max(0, sec);
    this.rankGlowHold = true;
    this.update(0);
  }

  /**
   * Tooling hook: pin the scene at `sec` on its clock (the harness steps
   * exact frames); the outcome beat and the coins are simulated forward
   * from wherever they are, so seeking is monotonic.
   */
  seek(sec: number): void {
    if (this.t < 0) return;
    const step = 1 / 120;
    while (this.t < sec) this.update(Math.min(step, sec - this.t));
  }

  /** Tooling: the score digits' rectangle (root space, inset past the stroke), the ledger's top and the eyebrow's draw order. */
  get toolingRects(): {
    digits: { x: number; y: number; w: number; h: number };
    statsTop: number;
    coinsUnderText: boolean;
  } {
    const b = this.score.getLocalBounds();
    const pad = 6;
    const firstRow = this.rows.find((_, i) => i < this.rowCount && !this.hiddenNow.includes(i));
    const rowH = this.pitchNow || 24;
    const idx = (c: Container) => this.root.getChildIndex(c);
    return {
      digits: {
        x: this.score.x + b.x + pad,
        y: this.score.y + b.y + pad,
        w: b.width - pad * 2,
        h: b.height - pad * 2,
      },
      statsTop: (firstRow?.label.y ?? 0) - rowH / 2,
      coinsUnderText:
        idx(this.coinLayer) < idx(this.title) &&
        idx(this.coinLayer) < idx(this.score) &&
        idx(this.coinLayer) < idx(this.banner.container) &&
        idx(this.coinLayer) < idx(this.vsLine),
    };
  }

  /** Tooling: hide / show the flare core layer (the digit-fill check excludes it). */
  set flareCoreVisible(v: boolean) {
    this.flareFx.container.visible = v;
  }

  /** Tooling: the NEW BEST chip's screen rectangle (null when it is not shown). */
  get bestChipRect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.bestChip.visible) return null;
    const b = this.bestChip.getBounds();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }

  /** Where the outcome beat is on its own clock (seconds since the banner started; -1 = not yet), for tooling. */
  get outcomeTime(): number {
    return this.bannerT;
  }

  /** Prewarm: the snap blur program and the chip sprites, in the prewarm frame. */
  prewarm(): void {
    this.root.visible = true;
    this.root.alpha = 0.01;
    this.snap.strength = 4;
    this.root.filters = [this.snap];
    const c = this.chips[0];
    if (c) {
      c.glow.visible = c.tile.visible = true;
      c.glow.position.set(-500, -500);
      c.tile.position.set(-500, -500);
    }
    const k = this.coins[0];
    if (k) {
      k.halo.visible = k.coin.visible = true;
      k.halo.position.set(-500, -500);
      k.coin.position.set(-500, -500);
    }
    this.fx.puff(this.tex, -500, -500, 0xffffff, 4, 0.05, 0.5);
    this.fx.lineGlow(this.tex, -500, -500, 10, 10, true, 0xffffff, 0.05);
  }

  prewarmDone(): void {
    this.root.filters = [];
    this.root.alpha = 1;
    this.root.visible = false;
    const c = this.chips[0];
    if (c) c.glow.visible = c.tile.visible = false;
    const k = this.coins[0];
    if (k) k.halo.visible = k.coin.visible = false;
    this.fx.update(1);
  }

  get playing(): boolean {
    return this.t >= 0;
  }

  play(h: ResultsHandles, breakdown: ScoreBreakdown, done: () => void): void {
    this.handles = h;
    this.breakdown = breakdown;
    this.done = done;
    this.t = 0;
    this.shiftTarget = this.shiftNow = 0;
    this.root.y = 0;
    this.lastShown = -1;
    this.burstNext = 0;
    this.stung = false;
    this.chipNext = 0;
    this.fit = null;
    this.fitReq = null;
    this.heroLocked = this.rowsLocked = false;
    this.kNow = 1;
    this.vsNow = true;
    this.eyebrowNow = true;
    this.hiddenNow = [];
    this.rowsAt = -1;
    this.doneFired = false;
    this.labelsPre = false;
    this.xpGoFired = false;
    this.coinsThrown = false;
    this.flareT = -1;
    this.title.visible = true;
    this.bannerT = -1;
    this.bannerLanded = false;
    this.stakeShown = -1;
    this.banner.hide();
    this.stake.alpha = this.stakeCoin.alpha = this.vsLine.alpha = 0;
    this.bestChip.visible = false;
    this.bestChip.alpha = 0;
    for (const c of this.coins) {
      c.t = -1;
      c.halo.visible = c.coin.visible = false;
    }
    // Bottom row first, then up; left to right within a row.
    this.burstOrder = [];
    const L = h.layout();
    const cols = Math.round(L.boardSize / (L.cell + L.gap));
    for (let i = h.cells.length - 1; i >= 0; i--) {
      if ((h.cells[i]?.color ?? -1) >= 0) this.burstOrder.push(i);
    }
    this.burstOrder.sort((a, b) => {
      const ra = Math.floor(a / cols);
      const rb = Math.floor(b / cols);
      return rb - ra || (a % cols) - (b % cols);
    });
    // Every tile gets a chip while they fit the pool; beyond it, every n-th.
    const n = this.burstOrder.length;
    this.chipStride = n > CHIP_CAP ? Math.ceil(n / CHIP_CAP) : 1;
    this.chipCount = Math.ceil(n / this.chipStride);

    if (this.popT.length !== h.cells.length) this.popT = new Float32Array(h.cells.length);
    this.popT.fill(-1);
    for (const c of this.chips) {
      c.t0 = -1;
      c.glow.visible = c.tile.visible = false;
    }
    this.panel.alpha = 0;
    // The hero: a challenge with its outcome known (or coming) demotes the
    // end reason to an eyebrow over the outcome banner; everything else
    // keeps the plain headline.
    const outcome = h.outcome ?? null;
    this.hero = outcome ? 'outcome' : 'plain';
    this.outcome = outcome && outcome !== 'pending' ? outcome : null;
    this.outcomePending = outcome === 'pending';
    this.outcomeGone = false;
    const headline = endReasonCopy(breakdown.endReason, h.forfeitTitle);
    this.title.text = headline;
    this.scoreGlow.tint = PALETTE.accent;
    if (this.hero === 'outcome') {
      this.title.style.fill = PALETTE.textDim;
    } else {
      this.title.style.fontSize = 28;
      this.title.style.fill = PALETTE.text;
      this.title.style.letterSpacing = 6;
    }
    this.score.text = '0';
    this.score.alpha = 0;
    this.title.alpha = 0;
    // NEW BEST only when this score beats a KNOWN previous best; otherwise
    // nothing (owner's call: the best is not restated on every results
    // screen — the HUD already shows it during play). One dialect for every
    // hero: a small amber chip beside the score's digits.
    const best = h.best;
    this.bestChip.visible = best !== undefined && best > 0 && breakdown.total > best;
    const level = breakdown.levelReached;
    const rowsData: [string, string][] = [
      ['BASE SCORE', String(breakdown.base)],
      [
        `BEST STREAK${breakdown.bestStreak >= 2 ? ` (${breakdown.bestStreak}X)` : ''}`,
        `+${breakdown.streakBonus}`,
      ],
      [
        `COLOUR LINES${breakdown.colorLines > 0 ? ` (${breakdown.colorLines})` : ''}`,
        `+${breakdown.colorBonus}`,
      ],
      ['LINES CLEARED', String(breakdown.linesCleared)],
      ['PIECES PLACED', String(breakdown.placements)],
      [
        'CLOCK USED',
        `${Math.floor(breakdown.elapsedMs / 60000)}:${String(Math.floor((breakdown.elapsedMs % 60000) / 1000)).padStart(2, '0')}`,
      ],
      ['LEVEL REACHED', `LV ${level}`],
    ];
    this.rowCount = rowsData.length;
    // A level worth a beat (5 and up) gets a small cool glow under its row —
    // the level language (indigo → mint from 10), never the sting's warm core.
    this.glowRow = level >= 5 ? rowsData.length - 1 : -1;
    this.levelGlow.visible = this.glowRow >= 0;
    this.levelGlow.alpha = 0;
    this.levelGlow.tint = level >= 10 ? PALETTE.accent : PALETTE.indigo;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      const d = rowsData[i];
      if (!r) continue;
      r.label.text = d?.[0] ?? '';
      r.value.text = d?.[1] ?? '';
      // The level row's value in the level language's end colour (mint).
      r.value.style.fill = i === rowsData.length - 1 ? levelColor(1) : PALETTE.text;
      r.label.visible = r.value.visible = d !== undefined;
      r.label.alpha = r.value.alpha = 0;
    }
    this.pitchNow = RESULTS_METRICS.rowPitch * L.boardSize;
    this.panelH = Math.max(
      resultsPanelRect(L).h,
      rowsStart(this.hero, 1, true) * L.boardSize +
        (this.rowCount - 1) * this.pitchNow +
        RESULTS_METRICS.bottom * L.boardSize,
    );
    if (this.outcome) this.prepareOutcome();
    this.layoutTexts();
    // The panel comes in out of focus and snaps sharp as it fades up.
    this.snap.strength = 10;
    this.root.filters = [this.snap];
    this.root.visible = true;
    h.setGrade?.(0);
  }

  /** The outcome's copy into the banner, the stake and the VS line (positions come from layoutTexts). */
  private prepareOutcome(): void {
    const o = this.outcome;
    if (!o) return;
    const copy = outcomeCopy(o);
    const color = o.won ? PALETTE.accent : PALETTE.danger;
    // The shadow first: only the fill's setter notifies the letters.
    this.bannerStyle.dropShadow.color = color;
    this.bannerStyle.fill = color;
    this.stake.text = o.won ? this.stakeText(0) : copy.stake;
    this.stake.style.fill = o.won ? PALETTE.accentWarm : PALETTE.danger;
    this.stakeCoin.visible = o.won && copy.stake !== '';
    // A loss: the score's halo goes quiet (text-dim), never a celebratory mint under a rose banner.
    if (!o.won) this.scoreGlow.tint = PALETTE.textDim;
    this.vsLine.text = copy.vs;
    this.layoutTexts();
  }

  /** "+20 $CHAIN" at a count value (the win's stake counts from 0). */
  private stakeText(n: number): string {
    return `+${formatScore(n)} $CHAIN`;
  }

  /** The streak heat the game reached, from its best streak: (streak - 1) / 4. */
  private heatReached(): number {
    const s = this.breakdown?.bestStreak ?? 1;
    return Math.max(0, Math.min(1, (s - 1) / 4));
  }

  private layoutTexts(): void {
    const h = this.handles;
    if (!h) return;
    const L = h.layout();
    const B = L.boardSize;
    const cx = L.boardX + B / 2;
    // A panel over the socket grid so the text never sits on bare sockets
    // (resultsPanelRect: the pushed-in plate + 16 px, shared with the shell;
    // its height is the content's, or the plate's when that is taller).
    const P = resultsPanelRect(L);
    const H = this.panelH || P.h;
    this.panel
      .clear()
      .roundRect(P.x, P.y, P.w, H, P.r)
      .fill({ color: 0x0f1226, alpha: 0.85 })
      .stroke({ color: 0x242a4a, width: 1, alpha: 1 });
    const y0 = P.y;
    const k = this.kNow;
    const m = RESULTS_METRICS;
    const small = Math.max(SMALL_FONT_MIN, Math.round(B * SMALL_FONT));
    let scoreY: number;
    if (this.hero === 'outcome') {
      const o = m.outcome;
      // With the eyebrow dropped (the fit's call on a short phone) the hero lifts by its slot.
      const lift = this.eyebrowNow ? 0 : m.eyebrowDrop * B;
      this.title.visible = this.eyebrowNow || this.outcomeGone;
      const bannerY = y0 + o.banner * k * B - lift;
      if (this.outcomeGone) {
        // The outcome never came: the end reason as the plain headline, in the banner's slot.
        this.title.style.fontSize = 28;
        this.title.style.letterSpacing = 6;
        this.title.position.set(cx, bannerY);
      } else {
        // The eyebrow: the end reason, small and dim, over the banner.
        this.title.style.fontSize = small;
        this.title.style.letterSpacing = Math.round(small * 0.22);
        this.title.position.set(cx, y0 + o.eyebrow * k * B);
      }
      const bannerFont = Math.max(BANNER_FONT_MIN, Math.round(B * BANNER_FONT));
      if (this.bannerStyle.fontSize !== bannerFont) {
        this.bannerStyle.fontSize = bannerFont;
        this.bannerStyle.letterSpacing = Math.round(bannerFont * 0.12);
      }
      this.banner.container.position.set(cx, bannerY);
      const rw = Math.round(B * RULE_W);
      this.ruleY = bannerY + bannerFont * RULE_BELOW;
      this.rule
        .clear()
        .roundRect(cx - rw / 2, this.ruleY, rw, 2, 1)
        .fill({ color: this.outcome && !this.outcome.won ? PALETTE.danger : PALETTE.accent });
      scoreY = y0 + o.score * k * B - lift;
      // The stake: the coin at cap height on the left of the amount, the pair centred.
      const lost = this.outcome !== null && !this.outcome.won;
      const stakeFont = Math.max(
        STAKE_FONT_MIN,
        Math.round(B * (lost ? STAKE_FONT_LOSS : STAKE_FONT)),
      );
      this.stake.style.fontSize = stakeFont;
      this.stake.style.letterSpacing = Math.round(stakeFont * 0.04);
      this.stakeCx = cx;
      this.stakeCoin.scale.set((stakeFont * 0.68) / COIN_TEX_PX);
      this.placeStake(y0 + o.stake * k * B - lift);
      this.vsLine.style.fontSize = small;
      this.vsLine.style.letterSpacing = Math.round(small * 0.12);
      this.vsLine.position.set(cx, y0 + o.vs * k * B - lift);
      this.vsLine.visible = this.vsNow;
    } else {
      const p = m.plain;
      const top = y0 + p.title * k * B;
      this.title.style.fontSize = 28;
      this.ruleY = top + 22;
      this.rule
        .clear()
        .roundRect(cx - 32, this.ruleY, 64, 2, 1)
        .fill({ color: PALETTE.accent });
      this.title.position.set(cx, top);
      this.title.visible = true;
      scoreY = y0 + p.score * k * B;
      this.vsLine.visible = false;
    }
    this.score.position.set(cx, scoreY);
    this.score.style.fontSize = Math.round(B * 0.16);
    this.scoreGlow.position.set(cx, scoreY);
    this.scoreGlow.scale.set((B * 1.1) / 256, (B * 0.5) / 256);
    // NEW BEST as a chip beside the digits, at the cap's top (placed again when the count lands: the width changes).
    const chipFont = Math.max(SMALL_FONT_MIN, Math.round(B * BEST_CHIP_FONT));
    this.bestChipText.style.fontSize = chipFont;
    this.bestChipText.style.letterSpacing = Math.round(chipFont * 0.12);
    this.placeBestChip();
    const rowY0 = y0 + rowsStart(this.hero, k, this.vsNow, this.eyebrowNow) * B;
    const rowH = this.pitchNow || m.rowPitch * B;
    const inset = B * ROW_INSET;
    let slot = 0;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (!r) continue;
      const hidden = this.hiddenNow.includes(i);
      const y = rowY0 + slot * rowH;
      if (!hidden) slot++;
      r.label.position.set(L.boardX + inset, y);
      r.value.position.set(L.boardX + B - inset, y);
      r.label.style.fontSize = Math.round(B * 0.034);
      r.value.style.fontSize = Math.round(B * 0.042);
      r.label.visible = r.value.visible = i < this.rowCount && !hidden;
    }
    if (this.glowRow >= 0) {
      this.levelGlow.position.set(cx, this.rows[this.glowRow]?.label.y ?? rowY0);
      this.levelGlow.scale.set((B * 0.9) / this.tex.size, (rowH * 2.2) / this.tex.size);
    }
  }

  /** Centre the stake line (coin + amount) on the panel at `y`; called per count tick as the width changes. */
  private placeStake(y?: number): void {
    const cy = y ?? this.stake.y;
    const font = this.stake.style.fontSize;
    const coinPx = this.stakeCoin.visible ? font * 0.68 : 0;
    const gap = this.stakeCoin.visible ? font * 0.18 : 0;
    // The Text's width carries its stroke padding; a hair of it is fine.
    const w = this.stake.width + coinPx + gap;
    const x0 = this.stakeCx - w / 2;
    this.stakeCoin.position.set(x0 + coinPx / 2, cy);
    this.stake.position.set(x0 + coinPx + gap, cy);
  }

  /** The NEW BEST chip beside the score's digits, at the cap's top. */
  private placeBestChip(): void {
    if (!this.bestChip.visible) return;
    const font = this.bestChipText.style.fontSize;
    const padX = font * 0.55;
    const w = this.bestChipText.width + padX * 2;
    const hgt = font * 1.5;
    // A solid plate fill under the amber tint (the shell's chip weight): a
    // coin behind the chip never shows through its text.
    this.bestChipBg
      .clear()
      .roundRect(-w / 2, -hgt / 2, w, hgt, hgt / 2)
      .fill({ color: PALETTE.plateTop, alpha: 1 })
      .roundRect(-w / 2, -hgt / 2, w, hgt, hgt / 2)
      .fill({ color: PALETTE.accentWarm, alpha: 0.14 })
      .stroke({ color: PALETTE.accentWarm, width: 1, alpha: 0.6 });
    const L = this.handles?.layout();
    const gap = L ? L.boardSize * BEST_CHIP_GAP : 8;
    // The digits' half-width without the stroke padding; the chip hangs off their right edge at cap height.
    const half = this.score.width / 2 - 4;
    this.bestChip.position.set(
      this.score.x + half + gap + w / 2,
      this.score.y - this.score.style.fontSize * 0.28,
    );
  }

  /** Launch a lit chip from a tile's screen position toward the score. */
  private launchChip(h: ResultsHandles, L: Layout, sprite: Sprite, color: number): void {
    if (this.chipNext >= this.chipCount) return;
    const c = this.chips[this.chipNext];
    if (!c) return;
    const order = this.chipNext++;
    (sprite.parent ?? sprite).toGlobal(sprite.position, this.tmp);
    c.x0 = this.tmp.x;
    c.y0 = this.tmp.y;
    c.t0 = this.t;
    // Land spread across the count-up, in launch order.
    const share = this.chipCount > 1 ? order / (this.chipCount - 1) : 1;
    c.t1 = SCORE_START_S + SCORE_COUNT_S * (CHIP_LAND_FROM + (1 - CHIP_LAND_FROM) * share);
    // Burst outward from the board centre and up, then dive into the number.
    const bx = L.boardX + L.boardSize / 2;
    const by = L.boardY + L.boardSize / 2;
    let dx = c.x0 - bx;
    let dy = c.y0 - by;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    c.cx = c.x0 + dx * L.boardSize * 0.32;
    c.cy = c.y0 + dy * L.boardSize * 0.2 - L.boardSize * 0.28;
    c.spin = (Math.random() - 0.5) * 5;
    c.color = color;
    c.tile.texture = h.tex.tiles[Math.max(0, Math.min(h.tex.tiles.length - 1, color))]!;
    c.tile.tint = 0xffffff;
    c.glow.tint = shade(colorOf(color), 0.2);
    c.glow.visible = c.tile.visible = true;
    c.tile.rotation = 0;
  }

  /**
   * The count lands: a flourish keyed to the streak heat reached. In the HUD
   * (no bloom out here) it is built from layered additive glows: an accent
   * `#3de6c9` halo at 0.35 with a warm-white `#ffe8c8` core at 0.25 — a
   * coloured halo on the dark panel, never a cream blob — and a soft bar
   * across the number in the tier's colour; the white tier adds god rays in
   * the post chain (behind the panel, so they show around it). The post grade
   * takes a brief warm breath and fades out. No rings: they are the
   * streak-burst language.
   */
  private sting(h: ResultsHandles, L: Layout): void {
    this.stung = true;
    const tier = stingTier(this.heatReached());
    const x = this.score.x;
    const y = this.score.y;
    const s = h.screen?.() ?? { width: L.width, height: L.height };
    const B = L.boardSize;
    // A known loss keys the flourish to text-dim: the punch stays, the celebration does not.
    const lost = this.outcome !== null && !this.outcome.won;
    const halo = lost ? PALETTE.textDim : PALETTE.accent;
    const flourish = (bar: number, k: number): void => {
      this.fx.puff(h.tex, x, y, lost ? halo : PALETTE.warmWhite, B * 0.42 * k, 0.4, 0.25);
      this.fx.puff(h.tex, x, y, halo, B * 1.3 * k, 0.6, 0.35);
      this.fx.lineGlow(h.tex, x, y, B * 1.4 * k, B * 0.14, true, lost ? halo : bar, 0.55, 0.5);
    };
    if (lost) {
      flourish(halo, 0.7);
    } else if (tier === 'white') {
      // Warm white: rays behind the panel, a full flourish, a warm breath of grade.
      h.post?.rays(x / s.width, y / s.height, 0.9, [1, 0.95, 0.85], 0.9);
      h.post?.kick(0.12);
      flourish(PALETTE.warmWhite, 1);
    } else if (tier === 'amber') {
      h.post?.kick(0.06);
      flourish(PALETTE.accentWarm, 0.85);
    } else {
      flourish(PALETTE.accent, 0.7);
    }
    this.scoreGlow.alpha = 1;
    // The final number is known now: the NEW BEST chip takes its place beside it.
    this.placeBestChip();
  }

  /**
   * Post grade after the sting: a brief warm breath (0.3 / 0.2 / 0 by tier)
   * fading out over 0.8 s, never held — a held grade lifted the blurred
   * backdrop into a grey-violet wash under the buttons.
   */
  private stingGrade(t: number): number {
    const tier = stingTier(this.heatReached());
    const peak = tier === 'white' ? 0.3 : tier === 'amber' ? 0.2 : 0;
    const p = Math.max(0, Math.min(1, (t - (SCORE_START_S + SCORE_COUNT_S)) / 0.8));
    return peak * (1 - easeOutCubic(p));
  }

  /** The outcome beat starts: the banner slams in; a loss cools the room and lands without the flash. */
  private startOutcome(h: ResultsHandles): void {
    const o = this.outcome;
    if (!o) return;
    this.bannerT = 0;
    this.banner.show(outcomeCopy(o).title);
    if (h.reducedMotion) this.banner.update(10);
    if (o.won) {
      h.onBeat?.('outcome-win');
    } else {
      h.onBeat?.('outcome-loss');
      h.post?.roomDim(LOSS_DIM, LOSS_DIM_S);
    }
  }

  /**
   * The banner has landed. A win: one warm-white flare at the score (filled,
   * α 1 → 0 over 250 ms, no hoop), the coin burst from the score, a mint
   * pulse on the panel's edge, and the stake starts counting. A loss: the
   * stake lost fades up in rose; nothing is thrown.
   */
  private landOutcome(h: ResultsHandles, L: Layout): void {
    const o = this.outcome;
    if (!o) return;
    this.bannerLanded = true;
    const B = L.boardSize;
    this.preSettleLabels();
    if (o.won) {
      if (!h.reducedMotion) {
        const sx = this.score.x;
        const sy = this.score.y;
        // One filled flare: the warm bloom under the digits, the hot core held over them.
        this.fx.puff(h.tex, sx, sy, FLARE_BLOOM_COLOR, B * FLARE_SIZE, FLARE_S, 1, true);
        this.flareFx.flare(
          h.tex,
          sx,
          sy,
          FLARE_CORE_COLOR,
          B * FLARE_CORE_SIZE,
          FLARE_CORE_HOLD_S,
          FLARE_CORE_OUT_S,
          FLARE_CORE_ALPHA,
        );
        this.flareT = 0;
        this.scoreGlow.alpha = FLARE_GLOW_DIP;
        this.throwCoins(h, L);
        this.coinsThrown = true;
        h.post?.kick(0.05);
      }
      this.haloPulse(PALETTE.accent, WIN_PULSE_ALPHA);
      h.onBeat?.('outcome-burst');
    }
  }

  /**
   * The rows' labels take their places, faint, as the letters slam — so the
   * plate has its structure under the hero at the landing; their values slam
   * in with the rows. The pitch locks here with them.
   */
  private preSettleLabels(): void {
    if (this.labelsPre) return;
    this.rowsLocked = true;
    this.labelsPre = true;
    this.layoutTexts();
  }

  /** The win's coins: a fan launched upward from the score, three sizes, spinning and flipping, under gravity. */
  private throwCoins(h: ResultsHandles, L: Layout): void {
    const n = Math.min(COIN_CAP, Math.max(0, Math.floor(h.coins ?? 0)));
    const B = L.boardSize;
    const x0 = this.score.x;
    const y0 = this.score.y;
    // A phone's board is the screen: a narrower, slower fan keeps every coin on it sideways.
    const narrow = B >= L.width * COIN_NARROW_FROM;
    let fan = narrow ? COIN_FAN_RAD_NARROW : COIN_FAN_RAD;
    let vMax = narrow ? COIN_SPEED_MAX_NARROW : COIN_SPEED_MAX;
    // Headroom: the apex stays under the chrome's row (a rank-up's compressed
    // panel puts the score right under it). The cap is on the RISE: the
    // launch speed keeps its floor and the fan widens, so the throw goes
    // wide instead of up.
    // The scene is shifted up as a block on short screens: the headroom is
    // measured from where the score IS on screen, not in the root's space.
    const safeTop = Math.max(0, (this.fitReq?.safeTop ?? 0) - 8);
    const big = B >= COIN_BIG_FROM_PX ? COIN_BIG_SCALE : 1;
    const rMax = ((COIN_SIZES[0] ?? 0.062) * B * big) / 2;
    // The chrome's row, in root space; the birth line sits one coin above the
    // rule but never inside the chrome (a rank-up's compressed panel puts the
    // rule right under the ✕): there the coins are born on the rule itself.
    const chromeY = CHROME_BOTTOM_PX + safeTop - this.shiftTarget;
    const jitter = COIN_SPAWN_JITTER_Y * B;
    const bornY = Math.max(this.ruleY - rMax, chromeY + rMax + jitter + 1);
    const headroom = Math.max(0, bornY - jitter - rMax - chromeY - 1);
    const riseCap = Math.sqrt(2 * COIN_GRAVITY * (headroom / B)); // B/s
    const capped = riseCap < vMax;
    if (capped) {
      vMax = Math.max(COIN_SPEED_FLOOR, Math.min(vMax, riseCap));
      fan = COIN_FAN_RAD_CAPPED;
    }
    const firstRow = this.rows.find((_, i) => i < this.rowCount && !this.hiddenNow.includes(i));
    const floorY = this.vsNow ? this.vsLine.y : (firstRow?.label.y ?? y0 + B);
    const digitsHalfW = this.score.getLocalBounds().width / 2 - 4;
    for (let i = 0; i < n; i++) {
      const c = this.coins[i];
      if (!c) break;
      // Spread across the fan with jitter, never an even spoke pattern.
      const u = n > 1 ? i / (n - 1) : 0.5;
      const a = (u - 0.5) * 2 * fan + (Math.random() - 0.5) * 0.25;
      const v = (COIN_SPEED_MIN + Math.random() * (vMax - COIN_SPEED_MIN)) * B;
      const sizeIdx = i % COIN_SIZES.length;
      c.size = (COIN_SIZES[sizeIdx] ?? COIN_SIZES[0]) * B * big;
      // Born on the rule (one radius above it, spread sideways), never on the
      // number. With no headroom (the rule under the ✕) they are born BESIDE
      // the number instead, each side, and leave outward.
      c.y = bornY + (Math.random() - 0.5) * 2 * jitter;
      if (capped) {
        const side = i % 2 === 0 ? 1 : -1;
        c.x = x0 + side * (digitsHalfW + c.size / 2 + Math.random() * COIN_SPAWN_SPREAD * B);
        c.vx = side * Math.max(COIN_SIDE_SPEED_MIN * B, Math.abs(Math.sin(a) * v));
      } else {
        c.x = x0 + (Math.random() - 0.5) * 2 * COIN_SPAWN_SPREAD * B;
        c.vx = Math.sin(a) * v;
      }
      c.vy = -Math.min(Math.cos(a) * v, riseCap * B);
      c.t = 0;
      // The coin waits its launch delay, unseen, then leaves.
      c.launch = Math.random() * COIN_LAUNCH_JITTER_S;
      c.gravity = capped ? COIN_GRAVITY_CAPPED : 1;
      c.life = COIN_LIFE_MIN + Math.random() * (COIN_LIFE_MAX - COIN_LIFE_MIN);
      if (capped)
        c.life =
          COIN_LIFE_CAPPED_MIN + Math.random() * (COIN_LIFE_CAPPED_MAX - COIN_LIFE_CAPPED_MIN);
      // Gone before the ledger: half a coin above the VS line (or the first row).
      c.floor = floorY - c.size / 2;
      // Sideways: a coin never leaves the screen — its drift over its whole
      // life is clamped to the room between it and the nearer screen edge.
      const room = Math.max(0, (c.vx < 0 ? c.x : L.width - c.x) - c.size / 2);
      c.vx = Math.sign(c.vx) * Math.min(Math.abs(c.vx), room / c.life);
      c.spin = (Math.random() - 0.5) * 2 * COIN_SPIN;
      c.flip = COIN_FLIP_MIN + Math.random() * (COIN_FLIP_MAX - COIN_FLIP_MIN);
      c.phase = Math.random() * Math.PI * 2;
      c.edge = sizeIdx === COIN_SIZES.length - 1 ? COIN_EDGE_MIN_SMALL : COIN_EDGE_MIN;
      c.coin.visible = c.halo.visible = true;
      c.coin.alpha = c.halo.alpha = 0;
    }
  }

  private updateCoins(dt: number, L: Layout): void {
    const B = L.boardSize;
    // The eyebrow's line box: a coin passing under it dips so the word stays legible.
    const eyebrow = this.hero === 'outcome' && this.title.visible && !this.outcomeGone;
    const eyeTop = this.title.y - this.title.height / 2;
    const eyeBottom = this.title.y + this.title.height / 2;
    for (const c of this.coins) {
      if (c.t < 0) continue;
      c.t += dt;
      if (c.t < c.launch) {
        c.coin.alpha = c.halo.alpha = 0;
        continue;
      }
      const age = c.t - c.launch;
      if (age >= c.life) {
        c.t = -1;
        c.coin.visible = c.halo.visible = false;
        continue;
      }
      c.vy += COIN_GRAVITY * c.gravity * B * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      const p = age / c.life;
      // Gone by the floor (the fade band above it), and by the end of its life.
      const toFloor = c.floor - (c.y + c.size / 2);
      if (toFloor <= 0) {
        c.t = -1;
        c.coin.visible = c.halo.visible = false;
        continue;
      }
      const lifeFade = p < COIN_FADE_FROM ? 1 : 1 - (p - COIN_FADE_FROM) / (1 - COIN_FADE_FROM);
      const fade = Math.min(lifeFade, toFloor / (COIN_FLOOR_FADE * B));
      // Birth: nothing for the first 60 ms, then body and halo fade up together (eased in, so
      // eighteen coins stacked at their birth never sum to a visible clump).
      const bornU = Math.max(0, Math.min(1, (age - COIN_BORN_S) / COIN_IN_S));
      const born = bornU * bornU;
      const dip = eyebrow && c.y > eyeTop && c.y < eyeBottom ? COIN_UNDER_EYEBROW_ALPHA : 1;
      // A coin tumbles: it spins in the plane and flips about its vertical axis (the width squashes).
      const flip = Math.cos(c.phase + age * c.flip);
      const s = c.size / COIN_TEX_PX;
      c.coin.position.set(c.x, c.y);
      c.coin.rotation += c.spin * dt;
      c.coin.scale.set(s * Math.max(c.edge, Math.abs(flip)), s);
      c.coin.alpha = born * fade * dip;
      c.halo.position.set(c.x, c.y);
      c.halo.scale.set((c.size * COIN_HALO) / this.tex.size);
      c.halo.alpha = COIN_HALO_ALPHA * born * fade * dip * (0.7 + 0.3 * Math.abs(flip));
    }
  }

  update(dt: number): void {
    if (this.shiftNow !== this.shiftTarget) {
      const k = Math.min(1, dt * 12);
      this.shiftNow += (this.shiftTarget - this.shiftNow) * k;
      if (Math.abs(this.shiftNow - this.shiftTarget) < 0.5) this.shiftNow = this.shiftTarget;
      this.root.y = this.shiftNow;
    }
    // The sting's glows outlive the beat (the buttons come up over them).
    this.fx.update(dt);
    this.flareFx.update(dt);
    if (this.flareT >= 0) {
      // The score's mint glow dips under the warm flare and comes back with the core's out.
      this.flareT += dt;
      const u = Math.min(1, this.flareT / (FLARE_CORE_HOLD_S + FLARE_CORE_OUT_S));
      this.scoreGlow.alpha = FLARE_GLOW_DIP + (0.5 - FLARE_GLOW_DIP) * u;
      if (u >= 1) this.flareT = -1;
    }
    if (this.rankGlowT >= 0) {
      if (!this.rankGlowHold) this.rankGlowT += dt;
      const u = Math.min(1, this.rankGlowT / RANK_GLOW_S);
      // Quick in (the first 5% — ~45 ms), then an ease-out fade over the rest.
      const a = u < 0.05 ? u / 0.05 : 1 - easeOutCubic((u - 0.05) / 0.95);
      this.rankGlow.alpha = this.rankGlowAlpha * a;
      if (u >= 1) {
        this.rankGlowT = -1;
        this.rankGlow.visible = false;
      }
    }
    if (this.handles && this.t < 0) {
      // Settled: the coins may still be landing.
      this.updateCoins(dt, this.handles.layout());
    }
    if (this.t < 0 || !this.handles || !this.breakdown) return;
    // The end-of-game slow-mo holds the clock at 0 (the scene is armed so
    // the shell can measure its tray) and releases it as one beat.
    if (this.paused) return;
    const h = this.handles;
    const L = h.layout();
    this.t += dt;
    const t = this.t;
    const cx = L.boardX + L.boardSize / 2;
    const cy = L.boardY + L.boardSize / 2;

    // Tilt back (a fake 3D on the table) and dolly the camera in 4% over 0.9 s.
    const k = easeOutCubic(Math.min(1, t / TILT_S));
    const dolly = easeOutCubic(Math.min(1, t / DOLLY_S));
    h.table.pivot.set(cx, cy);
    h.table.position.set(cx, cy + 10 * k);
    h.table.scale.set(1 - 0.02 * k, 1 - 0.08 * k);
    h.world.pivot.set(cx, cy);
    h.world.position.set(cx, cy);
    h.world.scale.set(1 + DOLLY * dolly);

    // Focus pull: the table goes to bokeh while the panel snaps sharp.
    if (h.post) {
      const focus = easeInOutQuad(Math.max(0, Math.min(1, (t - FOCUS_START_S) / FOCUS_S)));
      const s = h.screen?.() ?? { width: L.width, height: L.height };
      h.post.setDof(focus, (L.boardY + L.boardSize * 0.26) / s.height);
    }
    if (this.root.filters && this.root.filters.length > 0) {
      const p = Math.max(0, Math.min(1, (t - SNAP_START_S) / SNAP_S));
      this.snap.strength = 10 * (1 - easeOutCubic(p));
      if (p >= 1) this.root.filters = [];
    }

    // Tiles lift off bottom-to-top; each becomes a chip.
    if (t >= BURST_START_S) {
      while (this.burstNext < this.burstOrder.length) {
        const idx = this.burstOrder[this.burstNext];
        if (idx === undefined) break;
        const cols = Math.round(L.boardSize / (L.cell + L.gap));
        const rowFromBottom = Math.floor((h.cells.length - 1 - idx) / cols);
        const col = idx % cols;
        const due = BURST_START_S + rowFromBottom * BURST_ROW_S + col * BURST_COL_S;
        if (t < due) break;
        const cell = h.cells[idx];
        if (cell && cell.color >= 0) {
          const { x, y } = cell.sprite.position;
          const color = shade(colorOf(cell.color), 0.3);
          // One shard burst per row: fire it on the row's first tile.
          if (col === 0 || this.burstNext === 0)
            h.particles.burst(x, y, color, 6, L.cell * 4, L.cell / h.tex.size, 1, 0);
          h.oneShots.puff(h.tex, x, y, color, L.cell * 2.5, 0.35, 0.5);
          if (this.burstNext % this.chipStride === 0)
            this.launchChip(h, L, cell.sprite, cell.color);
          this.popT[idx] = 0;
          cell.color = -1;
          h.onBeat?.('burst');
        }
        this.burstNext++;
      }
    }

    // Tiles popping off the board.
    const colsN = Math.round(L.boardSize / (L.cell + L.gap));
    for (let i = 0; i < this.popT.length; i++) {
      const ft = this.popT[i] ?? -1;
      if (ft < 0) continue;
      const cell = h.cells[i];
      if (!cell) continue;
      const nt = ft + dt;
      const sp = cell.sprite;
      if (nt >= POP_S) {
        this.popT[i] = -1;
        sp.texture = h.tex.socket;
        sp.tint = 0xffffff;
        sp.scale.set(L.cell / h.tex.size);
        sp.alpha = 1;
        sp.rotation = 0;
        const r = Math.floor(i / colsN);
        const c = i % colsN;
        sp.position.set(
          L.boardX + c * (L.cell + L.gap) + L.cell / 2,
          L.boardY + r * (L.cell + L.gap) + L.cell / 2,
        );
        continue;
      }
      this.popT[i] = nt;
      const p = nt / POP_S;
      sp.alpha = 1 - p * p;
      sp.scale.set((L.cell / h.tex.size) * (1 + p * 0.3));
    }

    // Chips in flight: a quadratic arc out and up, then into the number.
    const sx = this.score.x;
    const sy = this.score.y;
    const chipPx = L.cell * 0.58;
    for (const c of this.chips) {
      if (c.t0 < 0) continue;
      const p = Math.max(0, Math.min(1, (t - c.t0) / Math.max(0.05, c.t1 - c.t0)));
      if (p >= 1) {
        c.t0 = -1;
        c.glow.visible = c.tile.visible = false;
        // Landing: the glow pulses and the number takes the hit.
        this.scoreGlow.alpha = Math.min(1, this.scoreGlow.alpha + 0.25);
        this.score.scale.set(Math.max(this.score.scale.x, 1.05));
        this.fx.puff(h.tex, sx, sy, c.glow.tint, L.cell * 1.6, 0.22, 0.5);
        continue;
      }
      const e = easeInOutQuad(p);
      const u = 1 - e;
      const x = u * u * c.x0 + 2 * u * e * c.cx + e * e * sx;
      const y = u * u * c.y0 + 2 * u * e * c.cy + e * e * sy;
      const scale = (chipPx / h.tex.size) * (1 - 0.45 * e);
      c.tile.position.set(x, y);
      c.tile.scale.set(scale);
      c.tile.rotation += c.spin * dt;
      c.tile.alpha = Math.min(1, p * 6);
      c.glow.position.set(x, y);
      c.glow.scale.set((chipPx * 2.4) / h.tex.size);
      c.glow.alpha = 0.75 * Math.min(1, p * 6);
    }

    // The panel fades in under the text once the burst is under way.
    this.panel.alpha = Math.min(1, Math.max(0, (t - 0.5) / 0.4));

    // Title, then the score counts up with a pulse per digit change.
    this.title.alpha = Math.min(1, Math.max(0, (t - 0.5) / 0.3));
    if (t >= SCORE_START_S) {
      if (!this.heroLocked) {
        // The count starts: the hero's spacing is fixed from here.
        this.heroLocked = true;
      }
      const p = Math.min(1, (t - SCORE_START_S) / SCORE_COUNT_S);
      const shown = Math.round(this.breakdown.total * easeOutCubic(p));
      this.score.alpha = Math.min(1, p * 4);
      if (shown !== this.lastShown) {
        // The same thousands separator as the share card and the modal: "1,400".
        this.score.text = formatScore(shown);
        this.score.scale.set(1.12);
        this.scoreGlow.alpha = 0.9;
        if (String(shown).length !== String(this.lastShown).length) h.onBeat?.('digit');
        this.lastShown = shown;
      }
      this.score.scale.set(this.score.scale.x + (1 - this.score.scale.x) * Math.min(1, dt * 14));
      this.scoreGlow.alpha = Math.max(0.35, this.scoreGlow.alpha - dt * 2.5);
      if (p >= 1 && !this.stung) {
        // One final punch when the count lands, and the grade sting.
        this.score.scale.set(1.2);
        this.sting(h, L);
      }
      if (this.stung) h.setGrade?.(this.stingGrade(t));
    }

    // The NEW BEST chip fades up once the count lands.
    if (t >= SCORE_START_S + SCORE_COUNT_S && this.bestChip.visible) {
      this.bestChip.alpha = Math.min(1, (t - (SCORE_START_S + SCORE_COUNT_S)) / 0.25);
    }

    // The outcome beat: the banner, then its landing (the coins, the stake, the VS line).
    let rowsStartAt = ROWS_START_S;
    if (this.hero === 'outcome') {
      if (this.bannerT < 0 && this.outcome && t >= OUTCOME_START_S) this.startOutcome(h);
      // A pending outcome that never comes (the shell is stuck): the plain headline, and on with the rows.
      if (this.outcomePending && t >= OUTCOME_START_S + OUTCOME_WAIT_MAX_S) this.setOutcome(null);
      if (this.bannerT >= 0) {
        this.bannerT += dt;
        const bt = this.bannerT;
        if (!h.reducedMotion) this.banner.update(bt);
        // The labels settle in, faint, as the letters slam: at the landing they are there.
        if (bt >= BANNER_LAND_S - LABEL_PRE_IN_S || h.reducedMotion) {
          this.preSettleLabels();
          const pre = Math.min(1, (bt - (BANNER_LAND_S - LABEL_PRE_IN_S)) / LABEL_PRE_IN_S);
          for (let i = 0; i < this.rowCount; i++) {
            const r = this.rows[i];
            if (r && !this.hiddenNow.includes(i) && r.label.alpha < LABEL_PRE_ALPHA)
              r.label.alpha = Math.max(r.label.alpha, pre * LABEL_PRE_ALPHA);
          }
        }
        if (!this.bannerLanded && (bt >= BANNER_LAND_S || h.reducedMotion)) this.landOutcome(h, L);
        if (this.bannerLanded) {
          const lt = bt - BANNER_LAND_S;
          const o = this.outcome;
          const counting = o?.won === true && o.chain > 0;
          // A counted stake never shows "+0": it fades up only once it reads a number.
          this.stake.alpha = counting && this.stakeShown < 1 ? 0 : Math.min(1, lt / STAKE_IN_S);
          this.stakeCoin.alpha = this.stake.alpha;
          if (counting && o) {
            const p = h.reducedMotion ? 1 : Math.min(1, lt / STAKE_COUNT_S);
            const n = Math.round(o.chain * easeOutCubic(p));
            if (n !== this.stakeShown) {
              this.stake.text = this.stakeText(n);
              this.stakeShown = n;
              this.stake.scale.set(1.1);
              this.placeStake();
            }
            this.stake.scale.set(
              this.stake.scale.x + (1 - this.stake.scale.x) * Math.min(1, dt * 14),
            );
            this.stakeCoin.scale.set(
              ((this.stake.style.fontSize * 0.68) / COIN_TEX_PX) * this.stake.scale.x,
            );
          }
          this.vsLine.alpha = Math.min(1, Math.max(0, (lt - VS_AFTER_S) / VS_IN_S));
        }
        rowsStartAt = t - bt + ROWS_AFTER_OUTCOME_S;
      } else if (this.outcome || this.outcomePending) {
        // Not yet: the rows wait for the beat.
        rowsStartAt = Number.POSITIVE_INFINITY;
      }
      this.updateCoins(dt, L);
    }

    // The rows wait for the shell's final tray measurement (the fit), within a grace.
    const fitReady = this.fitReq?.final === true || t >= rowsStartAt + FIT_GRACE_S;
    if (this.rowsAt < 0 && t >= rowsStartAt && fitReady) {
      this.rowsAt = t;
      this.rowsLocked = true;
      this.layoutTexts();
      // The shell shows its tray as the rows start (they are furniture, not a beat to wait out).
      if (!this.doneFired) {
        this.doneFired = true;
        const done = this.done;
        this.done = null;
        done?.();
      }
    }
    // The shell's XP beat waits for the rows and, on a win, for the last coin (the scene's clock).
    if (
      this.rowsAt >= 0 &&
      !this.xpGoFired &&
      (!this.coinsThrown || this.bannerT >= XP_GO_AFTER_BANNER_S)
    ) {
      this.xpGoFired = true;
      h.onBeat?.('xp-go');
    }
    // Rows slam in from alternating sides (with the labels already in place, only the values slam).
    if (this.rowsAt >= 0) {
      let slot = 0;
      for (let i = 0; i < this.rowCount; i++) {
        const r = this.rows[i];
        if (!r) continue;
        if (this.hiddenNow.includes(i)) continue;
        const start = this.rowsAt + slot * ROW_STEP_S;
        slot++;
        if (t < start) continue;
        const p = Math.min(1, (t - start) / ROW_IN_S);
        const e = easeOutBack(p, 1.4);
        const inset = L.boardSize * ROW_INSET;
        const off = (1 - e) * L.boardSize * 0.35 * (r.fromLeft ? -1 : 1);
        if (this.labelsPre) {
          r.label.x = L.boardX + inset;
          r.label.alpha = LABEL_PRE_ALPHA + (1 - LABEL_PRE_ALPHA) * p;
        } else {
          r.label.x = L.boardX + inset + off;
          r.label.alpha = Math.min(1, p * 2);
        }
        r.value.x = L.boardX + L.boardSize - inset + off;
        r.value.alpha = Math.min(1, p * 2);
        if (p < 0.05) h.onBeat?.('row');
        // The level row's cool glow arrives with the row, a beat behind it.
        if (i === this.glowRow) this.levelGlow.alpha = 0.32 * easeOutCubic(p);
      }
      const shown = this.rowCount - this.hiddenNow.length;
      if (t >= this.rowsAt + shown * ROW_STEP_S + ROW_IN_S + 0.4) {
        this.t = -1;
        h.onBeat?.('done');
      }
    }
  }

  /** Reset the table/world transforms (a new game on the same playfield). */
  reset(): void {
    const h = this.handles;
    if (h) {
      h.table.pivot.set(0, 0);
      h.table.position.set(0, 0);
      h.table.scale.set(1);
      h.world.pivot.set(0, 0);
      h.world.position.set(0, 0);
      h.world.scale.set(1);
      h.post?.setDof(0);
      h.setGrade?.(0);
    }
    for (const c of this.chips) {
      c.t0 = -1;
      c.glow.visible = c.tile.visible = false;
    }
    for (const c of this.coins) {
      c.t = -1;
      c.halo.visible = c.coin.visible = false;
    }
    this.banner.hide();
    this.root.filters = [];
    this.t = -1;
    this.root.visible = false;
  }
}

/** Piece colour for a cell colour index (tiles are baked per colour, so the sprite tint is white). */
function colorOf(index: number): number {
  return pieceColor(index);
}
