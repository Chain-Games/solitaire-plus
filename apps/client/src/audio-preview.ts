import { assetUrl } from './assets.js';
import { CARD_CUES } from './audio/cardfx.js';
import { AudioEngine, type CardCue, DEFAULT_MIX, type Mix } from './audio/engine.js';

/**
 * Dev-only: /audio-preview.html plays every card cue through the real
 * AudioEngine (as the playfield calls it), a foundation per rank, the
 * cascade in both of its modes and Blockari's placement for reference; and
 * measures the shipped files (decoded, at their manifest gain) against
 * Blockari's `place`.
 */
const engine = new AudioEngine(true);
const mix: Mix = { ...DEFAULT_MIX };
engine.setMix(mix);
const unlock = (): void => engine.unlock();
document.addEventListener('pointerdown', unlock, { capture: true });

function button(parent: string, label: string, fn: () => void): void {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => {
    unlock();
    fn();
  });
  document.getElementById(parent)?.appendChild(b);
}

const CUES: CardCue[] = [
  'card-place',
  'card-flip',
  'card-draw',
  'recycle',
  'foundation',
  'return',
  'cascade',
  'shuffle',
  'rejected',
  'undo',
];
for (const c of CUES) button('cues', c, () => engine.cue(c));

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
RANKS.forEach((r, i) => button('ranks', r, () => engine.cue('foundation', i + 1)));
button('ranks', 'A..K', () =>
  RANKS.forEach((_, i) => setTimeout(() => engine.cue('foundation', i + 1), i * 220)),
);

button('cascade', 'one call (engine run)', () => engine.cue('cascade'));
button('cascade', 'per card x 52 (rank)', () => {
  for (let i = 0; i < 52; i++)
    setTimeout(() => engine.cue('cascade', Math.floor(i / 4) + 1), i * 80);
});

button('ref', 'place (Blockari)', () => engine.cue('place'));
button('ref', 'streak 2X', () =>
  engine.handle({
    type: 'scored',
    kind: 'foundation',
    points: 125,
    streak: 2,
    total: 0,
    pile: 'f0',
  }),
);
button('ref', 'level up', () =>
  engine.handle({ type: 'levelUp', level: 2, from: 1, atScore: 0, nextThreshold: 0 }),
);

// ---- the mixer
const mixEl = document.getElementById('mix');
for (const k of ['master', 'music', 'sfx'] as const) {
  const l = document.createElement('label');
  l.textContent = k === 'sfx' ? 'effects' : k;
  const r = document.createElement('input');
  r.type = 'range';
  r.min = '0';
  r.max = '1';
  r.step = '0.01';
  r.value = String(mix[k]);
  r.addEventListener('input', () => {
    mix[k] = Number(r.value);
    engine.setMix(mix);
  });
  l.appendChild(r);
  mixEl?.appendChild(l);
}

// ---- levels
interface Entry {
  file: string;
  gain: number;
}

const db = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -Infinity);

/** Sample peak over every channel and the loudest 50 ms of the channels' mean power. */
function levels(buf: AudioBuffer): { peak: number; rms: number } {
  const w = Math.floor(buf.sampleRate * 0.05);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  let peak = 0;
  let best = 0;
  let acc = 0;
  for (let i = 0; i < buf.length; i++) {
    for (const x of chans) {
      const v = x[i] ?? 0;
      peak = Math.max(peak, Math.abs(v));
      acc += (v * v) / chans.length;
      if (i >= w) acc -= (x[i - w] ?? 0) ** 2 / chans.length;
    }
    best = Math.max(best, acc / w);
  }
  return { peak: db(peak), rms: 10 * Math.log10(best + 1e-20) };
}

document.getElementById('measure')?.addEventListener('click', () => {
  void (async () => {
    const res = await fetch(assetUrl('audio/manifest.json'));
    const manifest = (await res.json()) as { cues: Record<string, Entry> };
    const ctx = new OfflineAudioContext(1, 48_000, 48_000);
    const ids = ['place', 'reject', 'deal', ...CARD_CUES];
    const rows: string[] = [];
    let ref: { peak: number; rms: number } | null = null;
    for (const id of ids) {
      const e = manifest.cues[id];
      if (!e) continue;
      const buf = await ctx.decodeAudioData(
        await (await fetch(assetUrl(`audio/${e.file}`))).arrayBuffer(),
      );
      const l = levels(buf);
      const g = db(e.gain);
      const bus = { peak: l.peak + g, rms: l.rms + g };
      ref ??= bus;
      rows.push(
        `<tr><td>${id}</td><td>${e.gain}</td><td>${bus.peak.toFixed(1)}</td><td>${bus.rms.toFixed(1)}</td><td>${(bus.peak - ref.peak).toFixed(1)}</td><td>${(bus.rms - ref.rms).toFixed(1)}</td></tr>`,
      );
    }
    const el = document.getElementById('levels');
    if (el)
      el.innerHTML = `<table><tr><th>cue</th><th>gain</th><th>peak dBFS</th><th>RMS50 dBFS</th><th>peak vs place</th><th>RMS vs place</th></tr>${rows.join('')}</table>`;
  })();
});
