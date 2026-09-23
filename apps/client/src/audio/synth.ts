/**
 * The alpha's synthesised placeholder cues, kept as the fallback the engine
 * uses when the generated manifest cannot be fetched or decoded. WebAudio
 * oscillators only: nothing fetched, nothing generated.
 *
 * The card cues are the exception: their fallback is the real thing. The
 * committed files are offline renders of `cardfx.ts`, so `card()` renders
 * the same DSP into an AudioBuffer (once per cue, a few ms) and plays it at
 * the manifest gain the files would have had.
 */
import { CARD_CUE_GAIN, type CardCueId, renderCardCue } from './cardfx.js';
import type { ResultsBeat } from './engine.js';

export class SynthCues {
  private readonly cards = new Map<CardCueId, AudioBuffer>();

  constructor(
    private readonly ctx: AudioContext,
    private readonly out: AudioNode,
  ) {}

  /** A card cue rendered on the spot from cardfx.ts (cached): `rate` pitches it, `gain` scales the manifest gain. */
  card(id: CardCueId, o: { rate?: number; gain?: number; delay?: number } = {}): void {
    const c = this.ctx;
    let buf = this.cards.get(id);
    if (!buf) {
      const x = renderCardCue(id, c.sampleRate);
      buf = c.createBuffer(1, x.length, c.sampleRate);
      buf.getChannelData(0).set(x);
      this.cards.set(id, buf);
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = o.rate ?? 1;
    const g = c.createGain();
    g.gain.value = CARD_CUE_GAIN[id] * (o.gain ?? 1);
    src.connect(g);
    g.connect(this.out);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
    src.start(c.currentTime + (o.delay ?? 0));
  }

  place(): void {
    const t = this.ctx.currentTime;
    this.noise(0.05, t, 0.35, 1800);
    this.tone('sine', 220, 0.09, t, 0.25, 160);
  }

  rejected(): void {
    this.tone('square', 140, 0.09, this.ctx.currentTime, 0.12, 110);
  }

  deal(): void {
    const t = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) this.tone('triangle', 520 + i * 90, 0.06, t + i * 0.05, 0.08);
  }

  clear(lines: number, sameColor: boolean): void {
    const t = this.ctx.currentTime;
    const base = 440;
    const steps = Math.min(5, lines + 1);
    for (let i = 0; i < steps; i++) {
      const f = base * Math.pow(2, (i * (lines >= 3 ? 4 : 3)) / 12);
      this.tone('triangle', f, 0.16, t + i * 0.055, 0.22);
      this.tone('sine', f * 2, 0.1, t + i * 0.055, 0.1);
    }
    this.noise(0.18, t, 0.25, 6000);
    if (sameColor) {
      for (let i = 0; i < 4; i++)
        this.tone('sine', 880 * Math.pow(2, (i * 7) / 12), 0.2, t + 0.3 + i * 0.07, 0.15);
    }
  }

  streak(n: number): void {
    const t = this.ctx.currentTime + 0.25;
    const notes = [0, 4, 7, 12, 16, 19];
    for (let i = 0; i < Math.min(notes.length, n + 1); i++) {
      this.tone('square', 330 * Math.pow(2, (notes[i] ?? 0) / 12), 0.12, t + i * 0.045, 0.07);
    }
  }

  /** Level-up: three glassy notes rising (F - Ab - C), 90 ms apart, the last one ringing. */
  levelUp(): void {
    const t = this.ctx.currentTime + 0.08;
    const notes = [932, 1175, 1397];
    for (let i = 0; i < notes.length; i++) {
      const f = notes[i] ?? 932;
      const last = i === notes.length - 1;
      this.tone('sine', f, last ? 0.5 : 0.22, t + i * 0.09, 0.09);
      this.tone('triangle', f * 2, last ? 0.3 : 0.14, t + i * 0.09, 0.03);
    }
  }

  end(stuck: boolean): void {
    const t = this.ctx.currentTime;
    const chord = stuck ? [220, 261.6, 311.1] : [261.6, 329.6, 392, 523.3];
    chord.forEach((f, i) => this.tone('triangle', f, 0.9, t + i * 0.06, 0.16));
  }

  resultsBeat(kind: ResultsBeat): void {
    const t = this.ctx.currentTime;
    if (kind === 'burst' || kind === 'outcome-win')
      this.tone('triangle', 520 + Math.random() * 300, 0.08, t, 0.05);
    else if (kind === 'outcome-burst') this.streak(4);
    else if (kind === 'outcome-loss') this.end(true);
    else if (kind === 'digit') this.tone('square', 880, 0.05, t, 0.04);
    else if (kind === 'row') this.tone('sine', 196, 0.12, t, 0.12, 150);
    else this.tone('triangle', 523.3, 0.5, t, 0.14);
  }

  countdown(value: number): void {
    const t = this.ctx.currentTime;
    if (value === 0) {
      this.tone('triangle', 660, 0.35, t, 0.2);
      this.tone('sine', 1320, 0.3, t, 0.08);
      this.noise(0.25, t, 0.2, 5000);
    } else {
      this.tone('triangle', 440, 0.12, t, 0.14);
    }
  }

  // ---------------------------------------------------------------------------

  private tone(
    type: OscillatorType,
    freq: number,
    dur: number,
    at: number,
    gain: number,
    glideTo?: number,
  ): void {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (glideTo !== undefined) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g);
    g.connect(this.out);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  private noise(dur: number, at: number, gain: number, cutoff: number): void {
    const c = this.ctx;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.out);
    src.start(at);
  }
}
