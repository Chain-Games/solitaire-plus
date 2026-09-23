/**
 * Offline renderer for the card cues (apps/client/src/audio/cardfx.ts).
 *
 *   node tools/cardfx/render.ts             render, encode, update the manifest, print the levels
 *   node tools/cardfx/render.ts --measure   only print the levels table of what is shipped
 *   node tools/cardfx/render.ts --wav=DIR   also keep the premaster WAVs in DIR
 *
 * No API, no key: the cues are pure DSP (filtered noise bursts, damped sines).
 * The chain matches Blockari's tools/audiogen SFX post as far as it applies:
 * mono 48 kHz, peak at -3.5 dBFS in the render (the codecs land it near
 * -3 dBTP), Opus 96k `.ogg` (primary) + AAC 192k `.m4a` (Safari), and the
 * manifest entry carries the play-time gain, the duration, the true peak
 * (the worse of the two containers) and the bytes.
 *
 * The levels table decodes every shipped card cue AND Blockari's placement
 * family (`place`, `reject`, `deal`) and reports, per cue, the file's sample
 * peak and RMS (over the cue's loudest 50 ms, which is what a short cue
 * reads as) and the same at its manifest gain, i.e. on the SFX bus before
 * the user's sliders. Nothing a card does may sit above `place` there.
 *
 * Requires Node >= 22.6 (type stripping) and ffmpeg on PATH (or FFMPEG=...).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CARD_CUES,
  CARD_CUE_GAIN,
  type CardCueId,
  renderCardCue,
} from '../../apps/client/src/audio/cardfx.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUDIO = path.join(ROOT, 'apps/client/public/audio');
const SFX = path.join(AUDIO, 'sfx');
const MANIFEST = path.join(AUDIO, 'manifest.json');
const FFMPEG = process.env['FFMPEG'] ?? 'ffmpeg';
const SR = 48_000;
/** Blockari's placement family, the reference the card cues are levelled against. */
const REFERENCE = ['place', 'reject', 'deal'];
/**
 * The phone column high-passes at this (4th order) before the RMS: Blockari's
 * `place` is 94 % energy under 250 Hz, which a phone speaker does not play,
 * so a plain RMS flatters it against a card's paper snap.
 */
const PHONE_HP_HZ = 250;

const args = process.argv.slice(2);
const measureOnly = args.includes('--measure');
const wavDir = args.find((a) => a.startsWith('--wav='))?.slice(6);

interface Entry {
  kind: string;
  file: string;
  alt: string;
  duration: number;
  gain: number;
  lufs: number | null;
  truePeak: number;
  bytes: number;
  [k: string]: unknown;
}
interface Manifest {
  version: number;
  generatedAt: string;
  cues: Record<string, Entry>;
}

function wav(x: Float32Array, sr: number): Buffer {
  const b = Buffer.alloc(44 + x.length * 4);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + x.length * 4, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(3, 20); // IEEE float
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(32, 34);
  b.write('data', 36);
  b.writeUInt32LE(x.length * 4, 40);
  for (let i = 0; i < x.length; i++) b.writeFloatLE(x[i] ?? 0, 44 + i * 4);
  return b;
}

function ff(argv: string[]): string {
  return execFileSync(FFMPEG, ['-hide_banner', '-nostdin', ...argv], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
}

/** True peak (dBTP, 4x oversampled) of an encoded file, via ebur128. */
function truePeak(file: string): number {
  const r = spawnSync(
    FFMPEG,
    ['-hide_banner', '-nostdin', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const m = /True peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf)/.exec(r.stderr ?? '');
  return m && m[1] !== '-inf' ? Number(m[1]) : -Infinity;
}

/** Decode a file to mono float at 48 kHz; `hp` high-passes it first (what a phone speaker plays). */
function decode(file: string, hp = false): Float32Array {
  const af = hp
    ? ['-af', `highpass=f=${PHONE_HP_HZ}:poles=2,highpass=f=${PHONE_HP_HZ}:poles=2`]
    : [];
  const raw = execFileSync(
    FFMPEG,
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      file,
      ...af,
      '-ac',
      '1',
      '-ar',
      String(SR),
      '-f',
      'f32le',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 },
  );
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

const db = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -Infinity);

/** Sample peak and the loudest 50 ms RMS, both dBFS. */
function levels(x: Float32Array): { peak: number; rms: number } {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i] ?? 0));
  const w = Math.floor(SR * 0.05);
  let best = 0;
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    acc += (x[i] ?? 0) ** 2;
    if (i >= w) acc -= (x[i - w] ?? 0) ** 2;
    best = Math.max(best, acc / w);
  }
  return { peak: db(peak), rms: 10 * Math.log10(best + 1e-20) };
}

function render(manifest: Manifest): void {
  mkdirSync(SFX, { recursive: true });
  const tmp = mkdtempSync(path.join(tmpdir(), 'cardfx-'));
  if (wavDir) mkdirSync(wavDir, { recursive: true });
  try {
    for (const id of CARD_CUES) {
      const x = renderCardCue(id, SR);
      const w = path.join(wavDir ?? tmp, `${id}.wav`);
      writeFileSync(w, wav(x, SR));
      const ogg = path.join(SFX, `${id}.ogg`);
      const m4a = path.join(SFX, `${id}.m4a`);
      ff([
        '-y',
        '-i',
        w,
        '-c:a',
        'libopus',
        '-b:a',
        '96k',
        '-ar',
        '48000',
        '-map_metadata',
        '-1',
        ogg,
      ]);
      ff([
        '-y',
        '-i',
        w,
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-map_metadata',
        '-1',
        m4a,
      ]);
      const tp = Math.max(truePeak(ogg), truePeak(m4a));
      manifest.cues[id] = {
        kind: 'sfx',
        file: `sfx/${id}.ogg`,
        alt: `sfx/${id}.m4a`,
        duration: Math.round((x.length / SR) * 1000) / 1000,
        gain: CARD_CUE_GAIN[id as CardCueId],
        lufs: null, // under 400 ms: no gated integrated loudness, as Blockari's short cues
        truePeak: Math.round(tp * 10) / 10,
        bytes: statSync(ogg).size + statSync(m4a).size,
        source: 'cardfx',
      };
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  manifest.generatedAt = new Date().toISOString();
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
}

function table(manifest: Manifest): void {
  const ref = manifest.cues['place'];
  if (!ref) throw new Error('manifest has no `place` to level against');
  const refG = db(ref.gain);
  const refL = levels(decode(path.join(AUDIO, ref.file)));
  const refP = levels(decode(path.join(AUDIO, ref.file), true));
  const f = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(1);
  const rows: string[] = [
    '| cue | gain | file peak | file RMS50 | bus peak | bus RMS50 | bus RMS50 >250 Hz | vs place: peak / RMS / RMS >250 Hz | dBTP |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const id of [...REFERENCE, ...CARD_CUES]) {
    const e = manifest.cues[id];
    if (!e) continue;
    const l = levels(decode(path.join(AUDIO, e.file)));
    const p = levels(decode(path.join(AUDIO, e.file), true));
    const g = db(e.gain);
    rows.push(
      `| ${id} | ${e.gain} | ${l.peak.toFixed(1)} | ${l.rms.toFixed(1)} | ${(l.peak + g).toFixed(1)} | ${(l.rms + g).toFixed(1)} | ${(p.rms + g).toFixed(1)} | ${f(l.peak + g - refL.peak - refG)} / ${f(l.rms + g - refL.rms - refG)} / ${f(p.rms + g - refP.rms - refG)} | ${e.truePeak} |`,
    );
  }
  console.log(rows.join('\n'));
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
if (!measureOnly) render(manifest);
table(manifest);
