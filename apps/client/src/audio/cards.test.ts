import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CARD_CUES, CARD_CUE_GAIN, CARD_PEAK_DBFS, renderCardCue } from './cardfx.js';

/**
 * The card cues: the DSP renders (deterministic, short, at their peak), and
 * the engine's routing — which sim event / playfield name plays which cue,
 * the hand-over from events to the playfield, the cascade in both of its
 * modes, the reject dedup and the haptics. The engine runs against a fake
 * AudioContext with no manifest, so every cue lands on the synth fallback,
 * which is spied on.
 */

describe('cardfx renders', () => {
  it('every cue is short, at its peak, deterministic and finite', () => {
    for (const id of CARD_CUES) {
      const a = renderCardCue(id, 48_000);
      const b = renderCardCue(id, 48_000);
      expect(a).toEqual(b);
      expect(a.length / 48_000).toBeLessThanOrEqual(id === 'shuffle' ? 1.1 : 0.4);
      let peak = 0;
      for (const v of a) {
        expect(Number.isFinite(v)).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
      expect(20 * Math.log10(peak)).toBeCloseTo(CARD_PEAK_DBFS, 3);
    }
  });

  it('keeps every card gain at or under Blockari place (0.45)', () => {
    for (const id of CARD_CUES) expect(CARD_CUE_GAIN[id]).toBeLessThanOrEqual(0.45);
  });
});

// ---------------------------------------------------------------------------
// A fake WebAudio, just enough for the engine's graph.

class FakeParam {
  value = 1;
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number): this {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
}
class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  playbackRate = new FakeParam();
  type = '';
  fftSize = 512;
  smoothingTimeConstant = 0;
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect(): void {}
  disconnect(): void {}
  start(): void {}
  stop(): void {}
  getFloatTimeDomainData(): void {}
}
class FakeCtx {
  static now = 0;
  sampleRate = 48_000;
  state = 'running';
  destination = new FakeNode();
  get currentTime(): number {
    return FakeCtx.now;
  }
  createGain = (): FakeNode => new FakeNode();
  createBufferSource = (): FakeNode => new FakeNode();
  createBiquadFilter = (): FakeNode => new FakeNode();
  createAnalyser = (): FakeNode => new FakeNode();
  createOscillator = (): FakeNode => new FakeNode();
  createBuffer = (_c: number, n: number) => ({ getChannelData: () => new Float32Array(n) });
  resume = async (): Promise<void> => {};
  close = async (): Promise<void> => {};
}

const vibrations: (number | number[])[] = [];

beforeEach(() => {
  FakeCtx.now = 10;
  vibrations.length = 0;
  vi.stubGlobal('window', { AudioContext: FakeCtx });
  vi.stubGlobal('document', {
    hidden: false,
    createElement: () => ({ setAttribute() {}, style: {}, play: async () => {}, paused: false }),
    body: { appendChild() {} },
  });
  vi.stubGlobal('navigator', {
    vibrate: (p: number | number[]) => {
      vibrations.push(p);
      return true;
    },
    maxTouchPoints: 5,
  });
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 404 }));
  vi.stubGlobal(
    'Audio',
    class {
      canPlayType(): string {
        return 'probably';
      }
    },
  );
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
  });
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function engine() {
  const { SynthCues } = await import('./synth.js');
  const played: string[] = [];
  const rates: number[] = [];
  vi.spyOn(SynthCues.prototype, 'card').mockImplementation((id, o) => {
    played.push(id);
    if (id === 'foundation-tone') rates.push(o?.rate ?? 1);
  });
  vi.spyOn(SynthCues.prototype, 'end').mockImplementation(() => played.push('end'));
  vi.spyOn(SynthCues.prototype, 'streak').mockImplementation(() => played.push('streak'));
  const { AudioEngine } = await import('./engine.js');
  const e = new AudioEngine(true);
  e.unlock();
  await vi.advanceTimersByTimeAsync(0); // the manifest fetch fails: synth fallback from here
  return { e, played, rates };
}

const moved = (from: string, to: string, auto = false) =>
  ({ type: 'moved', from, to, slots: [1], auto }) as const;

describe('card cue routing', () => {
  it('plays each event as its card cue until the playfield takes the name', async () => {
    const { e, played } = await engine();
    e.handle({ type: 'dealt' });
    e.handle(moved('t0', 't1') as never);
    e.handle({ type: 'flipped', pile: 't0', slot: 3, card: null });
    e.handle({ type: 'drew', slots: [4] });
    e.handle({ type: 'recycled', count: 20 });
    e.handle({ type: 'undone', remaining: 0 });
    e.handle(moved('f0', 't2') as never);
    e.handle(moved('waste', 'f1') as never); // silent: `scored` pitches it
    e.handle({
      type: 'scored',
      kind: 'foundation',
      points: 100,
      streak: 1,
      total: 100,
      pile: 'f1',
    });
    expect(played).toEqual([
      'shuffle',
      'card-place',
      'card-flip',
      'card-draw',
      'recycle',
      'undo',
      'return',
      'foundation',
      'foundation-tone',
    ]);
  });

  it('hands a name over to the playfield once, without a double', async () => {
    const { e, played } = await engine();
    e.handle(moved('t0', 't1') as never);
    e.cue('card-place'); // the same card landing: already heard
    FakeCtx.now += 1;
    e.handle(moved('t1', 't2') as never); // the playfield owns it now: silent
    e.cue('card-place');
    expect(played).toEqual(['card-place', 'card-place']);
  });

  it('pitches the foundation tone by rank, else by streak', async () => {
    const { e, rates } = await engine();
    e.cue('foundation', 1);
    e.cue('foundation', 13);
    e.handle({ type: 'scored', kind: 'reveal', points: 50, streak: 3, total: 150, pile: 't0' });
    e.cue('foundation');
    expect(rates[0]).toBeCloseTo(1);
    expect(rates[1]).toBeCloseTo(Math.pow(2, 21 / 12));
    expect(rates[2]).toBeCloseTo(Math.pow(2, 4 / 12)); // 3X: the third pentatonic degree
  });

  it('dedups rejected() and cue("rejected") into one knock and one thump', async () => {
    const { e, played } = await engine();
    e.rejected();
    e.cue('rejected');
    expect(played).toEqual(['card-reject']);
    expect(vibrations).toEqual([20]);
  });

  it('maps the light haptics: tick on place, tap on foundation', async () => {
    const { e } = await engine();
    e.cue('card-place');
    vi.advanceTimersByTime(200);
    e.cue('foundation', 5);
    expect(vibrations).toEqual([8, 14]);
  });
});

describe('the cascade', () => {
  it('spaces an autocomplete burst of events into a rising run, the result after it', async () => {
    const { e, played, rates } = await engine();
    for (let i = 0; i < 8; i++) {
      e.handle(moved(`t${i % 7}`, `f${i % 4}`, true) as never);
      e.handle({ type: 'scored', kind: 'auto', points: 100, streak: 4, total: 0, pile: 'f0' });
    }
    e.handle({ type: 'ended', reason: 'cleared', breakdown: {} as never });
    // only the look-ahead is booked at once, and no streak stinger per card
    expect(played.filter((p) => p === 'cascade').length).toBeLessThan(4);
    expect(played).not.toContain('streak');
    for (let k = 0; k < 20; k++) {
      FakeCtx.now += 0.05;
      vi.advanceTimersByTime(50);
    }
    expect(played.filter((p) => p === 'cascade').length).toBe(8);
    expect(rates[0]).toBeCloseTo(1);
    expect(rates[7]).toBeGreaterThan(rates[0] ?? 1); // the fifth card climbs a degree
    expect(played).toContain('end');
  });

  it('per-card calls: two quick calls take over and cancel the engine run', async () => {
    const { e, played } = await engine();
    e.cue('cascade'); // one call: a run starts
    FakeCtx.now += 0.1;
    e.cue('cascade', 2); // a second: per card from here
    FakeCtx.now += 0.1;
    e.cue('cascade', 3);
    const before = played.filter((p) => p === 'cascade').length;
    for (let k = 0; k < 20; k++) {
      FakeCtx.now += 0.05;
      vi.advanceTimersByTime(50);
    }
    expect(played.filter((p) => p === 'cascade').length).toBe(before); // nothing more from the run
  });

  it('one call with nothing behind it plays a run by itself', async () => {
    const { e, played } = await engine();
    e.cue('cascade');
    for (let k = 0; k < 40; k++) {
      FakeCtx.now += 0.05;
      vi.advanceTimersByTime(50);
    }
    expect(played.filter((p) => p === 'cascade').length).toBe(16);
  });
});
