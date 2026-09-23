/**
 * The card cues, as DSP: every one is filtered noise bursts, damped sines and
 * a few envelopes, rendered deterministically (seeded noise) into a mono
 * Float32Array. Nothing here touches WebAudio or the DOM, so the same code
 * serves three places:
 *
 *   - tools/cardfx/render.ts renders each cue offline, peak-normalises it and
 *     encodes the committed `public/audio/sfx/<id>.ogg|.m4a` (+ manifest);
 *   - synth.ts wraps a render in an AudioBuffer as the fallback while the
 *     manifest is loading or if a file fails;
 *   - the dev page (audio-preview.html) measures it.
 *
 * Direction (KLONDIKE-BRIEF §8): short, dry, quiet. Real card stock: the
 * paper snap of one card meeting another, the felt thud under it, the crisp
 * flick of a flip. No reverb, no cartoon pitch; the only tonal element is
 * `foundation-tone`, a soft muted bell under the foundation snap that the
 * engine pitches up by rank / streak / cascade step.
 *
 * Keep this file import-free and to erasable TypeScript: the offline renderer
 * runs it under Node's type stripping.
 */

export const CARD_CUES = [
  'card-place',
  'card-flip',
  'card-draw',
  'recycle',
  'foundation',
  'foundation-tone',
  'return',
  'cascade',
  'shuffle',
  'card-reject',
  'undo',
] as const;

export type CardCueId = (typeof CARD_CUES)[number];

/**
 * Manifest gains, applied at play time on top of the ~-3 dBTP file. Set from
 * the render tool's levels table: every card cue's bus peak sits at least
 * 1 dB under Blockari's `place`, and its RMS above 250 Hz (what a phone
 * plays) 3 dB (place, foundation) to 7 dB (cascade, undo) under it.
 */
export const CARD_CUE_GAIN: Readonly<Record<CardCueId, number>> = {
  'card-place': 0.36,
  'card-flip': 0.25,
  'card-draw': 0.18,
  recycle: 0.28,
  foundation: 0.38,
  'foundation-tone': 0.06,
  return: 0.19,
  cascade: 0.27,
  shuffle: 0.45,
  'card-reject': 0.4,
  undo: 0.25,
};

/** The foundation tone's pitch before any rate: G4. */
export const FOUNDATION_TONE_HZ = 392;

/** Rendered sample peak, dBFS (the offline tool lands the encoded true peak near -3 dBTP). */
export const CARD_PEAK_DBFS = -3.8;

// ---------------------------------------------------------------------------
// Primitives

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type FilterType = 'lp' | 'hp' | 'bp';

/** RBJ cookbook biquad, coefficients normalised by a0. */
function coeffs(type: FilterType, f: number, q: number, sr: number): number[] {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0: number;
  let b1: number;
  let b2: number;
  if (type === 'lp') {
    b0 = (1 - cw) / 2;
    b1 = 1 - cw;
    b2 = b0;
  } else if (type === 'hp') {
    b0 = (1 + cw) / 2;
    b1 = -(1 + cw);
    b2 = b0;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  return [b0 / a0, b1 / a0, b2 / a0, (-2 * cw) / a0, (1 - alpha) / a0];
}

/** Filter `x` in place; the cutoff may glide (log) from `f0` to `f1` across it. */
function filter(
  x: Float32Array,
  type: FilterType,
  f0: number,
  q: number,
  sr: number,
  f1 = f0,
): void {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let c = coeffs(type, f0, q, sr);
  const n = x.length;
  for (let i = 0; i < n; i++) {
    if (f1 !== f0 && i % 32 === 0) c = coeffs(type, f0 * Math.pow(f1 / f0, i / n), q, sr);
    const [b0, b1, b2, a1, a2] = c as [number, number, number, number, number];
    const xi = x[i] ?? 0;
    const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

interface Burst {
  /** Start, seconds. */
  at: number;
  /** Filter. */
  type: FilterType;
  f: number;
  q?: number;
  /** Glide target for the cutoff over the burst. */
  fTo?: number;
  /** Attack, seconds (linear). */
  attack?: number;
  /** Exponential decay time constant, seconds. */
  tau: number;
  gain: number;
  /** Shape: 'exp' (hit) or 'swell' (a sin² rise and fall over `len`, for slides and swishes). */
  shape?: 'exp' | 'swell' | 'rise';
  /** Length for 'swell' / 'rise'; default 7 tau for 'exp'. */
  len?: number;
}

class Canvas {
  readonly out: Float32Array;
  readonly sr: number;
  private readonly rand: () => number;

  constructor(sr: number, seconds: number, seed: number) {
    this.sr = sr;
    this.out = new Float32Array(Math.ceil(sr * seconds));
    this.rand = rng(seed);
  }

  r(): number {
    return this.rand();
  }

  /** A filtered-noise burst. */
  burst(b: Burst): void {
    const sr = this.sr;
    const shape = b.shape ?? 'exp';
    const len = b.len ?? b.tau * 7 + (b.attack ?? 0);
    const n = Math.max(1, Math.floor(len * sr));
    const pad = 256; // filter warm-up, discarded
    const x = new Float32Array(n + pad);
    for (let i = 0; i < x.length; i++) x[i] = this.rand() * 2 - 1;
    filter(x, b.type, b.f, b.q ?? 0.707, sr, b.fTo ?? b.f);
    // a second pass steepens a fixed band-pass / high-pass (a glide keeps one pass, so it still moves)
    if ((b.type === 'bp' || b.type === 'hp') && b.fTo === undefined)
      filter(x, b.type, b.f, b.q ?? 0.707, sr);
    const start = Math.floor(b.at * sr);
    const atk = Math.max(1, Math.floor((b.attack ?? 0.0002) * sr));
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let env: number;
      if (shape === 'swell') env = Math.pow(Math.sin((Math.PI * i) / n), 2);
      else if (shape === 'rise') env = Math.pow(i / n, 2.2) * (i > n - atk ? (n - i) / atk : 1);
      else env = (i < atk ? i / atk : 1) * Math.exp(-(t - (b.attack ?? 0)) / b.tau);
      const j = start + i;
      if (j >= this.out.length) break;
      this.out[j] = (this.out[j] ?? 0) + (x[i + pad] ?? 0) * env * b.gain;
    }
  }

  /** A damped sine (optionally gliding), the felt's low body or the tone's partials. */
  sine(at: number, f: number, tau: number, gain: number, fTo = f, attack = 0.0015): void {
    const sr = this.sr;
    const n = Math.floor(tau * 7 * sr);
    const start = Math.floor(at * sr);
    const atk = Math.max(1, Math.floor(attack * sr));
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const fi = f * Math.pow(fTo / f, Math.min(1, i / n));
      ph += (2 * Math.PI * fi) / sr;
      const env = (i < atk ? i / atk : 1) * Math.exp(-t / tau);
      const j = start + i;
      if (j >= this.out.length) break;
      this.out[j] = (this.out[j] ?? 0) + Math.sin(ph) * env * gain;
    }
  }

  /**
   * One card meeting another / the felt: a hard paper click, the card's body
   * resonance, the felt's dull thud and an optional low sine for weight.
   */
  snap(at: number, s: Snap): void {
    const k = s.gain ?? 1;
    // Layer trims: white noise through a narrow band carries a fraction of the
    // click's power, and a sine carries all of its own, so the raw gains below
    // are balanced here to land body/felt in the 250 Hz-4 kHz a phone plays.
    const BODY = 3.2;
    const FELT = 2.2;
    const LOW = 0.3;
    const CLICK = 0.6;
    /** The body rings a little longer than its raw tau: less crest, more card. */
    const RING = 1.5;
    const j = 1 + (this.rand() * 2 - 1) * 0.06; // a little life per layer
    if (s.click)
      this.burst({
        at,
        type: 'hp',
        f: s.clickHz ?? 2600,
        tau: (s.clickTau ?? 0.001) * 1.3,
        gain: s.click * k * j * CLICK,
      });
    if (s.body)
      this.burst({
        at,
        type: 'bp',
        f: (s.bodyHz ?? 1400) * j,
        q: s.bodyQ ?? 1.1,
        tau: (s.bodyTau ?? 0.006) * RING,
        gain: s.body * k * BODY,
      });
    if (s.felt)
      this.burst({
        at,
        type: 'lp',
        f: s.feltHz ?? 480,
        attack: 0.0012,
        tau: s.feltTau ?? 0.014,
        gain: s.felt * k * FELT,
      });
    if (s.low)
      this.sine(at, s.lowHz ?? 160, s.lowTau ?? 0.018, s.low * k * LOW, (s.lowHz ?? 160) * 0.75);
  }

  /** Short fade at the tail so nothing ends on a cut. */
  finish(): Float32Array {
    const fade = Math.floor(this.sr * 0.01);
    const n = this.out.length;
    for (let i = 0; i < fade; i++) {
      const idx = n - 1 - i;
      this.out[idx] = (this.out[idx] ?? 0) * (i / fade);
    }
    return this.out;
  }
}

interface Snap {
  gain?: number;
  click?: number;
  clickHz?: number;
  clickTau?: number;
  body?: number;
  bodyHz?: number;
  bodyQ?: number;
  bodyTau?: number;
  felt?: number;
  feltHz?: number;
  feltTau?: number;
  low?: number;
  lowHz?: number;
  lowTau?: number;
}

// ---------------------------------------------------------------------------
// The cues

type Render = (sr: number, seed: number) => Float32Array;

const RENDER: Readonly<Record<CardCueId, Render>> = {
  /** A card settles on a tableau pile: paper tap over a soft felt thud. */
  'card-place': (sr, seed) => {
    const c = new Canvas(sr, 0.14, seed);
    c.snap(0.002, {
      click: 0.55,
      clickHz: 2800,
      clickTau: 0.0009,
      body: 0.6,
      bodyHz: 1150,
      bodyTau: 0.007,
      felt: 0.7,
      feltHz: 450,
      feltTau: 0.018,
      low: 0.35,
      lowHz: 150,
      lowTau: 0.02,
    });
    return c.finish();
  },

  /** A face-down card turns up: a flick of air, then the crisp snap of the face landing. */
  'card-flip': (sr, seed) => {
    const c = new Canvas(sr, 0.11, seed);
    c.burst({
      at: 0,
      type: 'bp',
      f: 2400,
      fTo: 5200,
      q: 0.9,
      tau: 0,
      shape: 'swell',
      len: 0.03,
      gain: 0.35,
    });
    c.snap(0.026, {
      click: 1,
      clickHz: 3200,
      clickTau: 0.0008,
      body: 0.5,
      bodyHz: 2100,
      bodyTau: 0.004,
      felt: 0.18,
      feltHz: 650,
      feltTau: 0.008,
    });
    return c.finish();
  },

  /** Stock to waste: a short slide off the stock ending in a light tap. */
  'card-draw': (sr, seed) => {
    const c = new Canvas(sr, 0.12, seed);
    c.burst({
      at: 0,
      type: 'bp',
      f: 1700,
      fTo: 3600,
      q: 0.8,
      tau: 0,
      shape: 'swell',
      len: 0.05,
      gain: 0.45,
    });
    c.snap(0.042, {
      click: 0.6,
      clickHz: 3000,
      clickTau: 0.0007,
      body: 0.4,
      bodyHz: 1600,
      bodyTau: 0.005,
      felt: 0.25,
      feltHz: 520,
      feltTau: 0.01,
    });
    return c.finish();
  },

  /** Waste back to the stock: the pile swept up (a quick flutter of edges) and squared with one tap. */
  recycle: (sr, seed) => {
    const c = new Canvas(sr, 0.36, seed);
    c.burst({
      at: 0,
      type: 'bp',
      f: 2200,
      fTo: 1400,
      q: 0.7,
      tau: 0,
      shape: 'swell',
      len: 0.22,
      gain: 0.16,
    });
    let t = 0.012;
    for (let i = 0; i < 12; i++) {
      c.burst({
        at: t,
        type: 'hp',
        f: 2400 + c.r() * 2000,
        tau: 0.0005,
        gain: 0.35 + c.r() * 0.25,
      });
      t += 0.013 + i * 0.0012 + c.r() * 0.004;
    }
    c.snap(0.24, {
      click: 0.35,
      clickHz: 2400,
      body: 0.45,
      bodyHz: 900,
      bodyTau: 0.008,
      felt: 0.65,
      feltHz: 400,
      feltTau: 0.02,
      low: 0.3,
      lowHz: 130,
    });
    return c.finish();
  },

  /** A card lands home: the firmest, crispest snap in the set (its pitch lives in `foundation-tone`). */
  foundation: (sr, seed) => {
    const c = new Canvas(sr, 0.12, seed);
    c.snap(0.002, {
      click: 1,
      clickHz: 2400,
      clickTau: 0.0012,
      body: 0.65,
      bodyHz: 1500,
      bodyTau: 0.007,
      felt: 0.35,
      feltHz: 520,
      feltTau: 0.013,
      low: 0.22,
      lowHz: 185,
      lowTau: 0.015,
    });
    return c.finish();
  },

  /** A soft muted bell, G4, under the foundation snap; the engine rides its rate for the rise. */
  'foundation-tone': (sr, seed) => {
    const c = new Canvas(sr, 0.4, seed);
    const f = FOUNDATION_TONE_HZ;
    c.sine(0, f, 0.09, 1, f, 0.003);
    c.sine(0, f * 2, 0.05, 0.3, f * 2, 0.003);
    c.sine(0, f * 3.01, 0.025, 0.1, f * 3.01, 0.002);
    c.sine(0, f * 4.2, 0.012, 0.05, f * 4.2, 0.001);
    return c.finish();
  },

  /** Off a foundation: the card lifted (a falling swish) and set down softly. */
  return: (sr, seed) => {
    const c = new Canvas(sr, 0.16, seed);
    c.burst({
      at: 0,
      type: 'bp',
      f: 3200,
      fTo: 1500,
      q: 0.8,
      tau: 0,
      shape: 'swell',
      len: 0.055,
      gain: 0.35,
    });
    c.snap(0.048, {
      click: 0.35,
      clickHz: 2400,
      body: 0.45,
      bodyHz: 1000,
      bodyTau: 0.007,
      felt: 0.45,
      feltHz: 420,
      feltTau: 0.016,
      low: 0.2,
      lowHz: 140,
    });
    return c.finish();
  },

  /** One step of the autocomplete run: a light, quick snap (the tone rides under it). */
  cascade: (sr, seed) => {
    const c = new Canvas(sr, 0.075, seed);
    c.snap(0.001, {
      click: 0.85,
      clickHz: 2900,
      clickTau: 0.0008,
      body: 0.45,
      bodyHz: 1800,
      bodyTau: 0.004,
      felt: 0.2,
      feltHz: 600,
      feltTau: 0.008,
    });
    return c.finish();
  },

  /** The deal-in: a riffle (the halves' edges interleaving), the bridge falling together, the deck squared twice. */
  shuffle: (sr, seed) => {
    const c = new Canvas(sr, 1.05, seed);
    const riffle = 0.56;
    c.burst({
      at: 0.01,
      type: 'bp',
      f: 2600,
      q: 0.6,
      tau: 0,
      shape: 'swell',
      len: riffle,
      gain: 0.07,
    });
    let t = 0.02;
    const cards = 46;
    for (let i = 0; i < cards; i++) {
      const u = i / (cards - 1);
      // faster through the middle of the riffle, slower at either end
      const dt = 0.0085 + 0.009 * Math.pow(Math.abs(u - 0.5) * 2, 2) + c.r() * 0.003;
      const g = (0.3 + c.r() * 0.3) * (0.6 + 0.4 * Math.sin(Math.PI * Math.min(1, u * 1.2)));
      c.burst({ at: t, type: 'hp', f: 2200 + c.r() * 2800, tau: 0.0004 + c.r() * 0.0003, gain: g });
      c.burst({ at: t, type: 'bp', f: 1100 + c.r() * 500, q: 1.2, tau: 0.0025, gain: g * 0.35 });
      t += dt;
    }
    c.burst({
      at: riffle + 0.05,
      type: 'bp',
      f: 1700,
      fTo: 900,
      q: 0.7,
      tau: 0,
      shape: 'swell',
      len: 0.2,
      gain: 0.2,
    });
    const tap: Snap = {
      click: 0.3,
      clickHz: 2200,
      body: 0.45,
      bodyHz: 820,
      bodyTau: 0.009,
      felt: 0.7,
      feltHz: 360,
      feltTau: 0.022,
      low: 0.35,
      lowHz: 125,
      lowTau: 0.022,
    };
    c.snap(0.84, tap);
    c.snap(0.92, { ...tap, gain: 0.55 });
    return c.finish();
  },

  /** An illegal drop snapping back: a muted double knock on the felt, no paper edge. */
  'card-reject': (sr, seed) => {
    const c = new Canvas(sr, 0.2, seed);
    const knock: Snap = {
      body: 0.4,
      bodyHz: 700,
      bodyQ: 1.5,
      bodyTau: 0.008,
      felt: 0.7,
      feltHz: 380,
      feltTau: 0.016,
      low: 0.4,
      lowHz: 120,
      lowTau: 0.018,
    };
    c.snap(0.002, knock);
    c.snap(0.075, { ...knock, gain: 0.6 });
    return c.finish();
  },

  /** Undo: a reverse swish, as if the last move is pulled back, then a light tap. */
  undo: (sr, seed) => {
    const c = new Canvas(sr, 0.15, seed);
    c.burst({
      at: 0,
      type: 'bp',
      f: 1400,
      fTo: 3000,
      q: 0.8,
      tau: 0,
      shape: 'rise',
      len: 0.075,
      attack: 0.008,
      gain: 0.45,
    });
    c.snap(0.078, {
      click: 0.4,
      clickHz: 2800,
      body: 0.35,
      bodyHz: 1300,
      bodyTau: 0.005,
      felt: 0.25,
      feltHz: 500,
      feltTau: 0.01,
    });
    return c.finish();
  },
};

/** Render one cue, peak-normalised to CARD_PEAK_DBFS. Deterministic for a given seed. */
export function renderCardCue(id: CardCueId, sampleRate = 48_000, seed = 0x5eed): Float32Array {
  const x = RENDER[id](sampleRate, seed ^ hashId(id));
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i] ?? 0));
  const k = peak > 0 ? Math.pow(10, CARD_PEAK_DBFS / 20) / peak : 1;
  for (let i = 0; i < x.length; i++) x[i] = (x[i] ?? 0) * k;
  return x;
}

export function isCardCue(id: string): id is CardCueId {
  return (CARD_CUES as readonly string[]).includes(id);
}

function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
