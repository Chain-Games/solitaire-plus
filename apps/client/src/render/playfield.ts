import {
  RULES,
  orientation,
  type GameEvent,
  type GameState,
  type Piece,
  type ScoreBreakdown,
} from '@solitaire-plus/sim';
import {
  Application,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  TextStyle,
  type FederatedPointerEvent,
  type Texture,
} from 'pixi.js';
import type { GameController } from '../game/controller.js';
import {
  FloatText,
  OneShots,
  Particles,
  easeInOutQuad,
  easeInQuad,
  easeOutBack,
  easeOutCubic,
} from './effects.js';
import { Camera } from './camera.js';
import { FloorReflection } from './floor.js';
import { Fracture } from './fracture.js';
import { HoloBeam, HoloGhost } from './ghost-fx.js';
import { GlyphCache, GlyphString } from './glyph-text.js';
import { LetterBanner, Odometer } from './hud-fx.js';
import { LevelPill, levelColor, levelProgress } from './level-hud.js';
import {
  NO_INSET,
  computeLayout,
  cellToXY,
  hudBottomOf,
  type Layout,
  type LayoutInset,
} from './layout.js';
import { MoteField } from './motes.js';
import {
  ResultsScene,
  type FitRequest,
  type ResultsBeatKind,
  type ResultsDock,
  type ResultsOutcome,
} from './results-scene.js';
import { PALETTE, PIECE_COLORS, fromHsl, pieceColor, rankColor, shade, toHsl } from './palette.js';
import { PressureRing } from './pressure-ring.js';
import {
  QUALITY,
  WORLD_RESOLUTION_CAP,
  effectiveResolution,
  type QualitySettings,
  type QualityTier,
} from './quality.js';
import { Background } from './shaders/background.js';
import { PostFilter } from './shaders/post.js';
import { RimBand, Ribbons, TileGlow } from './streak-fx.js';
import { buildTextures, type Textures } from './textures.js';
import { WorldScene, type WorldEvent, type WorldTrigger } from './world.js';
import { worldFor } from './world-table.js';
import {
  ContactAO,
  KEY_RIG,
  LitBake,
  PieceShadow,
  TileMaterial,
  applyTileLook,
  shadowShiftX,
  shadowShiftY,
} from './tile-material.js';

/**
 * The playfield: everything a viewer sees during a game, rendered by Pixi on
 * its own ticker. React never touches this; it mounts the canvas and reacts to
 * the controller's events for overlays.
 *
 * Structure (each plane is a camera depth, camera.ts)
 *   world (post filter: bloom / chroma / grain / vignette)
 *     planeBack   background mesh, then the WORLD's sky (or flat) + sun   depth -1
 *     planeFar    the world's far layer with the sun's warm multiply      depth -0.9
 *     planeMotes  the world's mid layer (+ mid-lit), depth motes           depth -0.75
 *     planeFloor  the world's near layer + readability scrim, spotlight,
 *                 table light, side bands                                  depth -0.5
 *     table
 *       plateLayer  floor reflection, plate shadow, plate, rim lights, trays   depth -0.2
 *       tileLayer   bleed, bursts, banner band, 100 cell sprites, tile glow,
 *                   ghost layer, hot line, one-shots, ribbons      depth 0 (reference)
 *     planeMid    particles, hand (clipped to the trays while a deal rises),
 *                 drag shadow, landing sprites + rim flashes, trail, drag sprites,
 *                 float text, leaks, banner text                   depth 0
 *   hud (outside the post chain, so text stays crisp)              depth +0.4, whole px
 *   countdown text
 *
 * All sprites are allocated once in build(). frame() only updates transforms.
 */

const MAX_PIECE_CELLS = 9;
const CLEAR_ANIM_S = 0.3;
const POP_ANIM_S = 0.16;
const DEAL_STAGGER_S = 0.06;
const RETURN_ANIM_S = 0.18;
const GRAB_ANIM_S = 0.12;
const MOTE_COUNT = 30;
/** localStorage key remembering a refused motion-sensor permission (iOS). */
const MOTION_KEY = 'blockari.motion';
/** Pressure ring: how long hesitation takes to drain it fully. */
const PRESSURE_DRAIN_S = 6;
/** Streak pill: the outline's flash on a pop is this far toward white from the tube hue (pure white made two rings). */
const PILL_STROKE_FLASH_MIX = 0.5;
/** Pressure ring: the heat range over which its calm tint moves to the heat colour (3X → 4X). */
const RING_HEAT_FROM = 0.5;
const RING_HEAT_TO = 0.75;
/** How long init() waits for the world's textures before starting on the procedural backdrop. */
const WORLD_LOAD_CAP_MS = 4000;
/**
 * Supersampling governor (quality.ts `ssaa`, `WORLD_RESOLUTION_CAP`): the
 * last GOV_WINDOW ticker frames' periods are kept; once their p90 has sat
 * over GOV_P90_MS for GOV_HOLD_S of play, a fine-pointer screen running above
 * native steps the renderer down (2 -> 1.5 -> native) and a coarse-pointer
 * device steps the world filter down (2 -> 1.5 -> 1, the HUD stays native);
 * the session remembers the cap. 22 ms is the first missed vsync at 60 Hz
 * with a margin over one dropped frame in ten.
 */
const GOV_WINDOW = 120;
const GOV_P90_MS = 22;
const GOV_HOLD_S = 2;
/** The one intermediate step between 2x and native. */
const GOV_MID = 1.5;
/** Canvas-drawn Text rasterises at the renderer's resolution, capped here (memory: a 160 px numeral at 3x is a 480 px canvas). */
const TEXT_RES_CAP = 2;
/**
 * The HUD row's text (score, level pill, timer, mode pill, best) rasterises
 * at the renderer's own resolution up to this: on a 3× phone the row
 * composites at 3, and 2× text resampled into it was visibly soft on the
 * small level pill next to the mode pill (the owner's screenshot). The row's
 * numerals are ≤ 56 px, so a 3× raster costs nothing worth capping.
 */
const HUD_TEXT_RES_CAP = 3;
/** Portrait: the room's bloom / flash / leaks relative to the desktop. */
const ROOM_LIFT_PORTRAIT = 0.6;
/** Compact HUD: the level pill's top below the score digits' baseline (was 3: the pill crowded the digits). */
const LEVEL_GAP_COMPACT = 10;
/** Tray floor fill while a world is up (0.55 on the procedural backdrop). */
const TRAY_ALPHA_WORLD = 0.88;

// Streak VFX (streak-fx.ts). Tier numbers live in quality.ts; these are shapes.
/** The streak-increment burst fires when the banner's leading edge crosses the board centre. */
const BANNER_BURST_AT_S = 0.045;
/** One ribbon per cleared line: off the plate within this long. */
const RIBBON_S = 0.3;
/** Score float impact hold on a streak clear: two frames. */
const FLOAT_IMPACT_S = 0.034;
/** Ribbon pool: one per line of a 4-line clear, with room for overlap. */
const RIBBON_CAP = 8;
/** Streak-increment burst: the centre flare and the 2X/3X ring. */
const BURST_FLARE_S = 0.12;
const BURST_RING_S = 0.38;
/** Clear cells this many ranks from the placed piece dissolve without the white flash. */
const CLEAR_FLASH_MAX_RANK = 8;
/** The hot line at a row/column crossing: each trace at this fraction (they add there); a multiline clear's traces at HOT_MULTI_K so two lines never out-white one (and the 3+ tier's light is its column). */
const HOT_CROSS_K = 0.55;
const HOT_MULTI_K = 0.55;
/**
 * The 3+ clear's core (the filament inside the pool): its tint is the trace
 * colour lifted this far toward white below 4X, and it keeps the trace's
 * full envelope — HOT_MULTI_K dims the POOL only. At 0.55 on both the core
 * vanished into the pool (round 53: "the 3+ hot line lost its core").
 */
const HOT_CORE_LIFT = 0.25;
/** The 3+ core's envelope gain against the pool's HOT_MULTI_K (the core pixel reads ~0.2 lifted over the pool beside it). */
const HOT_CORE_K = 0.75;
/** 4X rim sparks: the hard core never thins below this many px (a short dash, not a hairline). */
const RIM_SPARK_CORE_PX = 2.5;
/** Sparks per popped cell on a one-line clear (capped by the tier's particlesPerCell), thinning down the line and divided by the line count. */
const CLEAR_SPARKS_PER_CELL = 3;
/** Embers only spawn above this heat. */
const EMBER_MIN_HEAT = 0.3;

// Levels (level-hud.ts; docs/art-direction.md "Levels"). Cool against the streaks' heat.
/** The banner programme's length (220 in / 400 hold / 200 out), and the gap a queued LEVEL banner leaves after a streak's. */
const LEVEL_BANNER_S = 0.82;
const LEVEL_QUEUE_GAP_S = 0.4;
/** The cool rim pulse travels the perimeter once in this long; the whole band brightens for the first LEVEL_RIM_LIFT_S. */
const LEVEL_RIM_S = 0.8;
const LEVEL_RIM_LIFT_S = 0.3;
/** The fifth-level beat: god rays from the banner's centre for this long (tiles masked), and the world's `levelUp` trigger. */
const LEVEL_RAYS_S = 0.75;
const LEVEL_BEAT_EVERY = 5;
/** The beat's banner: 1.25x with a 120 ms scale-in overshoot; its second rim pulse lands this long after the first. */
const LEVEL_BEAT_BANNER = 1.25;
const LEVEL_BEAT_POP_S = 0.12;
const LEVEL_BEAT_RIM2_S = 0.2;
/** The beat's pulses: lift amplitude and length against a plain level's (0.9 over LEVEL_RIM_LIFT_S). */
const LEVEL_BEAT_RIM_K = 1.45;
const LEVEL_BEAT_RIM_LIFT_S = 0.45;
/** The level sweep: the tiles lift at most this far toward the cool tint (never white). */
const LEVEL_SHEEN_PEAK = 0.22;
/** The level colours: the banner and rim in the mid cool, the sweep leaning mint. */
const LEVEL_BANNER_COLOR = levelColor(0.45);
const LEVEL_SHEEN_COLOR = levelColor(0.7);

// Tile material (tile-material.ts). Tier gates live in quality.ts; these are the light rig.
/** The fixed key is `KEY_RIG` (tile-material.ts), shared with the lit sprite bake. */
/** While a piece is lifted the key steps back to this so the piece reads as the light. */
const KEY_LIFTED = 0.62;
/** The piece light: height above the board in cells at lift 0 and per unit of lift, range in cells, strength. */
const PIECE_LIGHT_Z = 1.6;
const PIECE_LIGHT_Z_LIFT = 1.2;
const PIECE_LIGHT_RANGE = 3.5;
const PIECE_LIGHT_K = 0.6;
/** The piece light's gem glint on resting tiles fades out over this many cells from the piece. */
const PIECE_GEM_FADE = 2.5;
/** The piece light's colour: the piece colour pulled this far toward white. */
const PIECE_LIGHT_WHITE = 0.45;
/** Soft occlusion on tiles under the lifted piece: peak darkening, and its reach in cells past the footprint. */
const HOVER_OCCL = 0.15;
const HOVER_OCCL_REACH = 1.0;
/** Rim light: the plate's rim band reaches this many cells in from the edge (from heat 0.5). */
const RIM_BAND_REACH = 2.5;
/** Rim light from the hot line: weight and reach in cells. */
const HOT_LINE_RIM = 0.8;
const HOT_LINE_REACH = 2.2;
/** The contact-AO stamp fades in over the last 75% of the emissive pool's fade-in (after the landing). */
const AO_FADE_START = 0.25;

// Placement as physics (idea 7). Weight comes from these offsets, not from bigger numbers.
/** Lift height to socket in 4 frames: fast enough to read as a drop, slow enough to see. */
const LAND_TRAVEL_S = 0.07;
/** Two frames pressed into the socket before the board cell springs back. */
const LAND_SQUASH_S = 0.033;
/** The socket edge catches the light for ~4 frames after contact. */
const RIM_FLASH_S = 0.09;
/** Dust puffs per exposed footprint edge, so a 3×3 kicks up more than a domino. */
const DUST_PER_EDGE = 4;
/** Rejected drop: bounce off the blocking cell for this long before the return tween. */
const RECOIL_S = 0.12;
/** Recoil distance in cells — short; the return tween does the travelling. */
const RECOIL_CELLS = 0.35;
/** The blocking cell flashes rose once over this long. */
const BLOCK_FLASH_S = 0.22;

// Secondary motion (tier amplitudes in quality.ts; these are shapes).
/** Holographic ghost: lock-in flash the moment the placement becomes legal. */
const GHOST_FLASH_S = 0.12;
/** Ghost edge core width and scanline period, in cells (floors keep the phone readable). */
const GHOST_EDGE_CELLS = 0.045;
const GHOST_EDGE_MIN_PX = 1.6;
const GHOST_SCAN_CELLS = 0.11;
const GHOST_SCAN_MIN_PX = 3.5;
/** Holo line preview: alpha of the whole-line frame relative to the ghost. */
const GHOST_LINE_ALPHA = 0.75;
/** The projection column's side feather, in cells. */
const GHOST_BEAM_FEATHER = 0.6;
/** The piece's cast shadow keeps this much of its alpha while the beam lights the sockets under it. */
const GHOST_BEAM_SHADOW = 0.4;
/** Score hits at least this big squash-and-stretch the odometer. */
const ODO_SQUASH_MIN = 250;
/** Line-preview meshes: a 3x3 or a 1x5 can complete at most six lines. */
const HOLO_LINE_CAP = 6;

// Piece anticipation and trail (idea 8).
/** Tilt toward the travel direction, at most 4°. */
const TILT_MAX_RAD = (4 * Math.PI) / 180;
/** Horizontal speed at which the tilt reaches its maximum. */
const TILT_FULL_VEL = 1400;
/** Tilt follows velocity with ~70 ms of lag (per-second lerp rate). */
const TILT_LERP = 14;
/** Drop magnet: how far (0..1) the drawn piece settles onto its legal target, below this finger speed (px/s), at this ease rate (1/s). */
const MAGNET_K = 0.6;
const MAGNET_STILL_VEL = 900;
const MAGNET_LERP = 16;
/** Velocity smoothing rate; pointer events are jittery, the tilt must not be. */
const VEL_SMOOTH = 20;
/** Below this speed the piece leaves no trail; fully on 400 px/s above it. */
const TRAIL_MIN_VEL = 600;
const TRAIL_FADE_VEL = 400;
/** Ghost copies of the piece behind it, sampled this far apart in time. */
const TRAIL_GHOSTS = 1;
const TRAIL_SPACING_S = 0.016;
/** Alpha of the nearest ghost; each one behind it is dimmer. */
/** Per-ghost alphas, front to back. */
const TRAIL_ALPHAS = [0.5, 0.18, 0.08];
/** Ring buffer of recent drag transforms (x, y, rotation, scale, time) — ~270 ms at 60 fps. */
const TRAIL_HISTORY = 16;
/** On drop the ghosts converge into the landing over this long. */
const TRAIL_COLLAPSE_S = 0.12;

// In-game feel (docs/art-direction.md "Feel"). Tier gates live in quality.ts; these are shapes.
/** CSS px per millimetre (the tray float is specified in mm). */
const MM_PX = 96 / 25.4;

// 1. Piece drop weight: mass-based landing. Big pieces land heavier; the board never shakes.
/** A piece's mass, 0..1: its cell count over this, capped at 1. */
const MASS_CELLS = 5;
/** Landing squash at contact — x wider, y flatter — at mass 1; a domino gets MASS_FLOOR of it. */
const LAND_SQUASH_X = 0.06;
const LAND_SQUASH_Y = 0.06;
const MASS_FLOOR = 0.45;
/** Mass at and above which the landing asks for the `place-heavy` cue. */
const HEAVY_MASS = 0.8;
/**
 * Pressure ripple (LIGHT only, nothing moves): a brightness modulation
 * radiating from the footprint over the neighbours' faces — a crest (the
 * light's core, at most RIPPLE_LIFT at mass 1) with a shallower AO trough
 * behind it — reaching RIPPLE_REACH cells in RIPPLE_S; the front is
 * RIPPLE_WIDTH cells wide.
 */
const RIPPLE_REACH = 2;
const RIPPLE_S = 0.22;
const RIPPLE_LIFT = 0.22;
const RIPPLE_TROUGH = 0.8;
const RIPPLE_WIDTH = 0.55;
/** The modulation keeps this much of its strength at the far reach (a linear falloff from 1). */
const RIPPLE_FAR_K = 0.5;
/**
 * On the sockets (a tint cannot lift): the crest is a pool of the landed
 * piece's light OVER the socket face (its own additive sprite in the heat
 * layer, RIPPLE_LIGHT_CELLS wide) at RIPPLE_SOCKET_LIGHT × the modulation,
 * and the trough darkens the socket by RIPPLE_SOCKET_DIP × it (capped).
 */
const RIPPLE_SOCKET_LIGHT = 3.5;
const RIPPLE_LIGHT_CELLS = 1.7;
const RIPPLE_SOCKET_DIP = 3;
const RIPPLE_SOCKET_DIP_MAX = 0.35;
/** Dust scales with mass: puffs per edge = DUST_PER_EDGE × (DUST_MASS_MIN + mass), speed likewise. */
const DUST_MASS_MIN = 0.5;
/** A dust puff: a soft halo this many cells wide over a hard core this many cells wide (~2 px at 1080p), at this speed in cells/s. */
const DUST_HALO_CELLS = 0.18;
const DUST_CORE_CELLS = 0.045;
const DUST_SPEED_CELLS = 2.1;

// 2. Line-clear choreography by count (the streak heat system rides on top, unchanged).
/** Tiles pop out along the sweep this far apart: ten tiles in 162 ms. */
const CLEAR_POP_STEP_S = 0.018;
/** The directional sweep's light bar: length and thickness in cells. */
const SWEEP_LEN_CELLS = 2.2;
const SWEEP_THICK_CELLS = 0.6;
/**
 * The clear flash on a tile: how far its own colour goes toward white while
 * the sweep passes (one line, two lines) or as the lifted line shatters
 * (three plus). Never pure white below 4X: a white bar over white tiles is a
 * whiteout, and two lines must never out-white one.
 */
const CLEAR_FLASH_WHITE_1 = 0.25;
const CLEAR_FLASH_WHITE_2 = 0.15;
const CLEAR_FLASH_WHITE_BIG = 0.3;
/** A cell where a row and a column cross flashes less still (two traces will meet on it). */
const CLEAR_FLASH_WHITE_CROSS = 0.3;
/** The sweep bar's alpha: a coloured light over the tiles (two bars at once run dimmer, so two lines never out-white one). */
const SWEEP_ALPHA_1 = 0.22;
const SWEEP_ALPHA_2 = 0.18;
/** Two lines: the crossing flare — a soft bloom and a held core, sizes in cells. */
const CROSS_FLARE_CELLS = 2.6;
const CROSS_CORE_CELLS = 0.7;
const CROSS_CORE_HOLD_S = 0.09;
const CROSS_CORE_OUT_S = 0.16;
/** Three-plus lines: every tile of the line lifts this many px over CLEAR_LIFT_S, holds CLEAR_HOLD_S, then shatters. */
const CLEAR_LIFT_PX = 4;
const CLEAR_LIFT_S = 0.06;
const CLEAR_HOLD_S = 0.05;
/** The light column over a 3+ clear: filled and feathered, rising CLEAR_COLUMN_RISE cells and widening to CLEAR_COLUMN_WIDTH over CLEAR_COLUMN_S. */
const CLEAR_COLUMN_S = 0.3;
const CLEAR_COLUMN_RISE = 1.0;
const CLEAR_COLUMN_WIDTH = 2.4;
const CLEAR_COLUMN_ALPHA = 0.3;
/** Where a row and a column both clear, each column runs at this alpha so the crossing never blows out. */
const CLEAR_COLUMN_ALPHA_CROSS = 0.12;
/** Parallel lines' columns overlap (2.4 cells wide, a cell apart): each runs at CLEAR_COLUMN_ALPHA ÷ the parallel count. */
/** Same-rank cells on parallel lines pop this far apart, so a 3-wide front never lights six cells on one frame. */
const CLEAR_RANK_SKEW_S = 0.006;
/** The residual glow along a multiline's lines (a single line's is 0.4). */
const CLEAR_RESIDUAL_MULTI_ALPHA = 0.22;
/** Three-plus lines: the banner waits for the shatter to start (the lift, the hold and this much of the pop). */
const CLEAR_BANNER_AFTER_S = 0.08;

// 3. Hand-tray life: the waiting pieces idle; a deal slides in from the tray's outer edge.
/** A hand piece fits inside its tray box with this much air top and bottom; the box's centre is this far under the slot's home. */
const HAND_TRAY_INSET = 8;
const HAND_TRAY_CENTRE_DY = 6;
/** Idle float: one cycle this long, slots a phase apart; the contact shadow breathes with it. */
const TRAY_FLOAT_PERIOD_S = 4;
const TRAY_FLOAT_PHASE_S = 1.3;
const TRAY_SHADOW_A = 0.5;
const TRAY_SHADOW_FADE = 0.16;
const TRAY_SHADOW_GROW = 0.05;
/** Deal-in: an ease-out slide from the tray's outer edge, then a one-frame settle squash. */
const DEAL_SLIDE_S = 0.12;
const DEAL_SETTLE_S = 0.017;
const DEAL_SETTLE_SQUASH = 0.04;
/** Extra start distance outside the tray box so the piece is fully hidden before it slides. */
const DEAL_EDGE_PAD = 6;
/** "Next hand": the trays dim this much and their lift glow pulses once, over this long, with the deal's stagger. */
const TRAY_DIM = 0.4;
const TRAY_DIM_OUT_S = 0.15;
const TRAY_PULSE_S = 0.35;
const TRAY_PULSE_ALPHA = 0.7;
const TRAY_PULSE_TINT = 0.5;

// 4. Countdown and start: a real 3-2-1-GO.
/** A numeral holds this long (GO shorter); it scales in from COUNT_SCALE_FROM with a back-ease overshoot over COUNT_IN_S. */
const COUNT_STEP_S = 0.65;
const COUNT_GO_S = 0.5;
const COUNT_SCALE_FROM = 1.4;
const COUNT_IN_S = 0.22;
const COUNT_BACK = 1.7;
/**
 * The filled flash core behind each numeral (no ring): a soft bloom and a
 * held core, in board fractions of the spotlight frame — whose light sits in
 * its inner half, so the frame is ~2× the light's visible reach and the
 * core's light shows past the 0.3 B numeral.
 */
const COUNT_BLOOM_B = 1.3;
const COUNT_BLOOM_ALPHA = 0.08;
const COUNT_CORE_B = 0.85;
const COUNT_CORE_HOLD_S = 0.09;
/** The core is warm (accent-warm pulled halfway to warm white): a neutral white over the navy plate reads grey. */
const COUNT_CORE_COLOR = 0xffa030;
/** The core is drawn twice (a second flare at this alpha) so the warm light wins over the plate's blue out to the pool's edge. */
const COUNT_CORE_SECOND_ALPHA = 0.7;
const COUNT_CORE_OUT_S = 0.22;
const COUNT_CORE_ALPHA = 1;
/**
 * GO: the grid lights row by row bottom → top over GO_GRID_S — each SOCKET's
 * rim (its own additive outline) lit for GO_ROW_S as the front passes, with
 * one faint fill riding the front row only; never a plate-wide line.
 */
const GO_GRID_S = 0.24;
const GO_ROW_S = 0.07;
const GO_ROW_ALPHA = 0.75;
const GO_FILL_ALPHA = 0.14;
/** GO: the HUD elements slide in from HUD_IN_PX above over HUD_IN_S, HUD_IN_STAGGER_S apart. */
const HUD_IN_S = 0.24;
const HUD_IN_PX = 14;
const HUD_IN_STAGGER_S = 0.04;

// 5. End-of-game slow-mo: one continuous beat from the last frame of play into the results.
/** Presentation time runs at END_SLOW_K for END_SLOW_S of wall time, easing back over the last END_SLOW_EASE_S. */
const END_SLOW_S = 0.4;
const END_SLOW_K = 0.25;
const END_SLOW_EASE_S = 0.08;
/** Over the same 400 ms: the HUD dims to END_HUD_DIM; the board and room desaturate END_DESAT and darken END_DARKEN (post). */
const END_HUD_DIM = 0.4;
const END_DESAT = 0.4;
const END_DARKEN = 0.25;

/** Cues the playfield asks the audio for (docs/audio.md): the audio engine maps the names. */
export type FeelCue = 'place' | 'place-heavy' | 'end-slow' | 'cell-tick' | WorldEvent;

interface CellVis {
  sprite: Sprite;
  color: number;
  anim: 'none' | 'pop' | 'clear';
  t: number;
  delay: number;
  /** For clears: rotation direction. */
  dx: number;
  dy: number;
  /** For a landing: the piece's mass (0..1), which sets the pop's squash. */
  amp: number;
  /** Seconds left of the rejected-drop rose flash (0 = none). */
  flash: number;
  /** For clears: the tile's colour index (the cell's own is -1 from the event on). */
  clearColor: number;
  /** For clears: whether the tile has broken into chunks yet. */
  fractured: boolean;
  /** For clears: seconds since the event (runs through the delay), and the lift (0 = none, 1 = the 3+ lift). */
  age: number;
  liftK: number;
  /** For clears: unit push for the chunks (along the sweep, or away from the placed piece). */
  pushX: number;
  pushY: number;
  /** For clears: the flash's colour (the tile's own lifted toward white by the count). */
  flashColor: number;
}

interface SlotVis {
  root: Container;
  sprites: Sprite[];
  piece: Piece | null;
  dealT: number;
  dealDelay: number;
  hover: number;
  /** Top-left of the drawn piece relative to root, in px. */
  originX: number;
  originY: number;
  /** Scale-to-fit for this piece (≤ 1): a 5-wide line is wider than a phone's tray slot. */
  fit: number;
  /** Deal-in: where the slide starts, relative to home (px), and the settle's clock (-1 = done). */
  dealFromX: number;
  dealFromY: number;
  settleT: number;
}

interface DragState {
  slot: number;
  relX: number;
  relY: number;
  target: { r: number; c: number } | null;
  legal: boolean;
  /** The last LEGAL target and where the piece sat for it: a drop within ¾ cell of it still lands there. */
  lastLegal: { r: number; c: number; x: number; y: number } | null;
  grabT: number;
  shakeT: number;
  wasLegal: boolean;
  /** Top-left of the piece in canvas px. The drop-target arithmetic reads this, never the tilted layer. */
  x: number;
  y: number;
  /** Grab point in dragLayer-local px: the pivot the tilt rotates around. */
  gpx: number;
  gpy: number;
  /** Last frame's top-left, for velocity. */
  lastX: number;
  lastY: number;
  /** Smoothed velocity, px/s. */
  vx: number;
  vy: number;
  /** Current tilt, radians. */
  tilt: number;
  /**
   * Magnet: the drawn piece eases toward the exact target cells while the
   * placement is legal (presentation only; `x`/`y` stay the truth), so what
   * the eye lands on is what drops. In px, added to x/y when drawing.
   */
  magX: number;
  magY: number;
  /** Seconds since the placement became legal (holo lock-in flash), -1 = none. */
  lockT: number;
}

interface ReturnState {
  slot: number;
  t: number;
  fromX: number;
  fromY: number;
  fromScale: number;
  fromRot: number;
}

/** Rejected drop: a short bounce away from the blocking cell, then the return tween. */
interface RecoilState {
  slot: number;
  t: number;
  fromX: number;
  fromY: number;
  dirX: number;
  dirY: number;
}

export interface PlayfieldOptions {
  controller: GameController;
  quality: QualityTier;
  parent: HTMLElement;
  /** Shown in the HUD corner: "SOLO", "CHALLENGE", the code, etc. */
  modeLabel: string;
  /** Personal best to show beside the score label (solo). */
  best?: number | undefined;
  /** The session's supersampling cap from a previous governor step (settings `ssaaCap`); null = none. */
  ssaaCap?: number | null | undefined;
}

/** What the renderer is drawing at, for the settings sheet and tooling. */
export interface ResolutionInfo {
  /** The renderer's resolution (backing-store px per CSS px). */
  resolution: number;
  /** The screen's own (devicePixelRatio, clamped to the tier's cap). */
  native: number;
  /** Whether the frame is supersampled (resolution above native). */
  supersampled: boolean;
  /** The world container's (post filter's) resolution: min(resolution, WORLD_RESOLUTION_CAP, the coarse governor's cap). */
  world: number;
}

export class Playfield {
  readonly app = new Application();
  private readonly controller: GameController;
  private readonly parent: HTMLElement;
  private q: QualitySettings;
  private tier: QualityTier;
  private layout: Layout = computeLayout(1, 1, false);
  /** Room kept for the tutorial's narration (setGuideInset); none in play. */
  private guideInset: LayoutInset = NO_INSET;
  private tex!: Textures;
  private modeLabel: string;
  private best: number | undefined;
  private modePill = new Container();
  private modeBg = new Graphics();
  private bestText!: Text;

  private world = new Container();
  /** Camera planes (see the structure above) and the floor reflection under the plate. */
  private readonly camera = new Camera();
  private planeBack = new Container();
  private planeFar = new Container();
  private planeMotes = new Container();
  private planeFloor = new Container();
  private planeMid = new Container();
  private plateLayer = new Container();
  private rimLayer = new Container();
  private tileLayer = new Container();
  private floor = new FloorReflection();
  /** What mirrors into the floor: the plate's rim lights and everything on it. */
  private reflectionSource: Container[] = [];
  private reducedMotion = false;
  private orientationAsked = false;
  private background: Background | undefined;
  /** The painted world behind the board (world.ts), picked from the seed; the backdrop is its base. */
  private worldScene!: WorldScene;
  /** Time of day stops advancing at the results. */
  private worldFrozen = false;
  private post: PostFilter | null = null;
  private spotlight!: Sprite;
  /** Lit table surface under the plate so the shadow has something to fall on. */
  private tableLight!: Sprite;
  /** Wide-aspect side treatment: two soft vertical bands. */
  private sideBands: Sprite[] = [];
  private motes!: MoteField;
  private results!: ResultsScene;
  /** Hook for the audio engine: streak heat 0..1, every frame it changes. */
  onHeat: ((h: number) => void) | null = null;
  /** Hook for the host: the governor stepped the renderer resolution down (the session keeps the cap). */
  onResolutionStep: ((info: ResolutionInfo) => void) | null = null;
  /** The session's supersampling cap (see PlayfieldOptions.ssaaCap): the renderer's on a fine pointer, the world filter's on a coarse one. */
  private ssaaCap: number;
  /** Text rasterisation resolution: the renderer's, capped (TEXT_RES_CAP). */
  private textRes = 1;
  /** The HUD row's text resolution: the renderer's, capped higher (HUD_TEXT_RES_CAP). */
  private hudRes = 1;
  private govTimes = new Float32Array(GOV_WINDOW);
  private govN = 0;
  private govI = 0;
  private govSlowS = 0;
  private govEma = 1000 / 60;
  private govP90 = 0;
  /** Hook for the results cinematic beats (audio). */
  onResultsBeat: ((kind: ResultsBeatKind) => void) | null = null;
  private table = new Container();
  private plateShadow!: Sprite;
  private plate = new Graphics();
  private trays = new Graphics();
  private trayLift: Sprite[] = [];
  private boardLayer = new Container();
  private cells: CellVis[] = [];
  private ghostLayer = new Container();
  private ghostFill: Sprite[] = [];
  private ghostOutline: Sprite[] = [];
  private lineHints: Sprite[] = [];
  private previewOutline = new Graphics();
  /** Holographic preview (ghost-fx.ts): the piece, the lines it would clear, the beam. */
  private holoGhost!: HoloGhost;
  private holoLines: HoloGhost[] = [];
  private beam!: HoloBeam;
  /** Hot trail: sockets in a cleared line stay lit and cool over 2 s. */
  private heatLayer = new Container();
  private heat: Sprite[] = [];
  private heatT: number[] = [];
  /** The hot line's core: a tighter, whiter radial inside each heat sprite. */
  private heatCore: Sprite[] = [];
  /** Per cell: 1 = lit by a row clear, 2 = a column, 3 = both (shapes the strip). */
  private heatAxis = new Uint8Array(RULES.rows * RULES.cols);
  /** Per cell: seconds before its hot-line light ignites (under the tile as it pops), and whether its core shows (3+ clears). */
  private heatDelay = new Float32Array(RULES.rows * RULES.cols);
  private heatCoreOn = new Uint8Array(RULES.rows * RULES.cols);
  /** Per cell: the trace's gain for this clear (1, HOT_MULTI_K on a multiline clear, × HOT_CROSS_K on a crossing). */
  private heatGain = new Float32Array(RULES.rows * RULES.cols).fill(1);
  /** Chasing rim light on streak >= 3. */
  private rimLight!: Sprite;
  private rimMask = new Graphics();
  private rimChase = -1;

  /**
   * STREAK HEAT. One 0..1 value the renderer owns and eases toward the streak
   * level ((streak-1)/4, so 2X = 0.25 … 5X+ = 1). Everything that should feel
   * the streak reads it: plate rim, socket floor, spotlight, backdrop, trays,
   * post grade, the pill. A miss cools it over ~1.5 s. One number, ten surfaces.
   */
  private heatLevel = 0;
  private heatTarget = 0;
  private rimGlow = new Graphics();
  private plateHeat!: Sprite;
  private leaks: Sprite[] = [];
  /** Streak VFX (streak-fx.ts): rim energy band, ribbons, tile rim light + sheen. */
  private rimBand!: RimBand;
  private ribbons!: Ribbons;
  private tileGlow!: TileGlow;
  /** Fractional spawn accumulators: heat embers and 4X rim sparks. */
  private emberAcc = 0;
  private rimSparkAcc = 0;
  /**
   * Streak-increment burst: its own small pools drawn UNDER the banner's
   * darkening strip (and the tiles), so nothing crosses the banner text.
   */
  private burstFx!: OneShots;
  private burstParticles!: Particles;
  /** Streak-increment burst waiting for the banner's leading edge (-1 = none), and its streak. */
  private burstPending = -1;
  private burstStreak = 2;
  /** Whether the point (canvas px) lies on a filled tile's face (embers die there; bound once). */
  private readonly tileAt = (x: number, y: number): boolean => {
    const L = this.layout;
    const pitch = L.cell + L.gap;
    const c = Math.floor((x - L.boardX) / pitch);
    const r = Math.floor((y - L.boardY) / pitch);
    if (c < 0 || r < 0 || c >= RULES.cols || r >= RULES.rows) return false;
    // Inside the tile proper, not the gap after it.
    if (x - L.boardX - c * pitch > L.cell || y - L.boardY - r * pitch > L.cell) return false;
    return this.cellFilled(r * RULES.cols + c);
  };
  /** Whether cell i shows a tile right now (for the tile overlays; bound once). */
  private readonly cellFilled = (i: number): boolean => {
    const v = this.cells[i];
    if (!v || v.color < 0) return false;
    if (v.anim === 'clear') return false;
    return !(v.anim === 'pop' && v.delay > 0);
  };
  /**
   * Whether cell i carries a tile face for the rays' mask: a resting tile OR
   * the piece still landing on it (its sprite is over the cell for the
   * travel and the press; unmasked, the 4X beams took a landed L's faces to
   * 240 for five frames while `cellFilled` still said no).
   */
  private readonly cellTiled = (i: number): boolean => {
    const v = this.cells[i];
    return !!v && v.color >= 0 && v.anim !== 'clear';
  };
  /** Tile material (tile-material.ts): the lit tile mesh, contact AO, the piece's shadow. */
  private material!: TileMaterial;
  /** The lit look baked for every piece sprite (hand, drag, landing, chips, chunks). */
  private litBake!: LitBake;
  private contactAO!: ContactAO;
  private pieceShadow!: PieceShadow;
  private aoLayer = new Container();
  /** Light rig state: key strength eases down while a piece is lifted; the piece light eases in and out. */
  private keyK = 1;
  private lightK = 0;
  private lightX = 0;
  private lightY = 0;
  private lightZ = 0;
  private lightColor = 0xffffff;
  /** Lift of the piece at release, for the shadow closing up under the landing. */
  private landLift = 0;
  /** The dragged piece's footprint: cell centres relative to its top-left, at board pitch. */
  private footprint = new Float32Array(MAX_PIECE_CELLS * 2);
  private footprintN = 0;
  /** Scratch for the hot-line rim light: index, alpha and colour of every hot cell this frame. */
  private hotIdx = new Int16Array(RULES.rows * RULES.cols);
  private hotA = new Float32Array(RULES.rows * RULES.cols);
  private hotCol = new Float32Array(RULES.rows * RULES.cols * 3);
  /** Emissive pools under filled tiles (idea 5). */
  private bleedLayer = new Container();
  private bleed: Sprite[] = [];
  private bleedT: number[] = [];
  /** The streak banner (idea 3): band behind the tiles, text in front. */
  private bannerBand = new Container();
  private bannerFill!: Sprite;
  private bannerDark!: Sprite;
  private plateMask = new Graphics();
  private bannerEdge!: Sprite;
  private bannerText!: Text;
  private bannerT = -1;
  private bannerColor = 0xffffff;
  private pillGlow!: Sprite;
  /** Set-piece escalation state (idea 2). */
  private slowT = -1;
  /** 0..1 fade of the HUD readouts and the hand as the results begin (-1 idle). */
  private resultsFade = -1;
  /** Post grade held by the results sting (the heat tier reached), 0 when idle. */
  private resultsGrade = 0;
  private timeScale = 1;
  private oneShots!: OneShots;
  /** Fracture on clear (fracture.ts): tile chunks, pooled from the tier. */
  private fracture!: Fracture;
  /** Heat of the clear in flight ((streak - 1) / 4 at the linesCleared event): chunk count, launch, glow. */
  private clearHeat = 0;
  private fxMask!: Graphics;
  /** The hot line stops at the rim like every other table effect (the plate, inside its stroke). */
  private heatMask = new Graphics();
  private particles!: Particles;
  private handLayer = new Container();
  private slots: SlotVis[] = [];
  /** One soft shadow per tray piece, bobbing against it. */
  private handShadows: Sprite[] = [];
  private dragShadow!: Sprite;
  private dragLayer = new Container();
  private dragSprites: Sprite[] = [];
  /** Landing (idea 7): the released piece falls from lift height into the socket on its own sprites. */
  private landLayer = new Container();
  private landSprites: Sprite[] = [];
  private rimSprites: Sprite[] = [];
  private blockFlash!: Sprite;
  private landT = -1;
  private landFrom = { x: 0, y: 0, scale: 1, rot: 0 };
  private landTo = { x: 0, y: 0 };
  private landShadow = { x: 0, y: 0 };
  /** Board index per landing sprite (-1 = unused, or cancelled because a clear took the cell). */
  private landCell = new Int16Array(MAX_PIECE_CELLS).fill(-1);
  private landColor = 0;
  private landContact = false;
  /** Whether any landing cell survived the clear that fired in place() (else no falling sprite and no shadow). */
  private landAny = true;
  /** The landing piece's mass (cells / MASS_CELLS, capped): the squash, the dust and the ripple scale with it. */
  private landMass = 0;
  /** Pressure ripple (light only): its clock (-1 idle), source cells, mass, and this frame's per-cell modulation (+ = lift). */
  private rippleT = -1;
  private rippleCells = new Int16Array(MAX_PIECE_CELLS).fill(-1);
  private rippleN = 0;
  private rippleMass = 0;
  private rippleMod = new Float32Array(RULES.rows * RULES.cols);
  /** The ripple's crest on the sockets: one additive pool per cell, over the socket faces. */
  private rippleLight: Sprite[] = [];
  private rippleLayer = new Container();
  /** "Next hand": the trays' dim-and-pulse clock (-1 idle) and each tray's lift-glow pulse this frame. */
  private trayPulseT = -1;
  private trayPulseK = new Float32Array(RULES.handSize);
  private trayDimK = 0;
  /** GO: the grid-light clock (-1 idle), one additive rim outline per socket and the front row's fill. */
  private goT = -1;
  private goRims: Sprite[] = [];
  private goFill!: Sprite;
  private goLayer = new Container();
  /** GO: the HUD slide-in clock (-1 idle; the HUD is parked off while the countdown runs). */
  private hudInT = -1;
  private hudParked = false;
  /** End-of-game: the slow-mo clock (-1 idle) and the HUD's dim (1 = full). */
  private endSlowT = -1;
  private hudDim = 1;
  private recoil: RecoilState | null = null;
  /** Trail (idea 8): ghost copies of the piece fed from a ring buffer of recent drag transforms. */
  private trailLayer = new Container();
  private trailGhosts: Container[] = [];
  private trailBuf = new Float32Array(TRAIL_HISTORY * 5);
  private trailHead = 0;
  private trailCount = 0;
  private trailCollapseT = -1;
  private trailCollapseTo = { x: 0, y: 0, scale: 1 };
  /** Per ghost at collapse start: x, y, rotation, scale, alpha. */
  private trailFrom = new Float32Array(TRAIL_GHOSTS * 5);
  /** Clips the hand to its trays while a deal rises from below them. */
  private handMask = new Graphics();
  private floatText!: FloatText;

  private hud = new Container();
  private scoreText!: Text;
  private odometer!: Odometer;
  private letterBanner!: LetterBanner;
  private scoreLabel!: Text;
  private timerText!: Text;
  private timerBar = new Graphics();
  private streakPill = new Container();
  private streakBg = new Graphics();
  private streakStyle!: TextStyle;
  private streakCache!: GlyphCache;
  private streakText!: GlyphString;
  /** The level pill (level-hud.ts) and the ceremony's state. */
  private levelPill!: LevelPill;
  /** The sim's level (the pill rolls up to it in the ceremony). */
  private levelTarget = 1;
  /** Level-ups waiting for the board's centre band (a streak banner owns it first), oldest first. */
  private levelQueue: number[] = [];
  private levelDelay = 0;
  /** The level burst waits for the LEVEL banner's leading edge (-1 = none), and its level. */
  private levelBurstPending = -1;
  private levelBurstLevel = 2;
  /** The cool rim pulses: seconds since each started (-1 idle); the beat fires a second one 200 ms behind. */
  private levelRimT = -1;
  private levelRimT2 = -1;
  private levelRim2Due = -1;
  /** Whether the running pulses are the beat's (stronger, longer lift). */
  private levelRimBeat = false;
  /** The banner's group scale (1, or the beat's 1.25 with its overshoot). */
  private bannerBoost = 1;
  /** Whether the banner up right now is a LEVEL banner (a streak's takes the band back). */
  private levelBannerUp = false;
  /** The score digits' width the pill was last docked to. */
  private levelDockW = -1;
  private modeText!: Text;
  private countdownText!: Text;

  private displayedScore = 0;
  private targetScore = 0;
  private lastTimerSec = -1;
  private lastBarSec = -1;
  private timeSec = 0;
  private streakPulse = 0;
  private streakShownAt = -1;
  private streakStrokeFlash = 0;
  private streakW = 0;
  private streakH = 0;
  /**
   * Streak pressure ring (idea 4): PRESENTATION ONLY — there is no rule. A
   * shader-drawn stadium track around the pill (pressure-ring.ts) drains
   * while the player hesitates and refills on every placement, so the pill
   * visibly "wants" the next clear. As it drains the head pulses faster and
   * the tint shifts toward the danger colour.
   */
  private pressureRing = new PressureRing();
  private pressure = 1;
  private sincePlaceS = 0;
  private lastPlaced = { x: 0, y: 0 };
  private lastClear: { rows: readonly number[]; cols: readonly number[] } = { rows: [], cols: [] };
  private countdown: { value: number; t: number; resolve: () => void } | null = null;

  private drag: DragState | null = null;
  private returning: ReturnState | null = null;
  private unsubscribe: (() => void) | null = null;
  private destroyed = false;
  private coarse = false;
  private inputLocked = false;

  /** Hook for the audio engine: a drop that did not land. */
  onRejected: (() => void) | null = null;
  /** Hook for the audio engine: countdown tick (3, 2, 1, 0 = go). */
  onCountdown: ((value: number) => void) | null = null;
  /** Hook for the audio engine: the feel cues (`place` / `place-heavy` at contact, `end-slow` at the end). */
  onCue: ((cue: FeelCue) => void) | null = null;
  /** The clock, ms remaining, as the timer updates (the audio engine's last-20 s close). */
  onClock: ((remainingMs: number) => void) | null = null;

  /**
   * Camera motion (parallax, breathing, punch-in, settle), 0..1. Default 1;
   * `prefers-reduced-motion` forces 0. Tooling leaves it alone: with no
   * pointer events the look stays centred and the breathing runs on the
   * game clock, so a stepped recording is stable.
   */
  get cameraMotion(): number {
    return this.camera.motion;
  }

  set cameraMotion(k: number) {
    this.camera.motion = this.reducedMotion ? 0 : Math.max(0, Math.min(1, k));
  }

  constructor(opts: PlayfieldOptions) {
    this.controller = opts.controller;
    this.tier = opts.quality;
    this.q = QUALITY[opts.quality];
    this.modeLabel = opts.modeLabel;
    this.best = opts.best;
    this.parent = opts.parent;
    this.ssaaCap = opts.ssaaCap ?? Infinity;
  }

  async init(): Promise<void> {
    this.coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (this.reducedMotion) this.camera.motion = 0;
    try {
      await Promise.all([
        document.fonts.load('700 40px Rajdhani'),
        document.fonts.load('600 20px Rajdhani'),
      ]);
    } catch {
      // fall back to system fonts
    }
    await this.app.init({
      resizeTo: this.parent,
      background: PALETTE.bg,
      antialias: this.q.antialias,
      resolution: this.targetResolution(),
      autoDensity: true,
      preference: 'webgl',
      powerPreference: 'high-performance',
    });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    this.textRes = Math.min(TEXT_RES_CAP, this.app.renderer.resolution);
    this.hudRes = Math.min(HUD_TEXT_RES_CAP, this.app.renderer.resolution);
    this.parent.appendChild(this.app.canvas);
    this.app.canvas.style.touchAction = 'none';
    this.app.canvas.style.display = 'block';
    this.app.canvas.addEventListener('pointerleave', this.onPointerLeave);
    // Phones look with the tilt sensor instead of the pointer. Where the
    // browser gates it behind a permission (iOS), it is asked for once per
    // load, as the first touch lifts (never mid-drag), and a refusal is
    // remembered so nobody is asked twice.
    if (this.coarse && !this.reducedMotion) this.setupOrientation();

    this.tex = buildTextures(this.app.renderer);
    this.build();
    this.applyLayout();
    this.app.renderer.on('resize', this.applyLayout);

    this.unsubscribe = this.controller.subscribe(this.onEvent);
    this.controller.emitInitial(this.onEvent);
    this.syncBoardFromState(this.controller.current);

    // Shaders first, then the ticker RUNS before the world has loaded: the
    // countdown and input must never wait on a texture fetch (on a phone over
    // Wi-Fi that was seconds of a dead Start button). The world cross-fades in
    // whenever it lands. `init()` still resolves only after the load (capped),
    // so the recording harness — which parks the ticker and steps frames
    // itself — sees the world on the same frames every run.
    this.prewarm();
    this.app.ticker.add(this.frame);
    await Promise.race([this.loadWorld(), new Promise((r) => setTimeout(r, WORLD_LOAD_CAP_MS))]);
  }

  /**
   * On a portrait screen the room is the sky band above the plate; the 4X
   * lift (bloom, flash, leaks) runs there at 0.6 of the desktop so it never
   * goes white.
   */
  private roomLift(): number {
    return this.app.screen.height > this.app.screen.width ? ROOM_LIFT_PORTRAIT : 1;
  }

  /** Fetch and build the seed's world; a failure keeps the procedural backdrop. */
  private async loadWorld(): Promise<void> {
    const entry = worldFor(this.controller.current.seed);
    const res = this.app.renderer.resolution;
    // The width the 16:9 layers must be drawn at to COVER the frame: on a
    // portrait phone that is set by the height (h × 16/9), not the width —
    // picking by width handed phones the 1280 variant stretched 3×.
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const devicePx = (Math.max(w, (h * 16) / 9) + this.q.parallax * 4) * res;
    try {
      await this.worldScene.load(
        entry.id,
        import.meta.env.BASE_URL,
        devicePx,
        this.app.screen.height > this.app.screen.width,
      );
    } catch (err) {
      console.warn(`world ${entry.id} unavailable, keeping the procedural backdrop`, err);
      return;
    }
    if (this.destroyed) return;
    const m = this.worldScene.manifest;
    if (m) {
      this.motes.setPreset({
        kind: m.particles.kind,
        rate: m.particles.rate,
        tint: parseInt(m.particles.tint.replace('#', ''), 16),
      });
    }
    // The full layout again: the trays draw denser over a world.
    this.applyLayout();
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe?.();
    this.worldScene?.destroy();
    window.removeEventListener('deviceorientation', this.onOrientation);
    if (this.app.renderer) {
      this.app.canvas.removeEventListener('pointerleave', this.onPointerLeave);
      this.app.renderer.off('resize', this.applyLayout);
      this.app.ticker.remove(this.frame);
      this.floor.destroy();
      this.app.destroy(true, { children: true, texture: true });
    }
  }

  private setupOrientation(): void {
    const DOE = (
      window as unknown as {
        DeviceOrientationEvent?: { requestPermission?: () => Promise<'granted' | 'denied'> };
      }
    ).DeviceOrientationEvent;
    if (!DOE) return;
    if (typeof DOE.requestPermission !== 'function') {
      window.addEventListener('deviceorientation', this.onOrientation);
      return;
    }
    let denied = false;
    try {
      denied = localStorage.getItem(MOTION_KEY) === 'denied';
    } catch {
      // storage unavailable: ask once per load
    }
    if (denied) return;
    const ask = () => {
      if (this.orientationAsked) return;
      this.orientationAsked = true;
      DOE.requestPermission!().then(
        (r) => {
          if (r === 'granted') {
            window.addEventListener('deviceorientation', this.onOrientation);
          } else {
            try {
              localStorage.setItem(MOTION_KEY, 'denied');
            } catch {
              // ignore
            }
          }
        },
        () => undefined,
      );
    };
    this.app.canvas.addEventListener('pointerup', ask, { once: true });
  }

  private onOrientation = (e: DeviceOrientationEvent): void => {
    if (e.gamma === null || e.beta === null) return;
    this.camera.tilt(e.gamma, e.beta);
  };

  private onPointerLeave = (): void => {
    this.camera.pointerLeft();
  };

  /** Current layout, for tooling and tests. */
  /** Shell hook: shift the results ceremony vertically (see ResultsScene.setShift). */
  shiftResults(dy: number): void {
    this.results.setShift(dy);
  }

  /**
   * Shell hook: the docked tray's measured height decides the results
   * panel's compression (ResultsScene.fitResults); answers with the panel's
   * edge to dock to, or null before the results play.
   */
  fitResults(req: FitRequest): ResultsDock | null {
    return (this.results as ResultsScene | undefined)?.fitResults(req) ?? null;
  }

  /** Shell hook: the challenge's outcome arrived after the results began (null = it will not). */
  setResultsOutcome(o: ResultsOutcome | null): void {
    // The shell may call this before build() (its effect runs on mount).
    (this.results as ResultsScene | undefined)?.setOutcome(o);
  }

  /** Tooling hook (capture harness): step the results to `sec` on their clock. */
  resultsSeek(sec: number): void {
    this.results.seek(sec);
  }

  /** Tooling: the score digits' rect, the ledger's top, the coin layer's order. */
  get resultsToolingRects(): ResultsScene['toolingRects'] {
    return this.results.toolingRects;
  }

  /** Tooling: hide / show the results' flare core layer. */
  set resultsFlareCoreVisible(v: boolean) {
    this.results.flareCoreVisible = v;
  }

  /** Tooling: the NEW BEST chip's screen rectangle, or null. */
  get resultsBestChipRect(): { x: number; y: number; w: number; h: number } | null {
    return this.results.bestChipRect;
  }

  /** Tooling: the outcome beat's clock (seconds since the banner started; -1 before). */
  get resultsOutcomeTime(): number {
    return this.results.outcomeTime;
  }

  /**
   * Shell hook: the results tray's RANK-UP ceremony reaches the engine — a
   * halo in the rank colour behind the results panel (ResultsScene.rankUp)
   * and a touch of flash. The rim band and the sheen sit under the panel at
   * the results and would only leak as slits, so they stay off here.
   */
  rankUp(rankIndex: number): void {
    if (this.q.levelFx < 1) return;
    this.results.rankUp(rankColor(rankIndex));
    this.post?.kick(0.03);
  }

  /** Tooling hook (capture harness): hold the rank-up halo at `sec` into its 0.9 s envelope. */
  rankUpSeek(sec: number): void {
    this.results.rankUpSeek(sec);
  }

  get layoutInfo(): Layout {
    return this.layout;
  }

  /**
   * Tutorial hook: keep a band clear for the narration — between the HUD and
   * the board (portrait) or under the hand (landscape) — and re-lay the table
   * out at once, so nothing is ever dealt or dropped behind the caption.
   */
  setGuideInset(inset: LayoutInset): void {
    this.guideInset = inset;
    if (this.app.renderer) this.applyLayout();
  }

  /**
   * Tutorial hook: the lowest edge of the HUD's readouts (the streak pill's
   * pressure ring, the level pill under the score on a compact screen), in
   * CSS px from the top — the narration panel hangs 14 px under it.
   */
  get hudBottom(): number {
    return hudBottomOf(this.layout);
  }

  /**
   * Tutorial hook: whether the table's own choreography is still running —
   * a drag or a return, a landing, a clear (sweep, fracture, banner), a
   * level-up waiting for the band, the end's slow-mo or a deal. The
   * narration waits for it to go quiet.
   */
  get busy(): boolean {
    if (this.drag || this.returning || this.recoil) return true;
    if (this.landT >= 0 || this.bannerT >= 0 || this.bannerPending || this.slowT >= 0) return true;
    if (this.levelQueue.length > 0) return true;
    for (const s of this.slots) if (s.dealT < 1) return true;
    for (const v of this.cells) if (v.anim !== 'none') return true;
    return false;
  }

  /** Tutorial hook: show the world without the countdown (the demo starts on GO's other side). */
  revealWorld(): void {
    this.worldScene.reveal();
  }

  /** The personal best, when it arrives after construction (the profile answers async). */
  setBest(best: number | undefined): void {
    this.best = best;
    // Once the game is over the results plate carries NEW BEST; the HUD's
    // line is not rewritten inside the end beat (it would be born mid-dim).
    if (this.bestText && this.endSlowT < 0 && this.resultsFade < 0)
      this.bestText.text = best !== undefined && best > 0 ? `BEST ${best}` : '';
  }

  setQuality(tier: QualityTier): void {
    this.tier = tier;
    this.q = QUALITY[tier];
    // Before init() the scene does not exist yet; build() applies the tier itself.
    if (!this.background) return;
    this.background.setOctaves(this.q.bgOctaves);
    this.rimBand.setOctaves(Math.max(1, this.q.rimBand));
    this.pressureRing.setQuality(this.q.ringSparks, this.q.ringComet, this.reducedMotion);
    this.camera.configure(this.q.parallax);
    // The tier's supersampling (a medium <-> ultra switch changes it); the
    // resize event runs applyLayout.
    const r = this.targetResolution();
    if (Math.abs(r - this.app.renderer.resolution) > 1e-3) this.setResolution(r);
    // The world: a different layer count means different textures.
    const relayer = this.worldScene.isLoaded && this.worldScene.layerCount !== this.q.worldLayers;
    this.worldScene.setQuality(this.q);
    if (relayer) {
      this.worldScene.unload();
      void this.loadWorld();
    }
    if (this.layout.width > 1) this.layoutFloor();
    if (this.q.post) {
      if (!this.post) this.post = new PostFilter(this.q);
      this.post.applyQuality(this.q);
      this.post.resolution = this.worldResolution();
      this.world.filters = [this.post];
    } else {
      this.world.filters = [];
    }
    if (this.layout.width > 1)
      this.post?.setBoardRect(this.layout, this.app.screen.width, this.app.screen.height);
    this.post?.setRoomLift(this.roomLift());
    // Tier switches for the HUD and the ghost; a change mid-drag just redraws next frame.
    this.scoreText.visible = !this.q.odometer;
    this.odometer.container.visible = this.q.odometer;
    if (this.q.odometer) this.odometer.reset(this.displayedScore);
    this.levelPill.setTextOnly(this.q.levelFx === 0 || !this.q.odometer);
    if (this.layout.width > 1) this.levelPill.layout(this.app.renderer);
    if (!this.q.holoGhost) {
      this.holoGhost.hide();
      for (const hl of this.holoLines) hl.hide();
    }
    if (this.q.ghostBeam <= 0) this.beam.hide();
    for (const sh of this.handShadows) sh.visible = this.q.trayFloatMm > 0;
    if (this.q.tileLight > 0) this.material.setQuality(this.q.tileLight === 2 ? 2 : 1);
    if (!this.q.contactShadow) {
      this.contactAO.hideAll();
      this.pieceShadow.hide();
    }
    this.applyTileLook();
    for (const s of this.slots) this.layoutSlot(s);
  }

  /** Piece sprites take the lit bake on tiers with the lit mesh, the painted bake on low. */
  private applyTileLook(): void {
    if (this.q.tileLight > 0) {
      this.litBake.bake(this.q.tileLight === 2 ? 2 : 1);
      applyTileLook(this.tex, this.litBake);
    } else {
      applyTileLook(this.tex, null);
    }
  }

  /** Piece colour index of a tile texture, whichever bake it came from (-1 if none). */
  private tileIndexOf(texture: Texture): number {
    const i = this.tex.tiles.indexOf(texture);
    if (i >= 0) return i;
    const j = this.litBake.tiles.indexOf(texture);
    return j >= 0 ? j : this.tex.tilesPainted.indexOf(texture);
  }

  /**
   * The in-engine results cinematic (idea 10). Resolves when the beat is over;
   * React shows only the buttons after that.
   */
  playResults(
    breakdown: ScoreBreakdown,
    forfeitTitle?: string,
    outcome?: ResultsOutcome | 'pending' | null,
  ): Promise<void> {
    return new Promise((resolve) => {
      this.hideStreak();
      // One continuous beat: 400 ms of time dilation (the last landing's dust
      // and ripple at 0.25x) while the HUD dims and the board desaturates,
      // then the results scene's clock starts and the plate comes in over
      // it. The scene is armed now so the shell can measure its tray.
      if (this.q.endSlow) {
        this.endSlowT = 0;
        this.results.paused = true;
        this.onCue?.('end-slow');
      }
      // Play is over: the plate tilts under the results, and a spark from the
      // last landing (or the tiles' lift-off) must not cross its rim — the
      // particles' bounds pull in to the plate less a cell.
      {
        const L = this.layout;
        this.particles.bounds = {
          x0: L.boardX,
          y0: L.boardY,
          x1: L.boardX + L.boardSize,
          y1: L.boardY + L.boardSize,
        };
      }
      if (!this.q.endSlow) {
        this.resultsFade = 0;
      }
      this.results.play(
        {
          table: this.table,
          world: this.world,
          hud: this.hud,
          cells: this.cells,
          layout: () => this.layout,
          particles: this.particles,
          oneShots: this.oneShots,
          tex: this.tex,
          onBeat: (k) => this.onResultsBeat?.(k),
          best: this.best,
          post: this.post,
          screen: () => ({ width: this.app.screen.width, height: this.app.screen.height }),
          setGrade: (g) => {
            this.resultsGrade = g;
          },
          forfeitTitle,
          outcome,
          coins: this.q.outcomeCoins,
          reducedMotion: this.reducedMotion,
        },
        breakdown,
        resolve,
      );
    });
  }

  lockInput(locked: boolean): void {
    this.inputLocked = locked;
    if (locked && this.drag) this.endDrag(false);
  }

  /**
   * 3-2-1-GO over the board. Resolves when GO fades; the caller starts the
   * clock then. The HUD is parked off while the numerals run and slides in
   * on GO (countdownFx 2); the numerals scale in from 1.4 with an overshoot
   * over a filled flash core (no ring); GO lights the grid bottom → top and
   * breaks the world's dawn.
   */
  startCountdown(): Promise<void> {
    return new Promise((resolve) => {
      this.worldScene.reveal();
      this.countdown = { value: 3, t: 0, resolve };
      this.countdownText.visible = true;
      if (this.q.countdownFx >= 2 && !this.reducedMotion) this.parkHud();
      this.onCountdown?.(3);
      this.countdownBeat(3);
    });
  }

  /** The HUD's readouts wait off-stage (above, transparent) until GO slides them in. */
  private parkHud(): void {
    this.hudParked = true;
    this.hudInT = -1;
    for (const group of this.hudGroups()) {
      for (const el of group) {
        el.alpha = 0;
        el.pivot.y = HUD_IN_PX;
      }
    }
  }

  /** The HUD's readouts in slide order: the score block, the clock, the mode pill (built once). */
  private hudGroups(): Container[][] {
    if (this.hudGroupList.length === 0)
      this.hudGroupList = [
        [
          this.scoreLabel,
          this.scoreText,
          this.odometer.container,
          this.levelPill.container,
          this.bestText,
        ],
        [this.timerText, this.timerBar],
        [this.modePill],
      ];
    return this.hudGroupList;
  }
  private hudGroupList: Container[][] = [];

  /**
   * A numeral lands (3, 2, 1) or GO: the filled flash core behind it; on GO
   * the grid lights row by row from the bottom (socket-rim highlight plus a
   * faint fill per row), the HUD slides in, and the world's dawn breaks.
   */
  private countdownBeat(value: number): void {
    const L = this.layout;
    const fx = this.q.countdownFx;
    if (fx < 1) return;
    const cx = L.boardX + L.boardSize / 2;
    const cy = L.boardY + L.boardSize / 2;
    const B = L.boardSize;
    const go = value === 0;
    // Filled core: a soft bloom in the accent under a held warm-white core.
    // The bloom is the wide glow frame (a pedestal that reaches, not a
    // centre-heavy pool), so the accent reads OUTSIDE the warm core rather
    // than summing with it to grey.
    this.oneShots.puff(
      this.tex,
      cx,
      cy,
      go ? PALETTE.accentWarm : PALETTE.accent,
      B * COUNT_BLOOM_B,
      COUNT_CORE_HOLD_S + COUNT_CORE_OUT_S + 0.1,
      COUNT_BLOOM_ALPHA,
      false,
    );
    for (const a of [COUNT_CORE_ALPHA, COUNT_CORE_SECOND_ALPHA])
      this.oneShots.flare(
        this.tex,
        cx,
        cy,
        COUNT_CORE_COLOR,
        B * COUNT_CORE_B * (go ? 1.3 : 1),
        COUNT_CORE_HOLD_S,
        COUNT_CORE_OUT_S,
        a,
      );
    if (!go) return;
    // The grid lights bottom → top over GO_GRID_S: each socket's rim catches
    // the light as the front passes and one faint fill rides the front row.
    this.goT = 0;
    this.goLayer.visible = true;
    this.goFill.scale.set(B / this.tex.size, (L.cell * 1.2) / this.tex.size);
    this.goFill.x = cx;
    this.post?.kick(0.05);
    if (fx >= 2) {
      if (this.hudParked) this.hudInT = 0;
      // The world's clock is at dawn (0 on the game clock): the dawn breaks
      // with a horizontal light sweep across the far layer; on the procedural
      // backdrop the veins take a pulse instead.
      if (!this.worldScene.dawnSweep(this.reducedMotion)) this.background?.kick(0.3);
    }
  }

  // ---------------------------------------------------------------------------
  // Scene construction

  private build(): void {
    const { stage } = this.app;
    stage.addChild(this.world);
    stage.eventMode = 'static';
    stage.hitArea = this.app.screen;
    stage.on('pointermove', this.onPointerMove);
    stage.on('pointerup', this.onPointerUp);
    stage.on('pointerupoutside', this.onPointerUp);
    stage.on('pointercancel', this.onPointerUp);

    this.world.addChild(this.planeBack, this.planeFar, this.planeMotes, this.planeFloor);
    this.camera.add(this.planeBack, -1);
    this.camera.add(this.planeFar, -0.9);
    this.camera.add(this.planeMotes, -0.75);
    this.camera.add(this.planeFloor, -0.5);
    this.background = new Background(this.q.bgOctaves);
    this.planeBack.addChild(this.background.mesh);
    // The world sits above the backdrop (its base and fallback) and below
    // the table light; each of its containers goes on its own plane.
    this.worldScene = new WorldScene(this.tex);
    this.worldScene.setQuality(this.q);
    this.planeBack.addChild(this.worldScene.back);
    this.planeFar.addChild(this.worldScene.far);
    this.planeMotes.addChild(this.worldScene.mid);
    this.planeFloor.addChild(this.worldScene.near);

    this.spotlight = new Sprite(this.tex.spotlight);
    this.spotlight.anchor.set(0.5);
    this.spotlight.tint = 0x3d4394;
    this.spotlight.alpha = 1;
    this.spotlight.blendMode = 'add';
    this.planeFloor.addChild(this.spotlight);
    this.tableLight = new Sprite(this.tex.soft);
    this.tableLight.anchor.set(0.5);
    this.tableLight.tint = 0x2a2f70;
    this.tableLight.alpha = 1;
    this.tableLight.blendMode = 'add';
    this.planeFloor.addChild(this.tableLight);
    for (let i = 0; i < 2; i++) {
      const b = new Sprite(this.tex.soft);
      b.anchor.set(0.5);
      b.tint = 0x161a3a;
      b.alpha = 0.7;
      b.blendMode = 'add';
      b.visible = false;
      this.planeFloor.addChild(b);
      this.sideBands.push(b);
    }

    this.motes = new MoteField(this.tex, MOTE_COUNT);
    this.planeMotes.addChild(this.motes.container);

    // One material for every piece: bake the lit look into the piece sprites'
    // textures before anything is built from them.
    this.litBake = new LitBake(this.app.renderer, this.tex);
    this.applyTileLook();

    this.world.addChild(this.table);
    // The table is two camera planes: the slab (with the floor reflection under
    // it) and, a touch nearer, everything that sits on it.
    this.table.addChild(this.plateLayer, this.tileLayer);
    this.camera.add(this.plateLayer, -0.2);
    this.camera.add(this.tileLayer, 0);
    this.plateShadow = new Sprite(this.tex.shadow);
    this.plateShadow.anchor.set(0.5);
    this.plateShadow.alpha = 0.7;
    this.plateLayer.addChild(this.plateShadow);
    this.plateLayer.addChild(this.floor.mesh);
    this.plateLayer.addChild(this.plate);
    // Rim lights: their own group so the reflection can capture them with the tiles.
    this.plateLayer.addChild(this.rimLayer);
    this.plateHeat = new Sprite(this.tex.soft);
    this.plateHeat.anchor.set(0.5);
    this.plateHeat.blendMode = 'add';
    this.plateHeat.alpha = 0;
    this.rimLayer.addChild(this.plateHeat);
    this.rimGlow.blendMode = 'add';
    this.rimGlow.alpha = 0;
    this.rimLayer.addChild(this.rimGlow);
    this.rimBand = new RimBand(Math.max(1, this.q.rimBand));
    this.rimLayer.addChild(this.rimBand.mesh);
    // The slab itself is below the reflection's luma knee; two passes suffice.
    this.reflectionSource = [this.rimLayer, this.tileLayer];
    this.plateLayer.addChild(this.trays);
    for (let i = 0; i < RULES.handSize; i++) {
      const g = new Sprite(this.tex.glow);
      g.anchor.set(0.5);
      g.alpha = 0.5;
      g.blendMode = 'add';
      g.tint = 0x1c2140;
      this.plateLayer.addChild(g);
      this.trayLift.push(g);
    }
    this.bleedLayer.blendMode = 'add';
    this.tileLayer.addChild(this.bleedLayer);
    for (let i = 0; i < RULES.rows * RULES.cols; i++) {
      const b = new Sprite(this.tex.spotlight);
      b.anchor.set(0.5);
      b.blendMode = 'add';
      b.visible = false;
      this.bleedLayer.addChild(b);
      this.bleed.push(b);
      this.bleedT.push(0);
    }
    // Banner band sits behind the tiles: a darkening strip for contrast, then
    // a soft-ended additive band in the heat colour. Both clipped to the plate.
    this.bannerDark = new Sprite(this.tex.soft);
    this.bannerDark.anchor.set(0.5);
    this.bannerDark.tint = 0x000000;
    this.bannerDark.alpha = 0;
    this.bannerFill = new Sprite(this.tex.soft);
    this.bannerFill.anchor.set(0.5);
    this.bannerFill.blendMode = 'add';
    this.bannerEdge = new Sprite(this.tex.sweep);
    this.bannerEdge.anchor.set(0.5);
    this.bannerEdge.blendMode = 'add';
    this.bannerEdge.rotation = Math.PI / 2;
    this.bannerBand.addChild(this.bannerDark, this.bannerFill, this.bannerEdge);
    this.bannerBand.visible = false;
    this.tileLayer.addChild(this.bannerBand);
    this.tileLayer.addChild(this.boardLayer);
    for (let i = 0; i < RULES.rows * RULES.cols; i++) {
      const sprite = new Sprite(this.tex.socket);
      sprite.anchor.set(0.5);
      this.boardLayer.addChild(sprite);
      this.cells.push({
        sprite,
        color: -1,
        anim: 'none',
        t: 0,
        delay: 0,
        dx: 0,
        dy: 0,
        amp: 0,
        flash: 0,
        clearColor: 0,
        fractured: false,
        age: 0,
        liftK: 0,
        pushX: 0,
        pushY: 0,
        flashColor: 0xffffff,
      });
    }
    // GO: every socket's rim as an additive outline, lit row by row; the fill under them.
    this.goFill = new Sprite(this.tex.glow);
    this.goFill.anchor.set(0.5);
    this.goFill.blendMode = 'add';
    this.goFill.tint = PALETTE.accent;
    this.goFill.visible = false;
    this.goLayer.addChild(this.goFill);
    for (let i = 0; i < RULES.rows * RULES.cols; i++) {
      const o = new Sprite(this.tex.outline);
      o.anchor.set(0.5);
      o.blendMode = 'add';
      o.tint = PALETTE.accent;
      o.visible = false;
      this.goLayer.addChild(o);
      this.goRims.push(o);
    }
    // One container, off until GO: a hundred idle sprites are never walked.
    this.goLayer.visible = false;
    this.tileLayer.addChild(this.goLayer);
    // Contact AO over the sockets and gaps, then the lit tiles over that.
    this.contactAO = new ContactAO(this.tex, RULES.rows * RULES.cols);
    this.aoLayer.addChild(this.contactAO.container);
    this.tileLayer.addChild(this.aoLayer);
    this.material = new TileMaterial(this.tex, RULES.rows * RULES.cols);
    this.material.setDanger(PALETTE.danger);
    this.tileLayer.addChild(this.material.mesh);
    this.tileGlow = new TileGlow(this.tex, RULES.rows, RULES.cols);
    this.tileLayer.addChild(this.tileGlow.container);

    this.tileLayer.addChild(this.ghostLayer);
    this.tileLayer.addChild(this.heatLayer);
    this.heatLayer.blendMode = 'add';
    this.tileLayer.addChild(this.heatMask);
    this.heatLayer.mask = this.heatMask;
    for (let i = 0; i < RULES.rows * RULES.cols; i++) {
      // Radial falloff, not the flat soft square: neighbours overlap into a
      // trace with a bright core and feathered sides — light on the sockets,
      // not a bar over them.
      const h = new Sprite(this.tex.spotlight);
      h.anchor.set(0.5);
      h.visible = false;
      h.blendMode = 'add';
      this.heatLayer.addChild(h);
      this.heat.push(h);
      this.heatT.push(0);
    }
    for (let i = 0; i < RULES.rows * RULES.cols; i++) {
      const c = new Sprite(this.tex.spotlight);
      c.anchor.set(0.5);
      c.visible = false;
      c.blendMode = 'add';
      this.heatLayer.addChild(c);
      this.heatCore.push(c);
    }
    for (let i = 0; i < RULES.rows * RULES.cols; i++) {
      const r = new Sprite(this.tex.spotlight);
      r.anchor.set(0.5);
      r.visible = false;
      r.blendMode = 'add';
      this.rippleLayer.addChild(r);
      this.rippleLight.push(r);
    }
    // One container, off between landings: its hundred sprites are never walked idle.
    this.rippleLayer.visible = false;
    this.heatLayer.addChild(this.rippleLayer);
    this.rimLight = new Sprite(this.tex.glow);
    this.rimLight.anchor.set(0.5);
    this.rimLight.tint = PALETTE.accent;
    this.rimLight.blendMode = 'add';
    this.rimLight.visible = false;
    this.rimMask.blendMode = 'normal';
    this.tileLayer.addChild(this.rimMask);
    this.rimLight.mask = this.rimMask;
    this.tileLayer.addChild(this.rimLight);
    for (let i = 0; i < RULES.rows + RULES.cols; i++) {
      const s = new Sprite(this.tex.flat);
      s.anchor.set(0.5);
      s.visible = false;
      s.blendMode = 'add';
      this.ghostLayer.addChild(s);
      this.lineHints.push(s);
    }
    this.ghostLayer.addChild(this.previewOutline);
    for (let i = 0; i < MAX_PIECE_CELLS; i++) {
      const f = new Sprite(this.tex.flat);
      f.anchor.set(0.5);
      f.visible = false;
      this.ghostLayer.addChild(f);
      this.ghostFill.push(f);
      const o = new Sprite(this.tex.outline);
      o.anchor.set(0.5);
      o.visible = false;
      this.ghostLayer.addChild(o);
      this.ghostOutline.push(o);
    }
    // Holographic preview: the line frames under the piece's own projection.
    for (let i = 0; i < HOLO_LINE_CAP; i++) {
      const hl = new HoloGhost();
      this.ghostLayer.addChild(hl.mesh);
      this.holoLines.push(hl);
    }
    this.holoGhost = new HoloGhost();
    this.ghostLayer.addChild(this.holoGhost.mesh);

    this.fxMask = new Graphics();
    this.tileLayer.addChild(this.fxMask);
    this.oneShots = new OneShots(40, this.tex);
    this.oneShots.container.mask = this.fxMask;
    this.tileLayer.addChild(this.plateMask);
    this.bannerBand.mask = this.plateMask;
    this.tileLayer.addChild(this.oneShots.container);
    // Chunks are geometry: above the hot line and the sweeps, under the ribbons' light.
    this.fracture = new Fracture(this.q.fracturePool, this.q.fractureGlow, this.tex);
    this.fracture.container.mask = this.fxMask;
    this.fracture.glowContainer.mask = this.fxMask;
    this.tileLayer.addChild(this.fracture.glowContainer);
    this.tileLayer.addChild(this.fracture.container);
    this.ribbons = new Ribbons(RIBBON_CAP);
    this.ribbons.container.mask = this.fxMask;
    this.tileLayer.addChild(this.ribbons.container);
    // Burst layers go in under the banner band (and the tiles).
    this.burstFx = new OneShots(8, this.tex);
    this.burstFx.container.mask = this.fxMask;
    this.burstParticles = new Particles(48, this.tex);
    this.burstParticles.container.mask = this.fxMask;
    const under = this.tileLayer.getChildIndex(this.bannerBand);
    this.tileLayer.addChildAt(this.burstFx.container, under);
    this.tileLayer.addChildAt(this.burstParticles.container, under);

    this.world.addChild(this.planeMid);
    this.camera.add(this.planeMid, 0);
    this.particles = new Particles(this.q.particleCap, this.tex);
    this.particles.container.mask = this.fxMask;
    this.particles.riseBlocked = this.tileAt;
    this.planeMid.addChild(this.particles.container);
    this.fracture.bindParticles(this.particles);

    for (let slot = 0; slot < RULES.handSize; slot++) {
      const sh = new Sprite(this.tex.shadow);
      sh.anchor.set(0.5);
      sh.alpha = 0;
      sh.visible = false;
      this.planeMid.addChild(sh);
      this.handShadows.push(sh);
    }
    this.planeMid.addChild(this.handLayer);
    this.planeMid.addChild(this.handMask);
    this.handMask.visible = false;
    for (let slot = 0; slot < RULES.handSize; slot++) {
      const root = new Container();
      root.eventMode = 'static';
      root.cursor = 'grab';
      const sprites: Sprite[] = [];
      for (let i = 0; i < MAX_PIECE_CELLS; i++) {
        const s = new Sprite(this.tex.tiles[0]);
        s.anchor.set(0.5);
        s.visible = false;
        root.addChild(s);
        sprites.push(s);
      }
      root.on('pointerdown', (e: FederatedPointerEvent) => this.beginDrag(slot, e));
      root.on('pointerover', () => {
        const s = this.slots[slot];
        if (s) s.hover = 1;
      });
      root.on('pointerout', () => {
        const s = this.slots[slot];
        if (s) s.hover = 0;
      });
      this.handLayer.addChild(root);
      this.slots.push({
        root,
        sprites,
        piece: null,
        dealT: 1,
        dealDelay: 0,
        hover: 0,
        originX: 0,
        originY: 0,
        fit: 1,
        dealFromX: 0,
        dealFromY: 0,
        settleT: -1,
      });
    }

    this.dragShadow = new Sprite(this.tex.shadow);
    this.dragShadow.anchor.set(0.5);
    this.dragShadow.alpha = 0;
    this.planeMid.addChild(this.dragShadow);
    // The projection beam: above the shadow (it is light), under the piece.
    this.beam = new HoloBeam();
    this.beam.mesh.mask = this.fxMask;
    this.planeMid.addChild(this.beam.mesh);
    this.pieceShadow = new PieceShadow();
    this.planeMid.addChild(this.pieceShadow.container);
    // Landing layer: the falling piece, a rim flash per cell, the rejected-drop flash.
    this.planeMid.addChild(this.landLayer);
    this.landLayer.visible = false;
    for (let i = 0; i < MAX_PIECE_CELLS; i++) {
      const s = new Sprite(this.tex.tiles[0]);
      s.anchor.set(0.5);
      s.visible = false;
      this.landLayer.addChild(s);
      this.landSprites.push(s);
    }
    for (let i = 0; i < MAX_PIECE_CELLS; i++) {
      const s = new Sprite(this.tex.outline);
      s.anchor.set(0.5);
      s.visible = false;
      s.blendMode = 'add';
      this.landLayer.addChild(s);
      this.rimSprites.push(s);
    }
    this.blockFlash = new Sprite(this.tex.flat);
    this.blockFlash.anchor.set(0.5);
    this.blockFlash.blendMode = 'add';
    this.blockFlash.tint = PALETTE.danger;
    this.blockFlash.visible = false;
    this.planeMid.addChild(this.blockFlash);

    // Trail: ghost copies of the piece, additive, behind the dragged piece.
    this.planeMid.addChild(this.trailLayer);
    this.trailLayer.blendMode = 'add';
    this.trailLayer.mask = this.fxMask;
    // One comet smear per cell: a stretched glow trailing back along the
    // velocity from the cell centre (anchor at the head). No tile texture.
    for (let g = 0; g < TRAIL_GHOSTS; g++) {
      const ghost = new Container();
      ghost.visible = false;
      for (let i = 0; i < MAX_PIECE_CELLS; i++) {
        const s = new Sprite(this.tex.glow);
        s.anchor.set(1, 0.5);
        s.visible = false;
        s.blendMode = 'add';
        ghost.addChild(s);
      }
      this.trailLayer.addChild(ghost);
      this.trailGhosts.push(ghost);
    }
    this.planeMid.addChild(this.dragLayer);
    for (let i = 0; i < MAX_PIECE_CELLS; i++) {
      const s = new Sprite(this.tex.tiles[0]);
      s.anchor.set(0.5);
      s.visible = false;
      this.dragLayer.addChild(s);
      this.dragSprites.push(s);
    }
    this.dragLayer.visible = false;

    this.floatText = new FloatText(this.app.renderer, 10, this.textRes);
    this.planeMid.addChild(this.floatText.container);
    for (let i = 0; i < 2; i++) {
      const leak = new Sprite(this.tex.soft);
      leak.anchor.set(0.5);
      leak.blendMode = 'add';
      leak.alpha = 0;
      this.planeMid.addChild(leak);
      this.leaks.push(leak);
    }
    this.bannerText = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: 'Rajdhani, "Space Grotesk", sans-serif',
        fontSize: 72,
        fontWeight: '700',
        fill: 0xffffff,
        letterSpacing: 6,
        stroke: { color: PALETTE.bgDeep, width: 6, join: 'round' },
        dropShadow: { alpha: 0.9, blur: 22, color: PALETTE.accentWarm, distance: 0 },
      }),
      resolution: this.textRes,
    });
    this.bannerText.anchor.set(0.5);
    this.bannerText.visible = false;
    this.planeMid.addChild(this.bannerText);
    this.letterBanner = new LetterBanner(this.app.renderer, this.bannerText.style, this.textRes);
    this.letterBanner.container.visible = false;
    this.planeMid.addChild(this.letterBanner.container);

    this.buildHud();
    stage.addChild(this.hud);
    this.camera.add(this.hud, 0.4, true);

    // Hit-testing: the stage is `static` and Pixi INHERITS that mode down the
    // tree, so every decorative sprite counts as a hit target — and a hit on
    // a non-interactive sprite still ends the search. The 4X light leaks sit
    // above the trays in this plane and, on a phone, cover the outer slots:
    // slot 3 could never be grabbed. Only the hand slots take input; every
    // other layer is opted out (which also skips their subtrees), and the
    // HUD, world planes and table never take input at all.
    for (const c of this.planeMid.children) if (c !== this.handLayer) c.eventMode = 'none';
    for (const p of [this.planeBack, this.planeFar, this.planeMotes, this.planeFloor, this.table])
      p.eventMode = 'none';
    this.hud.eventMode = 'none';
    this.results = new ResultsScene(this.app.renderer, this.tex, this.textRes);
    this.results.attach(this.hud);

    this.setQuality(this.tier);
  }

  private buildHud(): void {
    const res = this.hudRes;
    const style = (size: number, weight: '500' | '600' | '700', fill: number, spacing = 1) =>
      new TextStyle({
        fontFamily: 'Rajdhani, "Space Grotesk", sans-serif',
        fontSize: size,
        fontWeight: weight,
        fill,
        letterSpacing: spacing,
        stroke: { color: PALETTE.bgDeep, width: 2, join: 'round' },
        dropShadow: { alpha: 0.5, blur: 2, color: 0x000000, distance: 2, angle: Math.PI / 2 },
      });

    this.scoreLabel = new Text({
      text: 'SCORE',
      style: style(11, '600', PALETTE.textDim, 3),
      resolution: res,
    });
    this.scoreText = new Text({
      text: '0',
      style: style(56, '700', PALETTE.text),
      resolution: res,
    });
    this.odometer = new Odometer(this.scoreText.style, undefined, res);
    this.timerText = new Text({
      text: '3:00',
      style: style(44, '700', PALETTE.text),
      resolution: res,
    });
    this.timerText.anchor.set(1, 0);
    // The pill's text is cached glyphs (glyph-text.ts): a new streak count
    // on the clear frame rasterises nothing.
    this.streakStyle = style(22, '700', PALETTE.accentWarm, 2);
    this.streakCache = new GlyphCache(this.app.renderer, this.streakStyle, res, {
      shadow: true,
      stroke: true,
      fill: true,
      body: false,
    });
    this.streakCache.setAlphabet('0123456789X STREAK');
    this.streakText = new GlyphString(this.streakCache, 12);
    this.streakText.setShadow(0.5, 0x000000);
    this.pillGlow = new Sprite(this.tex.glow);
    this.pillGlow.anchor.set(0.5);
    this.pillGlow.blendMode = 'add';
    this.pillGlow.tint = PALETTE.accentWarm;
    this.pillGlow.alpha = 0;
    this.streakPill.addChild(this.pillGlow, this.streakBg, this.streakText.container);
    this.streakPill.addChildAt(this.pressureRing.mesh, 1);
    this.pressureRing.setQuality(this.q.ringSparks, this.q.ringComet, this.reducedMotion);
    this.streakPill.visible = false;
    // The level pill's text is the mode pill's: white, bold, the HUD stroke
    // (a dim label read "muted" next to TUTORIAL / SOLO).
    this.levelPill = new LevelPill(
      this.tex,
      style(11, '700', PALETTE.text, 3),
      style(22, '700', PALETTE.text, 1),
      res,
    );
    this.modeText = new Text({
      text: this.modeLabel,
      style: style(12, '700', PALETTE.text, 2),
      resolution: res,
    });
    this.modeText.anchor.set(0.5);
    const mw = this.modeText.width + 20;
    const mh = this.modeText.height + 6;
    this.modeBg
      .roundRect(-mw / 2, -mh / 2, mw, mh, mh / 2)
      .fill({ color: PALETTE.plateTop, alpha: 0.9 })
      .stroke({ color: PALETTE.plateRim, width: 1, alpha: 0.9 });
    this.modePill.addChild(this.modeBg, this.modeText);
    this.bestText = new Text({
      text: this.best !== undefined && this.best > 0 ? `BEST ${this.best}` : '',
      style: style(12, '600', PALETTE.textDim, 2),
      resolution: res,
    });
    this.countdownText = new Text({
      text: '3',
      style: new TextStyle({
        fontFamily: 'Rajdhani, "Space Grotesk", sans-serif',
        fontSize: 160,
        fontWeight: '700',
        fill: PALETTE.text,
        stroke: { color: PALETTE.bgDeep, width: 8, join: 'round' },
        dropShadow: { alpha: 0.7, blur: 18, color: PALETTE.accent, distance: 0 },
      }),
      resolution: res,
    });
    this.countdownText.anchor.set(0.5);
    this.countdownText.visible = false;
    this.hud.addChild(
      this.scoreLabel,
      this.scoreText,
      this.odometer.container,
      this.timerText,
      this.timerBar,
      this.streakPill,
      this.levelPill.container,
      this.modePill,
      this.bestText,
      this.countdownText,
    );
  }

  private applyLayout = (): void => {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    this.layout = computeLayout(w, h, this.coarse, this.guideInset);
    const L = this.layout;
    this.app.stage.hitArea = new Rectangle(0, 0, w, h);
    this.post?.setBoardRect(L, w, h);
    this.post?.setRoomLift(this.roomLift());

    const bx = L.boardX + L.boardSize / 2;
    const by = L.boardY + L.boardSize / 2;
    this.camera.layout(bx, by);
    this.layoutFloor();
    this.spotlight.position.set(bx, by + L.boardSize * 0.05);
    this.spotlight.scale.set((L.boardSize * 2.1) / 256, (L.boardSize * 2.0) / 256);
    this.tableLight.position.set(bx, by + 10);
    this.tableLight.scale.set(
      (L.boardSize + L.gap * 6 + 240) / 256,
      (L.boardSize + L.gap * 6 + 240) / 256,
    );

    const wide = w >= 1100;
    const bandW = 220;
    for (let i = 0; i < this.sideBands.length; i++) {
      const b = this.sideBands[i];
      if (!b) continue;
      b.visible = wide;
      const cx =
        i === 0
          ? (L.boardX - 40) / 2
          : L.boardX + L.boardSize + 40 + (w - (L.boardX + L.boardSize + 40)) / 2;
      b.position.set(cx, h / 2);
      b.scale.set(bandW / 256, (h * 1.3) / 256);
    }

    this.motes.layout(w, h, { x: L.boardX, y: L.boardY, w: L.boardSize, h: L.boardSize });

    // Plate: gradient slab with a drop shadow, rim, and a top inner highlight.
    const pad = L.gap * 3;
    const px = L.boardX - pad;
    const py = L.boardY - pad;
    const ps = L.boardSize + pad * 2;
    const pr = L.cell * 0.35;
    this.plateShadow.position.set(px + ps / 2, py + ps / 2 + 18);
    this.plateShadow.scale.set((ps + 48) / 256, (ps + 48) / 256);
    this.plate.clear();
    const bands = 16;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      const c = lerp(PALETTE.plateTop, PALETTE.plateBottom, t);
      const y0 = py + (ps * i) / bands;
      const y1 = py + (ps * (i + 1)) / bands;
      if (i === 0) this.plate.roundRect(px, py, ps, ps, pr).fill({ color: c });
      else this.plate.rect(px, y0, ps, y1 - y0 + 0.5).fill({ color: c });
    }
    // Restore the rounded bottom corners over the band fills.
    this.plate
      .roundRect(px, py, ps, ps, pr)
      .stroke({ color: PALETTE.plateRim, width: 3, alpha: 1 });
    this.plate
      .moveTo(px + pr, py + 2)
      .lineTo(px + ps - pr, py + 2)
      .stroke({ color: 0xffffff, width: 1.5, alpha: 0.08 });

    // Hand trays: three sockets. Over a painted world the tray floor is
    // near-opaque, so nothing painted reads through an empty tray.
    this.trays.clear();
    const trayH = L.handHeight - 52;
    const trayY = L.handY + 32;
    const trayW = L.handSlotW - 10;
    const trayAlpha = this.worldScene?.isLoaded ? TRAY_ALPHA_WORLD : 0.55;
    for (let i = 0; i < RULES.handSize; i++) {
      const tx = (L.handSlotX[i] ?? 0) - trayW / 2;
      this.trays
        .roundRect(tx, trayY, trayW, trayH, L.cell * 0.5)
        .fill({ color: PALETTE.plateBottom, alpha: trayAlpha })
        .stroke({ color: PALETTE.plateRim, width: 1, alpha: 0.7 });
      const lift = this.trayLift[i];
      if (lift) {
        lift.position.set(tx + trayW / 2, trayY + trayH / 2);
        lift.scale.set((trayW * 1.1) / this.tex.size, (trayH * 1.1) / this.tex.size);
      }
      this.trays
        .moveTo(tx + L.cell * 0.5, trayY + 1.5)
        .lineTo(tx + trayW - L.cell * 0.5, trayY + 1.5)
        .stroke({ color: 0xffffff, width: 1, alpha: 0.06 });
    }
    // The deal mask: a rising piece appears from the tray floor. Only the floor
    // needs to clip, so the mask runs a cell above the tray and the overshoot
    // of a tall piece is never cut.
    this.handMask.clear();
    for (let i = 0; i < RULES.handSize; i++) {
      const tx = (L.handSlotX[i] ?? 0) - trayW / 2;
      this.handMask
        .roundRect(tx, trayY - L.cell, trayW, trayH + L.cell, L.cell * 0.5)
        .fill({ color: 0xffffff });
    }

    const scale = L.cell / this.tex.size;
    for (let r = 0; r < RULES.rows; r++) {
      for (let c = 0; c < RULES.cols; c++) {
        const v = this.cells[r * RULES.cols + c];
        if (!v) continue;
        const { x, y } = cellToXY(L, r, c);
        v.sprite.position.set(x + L.cell / 2, y + L.cell / 2);
        if (v.anim === 'none') v.sprite.scale.set(scale);
        const h = this.heat[r * RULES.cols + c];
        if (h) {
          h.position.set(x + L.cell / 2, y + L.cell / 2);
          h.scale.set(scale);
        }
        this.heatCore[r * RULES.cols + c]?.position.set(x + L.cell / 2, y + L.cell / 2);
        const rl = this.rippleLight[r * RULES.cols + c];
        if (rl) {
          rl.position.set(x + L.cell / 2, y + L.cell / 2);
          rl.scale.set((L.cell * RIPPLE_LIGHT_CELLS) / 256);
        }
        const b = this.bleed[r * RULES.cols + c];
        if (b) {
          b.position.set(x + L.cell / 2, y + L.cell / 2 + L.cell * 0.15);
          b.scale.set((L.cell * 2.2) / 256);
        }
        this.tileGlow.place(r * RULES.cols + c, x + L.cell / 2, y + L.cell / 2, L.cell);
        const go = this.goRims[r * RULES.cols + c];
        if (go) {
          go.position.set(x + L.cell / 2, y + L.cell / 2);
          go.scale.set(scale);
        }
        this.contactAO.place(r * RULES.cols + c, x + L.cell / 2, y + L.cell / 2, L.cell);
      }
    }
    for (const g of this.ghostFill) g.scale.set(scale);
    for (const g of this.ghostOutline) g.scale.set(scale);
    for (const d of this.dragSprites) d.scale.set(scale);
    for (const d of this.landSprites) d.scale.set(scale);
    for (const d of this.rimSprites) d.scale.set(scale);
    this.blockFlash.scale.set(scale);
    for (const ghost of this.trailGhosts) for (const d of ghost.children) d.scale.set(scale);

    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s) continue;
      s.root.position.set(L.handSlotX[i] ?? 0, L.handY + L.handHeight / 2);
      s.root.hitArea = new Rectangle(
        -L.handSlotW / 2,
        -L.handHeight / 2,
        L.handSlotW,
        L.handHeight,
      );
      this.layoutSlot(s);
    }

    // Every table effect stops at the plate rim on every layout: on a phone
    // the plate is the screen, so "plate + half a cell" was the screen edge.
    {
      const pad = L.gap * 3;
      const inset = 1.5; // inside the 3 px rim stroke
      this.fxMask
        .clear()
        .roundRect(
          L.boardX - pad + inset,
          L.boardY - pad + inset,
          L.boardSize + pad * 2 - inset * 2,
          L.boardSize + pad * 2 - inset * 2,
          L.cell * 0.35 - inset,
        )
        .fill({ color: 0xffffff });
    }
    this.particles.bounds = {
      x0: L.boardX - L.cell,
      y0: L.boardY - L.cell,
      x1: L.boardX + L.boardSize + L.cell,
      y1: L.boardY + L.boardSize + L.cell,
    };
    this.burstParticles.bounds = this.particles.bounds;
    this.fracture.layout(
      L.cell,
      L.boardY + L.boardSize + L.cell * 0.3,
      L.boardX - L.cell * 0.25,
      L.boardY - L.cell * 0.25,
      L.boardX + L.boardSize + L.cell * 0.25,
    );
    this.floatText.minY = L.boardY + L.cell * 0.6;
    this.rimLight.scale.set((L.cell * 1.2) / this.tex.size);
    {
      const pad = L.gap * 3;
      const px = L.boardX - pad;
      const py = L.boardY - pad;
      const ps = L.boardSize + pad * 2;
      this.plateHeat.position.set(px + ps / 2, py + ps / 2);
      this.plateHeat.scale.set((ps + 40) / 256, (ps + 40) / 256);
      // Band core ~0.13 cell (8 px at a 640 board); its glow reaches ~3 cores.
      this.rimBand.layout(px, py, ps, L.cell * 0.35, L.cell * 0.13);
      this.rimGlow
        .clear()
        .roundRect(px, py, ps, ps, L.cell * 0.35)
        .stroke({ color: 0xffffff, width: 4, alpha: 1 });
      this.bannerBand.position.set(L.boardX + L.boardSize / 2, L.boardY + L.boardSize / 2);
      this.bannerFill.scale.set((L.boardSize + 240) / 256, (L.cell * 1.9) / 256);
      this.bannerDark.scale.set((L.boardSize + 240) / 256, (L.cell * 2.2) / 256);
      this.plateMask
        .clear()
        .roundRect(px, py, ps, ps, L.cell * 0.35)
        .fill({ color: 0xffffff });
      // The hot line ends at the rim, like every other table effect (see fxMask).
      this.heatMask
        .clear()
        .roundRect(px + 1.5, py + 1.5, ps - 3, ps - 3, L.cell * 0.35 - 1.5)
        .fill({ color: 0xffffff });
      // The chase light may only exist on the rim (±6 px), never inside the board or outside the plate.
      this.rimMask
        .clear()
        .roundRect(px, py, ps, ps, L.cell * 0.35)
        .stroke({ color: 0xffffff, width: 12 });
      this.bannerEdge.scale.set((L.cell * 2.2) / this.tex.size, (L.cell * 1.2) / this.tex.size);
      this.bannerText.position.set(L.boardX + L.boardSize / 2, L.boardY + L.boardSize / 2);
      this.bannerText.style.fontSize = Math.round(L.boardSize * 0.11);
      this.letterBanner.container.position.copyFrom(this.bannerText.position);
      for (let i = 0; i < this.leaks.length; i++) {
        const leak = this.leaks[i];
        if (!leak) continue;
        leak.position.set(i === 0 ? -w * 0.1 : w * 1.1, h / 2);
        leak.scale.set((w * 0.6) / 256, (h * 1.6) / 256);
      }
    }

    // HUD.
    const compact = L.compact;
    this.scoreLabel.position.set(L.boardX, L.hudY + 4);
    this.scoreText.position.set(L.boardX - 2, L.hudY + (compact ? 12 : 14));
    this.scoreText.style.fontSize = compact ? 40 : 56;
    this.odometer.layout(this.app.renderer);
    this.odometer.container.position.copyFrom(this.scoreText.position);
    // Compact: 18 puts the clock's digits 10 px over the mode pill, the score's gap to the level pill.
    this.timerText.position.set(L.boardX + L.boardSize, L.hudY + (compact ? 18 : 24));
    this.timerText.style.fontSize = compact ? 34 : 42;
    this.bestText.position.set(L.boardX + this.scoreLabel.width + 14, L.hudY + 4);
    // Centred on the score digits' cap height (both sizes land near +46), not
    // on the band: the band's extra height is the ring's clearance from the rim.
    this.streakPill.position.set(L.boardX + L.boardSize / 2, L.hudY + 48);
    this.streakStyle.fontSize = compact ? 18 : 22;
    // The level pill docks to the score ("SCORE 1380 · LV 3" on one
    // baseline): tight to the right of the digits on the desktop, and under
    // them on a compact screen — never the streak pill's centre slot, never
    // over the world's top-band landmark. The x follows the digit count (animateHud).
    this.levelPill.setTextOnly(this.q.levelFx === 0 || !this.q.odometer);
    this.levelPill.setSizes(compact ? 12 : 13, compact ? 15 : 16);
    this.levelPill.layout(this.app.renderer);
    this.placeLevelPill();
    this.placeModePill();
    this.countdownText.position.set(L.boardX + L.boardSize / 2, L.boardY + L.boardSize / 2);
    this.countdownText.style.fontSize = Math.round(L.boardSize * 0.3);
    this.lastBarSec = -1;
  };

  /** Dock the level pill to the score's digits (their width changes as the score grows). */
  private placeLevelPill(): void {
    const L = this.layout;
    const digitsW = this.q.odometer ? this.odometer.width : this.scoreText.width;
    const pw = this.levelPill.width;
    const ph = this.levelPill.height;
    this.levelDockW = digitsW;
    if (L.compact) {
      // Under the digits, left-aligned with them, LEVEL_GAP_COMPACT below
      // their baseline, inside the HUD band and clear of the plate's top rim
      // (the HUD is 110 px: 12 + 40 of digits + 10 + the ~25 px pill, ≥ 14 px
      // over the rim at gap 4; layout.ts hudBottomOf tracks the pill's bottom).
      this.levelPill.container.position.set(
        Math.round(L.boardX + pw / 2),
        Math.round(
          this.scoreText.y + this.scoreText.style.fontSize * 0.89 + LEVEL_GAP_COMPACT + ph / 2,
        ),
      );
    } else {
      // On the score's baseline: the digits' cap height sits on the same line as the pill's number.
      const baseline = this.scoreText.y + this.scoreText.style.fontSize * 0.89;
      this.levelPill.container.position.set(
        Math.round(this.scoreText.x + digitsW + 12 + pw / 2),
        Math.round(baseline - ph / 2 + 2),
      );
    }
  }

  /**
   * The mode pill (SOLO / TUTORIAL / the challenge's label), right-aligned to
   * the board. Desktop: above the clock, in the band's top row. Compact: the
   * row grammar is score + level on the left, clock + mode on the right — the
   * pill sits UNDER the clock with its centre on the level pill's centre line,
   * so the two pills read as one row (the owner's ask, from a phone still with
   * TUTORIAL over the clock and LV under the score at different heights).
   */
  private placeModePill(): void {
    const L = this.layout;
    const x = L.boardX + L.boardSize - this.modeBg.width / 2;
    this.modePill.position.set(
      Math.round(x),
      L.compact ? this.levelPill.container.y : L.hudY + 2 + this.modeBg.height / 2,
    );
  }

  /** Tooling (capture harnesses, critics): the HUD row's pills and readouts as CSS-px boxes. */
  get hudGeometry(): Record<string, { x: number; y: number; w: number; h: number }> {
    const box = (cx: number, cy: number, w: number, h: number) => ({
      x: cx - w / 2,
      y: cy - h / 2,
      w,
      h,
    });
    const digitsW = this.q.odometer ? this.odometer.width : this.scoreText.width;
    const digitsH = this.q.odometer ? this.odometer.height : this.scoreText.height;
    return {
      score: { x: this.scoreText.x, y: this.scoreText.y, w: digitsW, h: digitsH },
      timer: {
        x: this.timerText.x - this.timerText.width,
        y: this.timerText.y,
        w: this.timerText.width,
        h: this.timerText.height,
      },
      level: box(
        this.levelPill.container.x,
        this.levelPill.container.y,
        this.levelPill.width,
        this.levelPill.height,
      ),
      mode: box(this.modePill.x, this.modePill.y, this.modeBg.width, this.modeBg.height),
      streak: box(
        this.streakPill.x,
        this.streakPill.y,
        this.streakW * this.streakPill.scale.x,
        this.streakH * this.streakPill.scale.y,
      ),
      plateRim: { x: this.layout.boardX, y: this.layout.boardY - this.layout.gap * 3, w: 0, h: 0 },
    };
  }

  /**
   * The tier-dependent part of the layout: the backdrop's overscan for the
   * camera, and the floor reflection's band and tray cut-outs. Runs on every
   * resize and on a tier change.
   */
  private layoutFloor(): void {
    const L = this.layout;
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    // The backdrop overscans by the parallax reach so its edge never shows.
    this.background?.resize(w, h, this.q.parallax * 2);
    const pad = L.gap * 3;
    this.worldScene.layout(w, h, this.q.parallax * 2, {
      x: L.boardX - pad,
      y: L.boardY - pad,
      size: L.boardSize + pad * 2,
      cell: L.cell,
      hudY: L.hudY,
      hudBaseline: L.hudY + (L.compact ? 44 : 58),
      trayBottom: L.handY + L.handHeight,
    });
    const trayH = L.handHeight - 52;
    const trayY = L.handY + 32;
    const trayW = L.handSlotW - 10;
    this.floor.layout(
      L.boardX - pad,
      L.boardY - pad,
      L.boardSize + pad * 2,
      L.cell,
      L.handSlotX.map((cx) => ({ x: cx - trayW / 2, y: trayY, w: trayW, h: trayH })),
      L.cell * 0.5,
      L.cell * 0.35,
      this.q.reflectionScale,
      this.q.reflectionTaps,
    );
  }

  private layoutSlot(s: SlotVis): void {
    const L = this.layout;
    if (!s.piece) {
      for (const sp of s.sprites) sp.visible = false;
      return;
    }
    const o = orientation(s.piece.shape, s.piece.rotation);
    // Fit the piece to its slot: a 5-wide line at hand scale is wider than a
    // phone's tray box, so it scales down (never up) with 8 px of air.
    const fullPitch = L.handCell * 1.08;
    s.fit = Math.min(
      1,
      (L.handSlotW - 16) / (o.cols * fullPitch),
      (L.handHeight - 52 - HAND_TRAY_INSET * 2) / (o.rows * fullPitch),
    );
    const pitch = fullPitch * s.fit;
    const w = o.cols * pitch;
    const h = o.rows * pitch;
    s.originX = -w / 2;
    // Centred in the tray BOX (whose centre sits HAND_TRAY_CENTRE_DY under the slot's home).
    s.originY = -h / 2 + HAND_TRAY_CENTRE_DY;
    const scale = (L.handCell * s.fit) / this.tex.size;
    const tile = this.tex.tilesHand[s.piece.color] ?? this.tex.tilesHand[0]!;
    const sh = this.handShadows[this.slots.indexOf(s)];
    if (sh) sh.scale.set((w + 28) / 256, (h + 28) / 256);
    for (let i = 0; i < s.sprites.length; i++) {
      const sp = s.sprites[i];
      const cell = o.cells[i];
      if (!sp) continue;
      if (!cell) {
        sp.visible = false;
        continue;
      }
      sp.visible = true;
      sp.texture = tile;
      sp.position.set(
        s.originX + cell.c * pitch + pitch / 2,
        s.originY + cell.r * pitch + pitch / 2,
      );
      sp.scale.set(scale * (this.tex.size / this.tex.tilesHandPx));
    }
  }

  // ---------------------------------------------------------------------------
  // Sim events -> visuals

  private onEvent = (e: GameEvent, state: GameState): void => {
    const L = this.layout;
    switch (e.type) {
      case 'handDealt': {
        for (let i = 0; i < this.slots.length; i++) {
          const s = this.slots[i];
          if (!s) continue;
          s.piece = e.hand[i] ?? null;
          s.dealT = this.reducedMotion ? 1 : 0;
          s.dealDelay = i * DEAL_STAGGER_S;
          s.settleT = -1;
          s.root.visible = true;
          s.root.alpha = 1;
          s.root.scale.set(1);
          this.layoutSlot(s);
          // Deal-in: from the tray's OUTER edge — the left slot from the left,
          // the right slot from the right, the middle one from below — with
          // the tray mask hiding it until it crosses the edge.
          this.dealFrom(s, i);
          s.root.position.set(
            (L.handSlotX[i] ?? 0) + s.dealFromX,
            L.handY + L.handHeight / 2 + s.dealFromY,
          );
        }
        this.handLayer.mask = this.handMask;
        this.handMask.visible = true;
        // "Next hand": the emptied trays dim from this frame and their lift glow pulses once.
        if (!this.reducedMotion) {
          this.trayPulseT = 0;
          this.trayDimK = 1;
          this.trays.tint = lerp(0xffffff, 0x000000, TRAY_DIM);
        }
        break;
      }
      case 'piecePlaced': {
        this.sincePlaceS = 0;
        const slot = this.slots[e.slot];
        if (slot) {
          slot.piece = null;
          this.layoutSlot(slot);
        }
        const color = pieceColor(e.piece.color);
        // Mass: a domino is light, a 3x3 or a 1x5 is heavy. Sets the squash,
        // the dust and the pressure ripple at contact (see animateLanding).
        const mass = Math.min(1, e.cells.length / MASS_CELLS);
        this.landMass = mass;
        let cx = 0;
        let cy = 0;
        for (const cell of e.cells) {
          const v = this.cells[cell.r * RULES.cols + cell.c];
          if (!v) continue;
          v.color = e.piece.color;
          v.amp = mass;
          const bl = this.bleed[cell.r * RULES.cols + cell.c];
          if (bl) {
            bl.tint = color;
            this.bleedT[cell.r * RULES.cols + cell.c] = 0.001;
          }
          // The socket stays until the falling piece lands on it; the cell then
          // takes over pressed into the socket and springs back (see animateLanding).
          v.sprite.tint = 0xffffff;
          v.sprite.alpha = 1;
          v.sprite.rotation = 0;
          v.sprite.scale.set(L.cell / this.tex.size);
          v.anim = 'pop';
          v.t = 0;
          v.delay = LAND_TRAVEL_S + LAND_SQUASH_S;
          v.flash = 0;
          cx += v.sprite.x;
          cy += v.sprite.y;
        }
        cx /= e.cells.length;
        cy /= e.cells.length;
        this.lastPlaced = { x: cx, y: cy };
        // Neighbours do not react to a landing: the placed piece has its own
        // squash, and every tile around it stays put and pixel-aligned.
        break;
      }
      case 'linesCleared': {
        const lines = e.rows.length + e.cols.length;
        this.lastClear = { rows: e.rows, cols: e.cols };
        const px = this.lastPlaced.x;
        const py = this.lastPlaced.y;
        const pitch = L.cell + L.gap;
        const choreo = this.q.clearChoreo;
        const cx0 = L.boardX + L.boardSize / 2;
        const cy0 = L.boardY + L.boardSize / 2;
        // The sweep passes one cell every CLEAR_POP_STEP_S: the tiles pop out
        // in its wake. Three-plus lines lift first and shatter from the
        // placed piece outward instead.
        const speed = pitch / CLEAR_POP_STEP_S;
        const big = lines >= 3 && choreo >= 1;
        const liftLead = big ? CLEAR_LIFT_S + CLEAR_HOLD_S : 0;
        // Rank by distance from the placed piece: the sparks thin out down
        // the line and the white flash is dropped past the 8th rank (one
        // visible source), whatever order the tiles pop in.
        const rankOf = (cells: { r: number; c: number }[]) => {
          const sorted = cells
            .map((cell) => ({
              cell,
              d: Math.hypot(
                cellToXY(L, cell.r, cell.c).x + L.cell / 2 - px,
                cellToXY(L, cell.r, cell.c).y + L.cell / 2 - py,
              ),
            }))
            .sort((a, b) => a.d - b.d);
          const rank = new Map<{ r: number; c: number }, number>();
          sorted.forEach(({ cell }, i) => rank.set(cell, i));
          return rank;
        };
        const fire = (
          cell: { r: number; c: number },
          delay: number,
          rank: number,
          axis: 1 | 2,
          pushX: number,
          pushY: number,
          lift: boolean,
        ) => {
          const v = this.cells[cell.r * RULES.cols + cell.c];
          if (!v) return;
          const idx = cell.r * RULES.cols + cell.c;
          // A cell still waiting for its landing takes the tile now; the clear
          // flash owns it from here, so its falling sprite is cancelled.
          this.commitTile(v);
          this.cancelLanding(idx);
          const h = this.heat[idx];
          if (h) {
            // The hot line: saturated, in the tile's own colour; cells lit by
            // both a row and a column this event get the square shape.
            h.tint = hotLineTint(this.tileColorOf(v));
            const core = this.heatCore[idx];
            // White is reserved for 4X: below it the core is the tile colour
            // lightened, so the beam itself is one more rung on the ramp.
            if (core)
              core.tint =
                this.heatTarget >= 0.7
                  ? lerp(h.tint, 0xfff6e8, 0.55)
                  : lerp(h.tint, 0xffffff, HOT_CORE_LIFT);
            this.heatAxis[idx] = this.heatT[idx] === 1 ? 3 : axis;
            this.heatT[idx] = 1;
            // The trace ignites under each tile as it pops (with the sweep,
            // or at the shatter), never the whole line at once; its whiter
            // core is the 3+ clear's — a one- or two-line trace is the
            // coloured pool alone (a full-length core is a hairline).
            this.heatDelay[idx] = delay;
            this.heatCoreOn[idx] = big ? 1 : 0;
            this.heatGain[idx] =
              (lines >= 2 ? HOT_MULTI_K : 1) * (this.heatAxis[idx] === 3 ? HOT_CROSS_K : 1);
          }
          v.anim = 'clear';
          v.t = 0;
          v.age = 0;
          v.delay = Math.max(0.001, delay);
          v.clearColor = v.color;
          v.fractured = false;
          v.dx = Math.random() < 0.5 ? -1 : 1;
          v.dy = rank;
          v.liftK = lift && !this.reducedMotion ? 1 : 0;
          v.pushX = pushX;
          v.pushY = pushY;
          const crossing = e.rows.includes(cell.r) && e.cols.includes(cell.c);
          v.flashColor = lerp(
            this.tileColorOf(v),
            0xffffff,
            choreo === 0
              ? 1
              : crossing
                ? CLEAR_FLASH_WHITE_CROSS
                : lines === 1
                  ? CLEAR_FLASH_WHITE_1
                  : lines === 2
                    ? CLEAR_FLASH_WHITE_2
                    : CLEAR_FLASH_WHITE_BIG,
          );
          v.color = -1;
          this.bleedT[idx] = -Math.max(0.001, this.bleedT[idx] ?? 0); // negative = fading out
        };
        // Each line's sweep: from the edge behind the placed piece toward the
        // far edge (a direction, not a burst from the middle), and when it
        // reaches the meeting point (a crossing, or the piece on parallel lines).
        interface Sweep {
          row: boolean;
          index: number;
          dir: number;
          from: number;
          to: number;
          meetAt: number;
          delay: number;
          hue: number;
        }
        const sweeps: Sweep[] = [];
        const meetX = e.cols[0] !== undefined ? cellToXY(L, 0, e.cols[0]).x + L.cell / 2 : px;
        const meetY = e.rows[0] !== undefined ? cellToXY(L, e.rows[0], 0).y + L.cell / 2 : py;
        for (const r of e.rows) {
          const dir = px < cx0 ? 1 : -1;
          const from = dir > 0 ? L.boardX - L.cell * 0.5 : L.boardX + L.boardSize + L.cell * 0.5;
          const to = dir > 0 ? L.boardX + L.boardSize + L.cell * 0.5 : L.boardX - L.cell * 0.5;
          sweeps.push({
            row: true,
            index: r,
            dir,
            from,
            to,
            meetAt: ((meetX - from) * dir) / speed,
            delay: 0,
            hue: this.lineHue(e.cells, r, -1, sweeps.length ? hueIndexOf(sweeps[0]!.hue) : -1),
          });
        }
        for (const c of e.cols) {
          const dir = py < cy0 ? 1 : -1;
          const from = dir > 0 ? L.boardY - L.cell * 0.5 : L.boardY + L.boardSize + L.cell * 0.5;
          const to = dir > 0 ? L.boardY + L.boardSize + L.cell * 0.5 : L.boardY - L.cell * 0.5;
          sweeps.push({
            row: false,
            index: c,
            dir,
            from,
            to,
            meetAt: ((meetY - from) * dir) / speed,
            delay: 0,
            hue: this.lineHue(e.cells, -1, c, sweeps.length ? hueIndexOf(sweeps[0]!.hue) : -1),
          });
        }
        // Two lines: the sweeps are timed to reach the meeting point together.
        let meetT = 0;
        if (lines === 2 && choreo >= 1) {
          for (const sw of sweeps) meetT = Math.max(meetT, sw.meetAt);
          for (const sw of sweeps) sw.delay = meetT - sw.meetAt;
        }
        for (let si = 0; si < sweeps.length; si++) {
          const sw = sweeps[si]!;
          const cells = sw.row
            ? Array.from({ length: RULES.cols }, (_, c) => ({ r: sw.index, c }))
            : Array.from({ length: RULES.rows }, (_, r) => ({ r, c: sw.index }));
          const rank = rankOf(cells);
          const axis: 1 | 2 = sw.row ? 1 : 2;
          for (const cell of cells) {
            const xy = cellToXY(L, cell.r, cell.c);
            const pos = (sw.row ? xy.x : xy.y) + L.cell / 2;
            const rk = rank.get(cell) ?? 0;
            let delay: number;
            let pushX: number;
            let pushY: number;
            if (big) {
              // Lift, hold, then shatter outward from the placed piece.
              delay = liftLead + rk * CLEAR_POP_STEP_S + si * CLEAR_RANK_SKEW_S;
              pushX = sw.row ? Math.sign(pos - px) : 0;
              pushY = sw.row ? 0 : Math.sign(pos - py);
            } else {
              // Pop as the sweep's light passes; the chunks go with it.
              delay = sw.delay + ((pos - sw.from) * sw.dir) / speed;
              pushX = sw.row ? sw.dir : 0;
              pushY = sw.row ? 0 : sw.dir;
            }
            fire(cell, delay, rk, axis, pushX, pushY, big);
          }
          const lineX = sw.row ? cx0 : cellToXY(L, 0, sw.index).x + L.cell / 2;
          const lineY = sw.row ? cellToXY(L, sw.index, 0).y + L.cell / 2 : cy0;
          this.motes.impulse(lineX, lineY, 90 + 40 * lines, L.boardSize * 0.9);
          const residual = this.lineColor(e.cells, sw.row ? sw.index : -1, sw.row ? -1 : sw.index);
          if (!big) {
            // The directional sweep: one bar of light with a white core in the
            // line's hue, running the whole line at the pop speed.
            const travel = Math.abs(sw.to - sw.from);
            const ttl = travel / speed;
            const len = L.cell * SWEEP_LEN_CELLS;
            // The bar (and its core — the frame is tinted whole) in the line's hue.
            const color = sweepTint(sw.hue);
            this.oneShots.sweep(
              this.tex,
              sw.row ? sw.from : lineX,
              sw.row ? lineY : sw.from,
              sw.row ? sw.to : lineX,
              sw.row ? lineY : sw.to,
              color,
              L.cell * SWEEP_THICK_CELLS,
              ttl,
              len,
              sw.delay,
              lines === 1 ? SWEEP_ALPHA_1 : SWEEP_ALPHA_2,
              true,
            );
          } else if (choreo >= 2) {
            // The light column rising from the line as the tiles shatter.
            this.oneShots.column(
              this.tex,
              lineX,
              lineY,
              L.boardSize,
              L.cell * CLEAR_COLUMN_WIDTH,
              sw.row,
              lerp(hotLineTint(sw.hue), PALETTE.warmWhite, 0.35),
              CLEAR_COLUMN_S,
              e.rows.length > 0 && e.cols.length > 0
                ? CLEAR_COLUMN_ALPHA_CROSS
                : CLEAR_COLUMN_ALPHA / Math.max(1, sw.row ? e.rows.length : e.cols.length),
              L.cell * CLEAR_COLUMN_RISE,
              liftLead,
            );
          }
          this.oneShots.lineGlow(
            this.tex,
            lineX,
            lineY,
            L.boardSize,
            L.cell * 1.6,
            sw.row,
            residual,
            0.5,
            lines >= 2 ? CLEAR_RESIDUAL_MULTI_ALPHA : 0.4,
            // The after-image: once the sweep has crossed the line, or at the shatter.
            big ? liftLead : sw.delay + Math.abs(sw.to - sw.from) / speed,
          );
          // Top-edge highlight: a 1.5 px line of light along the cleared line
          // — under the column of a 3+ clear only (a full-height hairline on
          // a one- or two-line clear is the hoop class).
          if (big)
            this.oneShots.lineHighlight(
              this.tex,
              sw.row ? lineX : lineX - L.cell * 0.5 + 1,
              sw.row ? lineY - L.cell * 0.5 + 1 : lineY,
              L.boardSize,
              sw.row,
              hotLineTint(residual),
              1.0,
              liftLead,
            );
        }
        // Three-plus lines: the banner waits for the shatter, so the lift and
        // the column are the one emphasised element while they run.
        this.bannerHold = big ? liftLead + CLEAR_BANNER_AFTER_S : 0;
        // Two lines: the crossing flare where the two sweeps meet — a soft
        // bloom in the two hues with a held warm-white core (filled, no hoop).
        if (lines === 2 && choreo >= 2 && sweeps.length === 2) {
          const a = sweeps[0]!;
          const b = sweeps[1]!;
          // At the crossing; between two parallel lines, midway, at the piece.
          const lineXOf = (sw: Sweep) => cellToXY(L, 0, sw.index).x + L.cell / 2;
          const lineYOf = (sw: Sweep) => cellToXY(L, sw.index, 0).y + L.cell / 2;
          const fx = a.row && b.row ? px : !a.row && !b.row ? (lineXOf(a) + lineXOf(b)) / 2 : meetX;
          const fy = !a.row && !b.row ? py : a.row && b.row ? (lineYOf(a) + lineYOf(b)) / 2 : meetY;
          const mixHue = lerp(hotLineTint(a.hue), hotLineTint(b.hue), 0.5);
          this.oneShots.puff(
            this.tex,
            fx,
            fy,
            mixHue,
            L.cell * CROSS_FLARE_CELLS,
            CROSS_CORE_HOLD_S + CROSS_CORE_OUT_S + 0.1,
            0.8,
            true,
            meetT,
          );
          this.oneShots.flare(
            this.tex,
            fx,
            fy,
            0xfff6e8,
            L.cell * CROSS_CORE_CELLS,
            CROSS_CORE_HOLD_S,
            CROSS_CORE_OUT_S,
            1.0,
            meetT,
          );
        }
        // No full-frame flash on a clear (round 3: a +40 lum wash over the
        // sky and the trays is the grey the critic saw): the light stays on
        // the line — the bar, the pops, the trace — and only the 4X
        // supernova's leaks and the streak burst reach the room.
        this.background?.kick(0.25 * lines);
        // Escalating set-piece by streak tier (state.streak is the new streak).
        const tier = state.streak;
        this.clearHeat = Math.min(1, Math.max(0, (tier - 1) / 4));
        const heatColor = this.heatColor(this.clearHeat);
        if (tier >= 2) {
          for (const r of e.rows) {
            const y = cellToXY(L, r, 0).y + L.cell / 2;
            const len = L.cell * 3;
            this.oneShots.sweep(
              this.tex,
              px,
              y,
              L.boardX + L.boardSize - len / 2,
              y,
              heatColor,
              L.cell * 1.1,
              0.3,
              len,
              0.08,
            );
            this.oneShots.sweep(
              this.tex,
              px,
              y,
              L.boardX + len / 2,
              y,
              heatColor,
              L.cell * 1.1,
              0.3,
              len,
              0.08,
            );
          }
          for (const c of e.cols) {
            const x = cellToXY(L, 0, c).x + L.cell / 2;
            const len = L.cell * 3;
            this.oneShots.sweep(
              this.tex,
              x,
              py,
              x,
              L.boardY + L.boardSize - len / 2,
              heatColor,
              L.cell * 1.1,
              0.3,
              len,
              0.08,
            );
            this.oneShots.sweep(
              this.tex,
              x,
              py,
              x,
              L.boardY + len / 2,
              heatColor,
              L.cell * 1.1,
              0.3,
              len,
              0.08,
            );
          }
          this.rimPulse = 1;
          // Ribbons: curling light in the line's colour, the streak signature.
          if (this.q.ribbons > 0) {
            for (const r of e.rows) {
              const y = cellToXY(L, r, 0).y + L.cell / 2;
              this.spawnRibbons(px, y, true, this.lineColor(e.cells, r, -1));
            }
            for (const c of e.cols) {
              const x = cellToXY(L, 0, c).x + L.cell / 2;
              this.spawnRibbons(x, py, false, this.lineColor(e.cells, -1, c));
            }
          }
        }
        if (tier === 3) this.worldEvent('streak3', px, py);
        if (tier >= 4) this.worldEvent('streak4', px, py);
        if (tier >= 3) {
          const fx = (px - 0) / this.app.screen.width;
          const fy = py / this.app.screen.height;
          this.post?.shock(fx, fy, 0.35 + 0.15 * Math.min(2, tier - 3));
        }
        if (tier >= 4) {
          this.slowT = 0;
          for (const leak of this.leaks) {
            leak.tint = PALETTE.warmWhite;
            leak.alpha = 0.5 * this.roomLift();
          }
          const r0 = e.rows[0];
          const c0 = e.cols[0];
          const both = r0 !== undefined && c0 !== undefined;
          this.supernova(
            both
              ? px
              : c0 !== undefined
                ? cellToXY(L, 0, c0).x + L.cell / 2
                : L.boardX + L.boardSize / 2,
            both
              ? py
              : r0 !== undefined
                ? cellToXY(L, r0, 0).y + L.cell / 2
                : L.boardY + L.boardSize / 2,
          );
        }
        if (lines >= 2) {
          // The count's own choreography above is the multiline language
          // (the crossing flare, the lift and the column); no rings.
          this.worldEvent('multiline', meetX, meetY);
        }
        break;
      }
      case 'scored': {
        this.targetScore = e.total;
        if (this.q.odometer && e.points >= ODO_SQUASH_MIN) this.odometer.squash();
        const { x, y } = cellToXY(L, e.row, e.col);
        const halfW = L.cell * 2.2;
        let fx = x + L.cell;
        let fy = y + L.cell * 0.5;
        if (e.lines > 0) {
          // The cleared line is empty now: spawn in its centre so no live tile is covered.
          const r0 = this.lastClear.rows[0];
          const c0 = this.lastClear.cols[0];
          fx = c0 !== undefined ? cellToXY(L, 0, c0).x + L.cell / 2 : L.boardX + L.boardSize / 2;
          fy = r0 !== undefined ? cellToXY(L, r0, 0).y + L.cell / 2 : L.boardY + L.boardSize / 2;
        }
        fx = Math.max(L.boardX + halfW, Math.min(L.boardX + L.boardSize - halfW, fx));
        fy = Math.max(L.boardY + L.cell * 0.6, Math.min(L.boardY + L.boardSize - L.cell, fy));
        const bannerComing = e.streak >= 2 || e.multiplier > 1;
        if (bannerComing) {
          // The banner owns the board's centre band for its sweep-in; the float
          // waits it out and spawns above the band — 2.2 cells up, or more on
          // a phone, where the letters and the float are big against the cells.
          const scale = e.lines >= 3 || e.streak >= 3 ? 1.3 : 1;
          const clear = L.boardSize * 0.11 * 0.6 + 40 * scale * 0.75 + 8;
          fy = Math.min(fy, L.boardY + L.boardSize / 2 - Math.max(L.cell * 2.2, clear));
        }
        const floatDelay = bannerComing ? 0.22 : 0;
        if (e.lines === 0) {
          this.floatText.show(fx, fy, `+${e.points}`, PALETTE.textDim, 0.55, 0.7);
        } else {
          const big = e.lines >= 3 || e.streak >= 3;
          this.floatText.show(
            fx,
            fy - L.cell * 0.15,
            `+${e.points}`,
            big ? PALETTE.accentWarm : PALETTE.accent,
            big ? 1.3 : e.lines === 1 ? 0.6 : 1,
            1.2,
            floatDelay,
            e.streak >= 2 ? FLOAT_IMPACT_S : 0,
          );
          const tags: string[] = [];
          if (e.multiplier > 1 && e.streak < 2)
            this.showBanner(`${e.multiplier}X MULTILINE`, 0, PALETTE.accent);
          if (tags.length > 0)
            this.floatText.show(
              fx,
              Math.max(L.boardY + L.cell * 0.6, fy - L.cell * 1.6),
              tags.join('  ·  '),
              PALETTE.text,
              0.8,
              1.3,
            );
        }
        if (e.streak >= 2) {
          this.showStreak(`${e.streak}X STREAK`);
          this.showBanner(`${e.streak}X STREAK`, e.streak);
          this.heatTarget = Math.min(1, (e.streak - 1) / 4);
          // The band replaces the chase dot everywhere but the low tier.
          if (e.streak >= 3 && this.q.rimBand === 0) this.rimChase = 0;
          if (this.q.burstShards > 0) {
            // The burst rides the banner's leading edge; a held banner brings it along.
            this.burstPending = this.bannerPending ? -1 : 0;
            this.burstStreak = e.streak;
          }
        } else if (e.lines === 0) {
          this.hideStreak();
          this.heatTarget = 0;
        }
        break;
      }
      case 'levelUp':
        // Right after `scored`, once per placement even across several levels.
        this.levelTarget = e.level;
        this.onLevelUp(e.level);
        break;
      case 'streakBroken':
        this.hideStreak();
        this.heatTarget = 0;
        break;
      case 'ended':
        this.targetScore = e.breakdown.total;
        // The score is final: the odometer snaps to it (a count changing
        // three times through the dilation reads as three scores).
        this.displayedScore = this.targetScore;
        this.scoreText.text = String(this.targetScore);
        if (this.q.odometer) this.odometer.reset(this.targetScore);
        this.bannerPending = null;
        this.bannerHold = 0;
        this.worldFrozen = true;
        this.hideStreak();
        this.heatTarget = 0;
        // A level-up still waiting for the band snaps its number in; the
        // results own the board from here.
        for (const lv of this.levelQueue) this.levelPill.setLevel(lv, this.q.odometer);
        this.levelQueue.length = 0;
        this.levelBurstPending = -1;
        this.lockInput(true);
        break;
    }
    void state;
  };

  /**
   * A level-up joins the ceremony queue. The board's centre band belongs to
   * whichever banner is up: if a streak banner is sweeping (it fires first,
   * from the same placement), the LEVEL banner waits 400 ms after it; the
   * whole ceremony — pill roll and pop, banner, burst, rim pulse, sweep —
   * fires as one beat when its turn comes.
   */
  private onLevelUp(level: number): void {
    this.levelQueue.push(level);
    if (this.levelQueue.length === 1) this.levelDelay = this.bannerWait();
  }

  /** Seconds until the centre band is free: nothing, or the rest of the banner up (or waiting) plus the gap. */
  private bannerWait(): number {
    if (this.bannerPending) return this.bannerPending.wait + LEVEL_BANNER_S + LEVEL_QUEUE_GAP_S;
    return this.bannerT >= 0 ? Math.max(0, LEVEL_BANNER_S - this.bannerT) + LEVEL_QUEUE_GAP_S : 0;
  }

  /**
   * The level-up ceremony (docs/art-direction.md "Levels"): its own COOL
   * language, indigo → mint, never the streaks' heat, and no rings (round 21).
   * The pill rolls and pops with a mint glow (deferred while the streak pill
   * holds the row); "LEVEL N" slams in on the banner; when the banner's
   * leading edge crosses the centre the motes are pushed from the pill; the rim band
   * takes a FILLED cool pulse — the whole band brightening indigo → mint for
   * 300 ms with one packet travelling the perimeter — and a vertical sheen
   * crosses the tiles in the cool tint (≤ 0.22). Every fifth level: cool god
   * rays from the banner's centre for 0.5 s that light sockets, rim and room
   * only (the tiles are masked), and the world's `levelUp` trigger. No
   * whole-scene motion, no shake, no whiteout.
   */
  private levelCeremony(level: number): void {
    const fx = this.q.levelFx;
    this.levelPill.setLevel(level, this.q.odometer);
    this.levelPill.pop();
    if (fx === 0) return;
    this.showBanner(`LEVEL ${level}`, 0, LEVEL_BANNER_COLOR);
    if (fx < 2) return;
    this.levelBurstPending = 0;
    this.levelBurstLevel = level;
    const beat = level % LEVEL_BEAT_EVERY === 0;
    if (this.q.rimBand > 0) {
      this.levelRimT = 0;
      this.levelRimT2 = -1;
      this.levelRim2Due = beat ? LEVEL_BEAT_RIM2_S : -1;
      this.levelRimBeat = beat;
    }
    if (this.q.tileSheen)
      this.tileGlow.sweep(LEVEL_SHEEN_COLOR, true, LEVEL_SHEEN_PEAK * (beat ? 2 : 1));
    if (beat) {
      // Unmistakable: the banner at 1.25x with a 120 ms overshoot, a second
      // rim pulse 200 ms behind the first, the sheen at twice the peak, rays
      // 1.5x longer (still masked off the tiles).
      this.bannerBoost = LEVEL_BEAT_BANNER;
      const L = this.layout;
      const cx = L.boardX + L.boardSize / 2;
      const cy = L.boardY + L.boardSize / 2;
      if (this.q.godRays && this.post) {
        this.post.rays(
          cx / this.app.screen.width,
          cy / this.app.screen.height,
          0.5,
          [0.55, 0.62, 1.0],
          LEVEL_RAYS_S,
          true,
        );
        this.post.setRayTiles(this.cellTiled); // the first frame, masked too
      }
      this.worldEvent('levelUp', cx, cy);
    }
  }

  /**
   * The level burst, on the banner's leading edge: a mote impulse from the
   * pill and a touch of flash. No shards (round 22): anything launched from
   * a HUD pill is born above the plate mask and reads as hairlines by the
   * time it is on the board — the rim pulse and the sheen are the light.
   */
  private levelBurst(): void {
    const L = this.layout;
    const px = this.levelPill.container.x;
    const py = this.levelPill.container.y + this.levelPill.height / 2;
    const beat = this.levelBurstLevel % LEVEL_BEAT_EVERY === 0;
    this.motes.impulse(px, py, beat ? 420 : 300, L.boardSize * 0.9);
    this.post?.kick(beat ? 0.05 : 0.03);
  }

  /**
   * A sim milestone reaches the world (docs/worlds.md, Events): the manifest
   * maps it to `lanterns` (an emissive layer, handled in world.ts), `sunburst`
   * (the sun flares; the supernova's rays take its colour) or `gust` (the
   * world's particles blown away from the cleared line at 6x for 1.2 s).
   */
  private worldEvent(kind: WorldTrigger, x: number, y: number): void {
    const ev = this.worldScene.trigger(kind);
    if (ev) this.onCue?.(ev);
    if (ev === 'gust')
      this.motes.gust(
        x,
        y,
        Math.max(this.app.screen.width, this.app.screen.height),
        this.layout.cell * 1.5,
      );
  }

  private lineColor(
    cells: readonly { r: number; c: number; color: number }[],
    r: number,
    c: number,
  ): number {
    // Average the line's colours for the residual glow; white if mixed too much.
    let first = -2;
    let uniform = true;
    for (const cell of cells) {
      if (cell.r !== r && cell.c !== c) continue;
      if (first === -2) first = cell.color;
      else if (cell.color !== first) uniform = false;
    }
    return uniform && first >= 0 ? pieceColor(first) : 0xdfe6ff;
  }

  /**
   * The line's own hue for its sweep: its most common tile colour (a mixed
   * line keeps a hue, never white). With `avoid` (another line's hue, on a
   * two-line clear) it takes the line's most common OTHER colour when it
   * has one, so the two sweeps are two tones even when both lines are
   * mostly the same colour.
   */
  private lineHue(
    cells: readonly { r: number; c: number; color: number }[],
    r: number,
    c: number,
    avoid = -1,
  ): number {
    const counts = new Map<number, number>();
    for (const cell of cells) {
      if (cell.r !== r && cell.c !== c) continue;
      if (cell.color < 0) continue;
      counts.set(cell.color, (counts.get(cell.color) ?? 0) + 1);
    }
    let best = -1;
    let bestN = 0;
    for (const [color, n] of counts) {
      if (color === avoid) continue;
      if (n > bestN) {
        bestN = n;
        best = color;
      }
    }
    if (best < 0 && avoid >= 0 && counts.has(avoid)) best = avoid;
    return best >= 0 ? pieceColor(best) : 0xdfe6ff;
  }

  private showStreak(text: string): void {
    this.streakText.set(text);
    const w = this.streakText.width + 28;
    const h = this.streakText.height + 8;
    this.streakBg
      .clear()
      .roundRect(-w / 2, -h / 2, w, h, h / 2)
      .fill({ color: PALETTE.accentWarm, alpha: 0.16 })
      .stroke({
        color: lerp(PALETTE.accentWarm, 0xffffff, PILL_STROKE_FLASH_MIX),
        width: 1.5,
        alpha: 0.95,
      });
    if (!this.streakPill.visible) {
      this.streakShownAt = this.timeSec;
      this.pressureRing.reset(this.pressure);
    }
    this.streakPill.visible = true;
    this.streakPulse = 1;
    this.streakStrokeFlash = 1;
    if (w !== this.streakW || h !== this.streakH) this.pressureRing.layout(w, h);
    this.streakW = w;
    this.streakH = h;
  }

  /** Indigo → amber → white-hot. */
  private heatColor(h: number): number {
    if (h <= 0.6) return lerp(PALETTE.plateRim, PALETTE.accentWarm, h / 0.6);
    return lerp(PALETTE.accentWarm, 0xfff3d6, (h - 0.6) / 0.4);
  }

  private rimPulse = 0;

  /** Seconds a banner asked for now must wait (a 3+ clear's lift and shatter own the board first). */
  private bannerHold = 0;
  private bannerPending: { text: string; streak: number; color?: number; wait: number } | null =
    null;

  private showBanner(text: string, streak: number, color?: number): void {
    if (this.bannerHold > 0) {
      this.bannerPending = {
        text,
        streak,
        wait: this.bannerHold,
        ...(color !== undefined ? { color } : {}),
      };
      return;
    }
    this.levelBannerUp = false;
    this.bannerBoost = 1;
    this.bannerText.text = text;
    this.bannerColor = color ?? this.heatColor(Math.min(1, (streak - 1) / 4));
    this.bannerFill.tint = this.bannerColor;
    this.bannerEdge.tint = 0xffffff;
    this.bannerText.style.dropShadow = {
      alpha: 0.9,
      blur: 22,
      color: this.bannerColor,
      distance: 0,
      angle: Math.PI / 2,
    };
    this.bannerT = 0;
    this.bannerBand.visible = true;
    if (this.q.bannerLetters) {
      // Per-letter slam; the whole-word Text stays hidden and only carries the group transform.
      this.bannerText.visible = false;
      this.letterBanner.show(text, this.bannerColor);
      this.letterBanner.update(0);
      this.letterBanner.container.alpha = 1;
      this.letterBanner.container.scale.set(1);
      this.letterBanner.container.y = this.bannerText.y;
    } else {
      this.letterBanner.hide();
      this.bannerText.visible = true;
    }
  }

  private hideStreak(): void {
    this.streakPill.visible = false;
    this.streakText.set('');
  }

  /**
   * One ribbon per cleared line: it leaves from the placed piece with the
   * sweep, runs outward along the line toward the far edge, curls at most
   * 1.2 cells off the line's band and is off the plate within 300 ms.
   */
  private spawnRibbons(px: number, py: number, row: boolean, color: number): void {
    const L = this.layout;
    const cx = L.boardX + L.boardSize / 2;
    const cy = L.boardY + L.boardSize / 2;
    // Toward the farther edge, so there is room to travel; curl toward the
    // board's middle across the line so it never leaves the band far.
    const dir = row ? (px < cx ? 1 : -1) : py < cy ? 1 : -1;
    const bend = row ? (py < cy ? 1 : -1) : px < cx ? 1 : -1;
    const edge = row
      ? dir > 0
        ? L.boardX + L.boardSize - px
        : px - L.boardX
      : dir > 0
        ? L.boardY + L.boardSize - py
        : py - L.boardY;
    const reach = edge + L.cell * 0.9; // ends just past the plate (the mask takes it)
    const curl = L.cell * 1.2;
    const a1 = reach * 0.45 * dir;
    const a2 = reach * 0.85 * dir;
    const a3 = reach * dir;
    const b1 = curl * 0.15 * bend;
    const b2 = curl * 0.7 * bend;
    const b3 = curl * bend;
    if (row) {
      this.ribbons.spawn(
        px,
        py,
        px + a1,
        py + b1,
        px + a2,
        py + b2,
        px + a3,
        py + b3,
        color,
        L.cell * 0.55,
        RIBBON_S,
        0.02,
      );
    } else {
      this.ribbons.spawn(
        px,
        py,
        px + b1,
        py + a1,
        px + b2,
        py + a2,
        px + b3,
        py + a3,
        color,
        L.cell * 0.55,
        RIBBON_S,
        0.02,
      );
    }
  }

  /**
   * Streak-increment burst, on the banner's leading edge, drawn under the
   * banner strip and the tiles. Three distinct sizes:
   *   2X  one hairline ring (0.9x board, 380 ms), 6 shards, a centre flare
   *   3X  that ring, a second one 120 ms later, 10 shards, a rim pulse
   *   4X  14 shards and the flare only — rays, rim, leaks and the sheen
   *       (the supernova) are the 4X language, so no rings.
   * Shard counts scale with the tier's `burstShards` (the 4X count).
   */
  private streakBurst(): void {
    const L = this.layout;
    const cx = L.boardX + L.boardSize / 2;
    const cy = L.boardY + L.boardSize / 2;
    const color = this.bannerColor;
    const streak = this.burstStreak;
    const max = this.q.burstShards;
    const n = streak >= 4 ? max : Math.ceil((max * (streak >= 3 ? 10 : 6)) / 14);
    this.burstParticles.shards(cx, cy, color, n, L.boardSize * 1.2, L.cell / this.tex.size);
    const flare = L.cell * (streak >= 3 ? 2.0 : 1.6);
    this.burstFx.puff(this.tex, cx, cy, 0xffffff, flare, BURST_FLARE_S, 1.0);
    if (streak < 4) {
      const ring = L.boardSize * 0.9;
      this.burstFx.ring(this.tex, cx, cy, 0xffffff, L.cell * 0.6, ring, BURST_RING_S, 1.0, 1);
      if (streak >= 3) {
        // Second ring: heat colour, 3 px, 120 ms behind.
        this.burstFx.ring(this.tex, cx, cy, color, L.cell * 0.6, ring, BURST_RING_S, 0.9, 2, 0.12);
        this.rimPulse = Math.max(this.rimPulse, 1);
      }
    } else {
      this.rimPulse = Math.max(this.rimPulse, 1.4);
    }
    this.post?.kick(0.05 + 0.04 * this.heatTarget);
  }

  /**
   * 4X supernova: god rays from the cleared line's centre (masked off the
   * tile faces), the rim band flares (with the light leaks), every tile
   * lifts toward white by at most 0.55 and settles over 250 ms, a sheen
   * crosses the tiles, motes are blown outward. No plate wash, no shards,
   * no rain: the tiles stay readable.
   */
  private supernova(x: number, y: number): void {
    const L = this.layout;
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    // The rays take the sun's colour when the world's 4X event is the sunburst.
    const sunlit =
      this.worldScene.isLoaded && this.worldScene.manifest?.events.streak4 === 'sunburst';
    // The rays light the sockets, the rim and the room — never the tile
    // faces (the tile mask, as the level rays): a resting tile's lift is the
    // nova and the sheen alone, capped at 0.55 toward white. Unmasked, the
    // beams near the source took resting tiles to 248 (round 53).
    if (this.q.godRays && this.post) {
      this.post.rays(
        x / w,
        y / h,
        0.8,
        sunlit ? this.worldScene.sunColour : undefined,
        undefined,
        true,
      );
      // Feed the mask now: the per-frame feed runs before the event, so the
      // rays' first frame would cross the tiles unmasked.
      this.post.setRayTiles(this.cellTiled);
    }
    // Eye adaptation: the exposure dips after the flash and recovers over ~1 s.
    this.post?.adapt();
    this.rimPulse = Math.max(this.rimPulse, 1.3);
    this.tileGlow.flash();
    if (this.q.tileSheen) this.tileGlow.sweep();
    this.motes.impulse(
      L.boardX + L.boardSize / 2,
      L.boardY + L.boardSize / 2,
      560,
      Math.max(w, h) * 0.8,
    );
  }

  /** Bring visuals in line with state without animation (initial mount / resume). */
  private syncBoardFromState(state: GameState): void {
    for (let i = 0; i < state.grid.length; i++) {
      const v = this.cells[i];
      const color = state.grid[i] ?? -1;
      if (!v) continue;
      v.color = color;
      v.anim = 'none';
      v.sprite.texture = color >= 0 ? (this.tex.tiles[color] ?? this.tex.socket) : this.tex.socket;
      v.sprite.tint = 0xffffff;
      v.sprite.alpha = 1;
      v.sprite.rotation = 0;
      v.sprite.scale.set(this.layout.cell / this.tex.size);
    }
    this.displayedScore = this.targetScore = state.score;
    this.scoreText.text = String(state.score);
    this.odometer.reset(state.score);
    this.levelTarget = state.level;
    this.levelQueue.length = 0;
    this.levelPill.setLevel(this.levelTarget, false);
  }

  // ---------------------------------------------------------------------------
  // Input

  private beginDrag(slot: number, e: FederatedPointerEvent): void {
    const s = this.slots[slot];
    if (!s) return;
    this.beginDragAt(slot, s.root.toLocal(e.global), e.global.x, e.global.y);
  }

  private beginDragAt(slot: number, local: { x: number; y: number }, gx: number, gy: number): void {
    if (
      this.inputLocked ||
      this.drag ||
      this.returning ||
      this.recoil ||
      this.controller.current.status !== 'playing'
    )
      return;
    const s = this.slots[slot];
    if (!s || !s.piece) return;
    const L = this.layout;
    const pitch = L.handCell * 1.08 * s.fit;
    const relX = (local.x - s.originX) / pitch;
    const relY = (local.y - s.originY) / pitch;
    const boardPitch = L.cell + L.gap;
    this.drag = {
      slot,
      relX,
      relY,
      target: null,
      legal: false,
      lastLegal: null,
      grabT: 0,
      shakeT: 0,
      wasLegal: true,
      x: gx - relX * boardPitch,
      y: gy - relY * boardPitch - L.dragLift,
      gpx: relX * boardPitch,
      gpy: relY * boardPitch,
      lastX: gx - relX * boardPitch,
      lastY: gy - relY * boardPitch - L.dragLift,
      vx: 0,
      vy: 0,
      tilt: 0,
      magX: 0,
      magY: 0,
      lockT: -1,
    };
    s.root.visible = false;
    s.hover = 0;

    const o = orientation(s.piece.shape, s.piece.rotation);
    const tile = this.tex.tiles[s.piece.color] ?? this.tex.tiles[0]!;
    for (let i = 0; i < this.dragSprites.length; i++) {
      const sp = this.dragSprites[i];
      const cell = o.cells[i];
      if (!sp) continue;
      sp.visible = cell !== undefined;
      if (cell) {
        sp.texture = tile;
        sp.position.set(cell.c * boardPitch + L.cell / 2, cell.r * boardPitch + L.cell / 2);
      }
      // The trail smears sit at the drag layout's cell centres, tinted like the piece.
      for (const ghost of this.trailGhosts) {
        const gs = ghost.children[i];
        if (!(gs instanceof Sprite)) continue;
        gs.visible = sp.visible;
        gs.tint = shade(pieceColor(s.piece.color), 0.35);
        gs.position.copyFrom(sp.position);
      }
    }
    for (const ghost of this.trailGhosts) {
      ghost.pivot.set(this.drag.gpx, this.drag.gpy);
      ghost.visible = false;
    }
    this.trailCount = 0;
    this.trailCollapseT = -1;
    this.dragLayer.pivot.set(this.drag.gpx, this.drag.gpy);
    this.dragLayer.rotation = 0;
    this.dragLayer.visible = true;
    this.dragLayer.alpha = 1;
    this.dragShadow.alpha = 0.7;
    this.dragShadow.scale.set(
      ((o.cols + 0.9) * L.cell + 24) / 256,
      ((o.rows + 0.9) * L.cell + 24) / 256,
    );
    this.footprintN = 0;
    for (const cell of o.cells) {
      this.footprint[this.footprintN * 2] = cell.c * boardPitch + L.cell / 2;
      this.footprint[this.footprintN * 2 + 1] = cell.r * boardPitch + L.cell / 2;
      this.footprintN++;
    }
    if (this.q.contactShadow) {
      // The shape-true shadow replaces the bounding-box one.
      this.dragShadow.alpha = 0;
      this.pieceShadow.setShape(
        o.cells.map((cell) => ({
          x: cell.c * boardPitch + L.cell / 2,
          y: cell.r * boardPitch + L.cell / 2,
        })),
        L.cell,
      );
    }
    this.lightColor = lerp(pieceColor(s.piece.color), 0xffffff, PIECE_LIGHT_WHITE);
    this.updateDrag(gx, gy);
  }

  private onPointerMove = (e: FederatedPointerEvent): void => {
    // The camera looks toward a fine pointer; touch looks with the tilt sensor.
    if (!this.coarse)
      this.camera.pointer(e.global.x, e.global.y, this.app.screen.width, this.app.screen.height);
    if (!this.drag) return;
    this.updateDrag(e.global.x, e.global.y);
  };

  private onPointerUp = (): void => {
    if (!this.drag) return;
    this.endDrag(true);
  };

  private updateDrag(px: number, py: number): void {
    const d = this.drag;
    if (!d) return;
    const s = this.slots[d.slot];
    if (!s || !s.piece) return;
    const L = this.layout;
    const pitch = L.cell + L.gap;
    const topLeftX = px - d.relX * pitch;
    const topLeftY = py - d.relY * pitch - L.dragLift;
    d.x = topLeftX;
    d.y = topLeftY;
    this.applyDragTransform(d);
    const o = orientation(s.piece.shape, s.piece.rotation);
    const liftK = Math.min(1, L.dragLift / (L.cell * 2.2));
    this.dragShadow.position.set(
      topLeftX + (o.cols * pitch) / 2 + 8 + 2 * liftK,
      topLeftY + (o.rows * pitch) / 2 + 20 + 8 * liftK,
    );

    // The piece follows the pointer freely, but the drop target is clamped to
    // the board whenever the PIECE is over it — judged by the footprint's
    // centre with half a cell of slack, not by the finger: a piece held by its
    // left cell and dropped on the right edge (or held low and dropped on the
    // bottom row) sits visibly on the board while the finger is outside the
    // rect, and that drop used to be refused. Edge placements need no pixel
    // precision either way: r/c are clamped into the board below.
    const cx = topLeftX + (o.cols * pitch) / 2;
    const cy = topLeftY + (o.rows * pitch) / 2;
    const slack = pitch / 2;
    const overBoard =
      cx >= L.boardX - slack &&
      cx <= L.boardX + L.boardSize + slack &&
      cy >= L.boardY - slack &&
      cy <= L.boardY + L.boardSize + slack;
    let target: { r: number; c: number } | null = null;
    if (overBoard) {
      const r = Math.round((topLeftY - L.boardY) / pitch);
      const c = Math.round((topLeftX - L.boardX) / pitch);
      target = {
        r: Math.max(0, Math.min(RULES.rows - o.rows, r)),
        c: Math.max(0, Math.min(RULES.cols - o.cols, c)),
      };
    }
    d.target = target;
    const legal = target !== null && this.controller.canPlace(d.slot, target.r, target.c);
    // The holo ghost locks in the moment the placement becomes legal.
    if (legal && !d.legal) d.lockT = 0;
    if (target && !legal && d.wasLegal) d.shakeT = 0.1;
    d.wasLegal = legal || target === null;
    d.legal = legal;
    if (legal && target) {
      // The ghost entered a (different) legal cell: the tick.
      if (!d.lastLegal || d.lastLegal.r !== target.r || d.lastLegal.c !== target.c)
        this.onCue?.('cell-tick');
      d.lastLegal = { r: target.r, c: target.c, x: d.x, y: d.y };
    }
    this.showGhost(d.slot, target, legal);
  }

  private showGhost(slot: number, target: { r: number; c: number } | null, legal: boolean): void {
    if (this.q.holoGhost) {
      this.showHoloGhost(slot, target, legal);
      return;
    }
    const s = this.slots[slot];
    for (const h of this.lineHints) h.visible = false;
    this.previewOutline.visible = false;
    if (!s || !s.piece || !target) {
      for (const g of this.ghostFill) g.visible = false;
      for (const g of this.ghostOutline) g.visible = false;
      return;
    }
    const o = orientation(s.piece.shape, s.piece.rotation);
    const L = this.layout;
    const color = legal ? pieceColor(s.piece.color) : PALETTE.danger;
    for (let i = 0; i < this.ghostFill.length; i++) {
      const f = this.ghostFill[i];
      const g = this.ghostOutline[i];
      const cell = o.cells[i];
      if (!f || !g) continue;
      if (!cell) {
        f.visible = g.visible = false;
        continue;
      }
      const r = target.r + cell.r;
      const c = target.c + cell.c;
      const inside = r >= 0 && c >= 0 && r < RULES.rows && c < RULES.cols;
      f.visible = g.visible = inside;
      if (inside) {
        const { x, y } = cellToXY(L, r, c);
        f.position.set(x + L.cell / 2, y + L.cell / 2);
        g.position.set(x + L.cell / 2, y + L.cell / 2);
        f.tint = g.tint = color;
        f.alpha = legal ? 0.28 : 0.16;
        f.blendMode = 'add';
        g.alpha = legal ? 0.9 : 0.8;
      }
    }
    if (legal) {
      const { rows, cols } = this.controller.previewLines(slot, target.r, target.c);
      let k = 0;
      this.previewOutline.clear();
      for (const r of rows) {
        const h = this.lineHints[k++];
        if (!h) break;
        const { y } = cellToXY(L, r, 0);
        h.visible = true;
        h.tint = 0xffffff;
        h.alpha = 0.1;
        h.position.set(L.boardX + L.boardSize / 2, y + L.cell / 2);
        h.scale.set(L.boardSize / this.tex.size, L.cell / this.tex.size);
        this.previewOutline
          .roundRect(L.boardX - 3, y - 3, L.boardSize + 6, L.cell + 6, L.cell * 0.2)
          .stroke({ color, width: 2, alpha: 0.85 });
      }
      for (const c of cols) {
        const h = this.lineHints[k++];
        if (!h) break;
        const { x } = cellToXY(L, 0, c);
        h.visible = true;
        h.tint = 0xffffff;
        h.alpha = 0.1;
        h.position.set(x + L.cell / 2, L.boardY + L.boardSize / 2);
        h.scale.set(L.cell / this.tex.size, L.boardSize / this.tex.size);
        this.previewOutline
          .roundRect(x - 3, L.boardY - 3, L.cell + 6, L.boardSize + 6, L.cell * 0.2)
          .stroke({ color, width: 2, alpha: 0.85 });
      }
      this.previewOutline.visible = rows.length + cols.length > 0;
    } else {
      this.previewOutline.visible = false;
    }
  }

  /**
   * The holographic preview: the piece's footprint as a scanned projection in
   * its colour (edge glow, scanlines, a sweep on a 1.1 s loop, a lock-in
   * flash), every line it would complete as a whole-line frame in the same
   * language, and — per frame, in updateBeam — the cone from the piece down
   * to the sockets. Illegal: rose, dimmer, no sweep. Same rules as the
   * sprite ghost: shown only over the board, lines only when legal.
   */
  private showHoloGhost(
    slot: number,
    target: { r: number; c: number } | null,
    legal: boolean,
  ): void {
    const s = this.slots[slot];
    for (const hl of this.holoLines) hl.hide();
    if (!s || !s.piece || !target) {
      this.holoGhost.hide();
      this.beam.hide();
      return;
    }
    const o = orientation(s.piece.shape, s.piece.rotation);
    const L = this.layout;
    const color = legal ? ghostTint(pieceColor(s.piece.color)) : PALETTE.danger;
    let mask = 0;
    for (const cell of o.cells) mask |= 1 << (cell.r * o.cols + cell.c);
    const tl = cellToXY(L, target.r, target.c);
    const pitch = L.cell + L.gap;
    const edge = Math.max(GHOST_EDGE_MIN_PX, L.cell * GHOST_EDGE_CELLS);
    const scan = Math.max(GHOST_SCAN_MIN_PX, L.cell * GHOST_SCAN_CELLS);
    this.holoGhost.show(
      tl.x,
      tl.y,
      o.cols,
      o.rows,
      mask,
      L.cell,
      L.cell,
      pitch,
      color,
      legal ? 1 : 0.55,
      edge,
      scan,
      1,
      legal ? 1 : 0,
    );
    if (!legal) return;
    const { rows, cols } = this.controller.previewLines(slot, target.r, target.c);
    let k = 0;
    for (const r of rows) {
      const hl = this.holoLines[k++];
      if (!hl) break;
      const { y } = cellToXY(L, r, 0);
      hl.show(
        L.boardX - 3,
        y - 3,
        1,
        1,
        1,
        L.boardSize + 6,
        L.cell + 6,
        pitch,
        color,
        GHOST_LINE_ALPHA,
        edge,
        scan,
        0.5,
        0.7,
      );
    }
    for (const c of cols) {
      const hl = this.holoLines[k++];
      if (!hl) break;
      const { x } = cellToXY(L, 0, c);
      hl.show(
        x - 3,
        L.boardY - 3,
        1,
        1,
        1,
        L.cell + 6,
        L.boardSize + 6,
        pitch,
        color,
        GHOST_LINE_ALPHA,
        edge,
        scan,
        0.5,
        0.7,
      );
    }
  }

  /**
   * The projection beam: four quads lofted from the dragged piece's footprint
   * (the drag layer's transform applied by hand, so nothing is allocated) down
   * to the target sockets, in the ghost's colour and state.
   */
  private updateBeam(d: DragState, flash: number): void {
    const s = this.slots[d.slot];
    if (this.q.ghostBeam <= 0 || !d.target || !s || !s.piece) {
      this.beam.hide();
      return;
    }
    const L = this.layout;
    const o = orientation(s.piece.shape, s.piece.rotation);
    const pitch = L.cell + L.gap;
    const w = o.cols * pitch - L.gap;
    const h = o.rows * pitch - L.gap;
    // The piece's footprint corners with the drag layer's live transform
    // applied by hand (no allocation); the column spans their x extent.
    const sc = this.dragLayer.scale.x;
    const cos = Math.cos(this.dragLayer.rotation);
    const sin = Math.sin(this.dragLayer.rotation);
    const px = this.dragLayer.x;
    const py = this.dragLayer.y;
    const pvx = this.dragLayer.pivot.x;
    const pvy = this.dragLayer.pivot.y;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    for (let i = 0; i < 4; i++) {
      const lx = ((i === 1 || i === 2 ? w : 0) - pvx) * sc;
      const ly = ((i >= 2 ? h : 0) - pvy) * sc;
      const x = px + lx * cos - ly * sin;
      const y = py + lx * sin + ly * cos;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
    }
    const feather = L.cell * GHOST_BEAM_FEATHER;
    const plateBottom = L.boardY + L.boardSize + L.gap * 3 - 1.5 + this.table.y;
    const color = d.legal ? ghostTint(pieceColor(s.piece.color)) : PALETTE.danger;
    this.beam.show(
      x0 - feather,
      y0 + L.cell * 0.3,
      x1 + feather,
      plateBottom,
      feather,
      L.cell * 0.5,
      color,
      this.q.ghostBeam * (d.legal ? 1 : 0.5),
      this.timeSec,
      flash,
    );
  }

  private endDrag(drop: boolean): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    for (const g of this.ghostFill) g.visible = false;
    for (const g of this.ghostOutline) g.visible = false;
    for (const h of this.lineHints) h.visible = false;
    this.previewOutline.visible = false;
    this.holoGhost.hide();
    for (const hl of this.holoLines) hl.hide();
    this.beam.hide();
    this.ghostLayer.x = 0;
    this.dragShadow.alpha = 0;
    this.pieceShadow.hide();
    this.landLift = this.dragLiftK(d);
    const s = this.slots[d.slot];
    // Read the piece before place(): the event handler empties the slot.
    const piece = s?.piece ?? null;
    let placed = false;
    if (drop && !(d.legal && d.target) && d.lastLegal) {
      // Lift-off jitter: the finger's last move nudged the target off a
      // placement the player had lined up. Within ¾ of a cell, it still lands.
      const pitch = this.layout.cell + this.layout.gap;
      const ll = d.lastLegal;
      if (Math.hypot(d.x - ll.x, d.y - ll.y) <= pitch * 0.75) {
        d.target = { r: ll.r, c: ll.c };
        d.legal = this.controller.canPlace(d.slot, ll.r, ll.c);
      }
    }
    if (drop && d.legal && d.target) {
      placed = this.controller.place(d.slot, d.target.r, d.target.c) === null;
    }
    if (placed && d.target && piece) {
      // The piece falls from where it was released onto the board cells.
      this.dragLayer.visible = false;
      this.beginLanding(d, d.target, piece);
      return;
    }
    if (!s || !piece) {
      this.dragLayer.visible = false;
      this.collapseTrail(this.dragLayer.x, this.dragLayer.y, this.dragLayer.scale.x);
      return;
    }
    this.collapseTrail(this.dragLayer.x, this.dragLayer.y, this.dragLayer.scale.x);
    // Rejected over the board: bounce off the blocking cell, which flashes rose.
    const target = d.target;
    const block = drop && target && !d.legal ? this.blockingCell(piece, target) : null;
    if (block && target) {
      // Away from the blocking cell, measured in cells from the footprint
      // centre; a piece blocked dead-centre bounces straight up.
      const o = orientation(piece.shape, piece.rotation);
      const dx = target.c + (o.cols - 1) / 2 - block.c;
      const dy = target.r + (o.rows - 1) / 2 - block.r;
      const len = Math.hypot(dx, dy);
      this.recoil = {
        slot: d.slot,
        t: 0,
        fromX: this.dragLayer.x,
        fromY: this.dragLayer.y,
        dirX: len > 0.01 ? dx / len : 0,
        dirY: len > 0.01 ? dy / len : -1,
      };
      block.cell.flash = BLOCK_FLASH_S;
      this.blockFlash.position.set(block.x, block.y);
      this.blockFlash.visible = true;
    } else {
      // Missed the board: straight into the return tween.
      this.beginReturn(d.slot);
    }
    this.onRejected?.();
  }

  /** The occupied cell under the piece nearest its centre — what a rejected drop bounced off. */
  private blockingCell(
    piece: Piece,
    target: { r: number; c: number },
  ): { cell: CellVis; x: number; y: number; r: number; c: number } | null {
    const o = orientation(piece.shape, piece.rotation);
    const grid = this.controller.current.grid;
    let best: { cell: CellVis; x: number; y: number; r: number; c: number } | null = null;
    let bestD = Infinity;
    for (const cell of o.cells) {
      const r = target.r + cell.r;
      const c = target.c + cell.c;
      if (r < 0 || c < 0 || r >= RULES.rows || c >= RULES.cols) continue;
      const idx = r * RULES.cols + c;
      if ((grid[idx] ?? -1) < 0) continue;
      const v = this.cells[idx];
      if (!v) continue;
      const dd = Math.hypot(cell.c - (o.cols - 1) / 2, cell.r - (o.rows - 1) / 2);
      if (dd < bestD) {
        bestD = dd;
        best = { cell: v, x: v.sprite.x, y: v.sprite.y, r, c };
      }
    }
    return best;
  }

  private beginReturn(slot: number): void {
    this.returning = {
      slot,
      t: 0,
      fromX: this.dragLayer.x,
      fromY: this.dragLayer.y,
      fromScale: this.dragLayer.scale.x,
      fromRot: this.dragLayer.rotation,
    };
  }

  /** Copy the drag layout onto the landing sprites and start the fall. */
  private beginLanding(d: DragState, target: { r: number; c: number }, piece: Piece): void {
    const L = this.layout;
    const tl = cellToXY(L, target.r, target.c);
    this.landFrom = {
      x: this.dragLayer.x,
      y: this.dragLayer.y,
      scale: this.dragLayer.scale.x,
      rot: this.dragLayer.rotation,
    };
    this.landTo = { x: tl.x + d.gpx, y: tl.y + d.gpy };
    this.landShadow = { x: this.dragShadow.x, y: this.dragShadow.y };
    this.dragShadow.alpha = this.q.contactShadow ? 0 : 0.7;
    this.landLayer.pivot.set(d.gpx, d.gpy);
    this.landLayer.position.set(this.landFrom.x, this.landFrom.y);
    this.landLayer.scale.set(this.landFrom.scale);
    this.landLayer.rotation = this.landFrom.rot;
    this.landLayer.visible = true;
    this.landT = 0;
    this.landContact = false;
    this.landColor = pieceColor(piece.color);
    const o = orientation(piece.shape, piece.rotation);
    const base = L.cell / this.tex.size;
    for (let i = 0; i < MAX_PIECE_CELLS; i++) {
      const src = this.dragSprites[i];
      const ls = this.landSprites[i];
      const rs = this.rimSprites[i];
      const cell = o.cells[i];
      if (!src || !ls || !rs) continue;
      ls.visible = src.visible;
      ls.texture = src.texture;
      ls.position.copyFrom(src.position);
      ls.scale.set(base);
      rs.visible = false;
      rs.position.copyFrom(src.position);
      // Board index per sprite, for the clear-cancel and the dust edges.
      this.landCell[i] = cell ? (target.r + cell.r) * RULES.cols + target.c + cell.c : -1;
    }
    // A clear fired inside place() may already own some of these cells.
    for (let i = 0; i < MAX_PIECE_CELLS; i++) {
      const idx = this.landCell[i] ?? -1;
      const v = idx >= 0 ? this.cells[idx] : undefined;
      if (v && v.anim === 'clear') this.cancelLanding(idx);
    }
    this.landAny = this.landCell.some((c) => c >= 0);
    // The game ended on this placement: the fall is skipped so the contact
    // — dust, ripple, cue — lands in the first frame of the slow-mo.
    if (this.endSlowT >= 0) {
      this.landT = LAND_TRAVEL_S;
      // The cells' hand-over was timed to the fall: pull it in too, or the
      // tiles vanish between the flight sprite and the cell (a cut).
      for (let i = 0; i < MAX_PIECE_CELLS; i++) {
        const idx = this.landCell[i] ?? -1;
        const v = idx >= 0 ? this.cells[idx] : undefined;
        if (v && v.anim === 'pop') v.delay = Math.max(0.001, v.delay - LAND_TRAVEL_S);
      }
    }
    this.collapseTrail(this.landTo.x, this.landTo.y, 1);
  }

  /** A clear took this cell: its falling sprite and rim flash are dropped. */
  private cancelLanding(idx: number): void {
    for (let i = 0; i < MAX_PIECE_CELLS; i++) {
      if (this.landCell[i] !== idx) continue;
      this.landCell[i] = -1;
      const ls = this.landSprites[i];
      const rs = this.rimSprites[i];
      if (ls) ls.visible = false;
      if (rs) rs.visible = false;
    }
  }

  /** A cell waiting for its landing shows the tile now. */
  private commitTile(v: CellVis): void {
    if (v.color < 0) return;
    v.sprite.texture = this.tex.tiles[v.color] ?? this.tex.tiles[0]!;
  }

  /** Start the ghosts converging on (x, y, scale) — the landing, or the recoiling piece. */
  private collapseTrail(x: number, y: number, scale: number): void {
    let any = false;
    for (let g = 0; g < TRAIL_GHOSTS; g++) {
      const ghost = this.trailGhosts[g];
      if (!ghost) continue;
      const o = g * 5;
      this.trailFrom[o] = ghost.x;
      this.trailFrom[o + 1] = ghost.y;
      this.trailFrom[o + 2] = ghost.rotation;
      this.trailFrom[o + 3] = ghost.scale.x;
      this.trailFrom[o + 4] = ghost.visible ? ghost.alpha : 0;
      if (ghost.visible && ghost.alpha > 0.005) any = true;
    }
    this.trailCollapseTo = { x, y, scale };
    this.trailCollapseT = any ? 0 : -1;
    if (!any) for (const ghost of this.trailGhosts) ghost.visible = false;
  }

  /** Where a dealt piece starts its slide, relative to home: just outside its tray's outer edge. */
  private dealFrom(s: SlotVis, slot: number): void {
    const L = this.layout;
    const trayH = L.handHeight - 52;
    const trayW = L.handSlotW - 10;
    const last = RULES.handSize - 1;
    if (slot === 0) {
      // The piece spans originX .. -originX about home; its right edge must clear the tray's left edge.
      s.dealFromX = -(trayW / 2 + DEAL_EDGE_PAD) + s.originX;
      s.dealFromY = 0;
    } else if (slot === last) {
      s.dealFromX = trayW / 2 - s.originX + DEAL_EDGE_PAD;
      s.dealFromY = 0;
    } else {
      s.dealFromX = 0;
      s.dealFromY = trayH / 2 + 6 - s.originY + DEAL_EDGE_PAD;
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame

  /** Tooling: freeze the ticker and advance exactly dt seconds, then render. */
  debugStep(dtSec: number): void {
    this.app.ticker.stop();
    // Under the shot harness the game clock is manual too; the PNG harness
    // leaves it on wall time and only freezes the presentation.
    if (this.controller.debugManualMs !== null) this.controller.debugAdvance(dtSec * 1000);
    this.frameWithDt(dtSec);
    this.app.renderer.render(this.app.stage);
  }

  /**
   * The drag exactly as a pointer would do it, in canvas pixels — the same
   * path a finger takes (grab → move → release), for the tutorial's
   * scripted moves and the shot harness. A grab is refused while input is
   * locked, a piece is in flight or the game is not running.
   */
  pointerGrab(slot: number, x: number, y: number): boolean {
    const s = this.slots[slot];
    if (!s) return false;
    this.beginDragAt(slot, s.root.toLocal({ x, y }), x, y);
    return this.drag !== null;
  }

  pointerMove(x: number, y: number): void {
    if (this.drag) this.updateDrag(x, y);
  }

  /** Releases the dragged piece; true when the drop placed it. */
  pointerRelease(): boolean {
    if (!this.drag) return false;
    const before = this.controller.current.placements;
    this.endDrag(true);
    return this.controller.current.placements > before;
  }

  /** A pointer position that would grab `slot` at its centre. */
  slotCentre(slot: number): { x: number; y: number } {
    const L = this.layout;
    return { x: L.handSlotX[slot] ?? 0, y: L.handY + L.handHeight / 2 };
  }

  debugResume(): void {
    this.app.ticker.start();
  }

  private frame = (): void => {
    this.govern(this.app.ticker.deltaMS);
    this.frameWithDt(Math.min(0.1, this.app.ticker.deltaMS / 1000));
  };

  // ---------------------------------------------------------------------------
  // Resolution and the supersampling governor

  /** The tier's resolution for this screen under the session cap (quality.ts `effectiveResolution`). */
  private targetResolution(): number {
    const w = this.parent.clientWidth || window.innerWidth || 1;
    const h = this.parent.clientHeight || window.innerHeight || 1;
    return effectiveResolution(
      this.q,
      window.devicePixelRatio || 1,
      this.coarse,
      w,
      h,
      this.ssaaCap,
    );
  }

  /** The screen's own resolution under the tier's cap: where the governor stops. */
  private nativeResolution(): number {
    return Math.min(Math.max(1, window.devicePixelRatio || 1), this.q.maxResolution);
  }

  /**
   * The world container's resolution: the renderer's under WORLD_RESOLUTION_CAP
   * and, on a coarse pointer, under the session cap the governor set.
   */
  private worldResolution(): number {
    const r = Math.min(this.app.renderer.resolution, WORLD_RESOLUTION_CAP);
    return this.coarse ? Math.max(1, Math.min(r, this.ssaaCap)) : r;
  }

  get resolutionInfo(): ResolutionInfo {
    const resolution = this.app.renderer?.resolution ?? 1;
    const native = this.nativeResolution();
    const world = this.post
      ? Number(this.post.resolution)
      : Math.min(resolution, WORLD_RESOLUTION_CAP);
    return { resolution, native, supersampled: resolution > native + 1e-3, world };
  }

  /**
   * Re-size the backing store at `r` (CSS size unchanged: autoDensity). The
   * renderer's resize event runs applyLayout; the resolutionChange runner
   * re-maps pointer events, so a drag still lands in CSS px.
   */
  private setResolution(r: number): void {
    const { renderer } = this.app;
    renderer.resize(renderer.screen.width, renderer.screen.height, r);
    if (this.post) this.post.resolution = this.worldResolution();
    this.applyLayout();
    this.govN = 0;
    this.govI = 0;
    this.govSlowS = 0;
  }

  /**
   * Per ticker frame (never under the harness, which steps frames itself):
   * the frame period into the window; the p90 over the window held above
   * GOV_P90_MS for GOV_HOLD_S of play steps one notch down — the renderer on
   * a fine pointer (its floor is native), the world filter on a coarse one
   * (its floor is 1; the HUD stays at native).
   */
  private govern(deltaMS: number): void {
    if (!this.controller.started || this.resultsFade >= 0) return;
    if (this.coarse && !this.post) return;
    const floor = this.coarse ? 1 : this.nativeResolution();
    const cur = this.coarse ? Number(this.post!.resolution) : this.app.renderer.resolution;
    if (cur <= floor + 1e-3) return;
    this.govEma += (deltaMS - this.govEma) * 0.1;
    this.govTimes[this.govI] = deltaMS;
    this.govI = (this.govI + 1) % GOV_WINDOW;
    if (this.govN < GOV_WINDOW) {
      this.govN++;
      return;
    }
    const sorted = Array.from(this.govTimes).sort((a, b) => a - b);
    this.govP90 = sorted[Math.floor(GOV_WINDOW * 0.9)] ?? 0;
    if (this.govP90 <= GOV_P90_MS) {
      this.govSlowS = 0;
      return;
    }
    this.govSlowS += deltaMS / 1000;
    if (this.govSlowS < GOV_HOLD_S) return;
    const next = cur > GOV_MID + 1e-3 && GOV_MID > floor + 1e-3 ? GOV_MID : floor;
    const what = this.coarse ? 'world resolution' : 'renderer resolution';
    console.info(
      `[blockari] supersampling governor: p90 frame ${this.govP90.toFixed(1)} ms (ema ${this.govEma.toFixed(1)} ms) over ${GOV_HOLD_S} s at ${cur}x; ${what} ${cur} -> ${next} (floor ${floor})`,
    );
    this.ssaaCap = next;
    if (this.coarse) {
      this.post!.resolution = this.worldResolution();
      this.govN = 0;
      this.govI = 0;
      this.govSlowS = 0;
    } else {
      this.setResolution(next);
    }
    this.onResolutionStep?.(this.resolutionInfo);
  }

  private frameWithDt(dtReal: number): void {
    // Slow-mo beat (4X+ clears): presentation time runs at 0.35x for 120 ms of
    // wall time, then snaps back. The game clock is untouched.
    if (this.slowT >= 0) {
      this.slowT += dtReal;
      this.timeScale = this.slowT < 0.12 ? 0.35 : 1;
      if (this.slowT >= 0.12) this.slowT = -1;
    }
    // End of the game: presentation time at END_SLOW_K for END_SLOW_S of
    // wall time, easing back over the last END_SLOW_EASE_S; the HUD dims
    // and the post grade desaturates and darkens over the same 400 ms and
    // holds (play is over — the one place the board may dim). The results
    // scene's clock is released as the dilation ends.
    if (this.endSlowT >= 0) {
      this.endSlowT += dtReal;
      const t = this.endSlowT;
      const p = Math.min(1, t / END_SLOW_S);
      const ease = Math.max(0, (t - (END_SLOW_S - END_SLOW_EASE_S)) / END_SLOW_EASE_S);
      this.timeScale = this.reducedMotion ? 1 : END_SLOW_K + (1 - END_SLOW_K) * Math.min(1, ease);
      const g = easeOutCubic(p);
      this.hudDim = 1 - (1 - END_HUD_DIM) * g;
      this.post?.setEndGrade(END_DESAT * g, END_DARKEN * g);
      this.applyHudAlpha();
      if (t >= END_SLOW_S) {
        this.endSlowT = -1;
        this.timeScale = 1;
        this.results.paused = false;
        this.resultsFade = 0;
      }
    }
    const dt = dtReal * this.timeScale;
    this.timeSec += dt;
    this.controller.update();
    this.camera.rest = this.resultsFade >= 0;
    this.camera.update(dt);
    this.animateStreakHeat(dt);

    this.background?.update(this.timeSec, dt);
    // The world: revealed with the countdown (or at once on a resume), lit by
    // the game clock (dawn -> noon -> dusk over the three minutes), frozen at
    // the results. Its room soften in post ramps with its cross-fade.
    if (this.controller.started) this.worldScene.reveal();
    if (!this.worldFrozen) this.worldScene.setTime(this.controller.clock() / RULES.durationMs);
    this.worldScene.update(dt, this.heatLevel);
    const worldK = this.worldScene.opacity;
    this.post?.setWorldBokeh(this.q.worldBokehPx * worldK * this.worldScene.softenK);
    // The backdrop's wide-screen side bands are its own outer-thirds
    // treatment; over a painted world they read as light rectangles.
    for (const b of this.sideBands) b.alpha = 0.7 * (1 - worldK);
    this.post?.update(this.timeSec, dt);
    this.particles.update(dt);
    this.burstParticles.update(dt);
    this.oneShots.update(dt);
    this.burstFx.update(dt);
    this.ribbons.update(dt);
    this.fracture.update(dt);
    this.floatText.update(dt);
    this.bakeAhead();
    this.animateMotes(dt);
    this.animateCells(dt);
    this.animateHand(dt);
    this.animateDrag(dt);
    this.animateLanding(dt);
    this.animateTrail(dt);
    this.animateHeat(dt);
    this.animateRipple(dt);
    this.animateMaterial(dt);
    this.animateHud(dt);
    this.animateCountdown(dt);
    // The reflection reads the board as it is this frame, before the stage draws.
    this.floor.capture(this.app.renderer, this.reflectionSource);
  }

  private animateMotes(dt: number): void {
    this.motes.update(dt, this.app.screen.width, this.app.screen.height);
    this.results.update(dt);
  }

  private animateCells(dt: number): void {
    const L = this.layout;
    const base = L.cell / this.tex.size;
    const fracture = this.q.fractureChunks > 0 && this.fracture.capacity > 0;
    for (let ci = 0; ci < this.cells.length; ci++) {
      const v = this.cells[ci]!;
      if (v.flash > 0) {
        // Rejected drop: one rose pulse on the tile, then back to its baked colour.
        v.flash = Math.max(0, v.flash - dt);
        const k = Math.sin((1 - v.flash / BLOCK_FLASH_S) * Math.PI);
        v.sprite.tint = lerp(0xffffff, PALETTE.danger, k);
        this.blockFlash.alpha = 0.55 * k;
        if (v.flash === 0) {
          v.sprite.tint = 0xffffff;
          this.blockFlash.visible = false;
        }
      }
      if (v.anim === 'none') continue;
      if (v.anim === 'clear') {
        // Three-plus lines: the tile itself lifts 4 px over 60 ms and holds
        // there until its turn to shatter (the chunks are born lifted; the
        // socket under them is back on the grid).
        v.age += dt;
        if (v.liftK > 0 && !v.fractured) {
          const { y } = cellToXY(L, Math.floor(ci / RULES.cols), ci % RULES.cols);
          v.sprite.y =
            y +
            L.cell / 2 -
            CLEAR_LIFT_PX * v.liftK * easeOutCubic(Math.min(1, v.age / CLEAR_LIFT_S));
        }
      }
      if (v.delay > 0) {
        v.delay -= dt;
        if (v.delay > 0) continue;
        v.t = 0;
        if (v.anim === 'pop') this.commitTile(v);
        if (v.anim === 'clear') {
          // Far down the line the sweep has already left the plate: no white
          // flash there, the tile just dissolves (or, fracturing, waits its
          // turn in the wave and breaks unflashed).
          // Far down the line there is no flash: the cell goes straight to
          // its dissolve or its shatter (a chunk-cut tile sitting whole for
          // three frames read as seams on a resting tile).
          if (v.dy >= CLEAR_FLASH_MAX_RANK)
            v.t = CLEAR_ANIM_S * (this.heatTarget >= 0.7 ? 0.16 : 0.2);
          const { x, y } = v.sprite.position;
          const tint = shade(this.tileColorOf(v), 0.35);
          // Axis of the line this cell belongs to: same row as the placed piece -> horizontal.
          const axisX = Math.abs(y - this.lastPlaced.y) < L.cell * 0.6 ? 1 : 0;
          const axisY = axisX ? 0 : 1;
          // Fewer sparks with distance from the placed piece: one clear source.
          // The same count per cell on every line count — a multiline's
          // extra is its choreography (flare, lift, column), not 4x the
          // white sparks (round 3: two lines out-whited one).
          const lines = this.lastClear.rows.length + this.lastClear.cols.length;
          const falloff = 1 - 0.6 * Math.min(1, v.dy / 9);
          const count = Math.round(
            (Math.min(this.q.particlesPerCell, CLEAR_SPARKS_PER_CELL) / Math.max(1, lines)) *
              falloff,
          );
          this.particles.burst(
            x,
            y,
            tint,
            count,
            L.cell * 4.5,
            L.cell / this.tex.size,
            axisX,
            axisY,
          );
        }
      }
      v.t += dt;
      if (v.anim === 'pop') {
        // The landing sprites did the travel and the press-in; the cell takes
        // over pressed into the socket (x wider, y flatter, by the piece's
        // mass) and springs back with a back-ease, so it rebounds through a
        // slight stretch before settling.
        const t = Math.min(1, v.t / POP_ANIM_S);
        const m = massK(v.amp);
        const k = easeOutBack(t, 2.2);
        v.sprite.scale.set(
          base * (1 + LAND_SQUASH_X * m * (1 - k)),
          base * (1 - LAND_SQUASH_Y * m * (1 - k)),
        );
        if (t >= 1) {
          v.anim = 'none';
          v.sprite.scale.set(base);
        }
      } else {
        const t = Math.min(1, v.t / CLEAR_ANIM_S);
        // At 4X the flash is warm white and 20% shorter, so the cleared line
        // reads as the source of the rays rather than a separate white bar.
        const hot4 = this.heatTarget >= 0.7;
        const flashEnd = hot4 ? 0.16 : 0.2;
        if (t < flashEnd) {
          if (!fracture || v.dy < CLEAR_FLASH_MAX_RANK) {
            v.sprite.tint = hot4 ? 0xfff1d0 : v.flashColor;
            v.sprite.texture = this.tex.flat;
            v.sprite.scale.set(base * (1 + t * 0.6));
          }
        } else if (fracture) {
          // Fracture: the tile breaks into chunks the moment the flash ends and
          // the socket fades in under them (the chunks do the dissolving).
          if (!v.fractured) {
            v.fractured = true;
            this.fractureCell(v);
            v.sprite.texture = this.tex.socket;
            v.sprite.tint = 0xffffff;
            v.sprite.rotation = 0;
            v.sprite.scale.set(base);
            if (v.liftK > 0) this.resetCellY(ci);
          }
          v.sprite.alpha = easeOutCubic((t - flashEnd) / (1 - flashEnd));
        } else {
          const k = easeOutCubic((t - flashEnd) / (1 - flashEnd));
          v.sprite.scale.set(base * (1.12 - k * 1.12), base * (1.12 - k * 1.12) * (1 - k * 0.4));
          v.sprite.rotation = v.dx * k * 0.26;
          v.sprite.alpha = 1 - k;
        }
        if (t >= 1) {
          v.anim = 'none';
          v.sprite.texture = this.tex.socket;
          v.sprite.tint = 0xffffff;
          v.sprite.alpha = 1;
          v.sprite.rotation = 0;
          v.sprite.scale.set(base);
          if (v.liftK > 0) this.resetCellY(ci);
          v.liftK = 0;
        }
      }
    }
  }

  /** Put a lifted cell's sprite back on the grid. */
  private resetCellY(idx: number): void {
    const { y } = cellToXY(this.layout, Math.floor(idx / RULES.cols), idx % RULES.cols);
    this.cells[idx]!.sprite.y = y + this.layout.cell / 2;
  }

  /**
   * Break a clearing tile into chunks: 4 at 1X, 6 from 2X (capped by the
   * tier), thrown along its line away from the placed piece.
   */
  private fractureCell(v: CellVis): void {
    const { x, y } = v.sprite.position;
    const heat = this.clearHeat;
    const want = heat < 0.2 ? 4 : 6;
    // Along the clear direction: with the sweep (one or two lines) or away
    // from the placed piece (three plus); a cell on a crossing takes both.
    let dirX = v.pushX;
    let dirY = v.pushY;
    if (dirX !== 0 && dirY !== 0) {
      dirX *= Math.SQRT1_2;
      dirY *= Math.SQRT1_2;
    }
    this.fracture.burst(
      x,
      y,
      v.clearColor,
      Math.min(want, this.q.fractureChunks),
      dirX,
      dirY,
      heat,
      this.heatColor(heat),
    );
  }

  private tileColorOf(v: CellVis): number {
    if (v.color >= 0) return pieceColor(v.color);
    const idx = this.tileIndexOf(v.sprite.texture);
    return idx >= 0 ? pieceColor(idx) : 0xffffff;
  }

  private animateHand(dt: number): void {
    const L = this.layout;
    let dealing = false;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s) continue;
      const home = { x: L.handSlotX[i] ?? 0, y: L.handY + L.handHeight / 2 };
      if (s.dealT < 1) {
        // Deal-in: a 120 ms ease-out slide from the tray's outer edge, then a
        // one-frame settle squash; slots 60 ms apart. The piece sprites are
        // the only thing that moves.
        dealing = true;
        if (s.dealDelay > 0) {
          s.dealDelay -= dt;
          s.root.position.set(home.x + s.dealFromX, home.y + s.dealFromY);
          continue;
        }
        const prev = s.dealT;
        s.dealT = Math.min(1, s.dealT + dt / DEAL_SLIDE_S);
        const t = s.dealT;
        const k = easeOutCubic(t);
        s.root.position.set(home.x + s.dealFromX * (1 - k), home.y + s.dealFromY * (1 - k));
        s.root.scale.set(1);
        s.root.alpha = 1;
        if (prev < 1 && t >= 1) {
          s.settleT = 0;
          if (s.piece)
            this.oneShots.puff(
              this.tex,
              home.x,
              home.y,
              pieceColor(s.piece.color),
              L.handSlotW * 0.9,
              0.35,
              0.22,
            );
        }
        continue;
      }
      // The settle: one frame pressed (x wider, y flatter), then home.
      let settleX = 1;
      let settleY = 1;
      if (s.settleT >= 0) {
        s.settleT += dt;
        if (s.settleT < DEAL_SETTLE_S) {
          settleX = 1 + DEAL_SETTLE_SQUASH;
          settleY = 1 - DEAL_SETTLE_SQUASH;
        } else {
          s.settleT = -1;
        }
      }
      // Hover lift.
      const target = s.hover ? 1.05 : 1;
      const cur = s.root.scale.y / settleY;
      const sc = cur + (target - cur) * Math.min(1, dt * 14);
      s.root.scale.set(sc * settleX, sc * settleY);
      // Idle float: 2 mm on a 4 s cycle of the presentation clock, slots
      // 1.3 s apart; the contact shadow under the piece breathes with it —
      // fading and spreading at the top of the float.
      const amp = this.reducedMotion ? 0 : this.q.trayFloatMm * MM_PX;
      const k =
        amp > 0
          ? 0.5 +
            0.5 *
              Math.sin(
                ((this.timeSec + i * TRAY_FLOAT_PHASE_S) * Math.PI * 2) / TRAY_FLOAT_PERIOD_S,
              )
          : 0;
      s.root.position.set(home.x, home.y - amp * k);
      const sh = this.handShadows[i];
      if (sh) {
        const on = this.q.trayFloatMm > 0 && s.piece !== null && s.root.visible;
        const want = on ? TRAY_SHADOW_A - TRAY_SHADOW_FADE * k : 0;
        // Eases in after a deal; gone the frame the piece is lifted.
        sh.alpha = s.root.visible ? sh.alpha + (want - sh.alpha) * Math.min(1, dt * 8) : 0;
        sh.visible = sh.alpha > 0.005;
        sh.position.set(home.x + 4, home.y + 10 + amp * k * 0.6);
        const grow = 1 + TRAY_SHADOW_GROW * k;
        const o = s.piece ? orientation(s.piece.shape, s.piece.rotation) : null;
        if (o) {
          const pitch = L.handCell * 1.08 * s.fit;
          sh.scale.set(((o.cols * pitch + 28) / 256) * grow, ((o.rows * pitch + 28) / 256) * grow);
        }
      }
    }
    // The tray clip costs a stencil pass; only pay it while something is sliding in.
    if (!dealing && this.handLayer.mask) {
      this.handLayer.mask = null;
      this.handMask.visible = false;
    }
    // "Next hand": the trays dim 20% and each lift glow pulses once, with
    // its piece's stagger — light, not motion.
    if (this.trayPulseT >= 0) {
      this.trayPulseT += dt;
      const total = TRAY_PULSE_S + DEAL_STAGGER_S * (RULES.handSize - 1);
      // Dimmed from the deal's first frame, released over the last TRAY_DIM_OUT_S.
      // Released so the floor is back the frame the last piece has settled.
      const settled = DEAL_STAGGER_S * (RULES.handSize - 1) + DEAL_SLIDE_S + DEAL_SETTLE_S;
      const dim = 1 - smoothstep(settled - TRAY_DIM_OUT_S, settled, this.trayPulseT);
      // A tint, not an alpha: the floor is translucent over the world, and
      // thinning it lets MORE of a bright painting through.
      this.trayDimK = dim;
      this.trays.tint = lerp(0xffffff, 0x000000, TRAY_DIM * dim);
      for (let i = 0; i < this.trayLift.length; i++) {
        const u = (this.trayPulseT - i * DEAL_STAGGER_S) / TRAY_PULSE_S;
        this.trayPulseK[i] = u > 0 && u < 1 ? Math.sin(u * Math.PI) : 0;
      }
      if (this.trayPulseT >= total) {
        this.trayPulseT = -1;
        this.trayPulseK.fill(0);
        this.trayDimK = 0;
        this.trays.tint = 0xffffff;
      }
    }
  }

  /**
   * Place the drag layer from the drag's top-left, scale and tilt. The pivot is
   * the grab point, so the tilt rotates the piece around the finger and the
   * top-left arithmetic the drop target uses is untouched.
   */
  private applyDragTransform(d: DragState): void {
    const L = this.layout;
    const from = ((this.slots[d.slot]?.fit ?? 1) * L.handCell) / L.cell;
    const sc = from + (1.12 - from) * easeOutBack(d.grabT, 1.4);
    this.dragLayer.scale.set(sc);
    this.dragLayer.rotation = d.tilt;
    // The lift itself is animated (presentation only): the piece rises to its
    // lift height with a back-ease overshoot. d.y, which the drop target
    // reads, already holds the full lift.
    const liftK = this.dragLiftK(d);
    this.dragLayer.position.set(
      d.x + d.magX + d.gpx * sc,
      d.y + d.magY + d.gpy * sc + L.dragLift * (1 - liftK),
    );
    // While the projection beam lights the sockets under the piece, its
    // shadow is filled in to a hint: a cast shadow under a light column reads
    // as a grey streak, not as light.
    const shadowMul = this.q.ghostBeam > 0 && d.target ? GHOST_BEAM_SHADOW : 1;
    if (this.q.contactShadow)
      this.pieceShadow.set(
        d.x + d.magX,
        d.y + d.magY,
        d.gpx,
        d.gpy,
        d.tilt,
        sc,
        liftK,
        L.cell,
        shadowMul,
      );
  }

  /**
   * How high the piece reads as lifted, 0..1 (briefly above 1 on the grab
   * overshoot): the same curve the drag layer rises on, so the shadow's
   * penumbra and offset follow the piece exactly.
   */
  private dragLiftK(d: DragState): number {
    const back = this.q.grabOvershoot;
    return back > 0 ? easeOutBack(d.grabT, back) : 1;
  }

  private animateDrag(dt: number): void {
    const L = this.layout;
    const d = this.drag;
    if (d) {
      d.grabT = Math.min(1, d.grabT + dt / GRAB_ANIM_S);
      // Velocity from the top-left's movement since last frame, smoothed.
      if (dt > 0) {
        const ivx = (d.x - d.lastX) / dt;
        const ivy = (d.y - d.lastY) / dt;
        const a = Math.min(1, dt * VEL_SMOOTH);
        d.vx += (ivx - d.vx) * a;
        d.vy += (ivy - d.vy) * a;
      }
      d.lastX = d.x;
      d.lastY = d.y;
      // Tilt toward the travel direction, lagging the velocity.
      const tiltTarget = TILT_MAX_RAD * Math.max(-1, Math.min(1, d.vx / TILT_FULL_VEL));
      d.tilt += (tiltTarget - d.tilt) * Math.min(1, dt * TILT_LERP);
      // Magnet toward the legal target: the drawn piece settles onto the
      // exact cells (up to MAGNET_K of the way) while the finger is slowing,
      // and lets go the moment the placement is not legal. Presentation only.
      {
        const pitch = L.cell + L.gap;
        const speed = Math.hypot(d.vx, d.vy);
        const still = 1 - Math.min(1, speed / MAGNET_STILL_VEL);
        let wantX = 0;
        let wantY = 0;
        if (d.legal && d.target) {
          wantX = (L.boardX + d.target.c * pitch - d.x) * MAGNET_K * still;
          wantY = (L.boardY + d.target.r * pitch - d.y) * MAGNET_K * still;
        }
        const a = Math.min(1, dt * MAGNET_LERP);
        d.magX += (wantX - d.magX) * a;
        d.magY += (wantY - d.magY) * a;
      }
      this.applyDragTransform(d);
      this.pushTrailSample();
      this.showTrail(Math.hypot(d.vx, d.vy));
      // The shadow separates as the piece rises (the bounding-box shadow only;
      // with the shape-true contact shadow it stays off).
      if (this.q.grabOvershoot > 0 && !this.q.contactShadow)
        this.dragShadow.alpha = 0.7 * (0.35 + 0.65 * Math.min(1, d.grabT / 0.6));
      // Breathing outline while a target is shown.
      const pulse = 1 + 0.1 * Math.sin((this.timeSec * (Math.PI * 2)) / 0.3);
      const base = L.cell / this.tex.size;
      for (const g of this.ghostOutline) if (g.visible) g.scale.set(base * pulse);
      // Holo ghost: the sweep and shimmer run on the game clock; the lock-in flash decays.
      if (d.lockT >= 0) {
        d.lockT += dt;
        if (d.lockT >= GHOST_FLASH_S) d.lockT = -1;
      }
      if (this.q.holoGhost) {
        const flash = d.lockT >= 0 ? 1 - d.lockT / GHOST_FLASH_S : 0;
        this.holoGhost.set(this.timeSec, flash);
        for (const hl of this.holoLines) hl.set(this.timeSec, flash);
        this.updateBeam(d, flash);
      }
      if (d.shakeT > 0) {
        d.shakeT -= dt;
        this.ghostLayer.x = Math.sin((0.1 - d.shakeT) * Math.PI * 40) * 3;
        if (d.shakeT <= 0) this.ghostLayer.x = 0;
      }
    }
    const rc = this.recoil;
    if (rc) {
      // Bounce off the blocking cell: out fast, then the return tween takes over.
      rc.t = Math.min(1, rc.t + dt / RECOIL_S);
      const k = easeOutCubic(rc.t);
      const dist = L.cell * RECOIL_CELLS;
      this.dragLayer.position.set(rc.fromX + rc.dirX * dist * k, rc.fromY + rc.dirY * dist * k);
      this.dragLayer.rotation *= 1 - Math.min(1, dt * TILT_LERP);
      if (rc.t >= 1) {
        this.recoil = null;
        this.beginReturn(rc.slot);
      }
    }
    const r = this.returning;
    if (r) {
      r.t = Math.min(1, r.t + dt / RETURN_ANIM_S);
      const s = this.slots[r.slot];
      const k = easeInOutQuad(r.t);
      const toScale = ((s?.fit ?? 1) * L.handCell) / L.cell;
      if (s && s.piece) {
        const o = orientation(s.piece.shape, s.piece.rotation);
        const pitch = L.handCell * 1.08 * s.fit;
        // The layer is placed by its pivot (the grab point), so the tray
        // target is the piece's top-left plus the pivot at hand scale.
        const tx =
          (L.handSlotX[r.slot] ?? 0) - (o.cols * pitch) / 2 + this.dragLayer.pivot.x * toScale;
        const ty =
          L.handY + L.handHeight / 2 - (o.rows * pitch) / 2 + this.dragLayer.pivot.y * toScale;
        this.dragLayer.position.set(r.fromX + (tx - r.fromX) * k, r.fromY + (ty - r.fromY) * k);
        this.dragLayer.scale.set(r.fromScale + (toScale - r.fromScale) * k);
        this.dragLayer.rotation = r.fromRot * (1 - k);
      }
      if (r.t >= 1) {
        this.returning = null;
        this.dragLayer.visible = false;
        this.dragLayer.rotation = 0;
        if (s) {
          s.root.visible = true;
          s.root.alpha = 1;
          s.dealT = 1;
        }
      }
    }
  }

  /** Record the drag layer's transform for the trail (ring buffer, no allocation). */
  private pushTrailSample(): void {
    const o = this.trailHead * 5;
    this.trailBuf[o] = this.dragLayer.x;
    this.trailBuf[o + 1] = this.dragLayer.y;
    this.trailBuf[o + 2] = this.dragLayer.rotation;
    this.trailBuf[o + 3] = this.dragLayer.scale.x;
    this.trailBuf[o + 4] = this.timeSec;
    this.trailHead = (this.trailHead + 1) % TRAIL_HISTORY;
    this.trailCount = Math.min(TRAIL_HISTORY, this.trailCount + 1);
  }

  /** Ghost i sits where the piece was (i+1) × TRAIL_SPACING_S ago; alpha fades with speed. */
  private showTrail(speed: number): void {
    const L = this.layout;
    const k = Math.max(0, Math.min(1, (speed - TRAIL_MIN_VEL) / TRAIL_FADE_VEL));
    for (let g = 0; g < TRAIL_GHOSTS; g++) {
      const ghost = this.trailGhosts[g];
      if (!ghost) continue;
      if (k <= 0 || this.trailCount < 2) {
        ghost.visible = false;
        continue;
      }
      const want = this.timeSec - (g + 1) * TRAIL_SPACING_S * 0.5;
      // Walk back from the newest sample to the first one at or before `want`,
      // then interpolate toward the sample after it so the ghosts sit on the
      // path at exact times, not on frame boundaries.
      let idx = (this.trailHead - 1 + TRAIL_HISTORY) % TRAIL_HISTORY;
      let newer = idx;
      for (let n = 1; n < this.trailCount; n++) {
        if ((this.trailBuf[idx * 5 + 4] ?? 0) <= want) break;
        newer = idx;
        idx = (idx - 1 + TRAIL_HISTORY) % TRAIL_HISTORY;
      }
      const o = idx * 5;
      const p = newer * 5;
      const t0 = this.trailBuf[o + 4] ?? 0;
      const t1 = this.trailBuf[p + 4] ?? 0;
      const f = t1 > t0 ? Math.max(0, Math.min(1, (want - t0) / (t1 - t0))) : 0;
      const at = (off: number) => {
        const a = this.trailBuf[o + off] ?? 0;
        const b = this.trailBuf[p + off] ?? a;
        return a + (b - a) * f;
      };
      ghost.visible = true;
      ghost.position.set(at(0), at(1));
      ghost.rotation = at(2);
      ghost.scale.set(at(3));
      // Comet tail: each cell's smear points back along the velocity, length
      // clamp(v × 60 ms, 0.5, 2.5 cells), width 0.8 cell, at the piece's colour.
      const dv = this.drag;
      const ang = dv ? Math.atan2(dv.vy, dv.vx) : 0;
      const len = Math.max(0.8, Math.min(2.5, (speed * 0.06) / L.cell)) * L.cell;
      for (const child of ghost.children) {
        if (!(child instanceof Sprite) || !child.visible) continue;
        child.rotation = ang - ghost.rotation;
        child.scale.set(len / this.tex.size / at(3), (L.cell * 0.8) / this.tex.size / at(3));
      }
      ghost.alpha = (TRAIL_ALPHAS[g] ?? 0) * k;
    }
  }

  /** After a drop the ghosts converge into the landing (or the recoiling piece) and fade. */
  private animateTrail(dt: number): void {
    if (this.trailCollapseT < 0) return;
    this.trailCollapseT += dt;
    const t = Math.min(1, this.trailCollapseT / TRAIL_COLLAPSE_S);
    const k = easeOutCubic(t);
    const to = this.trailCollapseTo;
    for (let g = 0; g < TRAIL_GHOSTS; g++) {
      const ghost = this.trailGhosts[g];
      if (!ghost) continue;
      const o = g * 5;
      const a0 = this.trailFrom[o + 4] ?? 0;
      if (a0 <= 0) {
        ghost.visible = false;
        continue;
      }
      const fx = this.trailFrom[o] ?? 0;
      const fy = this.trailFrom[o + 1] ?? 0;
      const fr = this.trailFrom[o + 2] ?? 0;
      const fs = this.trailFrom[o + 3] ?? 1;
      ghost.visible = true;
      ghost.position.set(fx + (to.x - fx) * k, fy + (to.y - fy) * k);
      ghost.rotation = fr * (1 - k);
      ghost.scale.set(fs + (to.scale - fs) * k);
      ghost.alpha = a0 * (1 - t);
    }
    if (t >= 1) {
      this.trailCollapseT = -1;
      for (const ghost of this.trailGhosts) ghost.visible = false;
    }
  }

  /**
   * The released piece falls from lift height into the socket (LAND_TRAVEL_S,
   * accelerating), presses in for two frames (LAND_SQUASH_S), then the board
   * cells take over and spring back. At contact: the socket rim catches the
   * light, dust skids outward from the footprint edges, the shadow closes up.
   */
  private animateLanding(dt: number): void {
    if (this.landT < 0) return;
    const L = this.layout;
    this.landT += dt;
    const t = this.landT;
    const base = L.cell / this.tex.size;
    const from = this.landFrom;
    const to = this.landTo;
    if (t < LAND_TRAVEL_S) {
      const k = easeInQuad(t / LAND_TRAVEL_S);
      this.landLayer.position.set(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
      this.landLayer.scale.set(from.scale + (1 - from.scale) * k);
      this.landLayer.rotation = from.rot * (1 - k);
      if (!this.drag && !this.landAny) {
        // Every cell went to a clear: nothing falls, so nothing casts (a
        // shadow closing up on an empty socket read as a grey smudge).
        this.dragShadow.alpha = 0;
        this.pieceShadow.hide();
      } else if (!this.drag) {
        // The lifted piece's shadow closes up under it as it lands.
        if (this.q.contactShadow) {
          const sc = this.landLayer.scale.x;
          this.pieceShadow.set(
            this.landLayer.x - this.landLayer.pivot.x * sc,
            this.landLayer.y - this.landLayer.pivot.y * sc,
            this.landLayer.pivot.x,
            this.landLayer.pivot.y,
            this.landLayer.rotation,
            sc,
            this.landLift * (1 - k),
            L.cell,
            1,
          );
        } else {
          this.dragShadow.alpha = 0.7 * (1 - k);
          this.dragShadow.position.set(
            this.landShadow.x + (to.x - from.x) * k,
            this.landShadow.y + (to.y - from.y) * k,
          );
        }
      }
      return;
    }
    this.landLayer.position.set(to.x, to.y);
    this.landLayer.scale.set(1);
    this.landLayer.rotation = 0;
    if (!this.landContact) {
      this.landContact = true;
      if (!this.drag) {
        this.dragShadow.alpha = 0;
        this.pieceShadow.hide();
      }
      this.onLandingContact();
    }
    const since = t - LAND_TRAVEL_S;
    // Press-in: the tiles squash for two frames — wider and flatter, by the
    // piece's mass — then the board cells own them and spring back.
    const squash = Math.min(1, since / LAND_SQUASH_S);
    const m = massK(this.landMass);
    const pressedX = 1 + LAND_SQUASH_X * m * squash;
    const pressedY = 1 - LAND_SQUASH_Y * m * squash;
    for (let i = 0; i < MAX_PIECE_CELLS; i++) {
      const ls = this.landSprites[i];
      const rs = this.rimSprites[i];
      if (!ls || !rs) continue;
      if ((this.landCell[i] ?? -1) < 0) continue;
      ls.scale.set(base * pressedX, base * pressedY);
      if (squash >= 1) ls.visible = false;
      const rim = 1 - Math.min(1, since / RIM_FLASH_S);
      rs.alpha = rim;
      rs.visible = rim > 0;
    }
    if (since >= Math.max(LAND_SQUASH_S, RIM_FLASH_S)) {
      this.landT = -1;
      this.landLayer.visible = false;
      for (let i = 0; i < MAX_PIECE_CELLS; i++) this.landCell[i] = -1;
    }
  }

  /**
   * Contact: rim flash on, dust outward from every exposed footprint edge
   * (more of it, faster, for a heavy piece), the light-only pressure ripple
   * across the neighbours, and the placement cue by mass.
   */
  private onLandingContact(): void {
    const L = this.layout;
    const mass = this.landMass;
    this.onCue?.(mass >= HEAVY_MASS ? 'place-heavy' : 'place');
    if (this.q.landRipple && !this.reducedMotion) {
      this.rippleN = 0;
      for (let i = 0; i < MAX_PIECE_CELLS; i++) {
        const idx = this.landCell[i] ?? -1;
        if (idx >= 0) this.rippleCells[this.rippleN++] = idx;
      }
      this.rippleT = this.rippleN > 0 ? 0 : -1;
      this.rippleMass = mass;
      this.rippleLayer.visible = this.rippleT >= 0;
    }
    // White, additive: clears the bloom threshold on every tile colour.
    const rimColor = 0xffffff;
    const dustColor = shade(this.landColor, 0.3);
    const size = (L.cell * DUST_HALO_CELLS) / this.tex.size;
    const core = (L.cell * DUST_CORE_CELLS) / this.tex.size;
    const dustN = Math.round(DUST_PER_EDGE * (DUST_MASS_MIN + mass));
    const dustV = L.cell * DUST_SPEED_CELLS * (0.8 + 0.5 * mass);
    for (let i = 0; i < MAX_PIECE_CELLS; i++) {
      const idx = this.landCell[i] ?? -1;
      const rs = this.rimSprites[i];
      if (idx < 0 || !rs) continue;
      rs.tint = rimColor;
      rs.alpha = 1;
      rs.blendMode = 'add';
      rs.visible = true;
      const r = Math.floor(idx / RULES.cols);
      const c = idx % RULES.cols;
      const { x, y } = cellToXY(L, r, c);
      const cx = x + L.cell / 2;
      const cy = y + L.cell / 2;
      // An edge is exposed when the cell beyond it is not part of the piece.
      for (const [dr, dc] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        const nidx = (r + dr) * RULES.cols + c + dc;
        let inside = false;
        for (let j = 0; j < MAX_PIECE_CELLS; j++) if (this.landCell[j] === nidx) inside = true;
        if (inside) continue;
        this.particles.dust(
          cx + dc * L.cell * 0.5,
          cy + dr * L.cell * 0.5 + L.cell * 0.12,
          dustColor,
          dustN,
          dustV,
          size,
          dc,
          dr,
          core,
        );
      }
    }
  }

  /**
   * The pressure ripple after a landing, LIGHT only: for every cell within
   * RIPPLE_REACH of the footprint, a modulation of its face brightness — a
   * crest (the light's core) travelling outward with a shallower AO trough
   * behind it, fading over RIPPLE_S — that the lit mesh applies as a
   * (negative) occlusion, the socket sprites as a tint dip and the contact
   * AO as a lift. No geometry moves; the neighbours stay pixel-aligned.
   */
  private animateRipple(dt: number): void {
    if (this.rippleT < 0) return;
    this.rippleT += dt;
    const p = this.rippleT / RIPPLE_S;
    const mod = this.rippleMod;
    if (p >= 1) {
      this.rippleT = -1;
      mod.fill(0);
      for (let i = 0; i < this.cells.length; i++) {
        const v = this.cells[i]!;
        if (v.anim === 'none' && v.flash === 0) v.sprite.tint = 0xffffff;
        const rl = this.rippleLight[i];
        if (rl) rl.visible = false;
      }
      this.rippleLayer.visible = false;
      return;
    }
    const lightColor = lerp(this.landColor, PALETTE.warmWhite, 0.4);
    const front = 0.5 + RIPPLE_REACH * p;
    const env = 1 - smoothstep(0.7, 1, p);
    const amp = RIPPLE_LIFT * massK(this.rippleMass) * env;
    const w = RIPPLE_WIDTH;
    const reach = RIPPLE_REACH + 0.6;
    for (let i = 0; i < this.cells.length; i++) {
      const r = Math.floor(i / RULES.cols);
      const c = i % RULES.cols;
      let d = Infinity;
      let inside = false;
      for (let k = 0; k < this.rippleN; k++) {
        const j = this.rippleCells[k] ?? -1;
        if (j === i) {
          inside = true;
          break;
        }
        const dr = Math.floor(j / RULES.cols) - r;
        const dc = (j % RULES.cols) - c;
        const dd = Math.sqrt(dr * dr + dc * dc);
        if (dd < d) d = dd;
      }
      if (inside || d > reach) {
        mod[i] = 0;
        const rl = this.rippleLight[i];
        if (rl) rl.visible = false;
        continue;
      }
      const u = d - front;
      const crest = Math.exp(-(u * u) / (w * w));
      const ub = u + w * 1.4;
      const trough = -RIPPLE_TROUGH * Math.exp(-(ub * ub) / (w * w));
      const m = amp * (1 - (1 - RIPPLE_FAR_K) * Math.min(1, d / reach)) * (crest + trough);
      mod[i] = m;
      // Sockets (and the low tier's sprites): the trough is a tint dip; the
      // crest is the socket's own emissive pool lit in the piece's colour
      // (a tint cannot lift). The mesh does both itself (animateMaterial).
      const v = this.cells[i]!;
      if (v.anim === 'none' && v.flash === 0 && (v.color < 0 || this.q.tileLight === 0))
        v.sprite.tint =
          m < 0
            ? lerp(0xffffff, 0x000000, Math.min(RIPPLE_SOCKET_DIP_MAX, -m * RIPPLE_SOCKET_DIP))
            : 0xffffff;
      const rl = this.rippleLight[i];
      if (rl) {
        const a = m > 0 && v.color < 0 ? m * RIPPLE_SOCKET_LIGHT : 0;
        rl.visible = a > 0.004;
        if (rl.visible) {
          rl.tint = lightColor;
          rl.alpha = a;
        }
      }
    }
  }

  private animateStreakHeat(dt: number): void {
    const L = this.layout;
    // Ease toward the target: quick to heat up, ~1.5 s to cool.
    const rate = this.heatTarget > this.heatLevel ? 6 : 0.67;
    this.heatLevel += (this.heatTarget - this.heatLevel) * Math.min(1, dt * rate);
    if (Math.abs(this.heatTarget - this.heatLevel) < 0.002) this.heatLevel = this.heatTarget;
    const h = this.heatLevel;
    const color = this.heatColor(h);
    const flicker =
      0.85 + 0.15 * Math.sin(this.timeSec * 9 * Math.PI * 2) * Math.sin(this.timeSec * 2.3);

    // Plate rim and floor.
    this.rimPulse = Math.max(0, this.rimPulse - dt * 3);
    this.rimGlow.tint = color;
    this.rimGlow.alpha = Math.min(1, h * 0.9 * flicker + this.rimPulse * 0.8);
    this.plateHeat.tint = color;
    this.plateHeat.alpha = h * 0.28;
    this.floor.set(h);
    // Spotlight brightens, warms and tightens.
    this.spotlight.tint = lerp(0x3d4394, color, h * 0.7);
    this.spotlight.alpha = 1 + h * 0.4;
    this.spotlight.scale.set(
      ((2.1 - 0.4 * h) * L.boardSize) / 256,
      ((2.0 - 0.4 * h) * L.boardSize) / 256,
    );
    // Trays and pill.
    for (let i = 0; i < this.trayLift.length; i++) {
      const g = this.trayLift[i]!;
      const pulse = this.trayPulseK[i] ?? 0;
      g.tint = lerp(lerp(0x1c2140, color, h), PALETTE.accent, pulse * TRAY_PULSE_TINT);
      // The "next hand" dim takes the lift glow down with the floor; the pulse comes back over it.
      g.alpha = (0.5 + h * 0.5) * (1 - this.trayDimK) + pulse * TRAY_PULSE_ALPHA;
    }
    this.pillGlow.alpha = h * 0.9 * flicker;
    this.pillGlow.scale.set(
      ((this.streakW + 60) / this.tex.size) * (1 + h * 0.3),
      ((this.streakH + 40) / this.tex.size) * (1 + h * 0.3),
    );
    // Backdrop and post grade.
    this.background?.setHeat(h);
    this.post?.setHeat(Math.max(h, this.resultsGrade));
    this.motes.setHeat(h);
    this.onHeat?.(h);
    this.animateStreakFx(dt, h, color, flicker);
    // Results: the HUD readouts and the hand fade over 300 ms so there is one score on screen.
    if (this.resultsFade >= 0 && this.resultsFade < 1) {
      this.resultsFade = Math.min(1, this.resultsFade + dt / 0.3);
      this.applyHudAlpha();
    }
    // Light leaks decay.
    for (const leak of this.leaks) leak.alpha = Math.max(0, leak.alpha - dt * 1.6);

    // A banner waiting for a 3+ clear's shatter.
    if (this.bannerPending) {
      this.bannerPending.wait -= dt;
      if (this.bannerPending.wait <= 0) {
        const b = this.bannerPending;
        this.bannerPending = null;
        this.bannerHold = 0;
        this.showBanner(b.text, b.streak, b.color);
        if (this.q.burstShards > 0 && b.streak >= 2) this.burstPending = 0;
      }
    }
    // Banner: 220 ms in / 400 hold / 200 out. Band sweeps behind the tiles,
    // text pops in front.
    if (this.bannerT >= 0) {
      this.bannerT += dt;
      const t = this.bannerT;
      const w = L.boardSize + 240;
      // Under the 4X rays the darkening strip deepens so the text stays legible.
      const dark = this.heatTarget >= 0.7 ? 0.55 : 0.4;
      // The fifth-level banner: 1.25x, scaling in with a 120 ms overshoot (~+18%).
      const boost =
        this.bannerBoost === 1
          ? 1
          : this.bannerBoost * (0.85 + 0.15 * easeOutBack(Math.min(1, t / LEVEL_BEAT_POP_S), 2.2));
      if (t < 0.22) {
        const k = easeOutCubic(t / 0.22);
        this.bannerFill.alpha = 0.25 * k;
        this.bannerDark.alpha = dark * k;
        this.bannerEdge.visible = true;
        // Fade over the last 30% of the travel so the edge never parks on the rim.
        this.bannerEdge.alpha = 1 - Math.max(0, (k - 0.7) / 0.3);
        this.bannerEdge.x = -w / 2 + w * k;
        this.bannerText.alpha = Math.min(1, k * 1.5);
        this.bannerText.scale.set(boost * (0.7 + 0.3 * easeOutBack(Math.min(1, t / 0.2), 1.6)));
      } else if (t < 0.62) {
        this.bannerFill.alpha = 0.25;
        this.bannerDark.alpha = dark;
        this.bannerEdge.alpha = Math.max(0, 1 - (t - 0.22) * 5);
        this.bannerText.alpha = 1;
        this.bannerText.scale.set(boost * (1 + 0.02 * Math.sin(t * 30)));
      } else if (t < 0.82) {
        const k = (t - 0.62) / 0.2;
        this.bannerFill.alpha = 0.25 * (1 - k);
        this.bannerDark.alpha = dark * (1 - k);
        this.bannerText.alpha = 1 - k;
        this.bannerText.scale.set(boost * (1 + 0.15 * k));
        this.bannerText.y = L.boardY + L.boardSize / 2 - 30 * k;
      } else {
        this.bannerT = -1;
        this.levelBannerUp = false;
        this.bannerDark.alpha = 0;
        this.bannerBand.visible = false;
        this.bannerText.visible = false;
        this.letterBanner.hide();
        this.bannerText.y = L.boardY + L.boardSize / 2;
      }
      // Per-letter banner: the letters slam in on their own clock; the group
      // takes the hold wobble and the out from the whole-word programme above.
      if (this.bannerT >= 0 && this.q.bannerLetters) {
        const lb = this.letterBanner.container;
        lb.alpha = t < 0.22 ? 1 : this.bannerText.alpha;
        lb.scale.set(t < 0.22 ? boost : this.bannerText.scale.x);
        lb.y = this.bannerText.y;
        this.letterBanner.update(t);
      }
    }

    // Emissive pools under filled tiles: fade in on place, out on clear.
    for (let i = 0; i < this.bleed.length; i++) {
      const b = this.bleed[i];
      const t = this.bleedT[i] ?? 0;
      if (!b || t === 0) continue;
      if (t > 0) {
        const nt = Math.min(1, t + dt * 4);
        this.bleedT[i] = nt;
        b.visible = true;
        b.alpha = 0.16 * easeOutCubic(nt) * (1 + h * 0.6);
      } else {
        const nt = -t - dt * 3;
        if (nt <= 0) {
          this.bleedT[i] = 0;
          b.visible = false;
        } else {
          this.bleedT[i] = -nt;
          b.alpha = 0.16 * nt;
        }
      }
    }
  }

  /** The HUD readouts at the end-of-game dim × the results fade; the hand and trays take the fade alone. */
  private applyHudAlpha(): void {
    const fade = this.resultsFade >= 0 ? 1 - this.resultsFade : 1;
    const a = this.hudDim * fade;
    this.scoreText.alpha = a;
    this.odometer.container.alpha = a;
    this.levelPill.container.alpha = a;
    this.scoreLabel.alpha = a;
    this.timerText.alpha = a;
    this.timerBar.alpha = a;
    this.modePill.alpha = a;
    this.bestText.alpha = a;
    this.handLayer.alpha = fade;
    this.trays.alpha = fade;
  }

  /**
   * The streak VFX that ride the heat value every frame (streak-fx.ts): the
   * rim energy band, heat embers, 4X rim sparks, tile rim light and sheen,
   * and the burst waiting on the banner's leading edge.
   * All of it scales with `h`, so a miss cools it away with the rest.
   */
  private animateStreakFx(dt: number, h: number, color: number, flicker: number): void {
    const L = this.layout;
    const pad = L.gap * 3;
    const px = L.boardX - pad;
    const py = L.boardY - pad;
    const ps = L.boardSize + pad * 2;
    const hot = Math.max(0, Math.min(1, (h - 0.45) / 0.35)); // 0 below 3X, 1 at 4X+
    const texSize = this.tex.size;

    // Rim energy band. The plain stroke underneath thins to half so the band's
    // travelling packets read as the light source, not a second outline.
    if (this.q.rimBand > 0) {
      // The level-up's FILLED cool pulse: the whole band brightens indigo →
      // mint for 300 ms while one packet goes round the perimeter from the
      // top centre (under the pill), quick in, fading out over its lap.
      // The beat's second pulse lands 200 ms behind; the two add (one packet
      // position — the newer one's — and the sum of their lifts).
      let spot: { at: number; k: number; color: number; lift: number } | undefined;
      if (this.levelRim2Due >= 0) {
        this.levelRim2Due -= dt;
        if (this.levelRim2Due <= 0) {
          this.levelRim2Due = -1;
          this.levelRimT2 = 0;
        }
      }
      const liftS = this.levelRimBeat ? LEVEL_BEAT_RIM_LIFT_S : LEVEL_RIM_LIFT_S;
      const liftK = this.levelRimBeat ? LEVEL_BEAT_RIM_K : 1;
      for (const which of [0, 1] as const) {
        let tt = which === 0 ? this.levelRimT : this.levelRimT2;
        if (tt < 0) continue;
        tt += dt;
        const u = tt / LEVEL_RIM_S;
        const l = tt / liftS;
        if (u >= 1) tt = -1;
        if (which === 0) this.levelRimT = tt;
        else this.levelRimT2 = tt;
        if (tt < 0) continue;
        const lift = l < 1 ? Math.min(1, l * 5) * (1 - l * l) * 0.9 * liftK : 0;
        spot = {
          at: 0.5 + u * 4,
          k: Math.min(1, u * 6) * (1 - u * u),
          color: l < 1 ? levelColor(l) : LEVEL_BANNER_COLOR,
          lift: Math.min(2.2, (spot?.lift ?? 0) + lift),
        };
      }
      this.rimBand.set(
        this.timeSec,
        h,
        color,
        Math.min(1, h * 1.5 + this.rimPulse * 0.5),
        this.rimPulse,
        spot,
      );
      this.rimGlow.alpha *= 0.5;
      // One rim system at a time: the legacy chase dot never runs under the band.
      if (this.rimChase >= 0) {
        this.rimChase = -1;
        this.rimLight.visible = false;
      }
    } else {
      this.rimBand.set(0, 0, 0, 0, 0); // tier dropped to low mid-streak: hide, do not freeze
    }

    // Heat embers, Ori-style: tiny saturated cores in soft halos rising off
    // the top edges of filled tiles and hot sockets. Rate ramps from heat 0.3
    // to the tier's cap at 4X; the tint goes ember-orange to amber, never white.
    if (this.q.emberRate > 0 && h >= EMBER_MIN_HEAT) {
      this.emberAcc += dt * this.q.emberRate * Math.min(1, (h - EMBER_MIN_HEAT) / 0.45);
      const emberColor = lerp(0xff7a2a, 0xffc46a, Math.max(0, Math.min(1, (h - 0.5) / 0.25)));
      const speed = L.boardSize * (0.14 + 0.1 * h);
      while (this.emberAcc >= 1) {
        this.emberAcc -= 1;
        // Pick a random source among lit cells without allocating: count, then walk.
        let count = 0;
        for (let i = 0; i < this.cells.length; i++)
          if (this.cellFilled(i) || (this.heatT[i] ?? 0) > 0.2) count++;
        if (count === 0) break;
        let pick = Math.floor(Math.random() * count);
        for (let i = 0; i < this.cells.length; i++) {
          if (!(this.cellFilled(i) || (this.heatT[i] ?? 0) > 0.2)) continue;
          if (pick-- > 0) continue;
          const sp = this.cells[i]!.sprite;
          // The ember's lower tip starts 0.15 cell above the tile's top edge
          // (its centre ~0.3 cell higher); never inside the tile above it, and
          // it dies if it drifts onto a face (an ember across a face reads as
          // a scratch).
          const above = i - RULES.cols;
          if (above >= 0 && this.cellFilled(above)) break;
          this.particles.rise(
            sp.x + (Math.random() - 0.5) * L.cell * 0.8,
            sp.y - L.cell * 0.95,
            emberColor,
            L.cell / texSize,
            speed,
            hot,
          );
          break;
        }
      }
    } else {
      this.emberAcc = 0;
    }

    // 4X: sparks jump off the rim inward over the tiles.
    if (this.q.rimSparks > 0 && h >= 0.68) {
      this.rimSparkAcc += dt * this.q.rimSparks * (0.6 + (h - 0.68) * 1.5);
      while (this.rimSparkAcc >= 1) {
        this.rimSparkAcc -= 1;
        const d = Math.random() * 4;
        let x: number;
        let y: number;
        let nx = 0;
        let ny = 0;
        if (d < 1) {
          x = px + d * ps;
          y = py;
          ny = 1;
        } else if (d < 2) {
          x = px + ps;
          y = py + (d - 1) * ps;
          nx = -1;
        } else if (d < 3) {
          x = px + (3 - d) * ps;
          y = py + ps;
          ny = -1;
        } else {
          x = px;
          y = py + (4 - d) * ps;
          nx = 1;
        }
        const v = L.cell * (3 + Math.random() * 4);
        const tang = (Math.random() - 0.5) * v * 1.2;
        // A short dash with a core, like a clear's sparks (the plate mask
        // clips it at the rim, so it never crosses into the HUD band); a
        // full-stretch hairline read as a scratch across the sockets.
        this.particles.spark(
          x,
          y,
          0xfff6e0,
          nx * v - ny * tang,
          ny * v + nx * tang - L.cell * 1.5,
          (L.cell * 0.7) / texSize,
          0.25 + Math.random() * 0.25,
          RIM_SPARK_CORE_PX,
          L.cell / texSize,
        );
      }
    } else {
      this.rimSparkAcc = 0;
    }

    // Tile rim light (from heat 0.5, breathing with the pill) and the sheen.
    this.tileGlow.update(dt, h, color, (flicker - 0.7) / 0.3, this.q.tileRim, this.cellFilled);
    // The level rays light sockets, rim and room only: feed them the tiles.
    if (this.post?.raysMaskingTiles) this.post.setRayTiles(this.cellTiled);

    // The rays are attenuated inside the banner band while it is up.
    this.post?.setBannerBand(
      this.bannerT >= 0 ? (L.boardY + L.boardSize / 2 - L.cell * 1.1) / this.app.screen.height : -1,
      this.bannerT >= 0 ? (L.boardY + L.boardSize / 2 + L.cell * 1.1) / this.app.screen.height : -1,
    );

    // Streak-increment burst, on the banner's leading edge.
    if (this.burstPending >= 0) {
      this.burstPending += dt;
      if (this.burstPending >= BANNER_BURST_AT_S) {
        this.burstPending = -1;
        this.streakBurst();
      }
    }
    // The level burst, on the LEVEL banner's leading edge.
    if (this.levelBurstPending >= 0) {
      this.levelBurstPending += dt;
      if (this.levelBurstPending >= BANNER_BURST_AT_S) {
        this.levelBurstPending = -1;
        this.levelBurst();
      }
    }
  }

  private animateHeat(dt: number): void {
    for (let i = 0; i < this.heat.length; i++) {
      const t = this.heatT[i] ?? 0;
      const h = this.heat[i];
      const core = this.heatCore[i];
      if (!h || !core) continue;
      if (t <= 0) {
        if (h.visible) h.visible = false;
        if (core.visible) core.visible = false;
        continue;
      }
      if ((this.heatDelay[i] ?? 0) > 0) {
        // Waiting for the shatter (3+ lines): the trace lights as the tiles go.
        this.heatDelay[i] = (this.heatDelay[i] ?? 0) - dt;
        if (h.visible) h.visible = false;
        if (core.visible) core.visible = false;
        continue;
      }
      const nt = Math.max(0, t - dt / 1.0);
      this.heatT[i] = nt;
      h.visible = true;
      // Peaks at 120 ms, then an ease-out cubic decay over the rest of the
      // second. The radial frame peaks at ~0.5 in its core, so alpha 1 here is
      // an effective 0.5 of light where neighbours overlap.
      const age = 1 - nt;
      const env = age < 0.12 ? age / 0.12 : 1 - Math.pow((age - 0.12) / 0.88, 3);
      // Two-line traces run dimmer, and where a row and a column cross the two add: each at HOT_CROSS_K.
      h.alpha = env * (this.heatGain[i] ?? 1);
      // Radials stretched 3.4 cells along the line overlap their neighbours
      // into one continuous trace rather than a row of discs.
      const axis = this.heatAxis[i] ?? 3;
      const cell = this.layout.cell;
      const along = (cell * 3.4) / 256;
      const across = (cell * (1.1 + 0.2 * nt)) / 256;
      h.scale.set(axis === 2 ? across : along, axis === 1 ? across : along);
      // The core: 2.8 cells along, 0.5 across, whiter — the filament inside
      // the coloured halo that makes the trace read as light.
      // The core keeps the full envelope (only a crossing halves it): the
      // pool's multiline dimming is what makes the filament read at all.
      core.visible = (this.heatCoreOn[i] ?? 0) === 1;
      core.alpha = env * HOT_CORE_K * (axis === 3 ? HOT_CROSS_K : 1);
      const cAlong = (cell * 2.8) / 256;
      const cAcross = (cell * 0.5) / 256;
      core.scale.set(axis === 2 ? cAcross : cAlong, axis === 1 ? cAcross : cAlong);
    }
    if (this.rimChase >= 0) {
      const L = this.layout;
      const pad = L.gap * 3;
      const px = L.boardX - pad;
      const py = L.boardY - pad;
      const ps = L.boardSize + pad * 2;
      this.rimChase += dt / 1.2;
      const t = this.rimChase % 1;
      const perim = ps * 4;
      const d = t * perim;
      let x: number;
      let y: number;
      if (d < ps) {
        x = px + d;
        y = py;
      } else if (d < ps * 2) {
        x = px + ps;
        y = py + (d - ps);
      } else if (d < ps * 3) {
        x = px + ps - (d - ps * 2);
        y = py + ps;
      } else {
        x = px;
        y = py + ps - (d - ps * 3);
      }
      this.rimLight.visible = true;
      this.rimLight.position.set(x, y);
      // Fade across the rounded corners so no glint sits outside the rim.
      const cr = L.cell * 0.35;
      const edgePos = d % ps;
      const cornerK = Math.min(1, Math.min(edgePos, ps - edgePos) / cr);
      this.rimLight.alpha = 0.9 * cornerK;
      if (this.rimChase >= 2) {
        this.rimChase = -1;
        this.rimLight.visible = false;
      }
    }
  }

  /**
   * Tile material, every frame: the light rig (fixed key, the dragged piece
   * as a moving light), which cells the lit mesh owns (the rest keep their
   * sprites), the rim light each tile gets from the hot line and the plate's
   * rim band, the soft occlusion under a lifted piece, and the contact-AO
   * stamps fading with the emissive pools.
   */
  private animateMaterial(dt: number): void {
    const L = this.layout;
    const q = this.q;
    const litTier = q.tileLight > 0;
    const texSize = this.tex.size;
    const pitch = L.cell + L.gap;
    const B = L.boardSize;
    const d = this.drag;
    const landing = this.landT >= 0 && !this.landContact;

    // Light rig. Lifted piece: the key steps back and the piece light eases in
    // at its footprint; released: the light rides the fall, then fades out.
    const keyTarget = d || landing ? KEY_LIFTED : 1;
    this.keyK += (keyTarget - this.keyK) * Math.min(1, dt * 8);
    let lightTarget = 0;
    let lift = 0;
    let topX = 0;
    let topY = 0;
    let occlOn = false;
    if (d) {
      lift = this.dragLiftK(d);
      topX = d.x;
      topY = d.y;
      lightTarget = 1;
      occlOn = true;
    } else if (landing) {
      const sc = this.landLayer.scale.x;
      topX = this.landLayer.x - this.landLayer.pivot.x * sc;
      topY = this.landLayer.y - this.landLayer.pivot.y * sc;
      lift = this.landLift * (1 - Math.min(1, this.landT / LAND_TRAVEL_S));
      lightTarget = 1;
      occlOn = true;
    }
    if (occlOn) {
      // Footprint centre, at board pitch (the drop position, not the tilted drawing).
      let fx = 0;
      let fy = 0;
      for (let k = 0; k < this.footprintN; k++) {
        fx += this.footprint[k * 2] ?? 0;
        fy += this.footprint[k * 2 + 1] ?? 0;
      }
      const n = Math.max(1, this.footprintN);
      this.lightX = topX + fx / n;
      this.lightY = topY + fy / n;
      this.lightZ = L.cell * (PIECE_LIGHT_Z + PIECE_LIGHT_Z_LIFT * lift);
    }
    // In over ~80 ms on grab; out over ~50 ms once the piece is down, so the
    // landed tiles are not left glowing under a light that is now them.
    this.lightK +=
      (lightTarget - this.lightK) * Math.min(1, dt * (lightTarget > this.lightK ? 12 : 20));
    this.material.setKey(
      L.boardX + KEY_RIG.x * B,
      L.boardY + KEY_RIG.y * B,
      KEY_RIG.z * B,
      KEY_RIG.range * B,
      this.keyK,
    );
    this.material.setLight(
      this.lightX,
      this.lightY,
      this.lightZ,
      this.lightColor,
      L.cell * PIECE_LIGHT_RANGE,
      this.lightK * PIECE_LIGHT_K,
      L.cell * PIECE_GEM_FADE,
    );

    // Hot cells this frame (the hot line), for the rim light.
    let nHot = 0;
    if (litTier) {
      for (let j = 0; j < this.heat.length; j++) {
        const hs = this.heat[j];
        if (!hs || !hs.visible || (this.heatT[j] ?? 0) <= 0) continue;
        this.hotIdx[nHot] = j;
        this.hotA[nHot] = hs.alpha;
        const t = hs.tint;
        this.hotCol[nHot * 3] = ((t >> 16) & 0xff) / 255;
        this.hotCol[nHot * 3 + 1] = ((t >> 8) & 0xff) / 255;
        this.hotCol[nHot * 3 + 2] = (t & 0xff) / 255;
        nHot++;
      }
    }
    const h = this.heatLevel;
    const bandK = Math.max(0, (h - 0.5) / 0.5);
    const bandColor = this.heatColor(h);
    const br = ((bandColor >> 16) & 0xff) / 255;
    const bg = ((bandColor >> 8) & 0xff) / 255;
    const bb = (bandColor & 0xff) / 255;
    const occlK = HOVER_OCCL * lift;
    // Where the piece's shadow lands: the footprint shifted like the shadow.
    const shX = topX + shadowShiftX(lift, L.cell);
    const shY = topY + shadowShiftY(lift, L.cell);

    this.material.begin();
    for (let i = 0; i < this.cells.length; i++) {
      const v = this.cells[i]!;
      // A cell waiting for its clear flash (colour already -1) stays lit
      // until the flash owns it, so nothing pops back to the painted bake.
      const waitingClear = v.anim === 'clear' && v.delay > 0;
      const colorIdx =
        v.color >= 0 ? v.color : waitingClear ? this.tileIndexOf(v.sprite.texture) : -1;
      const lit =
        litTier &&
        colorIdx >= 0 &&
        (v.anim !== 'clear' || waitingClear) &&
        !(v.anim === 'pop' && v.delay > 0) &&
        v.sprite.texture !== this.tex.socket;
      v.sprite.visible = !lit;
      const r = Math.floor(i / RULES.cols);
      const c = i % RULES.cols;
      if (lit) {
        const sp = v.sprite;
        this.material.place(i, sp.x, sp.y, (sp.scale.x * texSize) / 2, (sp.scale.y * texSize) / 2);
        // Soft occlusion under the lifted piece.
        let occl = 0;
        if (occlOn && occlK > 0.002) {
          let best = Infinity;
          for (let k = 0; k < this.footprintN; k++) {
            const gx = shX + (this.footprint[k * 2] ?? 0);
            const gy = shY + (this.footprint[k * 2 + 1] ?? 0);
            const ex = sp.x - gx;
            const ey = sp.y - gy;
            const dist = Math.sqrt(ex * ex + ey * ey) / pitch;
            if (dist < best) best = dist;
          }
          occl = occlK * Math.max(0, 1 - Math.max(0, best - 0.35) / HOVER_OCCL_REACH);
        }
        const flash = v.flash > 0 ? Math.sin((1 - v.flash / BLOCK_FLASH_S) * Math.PI) : 0;
        // The pressure ripple's crest lifts the face (a negative occlusion), its trough dips it.
        this.material.setTile(i, colorIdx, occl - (this.rippleMod[i] ?? 0), flash);
        // Rim light: the plate's rim band from the nearest edges, plus every hot cell nearby.
        let vx = 0;
        let vy = 0;
        let sw = 0;
        let cr = 0;
        let cg = 0;
        let cb = 0;
        if (bandK <= 0 && nHot === 0) {
          this.material.setRim(i, 0, 0, 0, 0, 0, 0);
        } else {
          if (bandK > 0) {
            for (let e = 0; e < 4; e++) {
              const dist =
                e === 0
                  ? c + 0.5
                  : e === 1
                    ? RULES.cols - c - 0.5
                    : e === 2
                      ? r + 0.5
                      : RULES.rows - r - 0.5;
              const w = bandK * Math.max(0, 1 - (dist - 0.5) / RIM_BAND_REACH);
              if (w <= 0) continue;
              vx += w * (e === 0 ? -1 : e === 1 ? 1 : 0);
              vy += w * (e === 2 ? -1 : e === 3 ? 1 : 0);
              sw += w;
              cr += w * br;
              cg += w * bg;
              cb += w * bb;
            }
          }
          for (let k = 0; k < nHot; k++) {
            const j = this.hotIdx[k] ?? 0;
            const ddx = (j % RULES.cols) - c;
            const ddy = Math.floor(j / RULES.cols) - r;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy);
            if (dist < 0.5) continue;
            const w =
              (this.hotA[k] ?? 0) * HOT_LINE_RIM * Math.max(0, 1 - (dist - 1) / HOT_LINE_REACH);
            if (w <= 0) continue;
            vx += (w * ddx) / dist;
            vy += (w * ddy) / dist;
            sw += w;
            cr += w * (this.hotCol[k * 3] ?? 0);
            cg += w * (this.hotCol[k * 3 + 1] ?? 0);
            cb += w * (this.hotCol[k * 3 + 2] ?? 0);
          }
          const len = Math.sqrt(vx * vx + vy * vy);
          if (sw > 0) {
            this.material.setRim(
              i,
              len > 1e-4 ? vx / len : 0,
              len > 1e-4 ? vy / len : 0,
              Math.min(1, sw),
              cr / sw,
              cg / sw,
              cb / sw,
            );
          } else {
            this.material.setRim(i, 0, 0, 0, 0, 0, 0);
          }
        }
      } else {
        this.material.setTile(i, -1, 0, 0);
      }
      // Contact AO: with the emissive pool's timing, in only after the landing.
      if (q.contactShadow) {
        const t = this.bleedT[i] ?? 0;
        let k = 0;
        if (this.cellFilled(i)) {
          if (t > 0) k = easeOutCubic(Math.max(0, (t - AO_FADE_START) / (1 - AO_FADE_START)));
        } else if (t < 0) {
          k = -t;
        }
        // The ripple's crest lifts the contact shadow beside it as it passes.
        const rip = this.rippleMod[i] ?? 0;
        if (rip > 0) k *= Math.max(0, 1 - rip * 2);
        this.contactAO.set(i, k);
      }
    }
    this.material.commit();
  }

  private animateHud(dt: number): void {
    const L = this.layout;
    // GO: the HUD's readouts slide in from above, 40 ms apart per group.
    if (this.hudInT >= 0) {
      this.hudInT += dt;
      const groups = this.hudGroups();
      let done = true;
      for (let g = 0; g < groups.length; g++) {
        const u = Math.max(0, Math.min(1, (this.hudInT - g * HUD_IN_STAGGER_S) / HUD_IN_S));
        if (u < 1) done = false;
        const k = easeOutCubic(u);
        for (const el of groups[g]!) {
          el.alpha = k;
          el.pivot.y = HUD_IN_PX * (1 - k);
        }
      }
      if (done) {
        this.hudInT = -1;
        this.hudParked = false;
      }
    }
    // Score counts up toward the target.
    if (this.q.odometer) {
      // Continuous ease (8/s, a 40/s floor so the last digit never crawls);
      // the odometer slides its columns from the fraction.
      if (this.displayedScore !== this.targetScore) {
        const diff = this.targetScore - this.displayedScore;
        const step = Math.max(Math.abs(diff) * Math.min(1, dt * 8), dt * 40);
        this.displayedScore += Math.sign(diff) * Math.min(Math.abs(diff), step);
        this.odometer.set(this.displayedScore);
        this.scoreText.text = String(Math.round(this.displayedScore));
      }
      this.odometer.update(dt);
    } else if (this.displayedScore !== this.targetScore) {
      const diff = this.targetScore - this.displayedScore;
      const step = Math.max(1, Math.abs(diff) * Math.min(1, dt * 8));
      this.displayedScore += Math.sign(diff) * Math.min(Math.abs(diff), Math.ceil(step));
      this.scoreText.text = String(Math.round(this.displayedScore));
    }
    // Level pill: the ring follows the displayed score inside the shown level
    // (a queued level-up holds it full until its ceremony rolls the number).
    this.levelPill.setProgress(levelProgress(this.displayedScore, this.levelPill.shownLevel));
    // One emphasised pill at a time: while the streak pill is up the level
    // pill's pop (and its glow) wait for it to retire.
    this.levelPill.setHold(this.streakPill.visible);
    this.levelPill.update(dt);
    if (!L.compact) {
      const digitsW = this.q.odometer ? this.odometer.width : this.scoreText.width;
      if (digitsW !== this.levelDockW) {
        this.levelDockW = digitsW;
        this.placeLevelPill();
      }
    }
    if (this.levelQueue.length > 0) {
      this.levelDelay -= dt;
      if (this.levelDelay <= 0) {
        if (this.bannerT >= 0 && this.bannerT < LEVEL_BANNER_S && !this.levelBannerUp) {
          // A streak banner started while we waited: yield to it again.
          this.levelDelay = this.bannerWait();
        } else {
          const lv = this.levelQueue.shift();
          if (lv !== undefined) {
            this.levelCeremony(lv);
            this.levelBannerUp = this.q.levelFx > 0;
            if (this.levelQueue.length > 0) this.levelDelay = LEVEL_BANNER_S + LEVEL_QUEUE_GAP_S;
          }
        }
      }
    }
    // Timer text and depletion bar.
    const remaining = this.controller.remainingMs;
    this.onClock?.(remaining);
    const sec = Math.ceil(remaining / 1000);
    if (sec !== this.lastTimerSec) {
      this.lastTimerSec = sec;
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      this.timerText.text = `${m}:${s.toString().padStart(2, '0')}`;
      this.timerText.style.fill =
        sec <= 10 ? PALETTE.danger : sec <= 30 ? PALETTE.accentWarm : PALETTE.text;
    }
    const barSec = Math.floor(remaining / 250);
    if (barSec !== this.lastBarSec) {
      this.lastBarSec = barSec;
      const frac = remaining / RULES.durationMs;
      const w = Math.max(60, this.timerText.width);
      const x = L.boardX + L.boardSize - w;
      const y = L.boardY - L.gap * 3 - 6;
      const color =
        frac > 0.33 ? PALETTE.accent : frac > 0.12 ? PALETTE.accentWarm : PALETTE.danger;
      this.timerBar
        .clear()
        .roundRect(x, y, w, 3, 1.5)
        .fill({ color: PALETTE.bgDeep, alpha: 0.9 })
        .roundRect(x + w * (1 - frac), y, w * frac, 3, 1.5)
        .fill({ color });
    }
    if (sec <= 10 && sec > 0 && this.controller.current.status === 'playing') {
      const frac = (remaining % 1000) / 1000;
      this.timerText.scale.set(1 + 0.08 * (1 - frac));
    } else {
      this.timerText.scale.set(1);
    }
    // Streak pill enter/pulse.
    if (this.streakPill.visible) {
      // Compact screens: the pill yields to the banner so they never collide with the top row.
      this.streakPill.alpha = L.compact && this.bannerT >= 0 ? 0 : 1;
      // Pressure: drains with hesitation, refills on placement (see the field doc).
      this.sincePlaceS += dt;
      const target = Math.max(0, 1 - this.sincePlaceS / PRESSURE_DRAIN_S);
      this.pressure +=
        (target - this.pressure) * Math.min(1, dt * (target > this.pressure ? 10 : 2));
      const urgency = 1 - this.pressure;
      // Tint: warm → danger with urgency; from 3X the calm ring takes the heat
      // colour like the banner (white-hot at 4X), urgency still winning.
      const heat = this.heatLevel;
      const hot = Math.max(
        0,
        Math.min(1, (heat - RING_HEAT_FROM) / (RING_HEAT_TO - RING_HEAT_FROM)),
      );
      const tint = lerp(
        lerp(PALETTE.accentWarm, PALETTE.danger, urgency * urgency),
        this.heatColor(heat),
        hot * (1 - urgency),
      );
      // The ring itself: the fill is continuous (a uniform, every frame). While
      // the compact HUD hides the pill under the banner the refill waits.
      this.pressureRing.update(dt, this.pressure, target, tint, 1, this.streakPill.alpha === 0);
      const age = this.timeSec - this.streakShownAt;
      const enter = Math.min(1, age / 0.2);
      const pulse = Math.sin(Math.min(1, 1 - this.streakPulse) * Math.PI) * 0.25;
      this.streakPill.scale.set(0.6 + 0.4 * easeOutBack(enter, 1.6) + pulse);
      this.streakPulse = Math.max(0, this.streakPulse - dt / 0.22);
      if (this.streakStrokeFlash > 0) {
        this.streakStrokeFlash = Math.max(0, this.streakStrokeFlash - dt * 4);
        if (this.streakStrokeFlash === 0) {
          const w = this.streakW;
          const h = this.streakH;
          this.streakBg
            .clear()
            .roundRect(-w / 2, -h / 2, w, h, h / 2)
            .fill({ color: PALETTE.accentWarm, alpha: 0.16 })
            .stroke({ color: PALETTE.accentWarm, width: 1, alpha: 0.9 });
        }
      }
    }
  }

  /**
   * The glyph caches (banner letters, float score, streak pill) bake their
   * alphabets ahead, one glyph a frame, round robin: the countdown absorbs
   * the lot, and a re-bake after a resize costs a frame a few ms, never the
   * clear frame.
   */
  private bakeAhead(): void {
    if (this.letterBanner.pending) this.letterBanner.step();
    else if (this.floatText.pending) this.floatText.step();
    else if (this.streakCache.pending) this.streakCache.step(1);
  }

  private animateCountdown(dt: number): void {
    if (this.goT >= 0) {
      // The front climbs bottom → top over GO_GRID_S; each socket's rim
      // flashes for GO_ROW_S as it passes and the fill rides the front.
      this.goT += dt;
      const L = this.layout;
      let any = false;
      let frontRow = -1;
      let frontK = 0;
      for (let r = 0; r < RULES.rows; r++) {
        const onset = ((RULES.rows - 1 - r) / (RULES.rows - 1)) * GO_GRID_S;
        const u = (this.goT - onset) / GO_ROW_S;
        const a = u > 0 && u < 1 ? Math.sin(u * Math.PI) * GO_ROW_ALPHA : 0;
        if (a > 0 && a >= frontK) {
          frontK = a;
          frontRow = r;
        }
        for (let c = 0; c < RULES.cols; c++) {
          const o = this.goRims[r * RULES.cols + c]!;
          o.visible = a > 0.004;
          if (o.visible) {
            o.alpha = a;
            any = true;
          }
        }
      }
      this.goFill.visible = frontRow >= 0;
      if (frontRow >= 0) {
        this.goFill.y = cellToXY(L, frontRow, 0).y + L.cell / 2;
        this.goFill.alpha = (frontK / GO_ROW_ALPHA) * GO_FILL_ALPHA;
      }
      if (!any && this.goT > GO_GRID_S) {
        this.goT = -1;
        this.goFill.visible = false;
        this.goLayer.visible = false;
      }
    }
    const c = this.countdown;
    if (!c) return;
    const stepS = c.value === 0 ? COUNT_GO_S : COUNT_STEP_S;
    c.t += dt;
    const t = Math.min(1, c.t / stepS);
    this.countdownText.text = c.value === 0 ? 'GO' : String(c.value);
    // Scale in 1.4 → 1 with a back-ease (it overshoots under 1 and settles),
    // then a slow drift down through the hold; out over the last quarter.
    const inK = this.reducedMotion ? 1 : easeOutBack(Math.min(1, c.t / COUNT_IN_S), COUNT_BACK);
    const scale = COUNT_SCALE_FROM + (1 - COUNT_SCALE_FROM) * inK;
    this.countdownText.scale.set(scale * (1 - 0.05 * t));
    this.countdownText.alpha = Math.min(1, c.t / 0.04) * (t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25);
    if (t >= 1) {
      if (c.value === 0) {
        this.countdown = null;
        this.countdownText.visible = false;
        c.resolve();
        return;
      }
      c.value -= 1;
      c.t = 0;
      this.onCountdown?.(c.value);
      this.countdownBeat(c.value);
    }
  }

  /**
   * Compile every program and warm the pools before the first real frame, so
   * the first line clear never stalls on a shader compile.
   */
  private prewarm(): void {
    this.particles.burst(-500, -500, 0xffffff, 8, 10, 0.1);
    this.particles.dust(-500, -500, 0xffffff, 2, 10, 0.1);
    this.oneShots.sweep(this.tex, -600, -600, -500, -500, 0xffffff, 10, 0.05);
    this.oneShots.sweep(this.tex, -600, -600, -500, -500, 0xffffff, 10, 0.05, 30, 0, 1, true);
    this.oneShots.ring(this.tex, -500, -500, 0xffffff, 1, 2, 0.05);
    this.oneShots.ring(this.tex, -500, -500, 0xffffff, 1, 2, 0.05, 0.5, 1);
    this.oneShots.ring(this.tex, -500, -500, 0xffffff, 1, 2, 0.05, 0.5, 2);
    this.oneShots.lineHighlight(this.tex, -500, -500, 10, true, 0xffffff, 0.05);
    this.oneShots.lineGlow(this.tex, -500, -500, 10, 10, true, 0xffffff, 0.05);
    this.floatText.show(-500, -500, '+0', PALETTE.text, 1, 0.05);
    this.particles.rise(-500, -500, 0xffffff, 0.1, 10, 0);
    this.particles.shards(-500, -500, 0xffffff, 2, 10, 0.1);
    this.burstParticles.shards(-500, -500, 0xffffff, 2, 10, 0.1);
    this.burstFx.puff(this.tex, -500, -500, 0xffffff, 4, 0.05, 0.5);
    this.fracture.burst(-500, -500, 0, 6, 0, 0, 1, PALETTE.accentWarm);
    this.rimBand.set(0, 0.5, PALETTE.accentWarm, 0.01, 0);
    this.pressureRing.layout(100, 30);
    this.pressureRing.update(0.02, 0.5, 0.5, PALETTE.accentWarm, 0.01, false);
    this.streakPill.visible = true;
    this.ribbons.spawn(-600, -600, -590, -600, -580, -600, -570, -600, 0xffffff, 4, 0.05);
    this.ribbons.update(0.01);
    this.holoGhost.show(-500, -500, 2, 2, 0xf, 10, 10, 12, 0xffffff, 0.01, 2, 4, 1, 1);
    this.holoGhost.set(0, 0.5);
    this.holoLines[0]?.show(-500, -500, 1, 1, 1, 40, 10, 12, 0xffffff, 0.01, 2, 4, 0.5, 0.7);
    this.beam.show(-520, -520, -500, -480, 4, 4, 0xffffff, 0.01, 0, 0);
    if (this.q.odometer) this.odometer.set(9.5); // a rolling column
    this.levelPill.pop();
    this.levelPill.setProgress(0.5);
    this.levelPill.update(0.02);
    this.letterBanner.show('LEVEL', PALETTE.accentWarm);
    this.letterBanner.update(0.05);
    this.letterBanner.container.alpha = 0.01;
    this.dragLayer.visible = true;
    this.dragLayer.position.set(-1000, -1000);
    this.dragShadow.alpha = 0.01;
    this.material.begin();
    this.material.place(0, -500, -500, 20, 20);
    this.material.setTile(0, 0, 0, 0);
    this.material.setRim(0, 0, 0, 0, 0, 0, 0);
    this.material.commit();
    this.contactAO.place(0, -500, -500, 40);
    this.contactAO.set(0, 0.5);
    this.pieceShadow.setShape([{ x: 0, y: 0 }], 40);
    this.pieceShadow.set(-500, -500, 0, 0, 0, 1, 0.5, 40, 1);
    const g = this.ghostFill[0];
    const o = this.ghostOutline[0];
    const h = this.lineHints[0];
    if (g) g.visible = true;
    if (o) o.visible = true;
    if (h) h.visible = true;
    this.countdownText.visible = true;
    this.countdownText.alpha = 0.01;
    this.results.prewarm();
    this.worldScene.prewarm(true);
    this.camera.update(0);
    this.floor.capture(this.app.renderer, this.reflectionSource);
    this.app.renderer.render(this.app.stage);
    this.results.prewarmDone();
    this.worldScene.prewarm(false);
    this.streakPill.visible = false;
    this.dragLayer.visible = false;
    this.dragShadow.alpha = 0;
    this.material.begin();
    this.material.commit();
    this.contactAO.set(0, 0);
    this.pieceShadow.hide();
    if (g) g.visible = false;
    if (o) o.visible = false;
    if (h) h.visible = false;
    this.countdownText.visible = false;
    this.countdownText.alpha = 1;
    this.holoGhost.hide();
    this.holoLines[0]?.hide();
    this.beam.hide();
    this.odometer.reset(this.displayedScore);
    this.levelPill.update(2);
    this.levelPill.setProgress(0);
    this.levelPill.update(2);
    this.letterBanner.hide();
    this.letterBanner.container.alpha = 1;
    this.particles.update(1);
    this.burstParticles.update(1);
    this.oneShots.update(1);
    this.burstFx.update(1);
    this.ribbons.update(1);
    this.fracture.update(1);
    this.rimBand.set(0, 0, 0, 0, 0);
    this.floatText.update(1);
  }
}

/**
 * The hot line's tint: the tile colour at full saturation, lightened 40%, so
 * additive light over the navy sockets still reads as that colour (sky and
 * mint were going steel-grey) and its core runs warm-white.
 */
/**
 * The hologram's colour: the piece colour with its saturation pushed 30% and
 * only a touch lighter, so the additive projection over a navy socket is
 * unmistakably that piece's candy hue, not a generic cyan.
 */
/** The piece colour index of a line hue (-1 when it is the mixed-line fallback). */
function hueIndexOf(hue: number): number {
  return PIECE_COLORS.indexOf(hue);
}

/** The clear sweep's bar: the line's hue at full saturation, a quarter lighter — a coloured light, never a white bar. */
function sweepTint(color: number): number {
  const [h, s, l] = toHsl(color);
  return fromHsl(h, Math.min(1, s * 1.35), l + (1 - l) * 0.25);
}

/** Landing weight, 0..1 → the squash / ripple strength: a domino keeps MASS_FLOOR of the full effect. */
function massK(mass: number): number {
  return MASS_FLOOR + (1 - MASS_FLOOR) * Math.max(0, Math.min(1, mass));
}

function ghostTint(color: number): number {
  const [h, s, l] = toHsl(color);
  return fromHsl(h, Math.min(1, s * 1.3), l + (1 - l) * 0.08);
}

function hotLineTint(color: number): number {
  const [h, s, l] = toHsl(color);
  return fromHsl(h, Math.min(1, s * 1.35), l + (1 - l) * 0.4);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
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
