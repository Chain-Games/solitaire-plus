import type { GameEvent, PileId } from '@solitaire-plus/sim';
import { assetUrl } from '../assets.js';
import type { CardCueId } from './cardfx.js';
import { type HapticKind, haptic } from './haptics.js';
import { SynthCues } from './synth.js';

/**
 * Event-driven audio. Subscribes to sim events and plays a cue per event;
 * never inspects state. Solitaire Plus is Blockari's engine with the card
 * cues added (docs/SPEC.md §8): the music, stems, ambience, clock close,
 * streak / level / countdown / results / coin cues are Blockari's as they
 * were; the playfield's card sounds are `cue(name)` (see CARD CUES below). The values it takes from outside the event stream
 * are pushed to it: the streak heat (`setHeat`), the streak level
 * (`setStreak`, also derived from `scored` / `streakBroken`), the clock
 * (`setClock`, for the last-20-seconds low-pass) and the world (`setWorld`,
 * for the ambience bed).
 *
 * Assets are generated offline by `tools/audiogen` and committed under
 * `public/audio/` with a manifest (id -> file, duration, gain, loop point).
 * The manifest is fetched lazily on the first `unlock()` — a user gesture —
 * and decoded into buffers. Until it arrives, and if it never does, the
 * alpha's synthesised cues (`synth.ts`) play instead, so the game is never
 * silent and never blocks on a fetch. Ambience beds are fetched on demand
 * per world (one 30 s bed a session, not ten).
 *
 * Graph:
 *
 *   sfx voices ─> sfxBus ─┬─> sfxLevel ─> master ─> destination
 *   ui voices ──┘         └─> analyser (sidechain key)
 *   bgm ─────> bgmGain ─┐
 *   rhythm ──> rhyGain ─┤
 *   lead ────> leadGain ├─> musicSum ─> lowpass ─> clockDip ─> duck ─> musicLevel ─> master
 *   hot ─────> hotGain ─┘
 *   ambience A/B ─> ambGain ─> ambBus ─> ambLevel(effects slider) ─> master
 *
 * STEMS. The bed and its two derived layers (`bgm-rhythm`, `bgm-lead`) and
 * the hot loop are all started at the same instant and never re-triggered;
 * the ride is gain only (RIDE, below), 250 ms equal-power ramps keyed to the
 * streak level. Phase-lock is by construction: the stems are the same length
 * as the bed and loop on its loopEnd.
 *
 * The duck is a real sidechain: a follower reads the SFX bus envelope every
 * ~16 ms and drives `duck.gain` toward a reduction proportional to that
 * envelope (10 ms attack, 250 ms release), -3.5 dB on hits and -5 dB on clears.
 * Nothing about the music is a fixed ramp.
 *
 * See docs/audio.md for the cue list, the ride table and the acceptance gate.
 */

export type ManifestKind = 'sfx' | 'ui' | 'music' | 'stem' | 'ambience';

interface ManifestEntry {
  readonly kind: ManifestKind;
  readonly file: string;
  readonly alt: string;
  readonly duration: number;
  readonly gain: number;
  readonly loop?: boolean;
  readonly loopEnd?: number;
  readonly world?: string;
  readonly stemOf?: string;
}

interface Manifest {
  readonly version: number;
  readonly cues: Record<string, ManifestEntry>;
}

/**
 * What `handle` accepts: the sim's events, plus the controller's own
 * (`revealed` / `pending` / `resync`, which make no sound). Structural, so the
 * audio does not import the game layer.
 */
export type AudioEvent = GameEvent | { readonly type: 'revealed' | 'pending' | 'resync' };

/**
 * CARD CUES — the names the playfield passes to `cue(name, arg?)`, and the
 * file each one plays (public/audio/sfx/<file>, rendered by tools/cardfx from
 * src/audio/cardfx.ts):
 *
 *   card-place   card-place        a card settles on a tableau pile   (haptic tick)
 *   card-flip    card-flip         a face-down card turns up
 *   card-draw    card-draw         stock -> waste
 *   recycle      recycle           waste back to the stock
 *   foundation   foundation + foundation-tone, the tone pitched up the
 *                major scale by `arg` = rank 1..13 when given, else up a
 *                pentatonic by the current streak                    (haptic tap)
 *   return       return            off a foundation                   (haptic tick)
 *   cascade      cascade + foundation-tone, one rising step per call;
 *                see `cascadeCue` for the one-call-starts-a-run mode  (haptic tick)
 *   shuffle      shuffle           the deal-in
 *   rejected     card-reject       an illegal drop snapping back      (haptic thump)
 *   undo         undo
 *
 * Until the playfield sends a name, the matching sim event plays it (moved,
 * flipped, drew, recycled, undone, scored{foundation}, dealt); the first
 * `cue(name)` takes that name over for the session, deduped against an event
 * that played it within CONTACT_DEDUP_S — one sound per card either way.
 */
export type CardCue =
  | 'card-place'
  | 'card-flip'
  | 'card-draw'
  | 'recycle'
  | 'foundation'
  | 'return'
  | 'cascade'
  | 'shuffle'
  | 'rejected'
  | 'undo';

const CARD_CUE_FILE: Readonly<Record<CardCue, CardCueId>> = {
  'card-place': 'card-place',
  'card-flip': 'card-flip',
  'card-draw': 'card-draw',
  recycle: 'recycle',
  foundation: 'foundation',
  return: 'return',
  cascade: 'cascade',
  shuffle: 'shuffle',
  rejected: 'card-reject',
  undo: 'undo',
};

const CARD_HAPTIC: Partial<Record<CardCue, HapticKind>> = {
  'card-place': 'tick',
  foundation: 'tap',
  return: 'tick',
  cascade: 'tick',
  rejected: 'thump',
};

function isCardCueName(name: string): name is CardCue {
  return Object.prototype.hasOwnProperty.call(CARD_CUE_FILE, name);
}

const isFoundationPile = (p: PileId): boolean => p[0] === 'f';

export type ResultsBeat =
  'burst' | 'digit' | 'row' | 'done' | 'outcome-win' | 'outcome-loss' | 'outcome-burst' | 'xp-go';

/** The world-event cues (the render engine calls `worldCue`). */
export type WorldCue = 'lanterns' | 'sunburst' | 'gust';

/** The UI vocabulary (`ui()` here, or `uiSound()` from audio/ui.ts anywhere). */
export type UiCue = 'hover' | 'press' | 'toast' | 'inbox' | 'flip';

const UI_CUE_ID: Readonly<Record<UiCue, string>> = {
  hover: 'ui-hover',
  press: 'ui-press',
  toast: 'toast-in',
  inbox: 'inbox-open',
  flip: 'odometer-flip',
};

interface Voice {
  readonly src: AudioBufferSourceNode;
  readonly startedAt: number;
}

interface DuckHold {
  readonly until: number;
  readonly depthDb: number;
}

interface Layer {
  readonly src: AudioBufferSourceNode;
  readonly gain: GainNode;
}

/**
 * An ambience bed on the wrap crossfade: pass k of the buffer starts at
 * t0 + k · (loopEnd − AMB_WRAP_XFADE_S), fading in over the crossfade while
 * pass k−1 fades out over the same, equal-power. The next pass is scheduled
 * a little before it is due by a timer.
 */
interface AmbienceBed {
  readonly gain: GainNode;
  readonly buf: AudioBuffer;
  readonly loopEnd: number;
  voices: AudioBufferSourceNode[];
  timer: ReturnType<typeof setTimeout> | null;
  nextAt: number;
}

const MASTER_GAIN = 0.5;

/**
 * The user mix. Three sliders (0..1) mapped through a perceptual curve (x^2)
 * so the middle of a slider is about -12 dB, not half amplitude. Defaults let
 * the bed lead and keep the SFX a complement under it. Ambience rides the
 * Effects slider (sound is not motion; it is not gated by reduced-motion).
 */
export interface Mix {
  master: number;
  music: number;
  sfx: number;
}
export const DEFAULT_MIX: Mix = { master: 0.8, music: 0.85, sfx: 0.4 };
const curve = (v: number): number => Math.max(0, Math.min(1, v)) ** 2;
const MAX_VOICES = 16;
/** Repeats within this window get a random +/-3 % pitch so they do not machine-gun. */
const REPEAT_WINDOW_S = 1.5;
const PITCH_JITTER = 0.03;
const DUCK_HIT_DB = -3.5;
const DUCK_CLEAR_DB = -3; // was -5: the owner heard the streak/clear cues 'drown out the bgm'
/** A rank-up is the level-up chime twice, this far apart. */
const RANK_UP_GAP_S = 0.18;
/** setTargetAtTime reaches ~95 % in 3 tau. */
const DUCK_ATTACK_TAU = 0.01 / 3;
const DUCK_RELEASE_TAU = 0.25 / 3;
/** The follower maps SFX-bus RMS from this floor up to full depth 25 dB above it. */
const DUCK_KEY_FLOOR_DB = -42;
const DUCK_KEY_RANGE_DB = 25;
const BGM_FADE_IN_S = 1.2;
const BGM_FADE_OUT_S = 2.5;

// ---- the ride (docs/audio.md, "Stems and the ride")
/** A stem enters or leaves over this, equal-power. */
const RIDE_RAMP_S = 0.25;
/** Streak level at which each stem is in. The bed is always in. */
const RIDE_RHYTHM_AT = 2;
const RIDE_LEAD_AT = 3;
/** At this level the hot loop is at its full manifest gain regardless of heat. */
const RIDE_FULL_AT = 4;

// ---- the clock close (the last 20 s)
const CLOCK_CLOSE_MS = 20_000;
/** Open = 18 kHz (nothing filtered). The sweep starts from 6 kHz so the first seconds read, and lands on 900 Hz. */
const CLOCK_LP_OPEN_HZ = 18_000;
const CLOCK_LP_START_HZ = 6_000;
const CLOCK_LP_CLOSED_HZ = 900;
const CLOCK_DIP_DB = -6;
/** Per-frame updates are smoothed with this tau; the reopen at the results uses REOPEN. */
const CLOCK_TAU = 0.15;
const CLOCK_REOPEN_TAU = 0.5;

// ---- ambience
const AMB_XFADE_S = 2.0;
/** The wrap: a bed loops by crossfading its tail into its head over this. */
const AMB_WRAP_XFADE_S = 1.0;
/** The next pass is scheduled this far ahead of its start. */
const AMB_SCHEDULE_AHEAD_S = 1.5;
/**
 * At `ended` the world recedes: the bed stays under the results cinematic
 * (there is no music by then) and fades over this. It also bounds how long
 * a bed can outlive a session that never called dispose().
 */
const AMB_END_FADE_S = 12;

// ---- micro cues
/** `cellTick` plays at most this often. */
const CELL_TICK_MAX_PER_S = 20;
/** `ui('hover')` at most this often (a pointer crossing a row of pills). */
const UI_HOVER_MAX_PER_S = 12;
/** `placeHeavy` within this of a placement (or of itself) is the same thud. */
const PLACE_HEAVY_DEDUP_S = 0.12;
const END_SLOW_DEDUP_S = 1.0;
/** A playfield cue this soon after the event played the same name is the same card. */
const CONTACT_DEDUP_S = 0.4;
/** `rejected()` and `cue('rejected')` within this are one snap-back. */
const REJECT_DEDUP_S = 0.15;

// ---- card pitch
/** Major scale, semitones: rank 1..13 (A..K) of a foundation or cascade card. */
const RANK_SEMIS = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21] as const;
/** Major pentatonic, semitones: the foundation tone by streak (1X .. 8X+). */
const STREAK_SEMIS = [0, 2, 4, 7, 9, 12, 14, 16] as const;
const semisToRate = (s: number): number => Math.pow(2, s / 12);

// ---- the autocomplete cascade
/** Spacing of the engine-driven run (event path, or one call starting it). */
const CASCADE_STEP_S = 0.065;
/** Ticks are booked this far ahead by a timer (the run never books 52 voices at once). */
const CASCADE_LOOKAHEAD_S = 0.12;
/** Two `cue('cascade')` calls within this: the playfield calls per card; the engine run stands down. */
const CASCADE_PER_CARD_S = 0.6;
/** A single `cue('cascade')` with no events behind it runs this many steps. */
const CASCADE_DEFAULT_RUN = 16;
/** Cascade step `i` climbs one scale degree every this many cards (four suits a rank). */
const CASCADE_CARDS_PER_STEP = 4;
/** The tone under a cascade step, relative to its foundation level. */
const CASCADE_TONE_GAIN = 0.8;

const CLEAR_CUES = new Set([
  'clear-1',
  'clear-2',
  'clear-3plus',
  'multiline',
  'streak-2',
  'streak-3',
  'streak-4',
  'end-timeout',
  'end-stuck',
]);

/** A 0.1 s silent WAV (8 kHz mono 8-bit, 844 bytes), the smallest thing an <audio> will loop. */
const SILENT_WAV =
  'data:audio/wav;base64,' +
  'UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

let playbackSession: HTMLAudioElement | null = null;

function ensurePlaybackSession(): void {
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  try {
    if (nav.audioSession) nav.audioSession.type = 'playback';
  } catch {
    /* not supported */
  }
  if (playbackSession) {
    if (playbackSession.paused) void playbackSession.play().catch(() => undefined);
    return;
  }
  try {
    const el = document.createElement('audio');
    el.setAttribute('playsinline', '');
    el.setAttribute('aria-hidden', 'true');
    el.loop = true;
    el.volume = 0.01;
    el.src = SILENT_WAV;
    el.style.display = 'none';
    document.body.appendChild(el);
    playbackSession = el;
    void el.play().catch(() => undefined);
  } catch {
    /* no DOM */
  }
}

/**
 * Equal-power ramp to `target` over `seconds`: cancel what is scheduled, hold
 * the current value, then eight linear segments on a sine (entering) or
 * cosine (leaving) shape. Linear segments rather than setValueCurveAtTime so
 * a ramp can be re-aimed mid-flight without the overlap exception.
 */
function rampEqualPower(param: AudioParam, target: number, now: number, seconds: number): void {
  const from = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(from, now);
  if (Math.abs(target - from) < 1e-5) return;
  const N = 8;
  for (let k = 1; k <= N; k++) {
    const t = k / N;
    const s = target > from ? Math.sin((t * Math.PI) / 2) : 1 - Math.cos((t * Math.PI) / 2);
    param.linearRampToValueAtTime(from + (target - from) * s, now + seconds * t);
  }
}

export interface AudioEngineOptions {
  /**
   * `ui`: the shell's shared engine — loads only the UI cues (hover, press,
   * toast, inbox, flip) and plays nothing else. Default: the game engine.
   */
  readonly scope?: 'game' | 'ui';
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  /** User SFX level, after the bus (the sidechain key is taken before it). */
  private sfxLevel: GainNode | null = null;
  private duck: GainNode | null = null;
  /** User music level, after the duck. */
  private musicLevel: GainNode | null = null;
  /** All music layers sum here, then the clock's low-pass and dip, then the duck. */
  private musicSum: GainNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private clockDip: GainNode | null = null;
  /** Ambience: its own bus on the Effects slider, outside the sidechain. */
  private ambBus: GainNode | null = null;
  private ambLevel: GainNode | null = null;
  private mix: Mix = { ...DEFAULT_MIX };
  private analyser: AnalyserNode | null = null;
  private keyBuf: Float32Array<ArrayBuffer> | null = null;
  private enabled: boolean;
  private readonly scope: 'game' | 'ui';

  private synth: SynthCues | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private entries = new Map<string, ManifestEntry>();
  private manifest: Manifest | null = null;
  private manifestPromise: Promise<Manifest | null> | null = null;
  private loadState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  private pending = new Map<string, Promise<boolean>>();

  private voices: Voice[] = [];
  private lastPlayed = new Map<string, number>();
  private holds: DuckHold[] = [];
  private follower: ReturnType<typeof setInterval> | null = null;

  private bgm: Layer | null = null;
  private rhythm: Layer | null = null;
  private lead: Layer | null = null;
  private hot: Layer | null = null;
  private wantMusic = false;
  private heat = 0;
  private streakLevel = 1;
  private clockOpen = true;

  private amb: AmbienceBed | null = null;
  private world: string | null = null;
  private wantWorld: string | null = null;
  private ambSeq = 0;

  private lastCellTick = -Infinity;
  private lastHover = -Infinity;
  private lastPlaceHeavy = -Infinity;
  private lastEndSlow = -Infinity;
  private lastReject = -Infinity;

  /** Card cue names the playfield has sent: their events stay silent from then on. */
  private owned = new Set<CardCue>();
  /** When the event path last played each card cue (for the hand-over dedup). */
  private eventPlayed = new Map<CardCue, number>();
  /** The streak after the last `scored` (pitches the foundation tone when no rank is given). */
  private streakNow = 0;

  private casc = {
    /** Steps still to book. */
    queue: 0,
    /** Step index (pitch). */
    index: 0,
    /** When the next step is due (ctx time). */
    nextAt: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
    /** Last `cue('cascade')`. */
    lastCall: -Infinity,
    /** The playfield sends one call per card: it owns the timing. */
    perCard: false,
  };

  constructor(enabled: boolean, options: AudioEngineOptions = {}) {
    this.enabled = enabled;
    this.scope = options.scope ?? 'game';
  }

  /** Must be called from a user gesture the first time. Starts the asset load. */
  unlock(): void {
    // iOS: with the ring/silent switch on, WebAudio is muted unless the page
    // is in the "playback" audio session. Two ways to get there, both only
    // meaningful on iOS and harmless elsewhere: the Audio Session API (iOS
    // 17+), and the classic trick — an <audio> element playing a silent loop,
    // which promotes the whole page to media playback (what background
    // music apps do). Must happen inside the user gesture that unlocks audio.
    ensurePlaybackSession();
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.enabled ? MASTER_GAIN * curve(this.mix.master) : 0;
      this.master.connect(ctx.destination);

      this.sfxBus = ctx.createGain();
      this.sfxLevel = ctx.createGain();
      this.sfxLevel.gain.value = curve(this.mix.sfx);
      this.sfxBus.connect(this.sfxLevel);
      this.sfxLevel.connect(this.master);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0;
      this.sfxBus.connect(this.analyser);
      this.keyBuf = new Float32Array(this.analyser.fftSize);

      this.duck = ctx.createGain();
      this.duck.gain.value = 1;
      this.musicLevel = ctx.createGain();
      this.musicLevel.gain.value = curve(this.mix.music);
      this.duck.connect(this.musicLevel);
      this.musicLevel.connect(this.master);

      // music layers -> sum -> low-pass -> dip -> duck
      this.musicSum = ctx.createGain();
      this.lowpass = ctx.createBiquadFilter();
      this.lowpass.type = 'lowpass';
      this.lowpass.frequency.value = CLOCK_LP_OPEN_HZ;
      this.lowpass.Q.value = 0; // dB for lowpass: flat (Butterworth), no peak at the cutoff
      this.clockDip = ctx.createGain();
      this.clockDip.gain.value = 1;
      this.musicSum.connect(this.lowpass);
      this.lowpass.connect(this.clockDip);
      this.clockDip.connect(this.duck);

      // ambience -> its own level (the Effects slider) -> master; never keys or takes the duck
      this.ambBus = ctx.createGain();
      this.ambLevel = ctx.createGain();
      this.ambLevel.gain.value = curve(this.mix.sfx);
      this.ambBus.connect(this.ambLevel);
      this.ambLevel.connect(this.master);

      this.synth = new SynthCues(ctx, this.sfxBus);
      void this.load(ctx);
      this.announce();
    } catch {
      this.ctx = null;
    }
  }

  /**
   * The shell's `sfx()` shim (shell/sfx.ts) plays through whatever is on
   * `window.__blockariAudio`: a game engine takes it while it lives and hands
   * back what was there (the shared UI engine, audio/ui.ts) on dispose.
   */
  private announced: { cue: (name: string) => void; rankUp: () => void } | null = null;
  private previousAnnounced: unknown = null;
  private announce(): void {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __blockariAudio?: unknown };
    this.announced = { cue: (name) => this.cue(name), rankUp: () => this.rankUp() };
    if (this.scope === 'ui' && w.__blockariAudio) return; // a game engine is up; stay the fallback
    this.previousAnnounced = w.__blockariAudio ?? null;
    w.__blockariAudio = this.announced;
  }
  private withdraw(): void {
    if (typeof window === 'undefined' || !this.announced) return;
    const w = window as unknown as { __blockariAudio?: unknown };
    if (w.__blockariAudio === this.announced)
      w.__blockariAudio = this.previousAnnounced ?? undefined;
    this.announced = null;
  }

  /** Stops everything and closes the context. GameHost's cleanup calls it. */
  dispose(): void {
    this.withdraw();
    this.stopFollower();
    this.cancelCascade();
    const ctx = this.ctx;
    if (!ctx) return;
    for (const v of this.voices) {
      try {
        v.src.stop();
      } catch {
        // already stopped
      }
    }
    this.voices = [];
    for (const l of [this.bgm, this.rhythm, this.lead, this.hot]) {
      try {
        l?.src.stop();
      } catch {
        // already stopped
      }
    }
    this.bgm = this.rhythm = this.lead = this.hot = null;
    this.fadeAmbience(0);
    this.world = null;
    this.ctx = null;
    void ctx.close().catch(() => undefined);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master && this.ctx)
      this.master.gain.setTargetAtTime(
        on ? MASTER_GAIN * curve(this.mix.master) : 0,
        this.ctx.currentTime,
        0.02,
      );
  }

  /** The three user sliders. Safe before unlock(); applied smoothly after. */
  setMix(mix: Partial<Mix>): void {
    this.mix = { ...this.mix, ...mix };
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.master?.gain.setTargetAtTime(
      this.enabled ? MASTER_GAIN * curve(this.mix.master) : 0,
      t,
      0.03,
    );
    this.musicLevel?.gain.setTargetAtTime(curve(this.mix.music), t, 0.03);
    this.sfxLevel?.gain.setTargetAtTime(curve(this.mix.sfx), t, 0.03);
    this.ambLevel?.gain.setTargetAtTime(curve(this.mix.sfx), t, 0.03);
  }

  /**
   * Streak heat 0..1 (the playfield's value): blends the hot-loop layer in
   * over the bed below 4X. Safe to call every frame; the change is smoothed.
   */
  setHeat(h: number): void {
    const v = Math.min(1, Math.max(0, Number.isFinite(h) ? h : 0));
    this.heat = v;
    this.applyHeat();
  }

  /**
   * Streak level 1..4 (1X = no streak, 2X, 3X, 4X+): the stems ride it —
   * rhythm in at 2X, lead at 3X, the full mix (hot loop at full) at 4X, each
   * a 250 ms equal-power ramp. Derived from `scored` / `streakBroken` too,
   * so a caller only needs this to override.
   */
  setStreak(level: number): void {
    const v = Math.min(4, Math.max(1, Math.round(Number.isFinite(level) ? level : 1)));
    if (v === this.streakLevel) return;
    this.streakLevel = v;
    this.applyRide();
  }

  /**
   * The game clock, ms remaining (the playfield pushes it as the timer
   * updates). Under 20 s a low-pass closes on the whole music bus, 18 kHz ->
   * 900 Hz on a log curve, with a 4 dB dip; it reopens at `ended`.
   */
  setClock(remainingMs: number): void {
    const ctx = this.ctx;
    const lp = this.lowpass;
    const dip = this.clockDip;
    if (!ctx || !lp || !dip) return;
    const r = Math.min(
      1,
      Math.max(0, (Number.isFinite(remainingMs) ? remainingMs : Infinity) / CLOCK_CLOSE_MS),
    );
    if (r >= 1) {
      if (this.clockOpen) return;
      this.clockOpen = true;
      this.reopen(CLOCK_TAU);
      return;
    }
    this.clockOpen = false;
    const now = ctx.currentTime;
    const hz = CLOCK_LP_CLOSED_HZ * Math.pow(CLOCK_LP_START_HZ / CLOCK_LP_CLOSED_HZ, r);
    const g = Math.pow(10, (CLOCK_DIP_DB * (1 - r)) / 20);
    lp.frequency.setTargetAtTime(hz, now, CLOCK_TAU);
    dip.gain.setTargetAtTime(g, now, CLOCK_TAU);
  }

  private reopen(tau: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.lowpass || !this.clockDip) return;
    const now = ctx.currentTime;
    this.lowpass.frequency.setTargetAtTime(CLOCK_LP_OPEN_HZ, now, tau);
    this.clockDip.gain.setTargetAtTime(1, now, tau);
    this.clockOpen = true;
  }

  /**
   * The world the game is played in (world-table id): its ambience bed
   * crossfades in over 2 s (and the previous one out). `null` fades it out.
   * Safe before unlock(); the bed starts once audio is unlocked and its file
   * has arrived (fetched on demand — one bed a session).
   */
  setWorld(id: string | null): void {
    this.wantWorld = id;
    if (id === this.world) return;
    if (!this.ctx) return;
    if (id === null) {
      this.fadeAmbience(AMB_XFADE_S);
      this.world = null;
      return;
    }
    const cue = `amb-${id}`;
    const seq = ++this.ambSeq;
    void this.ensure(cue).then((ok) => {
      if (!ok || seq !== this.ambSeq || this.wantWorld !== id || !this.ctx) return;
      this.startAmbience(cue, id);
    });
  }

  /** A world event: lanterns (a warm glass chime), sunburst (a bright shimmer), gust (a whoosh). */
  worldCue(kind: WorldCue): void {
    if (!this.ctx) return;
    this.play(kind, { depthDb: 0 });
  }

  /** The UI vocabulary. `toast` also buzzes (30 ms) where haptics are on; `hover` at most 12/s. */
  ui(kind: UiCue): void {
    if (kind === 'toast') haptic('toast');
    const ctx = this.ctx;
    if (!ctx) return;
    if (kind === 'hover') {
      if (ctx.currentTime - this.lastHover < 1 / UI_HOVER_MAX_PER_S) return;
      this.lastHover = ctx.currentTime;
    }
    this.play(UI_CUE_ID[kind], { depthDb: 0 });
  }

  /**
   * Hover over a legal cell during a drag: an 8 ms tick at -30 dB, at most
   * 20 a second, and the 8 ms haptic tick with it.
   */
  cellTick(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - this.lastCellTick < 1 / CELL_TICK_MAX_PER_S) return;
    this.lastCellTick = now;
    haptic('tick');
    this.play('cell-tick', { depthDb: 0, jitter: false });
  }

  /**
   * A low thud under `place` for a heavy piece. The engine layers it itself
   * on a placement of HEAVY_CELLS+ cells; the render engine may also request
   * it (a heavy landing it knows about) — the two are deduped within 120 ms.
   */
  placeHeavy(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - this.lastPlaceHeavy < PLACE_HEAVY_DEDUP_S) return;
    this.lastPlaceHeavy = now;
    this.play('place-heavy', { depthDb: DUCK_HIT_DB });
  }

  /** The end-of-game slow-mo: a low whoosh. Also fired at `ended`; deduped within 1 s. */
  endSlow(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - this.lastEndSlow < END_SLOW_DEDUP_S) return;
    this.lastEndSlow = now;
    this.play('end-slow', { depthDb: DUCK_CLEAR_DB });
  }

  /**
   * A cue by name — the bridge for the render engine's `onCue`: the CARD
   * CUES above (`arg`: a foundation / cascade card's rank 1..13, optional),
   * `end-slow` at the slow-mo, `cell-tick` on a legal target, Blockari's
   * `place` / `place-heavy`; the shell's `sfx()` shim (`ui-press`,
   * `toast-in`, `inbox-open`, `odometer-flip`, `rank-up`); and the world
   * events. Unknown names are ignored.
   */
  cue(name: string, arg?: number): void {
    if (name === 'reject') name = 'rejected';
    if (isCardCueName(name)) {
      this.cardFromPlayfield(name, arg);
      return;
    }
    switch (name) {
      case 'place':
      case 'place-heavy':
        this.place(name === 'place-heavy');
        return;
      case 'end-slow':
        this.endSlow();
        return;
      case 'cell-tick':
        this.cellTick();
        return;
      case 'rank-up':
        this.rankUp();
        return;
      case 'lanterns':
      case 'sunburst':
      case 'gust':
        this.worldCue(name);
        return;
      case 'ui-hover':
        this.ui('hover');
        return;
      case 'ui-press':
        this.ui('press');
        return;
      case 'toast-in':
        this.ui('toast');
        return;
      case 'inbox-open':
        this.ui('inbox');
        return;
      case 'odometer-flip':
        this.ui('flip');
        return;
      default:
        return;
    }
  }

  handle = (e: AudioEvent): void => {
    switch (e.type) {
      case 'dealt':
        this.cardFromEvent('shuffle');
        break;
      case 'moved':
        if (!this.wantMusic) this.startMusic(); // a resumed game has no countdown
        if (e.auto) {
          if (!this.casc.perCard) this.enqueueCascade(1); // per card: the playfield plays each step
        } else if (isFoundationPile(e.from)) {
          this.cardFromEvent('return');
        } else if (!isFoundationPile(e.to)) {
          this.cardFromEvent('card-place');
        } // to a foundation: `scored` follows with the streak that pitches it
        break;
      case 'flipped':
        this.cardFromEvent('card-flip');
        break;
      case 'drew':
        if (!this.wantMusic) this.startMusic();
        this.cardFromEvent('card-draw');
        break;
      case 'recycled':
        if (!this.wantMusic) this.startMusic();
        this.cardFromEvent('recycle');
        break;
      case 'undone':
        this.cardFromEvent('undo');
        break;
      case 'scored':
        this.streakNow = e.streak;
        if (e.kind === 'foundation') this.cardFromEvent('foundation');
        if (e.kind === 'auto') break; // the cascade: no stinger per card, the streak is frozen
        if (e.streak >= 2) {
          this.streak(e.streak);
          this.setStreak(e.streak);
          if (e.streak >= RIDE_FULL_AT) haptic('big');
        } else {
          this.setStreak(1);
        }
        break;
      case 'streakBroken':
        this.streakNow = 0;
        this.setStreak(1);
        break;
      case 'ended': {
        // A clear ends the instant the autocomplete is applied: the result lands after the run.
        const after = this.cascadeRemaining();
        this.end(e.reason === 'forfeit', after);
        if (after > 0) setTimeout(() => this.endSlow(), after * 1000);
        else this.endSlow();
        this.streakNow = 0;
        this.setStreak(1);
        this.stopMusic();
        this.fadeAmbience(AMB_END_FADE_S);
        this.world = null;
        this.reopen(CLOCK_REOPEN_TAU);
        break;
      }
      case 'levelUp':
        this.levelUp();
        break;
      default:
        break;
    }
  };

  // ---------------------------------------------------------------------------
  // Card cues

  /** A card cue from the sim's events: plays unless the playfield has taken the name. */
  private cardFromEvent(name: CardCue): void {
    const ctx = this.ctx;
    if (!ctx || this.owned.has(name)) return;
    this.eventPlayed.set(name, ctx.currentTime);
    this.playCard(name);
  }

  /** A card cue from the playfield: it owns the name from now on. */
  private cardFromPlayfield(name: CardCue, arg?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (name === 'cascade') {
      this.owned.add(name);
      this.cascadeCue(arg);
      return;
    }
    if (name === 'rejected') {
      this.rejected();
      return;
    }
    if (!this.owned.has(name)) {
      this.owned.add(name);
      const at = this.eventPlayed.get(name);
      if (at !== undefined && ctx.currentTime - at < CONTACT_DEDUP_S) return; // already heard
    }
    this.playCard(name, arg);
  }

  /** Play a card cue now (or after `delay`): the file, else the same DSP rendered live; plus its haptic. */
  private playCard(name: CardCue, arg?: number, delay = 0): void {
    const file = CARD_CUE_FILE[name];
    this.playCardFile(file, { delay });
    if (name === 'foundation') {
      const semis =
        arg !== undefined && arg >= 1
          ? RANK_SEMIS[Math.min(12, Math.round(arg) - 1)]
          : STREAK_SEMIS[Math.min(STREAK_SEMIS.length - 1, Math.max(0, this.streakNow - 1))];
      this.playCardFile('foundation-tone', {
        delay: delay + 0.004,
        rate: semisToRate(semis ?? 0),
        jitter: false,
      });
    }
    const h = CARD_HAPTIC[name];
    if (h) haptic(h);
  }

  private playCardFile(
    id: CardCueId,
    o: { delay?: number; rate?: number; gain?: number; jitter?: boolean } = {},
  ): void {
    if (!this.play(id, o)) this.synth?.card(id, o);
  }

  /**
   * `cue('cascade')`, designed for both ways a playfield may drive it:
   *
   *   - PER CARD: two calls within CASCADE_PER_CARD_S and the playfield owns
   *     the timing — each call is one step (`arg` a rank pitches it; else the
   *     step count does), and any engine run stands down.
   *   - ONE CALL: a single call starts a run — the one the `moved{auto}`
   *     events already booked (as many steps as cards), or, with no events
   *     behind it, CASCADE_DEFAULT_RUN steps. If a second call follows after
   *     all, the rest of the run is cancelled and it is per card from there.
   */
  private cascadeCue(rank?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const c = this.casc;
    const now = ctx.currentTime;
    const since = now - c.lastCall;
    c.lastCall = now;
    if (since < CASCADE_PER_CARD_S || c.perCard) {
      if (!c.perCard) {
        c.perCard = true;
        this.cancelCascade();
      }
      if (since > 1) c.index = 0;
      this.cascadeStep(0, rank);
      return;
    }
    if (c.queue > 0 || c.nextAt > now) return; // the event-driven run is already playing it
    c.index = 0;
    this.enqueueCascade(CASCADE_DEFAULT_RUN);
  }

  private enqueueCascade(n: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const c = this.casc;
    if (c.queue === 0 && c.nextAt < ctx.currentTime - 0.5) c.index = 0; // a new run
    c.queue += n;
    this.pumpCascade();
  }

  /** Book every step due within the look-ahead; come back for the rest. */
  private pumpCascade(): void {
    const ctx = this.ctx;
    const c = this.casc;
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    if (!ctx) return;
    const now = ctx.currentTime;
    while (c.queue > 0 && c.nextAt < now + CASCADE_LOOKAHEAD_S) {
      const at = Math.max(c.nextAt, now);
      this.cascadeStep(at - now);
      c.nextAt = at + CASCADE_STEP_S;
      c.queue--;
    }
    if (c.queue > 0) c.timer = setTimeout(() => this.pumpCascade(), 40);
  }

  private cancelCascade(): void {
    const c = this.casc;
    c.queue = 0;
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
  }

  /** Seconds until the booked run is done (0 when none). */
  private cascadeRemaining(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const c = this.casc;
    const left = c.queue * CASCADE_STEP_S + Math.max(0, c.nextAt - ctx.currentTime);
    return left > 0 ? left + 0.1 : 0;
  }

  /** One cascade step: the light snap and the tone a degree up per rank. */
  private cascadeStep(delay: number, rank?: number): void {
    const c = this.casc;
    const i = c.index++;
    const degree =
      rank !== undefined && rank >= 1
        ? Math.min(12, Math.round(rank) - 1)
        : Math.min(12, Math.floor(i / CASCADE_CARDS_PER_STEP));
    this.playCardFile('cascade', { delay });
    this.playCardFile('foundation-tone', {
      delay: delay + 0.003,
      rate: semisToRate(RANK_SEMIS[degree] ?? 0),
      gain: CASCADE_TONE_GAIN,
      jitter: false,
    });
    haptic('tick');
  }

  /**
   * Beats of the results cinematic (the playfield's ResultsScene calls these):
   * the shard burst, each digit landing, each breakdown row, the final total;
   * and a challenge's OUTCOME — the win's banner is the sparkle burst and its
   * coin burst the most triumphant cue there is (`streak-4`, under the
   * clear-duck); the loss lands on the sinking `end-stuck`, quiet. No new
   * assets.
   */
  resultsBeat(kind: ResultsBeat): void {
    if (!this.ctx) return;
    let ok: boolean;
    switch (kind) {
      case 'burst':
        ok = this.play('results-shards');
        break;
      case 'outcome-win':
        ok = this.play('results-shards', { gain: 0.9, depthDb: 0 });
        break;
      case 'outcome-burst':
        ok = this.play('streak-4', { gain: 0.7, depthDb: DUCK_CLEAR_DB });
        break;
      case 'outcome-loss':
        ok = this.play('end-stuck', { gain: 0.5, depthDb: 0 });
        break;
      case 'xp-go':
        return; // a shell cue, not a sound
      case 'digit':
        ok = this.play('countdown-tick', { gain: 0.35, rate: 1.35, depthDb: 0 });
        break;
      case 'row':
        ok = this.play('place', { gain: 0.5, rate: 1.12, depthDb: 0 });
        break;
      default:
        ok = this.play('clear-1', { gain: 0.6, depthDb: 0 });
        break;
    }
    if (!ok) this.synth?.resultsBeat(kind);
  }

  /** 3, 2, 1 are three ascending blips (`countdown-3/2/1`); 0 is `countdown-go` and the bed's fade-in. */
  countdown(value: number): void {
    if (!this.ctx) return;
    if (value === 0) {
      if (!this.play('countdown-go', { depthDb: DUCK_CLEAR_DB })) this.synth?.countdown(0);
      this.startMusic();
      return;
    }
    const id = value >= 3 ? 'countdown-3' : value === 2 ? 'countdown-2' : 'countdown-1';
    if (this.play(id, { jitter: false })) return;
    // The old tick, pitched up a little each step, then the synth.
    if (!this.play('countdown-tick', { rate: 1 + (3 - value) * 0.04 }))
      this.synth?.countdown(value);
  }

  /** An illegal drop snapping back: the card's muted double knock (Blockari's buzz only if that file is missing), and a thump. */
  rejected(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.currentTime - this.lastReject < REJECT_DEDUP_S) return; // rejected() and cue('rejected') for one drop
    this.lastReject = ctx.currentTime;
    haptic('thump');
    if (this.play('card-reject')) return;
    if (this.play('reject')) return;
    this.synth?.card('card-reject');
  }

  // ---------------------------------------------------------------------------
  // Cues

  /** Blockari's placement thud, for a playfield that still sends `place` / `place-heavy`. */
  private place(heavy: boolean): void {
    if (!this.play('place')) this.synth?.place();
    haptic('thump');
    if (heavy) this.placeHeavy();
  }

  private streak(n: number): void {
    const id = n >= 4 ? 'streak-4' : n === 3 ? 'streak-3' : 'streak-2';
    if (!this.play(id, { delay: 0.15, depthDb: DUCK_CLEAR_DB })) this.synth?.streak(n);
  }

  /** The level pill pops 80 ms after the event (its banner may queue behind a streak's); the chime rides with it. */
  private levelUp(): void {
    if (!this.play('level-up', { delay: 0.08 })) this.synth?.levelUp();
  }

  /**
   * The results tray's account-XP beats: an XP level crossed is the level-up
   * chime once; a RANK crossed is the same cue twice, RANK_UP_GAP_S apart —
   * no new asset, the chime doubled is the bigger event.
   */
  xpLevelUp(): void {
    if (!this.ctx) return;
    if (!this.play('level-up')) this.synth?.levelUp();
  }

  rankUp(): void {
    if (!this.ctx) return;
    if (this.play('level-up')) {
      this.play('level-up', { delay: RANK_UP_GAP_S });
    } else {
      this.synth?.levelUp();
      setTimeout(() => this.synth?.levelUp(), RANK_UP_GAP_S * 1000);
    }
  }

  /** The resolving chord for a clear or the clock; the sinking one for a forfeit. */
  private end(stuck: boolean, delay = 0): void {
    if (!this.play(stuck ? 'end-stuck' : 'end-timeout', { depthDb: DUCK_CLEAR_DB, delay })) {
      if (delay > 0) setTimeout(() => this.synth?.end(stuck), delay * 1000);
      else this.synth?.end(stuck);
    }
  }

  // ---------------------------------------------------------------------------
  // Asset playback

  /** Returns false when the cue is not (yet) available, so the caller can fall back. */
  private play(
    id: string,
    o: { gain?: number; rate?: number; delay?: number; depthDb?: number; jitter?: boolean } = {},
  ): boolean {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    const buf = this.buffers.get(id);
    const entry = this.entries.get(id);
    if (!ctx || !bus || !buf || !entry) return false;
    const now = ctx.currentTime;
    const at = now + (o.delay ?? 0);

    let rate = o.rate ?? 1;
    const last = this.lastPlayed.get(id);
    if (o.jitter !== false && last !== undefined && now - last < REPEAT_WINDOW_S) {
      rate *= 1 + (Math.random() * 2 - 1) * PITCH_JITTER;
    }
    this.lastPlayed.set(id, now);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = entry.gain * (o.gain ?? 1);
    src.connect(g);
    g.connect(bus);
    src.start(at);
    const voice: Voice = { src, startedAt: at };
    this.voices.push(voice);
    src.onended = () => {
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
      src.disconnect();
      g.disconnect();
    };
    while (this.voices.length > MAX_VOICES) {
      const oldest = this.voices.shift();
      try {
        oldest?.src.stop();
      } catch {
        // already stopped
      }
    }

    const depthDb = o.depthDb ?? (CLEAR_CUES.has(id) ? DUCK_CLEAR_DB : DUCK_HIT_DB);
    if (depthDb < 0) this.holds.push({ until: at + buf.duration / rate + 0.25, depthDb });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Music, the ride, heat, the clock and the sidechain

  /**
   * Start the bed and every stem at the same instant, never again: the ride
   * is gain only from here. Layers that have not decoded yet are skipped
   * (they would be out of phase started late) — the bed alone plays.
   */
  private startMusic(): void {
    this.wantMusic = true;
    const ctx = this.ctx;
    const sum = this.musicSum;
    if (!ctx || !sum || this.bgm) return;
    const entry = this.entries.get('bgm');
    const buf = this.buffers.get('bgm');
    if (!entry || !buf) return; // still loading: `load` starts it on arrival
    const now = ctx.currentTime;
    const loopEnd = Math.min(buf.duration, entry.loopEnd ?? buf.duration);

    const bgm = this.loop(ctx, buf, loopEnd, sum);
    bgm.gain.gain.setValueAtTime(0.0001, now);
    bgm.gain.gain.exponentialRampToValueAtTime(entry.gain, now + BGM_FADE_IN_S);
    bgm.src.start(now);
    this.bgm = bgm;

    const stem = (id: string): Layer | null => {
      const e = this.entries.get(id);
      const b = this.buffers.get(id);
      if (!e || !b) return null;
      const l = this.loop(ctx, b, loopEnd, sum);
      l.gain.gain.value = 0;
      l.src.start(now);
      return l;
    };
    this.rhythm = stem('bgm-rhythm');
    this.lead = stem('bgm-lead');
    this.hot = stem('hot-loop');
    this.reopen(CLOCK_TAU);
    this.applyRide();
    this.applyHeat();
    this.startFollower();
  }

  private loop(ctx: AudioContext, buf: AudioBuffer, loopEnd: number, out: AudioNode): Layer {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = Math.min(buf.duration, loopEnd);
    const gain = ctx.createGain();
    src.connect(gain);
    gain.connect(out);
    return { src, gain };
  }

  private stopMusic(): void {
    this.wantMusic = false;
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const layer of [this.bgm, this.rhythm, this.lead, this.hot]) {
      if (!layer) continue;
      layer.gain.gain.cancelScheduledValues(now);
      layer.gain.gain.setValueAtTime(Math.max(0.0001, layer.gain.gain.value), now);
      layer.gain.gain.exponentialRampToValueAtTime(0.0001, now + BGM_FADE_OUT_S);
      layer.src.stop(now + BGM_FADE_OUT_S + 0.05);
    }
    this.bgm = this.rhythm = this.lead = this.hot = null;
    this.stopFollower();
  }

  /** The ride table applied to the stems for the current streak level (250 ms equal-power). */
  private applyRide(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const lv = this.streakLevel;
    const aim = (layer: Layer | null, id: string, on: boolean): void => {
      const e = this.entries.get(id);
      if (!layer || !e) return;
      rampEqualPower(layer.gain.gain, on ? e.gain : 0, now, RIDE_RAMP_S);
    };
    aim(this.rhythm, 'bgm-rhythm', lv >= RIDE_RHYTHM_AT);
    aim(this.lead, 'bgm-lead', lv >= RIDE_LEAD_AT);
    const hotEntry = this.entries.get('hot-loop');
    if (this.hot && hotEntry) {
      const target = lv >= RIDE_FULL_AT ? hotEntry.gain : 0;
      rampEqualPower(this.hot.gain.gain, target, now, RIDE_RAMP_S);
    }
  }

  private applyHeat(): void {
    const ctx = this.ctx;
    const hot = this.hot;
    const entry = this.entries.get('hot-loop');
    if (!ctx || !hot || !entry) return;
    const h = this.heat;
    const now = ctx.currentTime;
    // Perceptual: quiet until the streak is real, then opens fast. No pitch
    // with it: the loop is cut to eight of the bed's beats and rides in phase
    // (a +6 % rate would drift it; the mixdown has none — one behaviour).
    // At 4X the ride holds the hot loop at full (applyRide); heat only moves it below that.
    // Owner (2026-09-20): no rise with heat — the loop enters only at 4X (applyRide holds it
    // there); below that it stays silent so a streak never "gets louder and louder".
    if (this.streakLevel < RIDE_FULL_AT) {
      const g = hot.gain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.setTargetAtTime(0, now, 0.2);
    }
    void h;
  }

  private startFollower(): void {
    if (this.follower) return;
    this.follower = setInterval(() => this.followKey(), 16);
  }

  private stopFollower(): void {
    if (this.follower) clearInterval(this.follower);
    this.follower = null;
    if (this.ctx && this.duck)
      this.duck.gain.setTargetAtTime(1, this.ctx.currentTime, DUCK_RELEASE_TAU);
  }

  /** One follower tick: SFX-bus envelope -> duck gain, with attack/release ballistics. */
  private followKey(): void {
    const ctx = this.ctx;
    const an = this.analyser;
    const duck = this.duck;
    const key = this.keyBuf;
    if (!ctx || !an || !duck || !key) return;
    an.getFloatTimeDomainData(key);
    let sum = 0;
    for (let i = 0; i < key.length; i++) sum += (key[i] ?? 0) * (key[i] ?? 0);
    const rmsDb = 10 * Math.log10(sum / key.length + 1e-12);

    const now = ctx.currentTime;
    let depthDb = DUCK_HIT_DB;
    let n = 0;
    for (const h of this.holds) {
      if (h.until < now) continue;
      this.holds[n++] = h;
      if (h.depthDb < depthDb) depthDb = h.depthDb;
    }
    this.holds.length = n;

    const amount = Math.min(1, Math.max(0, (rmsDb - DUCK_KEY_FLOOR_DB) / DUCK_KEY_RANGE_DB));
    const target = Math.pow(10, (depthDb * amount) / 20);
    const tau = target < duck.gain.value ? DUCK_ATTACK_TAU : DUCK_RELEASE_TAU;
    duck.gain.setTargetAtTime(target, now, tau);
  }

  // ---------------------------------------------------------------------------
  // Ambience

  private startAmbience(cue: string, id: string): void {
    const ctx = this.ctx;
    const bus = this.ambBus;
    const entry = this.entries.get(cue);
    const buf = this.buffers.get(cue);
    if (!ctx || !bus || !entry || !buf) return;
    const now = ctx.currentTime;
    this.fadeAmbience(AMB_XFADE_S);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(bus);
    const bed: AmbienceBed = {
      gain,
      buf,
      loopEnd: Math.min(buf.duration, entry.loopEnd ?? buf.duration),
      voices: [],
      timer: null,
      nextAt: now,
    };
    this.amb = bed;
    this.world = id;
    this.schedulePass(bed, true);
    rampEqualPower(gain.gain, entry.gain, now, AMB_XFADE_S);
  }

  /** Start the pass due at `bed.nextAt` (the first one without its fade-in) and book the one after. */
  private schedulePass(bed: AmbienceBed, first: boolean): void {
    const ctx = this.ctx;
    if (!ctx || this.amb !== bed) return;
    const X = Math.min(AMB_WRAP_XFADE_S, bed.loopEnd / 4);
    const at = bed.nextAt;
    const src = ctx.createBufferSource();
    src.buffer = bed.buf;
    const g = ctx.createGain();
    src.connect(g);
    g.connect(bed.gain);
    const N = 8;
    if (first) {
      g.gain.setValueAtTime(1, at);
    } else {
      g.gain.setValueAtTime(0, at);
      for (let k = 1; k <= N; k++)
        g.gain.linearRampToValueAtTime(Math.sin((k / N) * (Math.PI / 2)), at + (X * k) / N);
    }
    const outAt = at + bed.loopEnd - X;
    g.gain.setValueAtTime(1, outAt);
    for (let k = 1; k <= N; k++)
      g.gain.linearRampToValueAtTime(Math.cos((k / N) * (Math.PI / 2)), outAt + (X * k) / N);
    src.start(at, 0, bed.loopEnd);
    src.onended = () => {
      const i = bed.voices.indexOf(src);
      if (i >= 0) bed.voices.splice(i, 1);
      src.disconnect();
      g.disconnect();
    };
    bed.voices.push(src);
    bed.nextAt = outAt;
    const wait = Math.max(0, outAt - AMB_SCHEDULE_AHEAD_S - ctx.currentTime);
    bed.timer = setTimeout(() => {
      bed.timer = null;
      this.schedulePass(bed, false);
    }, wait * 1000);
  }

  private fadeAmbience(seconds: number): void {
    const ctx = this.ctx;
    const old = this.amb;
    if (!ctx || !old) return;
    this.amb = null;
    if (old.timer) clearTimeout(old.timer);
    old.timer = null;
    const now = ctx.currentTime;
    rampEqualPower(old.gain.gain, 0, now, seconds);
    for (const v of old.voices) {
      try {
        v.stop(now + seconds + 0.05);
      } catch {
        // already stopped
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Loading

  private codecFile(entry: ManifestEntry): string {
    const opus = new Audio().canPlayType('audio/ogg; codecs=opus') !== '';
    return assetUrl(`audio/${opus ? entry.file : entry.alt}`);
  }

  private async fetchManifest(): Promise<Manifest | null> {
    if (this.manifest) return this.manifest;
    if (!this.manifestPromise) {
      this.manifestPromise = (async () => {
        try {
          const res = await fetch(assetUrl('audio/manifest.json'), {
            cache: 'force-cache',
          });
          if (!res.ok) throw new Error(`manifest ${res.status}`);
          this.manifest = (await res.json()) as Manifest;
          return this.manifest;
        } catch (err) {
          console.warn('audio: manifest unavailable, using synth cues', err);
          return null;
        }
      })();
    }
    return this.manifestPromise;
  }

  /** Fetch + decode one cue (once); resolves false when it cannot be had. */
  private ensure(id: string): Promise<boolean> {
    const have = this.pending.get(id);
    if (have) return have;
    const p = (async () => {
      const ctx = this.ctx;
      if (!ctx) return false;
      if (this.buffers.has(id)) return true;
      const manifest = await this.fetchManifest();
      const entry = manifest?.cues[id];
      if (!entry) return false;
      try {
        const r = await fetch(this.codecFile(entry), { cache: 'force-cache' });
        if (!r.ok) throw new Error(`${id} ${r.status}`);
        const buf = await ctx.decodeAudioData(await r.arrayBuffer());
        if (this.ctx !== ctx) return false; // disposed meanwhile
        this.buffers.set(id, buf);
        this.entries.set(id, entry);
        return true;
      } catch (err) {
        console.warn(`audio: ${id} failed to load`, err);
        this.pending.delete(id); // let a later call retry
        return false;
      }
    })();
    this.pending.set(id, p);
    return p;
  }

  /**
   * The session's set: every cue but the ambience beds (those come on demand
   * with `setWorld`); the UI scope takes only the UI cues.
   */
  private async load(ctx: AudioContext): Promise<void> {
    if (this.loadState !== 'idle') return;
    this.loadState = 'loading';
    const manifest = await this.fetchManifest();
    if (!manifest || this.ctx !== ctx) {
      this.loadState = 'failed';
      return;
    }
    const ids = Object.entries(manifest.cues)
      .filter(([, e]) => (this.scope === 'ui' ? e.kind === 'ui' : e.kind !== 'ambience'))
      .map(([id]) => id);
    const results = await Promise.all(ids.map((id) => this.ensure(id)));
    const failed = results.filter((ok) => !ok).length;
    if (this.buffers.size === 0) {
      this.loadState = 'failed';
      console.warn('audio: no cue decoded, using synth cues');
      return;
    }
    if (failed > 0)
      console.warn(
        `audio: ${failed} of ${ids.length} cues failed to load; synth fallback covers them`,
      );
    this.loadState = 'ready';
    if (this.wantMusic) this.startMusic();
    if (this.wantWorld && this.wantWorld !== this.world) this.setWorld(this.wantWorld);
  }
}
