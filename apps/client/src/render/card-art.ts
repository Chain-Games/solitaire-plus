import { RANK_LABELS, isRed, rankOf, suitOf, type Card } from '@solitaire-plus/sim';
import { Rectangle, Texture } from 'pixi.js';

/**
 * The card atlas: 52 faces and one back, baked once at boot into a single
 * texture. The look is 21 Wild's deck exactly (see below): Byron Knoll's
 * Vector Playing Cards (public domain) on 21 Wild's warm paper, its Bebas
 * Neue corner indices and printed rules, and its guilloche back.
 *
 * KLONDIKE-BRIEF §7: the table is painted before this runs (the bake awaits
 * each decode, so it yields between cards), pips bake before courts, the
 * cell is sized to the DISPLAY not the window, and the atlas never exceeds
 * 4096² (phones' MAX_TEXTURE_SIZE).
 */

/** 21 Wild's CARD: 207 × 290 design units, corner radius 14. */
export const CARD_ASPECT = 290 / 207;
/** Corner radius as a fraction of the card width. */
export const CARD_RADIUS = 14 / 207;
/** The widest a card is ever drawn, in CSS px (desktop cap). */
const MAX_CARD_CSS = 104;
const MAX_ATLAS = 4096;
const COLS = 8;
/** Transparent gutter around each cell so linear filtering never bleeds a neighbour. */
const GUTTER = 2;

/**
 * The corner index (21 Wild cardFace.ts): position and cap size as fractions
 * of the card. The tableau's face-up overlap must show down to about
 * y + size / 2.
 */
export const INDEX = { x: 0.088, y: 0.087, size: 0.108 } as const;

export interface CardAtlas {
  /** Face per card id (0..51). */
  readonly faces: readonly Texture[];
  readonly back: Texture;
  /** The cell's size in texture px. */
  readonly cellW: number;
  readonly cellH: number;
  /** Texture px per CSS px of card width at bake time (the sprite scales by css / this). */
  readonly pxPerCss: number;
}

/*
 * Everything below is 21 Wild's card look, ported verbatim from
 * wild21-pixi/src/pixi/cardTexture.ts and cardFace.ts (owner's decision
 * 2026-09-22: "use the EXACT deck 21 wild is using"). Only the back's centre
 * mark is the Solitaire Plus logo instead of "21". The palette values are 21 Wild's tokens.
 */
const TOKENS = {
  void: 0x0d0a18,
  felt: 0x1b1030,
  feltDeep: 0x120a20,
  plum: 0x2a1a4a,
  gold: 0xffc53d,
  violet: 0xb401e0,
  violetLight: 0xd873ff,
  white: 0xffffff,
  ink: 0x0a0710,
} as const;
const DISPLAY_FACE = "'Bebas Neue', 'Oswald', sans-serif";

const FONT_SOURCES = [
  { family: 'Bebas Neue', file: 'BebasNeue-Regular.ttf', weight: '400' },
  { family: 'Saira', file: 'Saira-Medium.ttf', weight: '500' },
  { family: 'Saira', file: 'Saira-Bold.ttf', weight: '700' },
] as const;

let fontsPromise: Promise<void> | null = null;
function ensureFonts(): Promise<void> {
  if (fontsPromise) return fontsPromise;
  fontsPromise = (async () => {
    const set = typeof document === 'undefined' ? undefined : document.fonts;
    if (!set || typeof FontFace === 'undefined') return;
    await Promise.all(
      FONT_SOURCES.map(async (source) => {
        try {
          const face = new FontFace(
            source.family,
            `url(${import.meta.env.BASE_URL}fonts/${source.file})`,
            { weight: source.weight, style: 'normal', display: 'block' },
          );
          await face.load();
          set.add(face);
        } catch {
          // A missing font must not take the whole bake down.
        }
      }),
    );
    await set.load(`400 64px ${DISPLAY_FACE}`).catch(() => undefined);
  })();
  return fontsPromise;
}

function channels(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function mixHex(a: number, b: number, t: number): number {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

function css(hex: number, alpha = 1): string {
  const [r, g, b] = channels(hex);
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const PAPER_HIGH = mixHex(TOKENS.white, TOKENS.gold, 0.03);
const PAPER_BASE = mixHex(TOKENS.white, TOKENS.gold, 0.1);
const PAPER_LOW = mixHex(mixHex(TOKENS.white, TOKENS.gold, 0.14), TOKENS.plum, 0.09);

function fileOf(c: Card): string {
  const r = rankOf(c);
  const rank = r === 1 ? 'a' : r === 11 ? 'j' : r === 12 ? 'q' : r === 13 ? 'k' : String(r);
  return `${rank}${'cdhs'[suitOf(c)]}`;
}

const BODY_RULE = /fill\s*:\s*#(?:ffffff|fff)\s*;\s*stroke-width\s*:\s*0?\.5\s*;?/gi;
const PLAQUE_RULE = /fill\s*:\s*#fffeff\s*;/gi;
const TEXT_RULE = /<text\b[\s\S]*?<\/text>/gi;

function prepareSvg(source: string, width: number, height: number): string {
  let svg = source.replace(BODY_RULE, 'fill:none;stroke:none;');
  svg = svg.replace(PLAQUE_RULE, 'fill:none;');
  svg = svg.replace(TEXT_RULE, '');
  return svg.replace(/<svg\b[^>]*>/i, (tag) =>
    tag
      .replace(/\swidth\s*=\s*"[^"]*"/gi, '')
      .replace(/\sheight\s*=\s*"[^"]*"/gi, '')
      .replace(/\spreserveAspectRatio\s*=\s*"[^"]*"/gi, '')
      .replace(
        /^<svg/i,
        `<svg width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"`,
      ),
  );
}

async function decodeSvg(c: Card, w: number, h: number): Promise<HTMLImageElement> {
  const res = await fetch(`${import.meta.env.BASE_URL}cards/${fileOf(c)}.svg`);
  if (!res.ok) throw new Error(`card ${fileOf(c)}.svg: ${res.status}`);
  const url = URL.createObjectURL(
    new Blob([prepareSvg(await res.text(), w, h)], { type: 'image/svg+xml' }),
  );
  try {
    const img = new Image();
    img.decoding = 'async';
    img.width = w;
    img.height = h;
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function trackedWidth(ctx: CanvasRenderingContext2D, text: string, tracking: number): number {
  let total = 0;
  for (const ch of text) total += ctx.measureText(ch).width + tracking;
  return Math.max(0, total - tracking);
}

function drawTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  tracking: number,
): void {
  const total = trackedWidth(ctx, text, tracking);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let x = cx - total * 0.5;
  for (const ch of text) {
    ctx.fillText(ch, x, cy);
    x += ctx.measureText(ch).width + tracking;
  }
}

function hash2(x: number, y: number, seed: number): number {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 362437);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smooth(x - xi);
  const fy = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

let grainPattern: CanvasPattern | null = null;
function getGrainPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (grainPattern) return grainPattern;
  const size = 128;
  const tile = document.createElement('canvas');
  tile.width = tile.height = size;
  const tileCtx = tile.getContext('2d')!;
  const image = tileCtx.createImageData(size, size);
  const data = image.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = valueNoise(x * 0.9, y * 0.9, 17) * 0.6 + valueNoise(x * 0.28, y * 0.28, 91) * 0.4;
      const weave = (Math.sin(x * 1.05) + Math.sin(y * 1.05)) * 0.06;
      const v = Math.max(0, Math.min(1, n + weave));
      const level = Math.round(120 + v * 135);
      const i = (y * size + x) * 4;
      data[i] = level;
      data[i + 1] = level;
      data[i + 2] = level;
      data[i + 3] = 255;
    }
  }
  tileCtx.putImageData(image, 0, 0);
  grainPattern = ctx.createPattern(tile, 'repeat');
  return grainPattern;
}

/** Warm paper field, linen tooth and a soft inward vignette. Assumes a clip. */
function paintPaper(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const field = ctx.createLinearGradient(0, 0, w * 0.35, h);
  field.addColorStop(0, css(PAPER_HIGH));
  field.addColorStop(0.55, css(PAPER_BASE));
  field.addColorStop(1, css(PAPER_LOW));
  ctx.fillStyle = field;
  ctx.fillRect(0, 0, w, h);
  const grain = getGrainPattern(ctx);
  if (grain) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = grain;
    const scale = w / 320;
    ctx.scale(scale, scale);
    ctx.fillRect(0, 0, w / scale, h / scale);
    ctx.restore();
  }
  const band = Math.max(6, w * 0.16);
  const edge = css(TOKENS.plum, 0.16);
  const clear = css(TOKENS.plum, 0);
  const sides: [number, number, number, number, number, number, number, number][] = [
    [0, 0, 0, band, 0, 0, w, band],
    [0, h, 0, h - band, 0, h - band, w, band],
    [0, 0, band, 0, 0, 0, band, h],
    [w, 0, w - band, 0, w - band, 0, band, h],
  ];
  for (const [gx0, gy0, gx1, gy1, rx, ry, rw, rh] of sides) {
    const gradient = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    gradient.addColorStop(0, edge);
    gradient.addColorStop(1, clear);
    ctx.fillStyle = gradient;
    ctx.fillRect(rx, ry, rw, rh);
  }
}

/** The thin printed rule just inside the card edge, plus a faint burnish on the cut. */
function paintCardRules(ctx: CanvasRenderingContext2D, w: number, h: number, radius: number): void {
  const inset = w * 0.032;
  ctx.lineWidth = Math.max(1, w * 0.0045);
  ctx.strokeStyle = css(TOKENS.ink, 0.1);
  roundRectPath(ctx, inset, inset, w - inset * 2, h - inset * 2, radius * 0.72);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, w * 0.006);
  ctx.strokeStyle = css(TOKENS.white, 0.14);
  roundRectPath(ctx, 0.5, 0.5, w - 1, h - 1, radius);
  ctx.stroke();
}

/** Card ink (21 Wild cardFace.ts), matched to the deck's own artwork. */
const INK = { red: '#d40000', black: '#000000' } as const;

function drawIndexOne(ctx: CanvasRenderingContext2D, w: number, h: number, label: string): void {
  const size = h * INDEX.size;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${size}px ${DISPLAY_FACE}`;
  ctx.save();
  ctx.translate(w * INDEX.x, h * INDEX.y);
  if (label.length > 1) ctx.scale(0.74, 1);
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

/** Both corner indices; the second is the first turned 180° about the centre. */
function drawCardIndices(ctx: CanvasRenderingContext2D, w: number, h: number, c: Card): void {
  const label = RANK_LABELS[rankOf(c) - 1] ?? '?';
  ctx.save();
  ctx.fillStyle = isRed(c) ? INK.red : INK.black;
  drawIndexOne(ctx, w, h, label);
  ctx.translate(w, h);
  ctx.rotate(Math.PI);
  drawIndexOne(ctx, w, h, label);
  ctx.restore();
}

function paintFace(
  ctx: CanvasRenderingContext2D,
  c: Card,
  art: HTMLImageElement | null,
  w: number,
  h: number,
): void {
  const radius = CARD_RADIUS * w;
  ctx.save();
  roundRectPath(ctx, 0, 0, w, h, radius);
  ctx.clip();
  paintPaper(ctx, w, h);
  if (art) ctx.drawImage(art, 0, 0, w, h);
  drawCardIndices(ctx, w, h, c);
  paintCardRules(ctx, w, h, radius);
  ctx.restore();
}

/**
 * The back's colourway: the field's radial ramp (hi at the centre, lo at the
 * edge), the lattice / rosette line colour and the edge shade. The gold rules
 * and rosettes are shared by every theme (the logo is gold).
 */
export interface BackTheme {
  readonly hi: number;
  readonly mid: number;
  readonly lo: number;
  readonly line: number;
  readonly shade: number;
}

export const BACK_THEMES = {
  /** 21 Wild's own plum. */
  plum: { hi: 0x3d1c6a, mid: 0x1b1030, lo: 0x120a20, line: 0xd873ff, shade: 0x0d0a18 },
  /** Casino crimson: the logo's ribbon red; the strongest contrast on green felt. */
  crimson: { hi: 0xc4172f, mid: 0x7d0c1c, lo: 0x46050f, line: 0xff8a8a, shade: 0x1a0206 },
  /** Midnight navy: cool and quiet; the gold carries it. */
  navy: { hi: 0x1f3f86, mid: 0x0f2150, lo: 0x07122e, line: 0x7fa8ff, shade: 0x020612 },
  /** Royal emerald: the logo's green; tonal on the felt. */
  emerald: { hi: 0x1d7a55, mid: 0x0b4531, lo: 0x05261b, line: 0x7dffc4, shade: 0x010c08 },
} as const satisfies Record<string, BackTheme>;

export type BackThemeId = keyof typeof BACK_THEMES;
/** The theme the game bakes: royal navy (owner's pick, 09-23). */
export const BACK_THEME: BackThemeId = 'navy';

/** The back's logo: its width as a fraction of the card's. */
const LOGO_W = 0.62;

interface LogoArt {
  readonly image: HTMLImageElement;
  /** The opaque bounds inside the file (its margins are transparent). */
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
}

/** Load public/brand/logo.png and find its opaque bounds; null if it will not load. */
async function loadLogo(): Promise<LogoArt | null> {
  try {
    const image = new Image();
    image.src = `${import.meta.env.BASE_URL}brand/logo.png`;
    await image.decode();
    const c = document.createElement('canvas');
    c.width = image.naturalWidth;
    c.height = image.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(image, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if ((data[(y * width + x) * 4 + 3] ?? 0) > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    if (x1 < 0) return null;
    return { image, sx: x0, sy: y0, sw: x1 - x0 + 1, sh: y1 - y0 + 1 };
  } catch {
    return null;
  }
}

/** Hypotrochoid, the curve behind every banknote guilloche. */
function guilloche(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  teeth: number,
  depth: number,
  steps: number,
): void {
  const r = radius / teeth;
  const a = radius - r;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const k = (a / r) * t;
    const x = cx + a * Math.cos(t) + depth * r * Math.cos(k);
    const y = cy + a * Math.sin(t) - depth * r * Math.sin(k);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
}

function paintBack(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  logo: LogoArt | null,
  B: BackTheme = BACK_THEMES[BACK_THEME],
): void {
  const radius = CARD_RADIUS * w;
  ctx.save();
  roundRectPath(ctx, 0, 0, w, h, radius);
  ctx.clip();
  const cx = w * 0.5;
  const cy = h * 0.5;
  const field = ctx.createRadialGradient(cx, cy * 0.86, w * 0.05, cx, cy, h * 0.72);
  field.addColorStop(0, css(B.hi));
  field.addColorStop(0.55, css(B.mid));
  field.addColorStop(1, css(B.lo));
  ctx.fillStyle = field;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.lineWidth = Math.max(1, w * 0.0028);
  ctx.strokeStyle = css(B.line, 0.09);
  const step = w / 15;
  ctx.beginPath();
  for (let x = -h; x < w + h; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x + h, h);
    ctx.moveTo(x, 0);
    ctx.lineTo(x - h, h);
  }
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.lineWidth = Math.max(1, w * 0.0032);
  ctx.strokeStyle = css(TOKENS.gold, 0.2);
  guilloche(ctx, cx, cy, w * 0.42, 7, 0.85, 1400);
  ctx.strokeStyle = css(B.line, 0.24);
  guilloche(ctx, cx, cy, w * 0.34, 11, 0.7, 1600);
  ctx.strokeStyle = css(TOKENS.gold, 0.14);
  guilloche(ctx, cx, cy, w * 0.24, 5, 0.95, 1000);
  ctx.restore();

  const inset = w * 0.055;
  ctx.lineWidth = Math.max(1, w * 0.007);
  ctx.strokeStyle = css(TOKENS.gold, 0.55);
  roundRectPath(ctx, inset, inset, w - inset * 2, h - inset * 2, radius * 0.6);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, w * 0.003);
  ctx.strokeStyle = css(TOKENS.gold, 0.2);
  const inner = inset * 1.75;
  roundRectPath(ctx, inner, inner, w - inner * 2, h - inner * 2, radius * 0.46);
  ctx.stroke();

  if (!logo) {
    const markR = w * 0.145;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI * 0.25);
    const plate = ctx.createLinearGradient(-markR, -markR, markR, markR);
    plate.addColorStop(0, css(B.hi));
    plate.addColorStop(1, css(B.lo));
    ctx.fillStyle = plate;
    ctx.fillRect(-markR, -markR, markR * 2, markR * 2);
    ctx.lineWidth = Math.max(1, w * 0.008);
    ctx.strokeStyle = css(TOKENS.gold, 0.8);
    ctx.strokeRect(-markR, -markR, markR * 2, markR * 2);
    ctx.lineWidth = Math.max(1, w * 0.003);
    ctx.strokeStyle = css(TOKENS.gold, 0.32);
    ctx.strokeRect(-markR * 0.78, -markR * 0.78, markR * 1.56, markR * 1.56);
    ctx.restore();

    const size = Math.round(w * 0.15);
    ctx.font = `400 ${size}px ${DISPLAY_FACE}`;
    ctx.fillStyle = css(TOKENS.gold, 0.92);
    drawTracked(ctx, 'S+', cx, cy + size * 0.02, size * 0.06);
  }

  const band = Math.max(6, w * 0.2);
  const shade = css(B.shade, 0.55);
  const clear = css(B.shade, 0);
  const sides: [number, number, number, number, number, number, number, number][] = [
    [0, 0, 0, band, 0, 0, w, band],
    [0, h, 0, h - band, 0, h - band, w, band],
    [0, 0, band, 0, 0, 0, band, h],
    [w, 0, w - band, 0, w - band, 0, band, h],
  ];
  for (const [gx0, gy0, gx1, gy1, rx, ry, rw, rh] of sides) {
    const gradient = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    gradient.addColorStop(0, shade);
    gradient.addColorStop(1, clear);
    ctx.fillStyle = gradient;
    ctx.fillRect(rx, ry, rw, rh);
  }
  // The Solitaire Plus logo (the owner's art), over the vignette so it
  // reads at full strength, with a soft drop so it sits on the field.
  if (logo) {
    const lw = w * LOGO_W;
    const lh = (lw * logo.sh) / logo.sw;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = w * 0.04;
    ctx.shadowOffsetY = w * 0.012;
    ctx.drawImage(logo.image, logo.sx, logo.sy, logo.sw, logo.sh, cx - lw / 2, cy - lh / 2, lw, lh);
    ctx.restore();
  }
  ctx.restore();
}

/**
 * The card width, in texture px, the atlas bakes at: the largest card this
 * display will draw (the desktop cap, or the screen width over 7.4 on a
 * phone) times the device pixel ratio, capped so the atlas stays ≤ 4096².
 */
export function atlasCellWidth(screenW: number, screenH: number, dpr: number): number {
  const widest = Math.min(MAX_CARD_CSS, Math.max(screenW, screenH) / 7.4);
  const want = Math.ceil(widest * Math.max(1, Math.min(3, dpr)));
  const rows = Math.ceil(53 / COLS);
  const byW = Math.floor(MAX_ATLAS / COLS) - GUTTER * 2;
  const byH = Math.floor((MAX_ATLAS / rows - GUTTER * 2) / CARD_ASPECT);
  return Math.max(24, Math.min(want, byW, byH));
}

/** Bake order: the back and the pips first (fast, ~0.3 s on a phone), the heavy courts last. */
function bakeOrder(): Card[] {
  const pips: Card[] = [];
  const courts: Card[] = [];
  for (let c = 0; c < 52; c++) (rankOf(c) > 10 ? courts : pips).push(c);
  return [...pips, ...courts];
}

export interface CardSheet {
  readonly canvas: HTMLCanvasElement;
  readonly cellW: number;
  readonly cellH: number;
  /** Top-left of cell i (0..51 faces, 52 the back) in sheet px. */
  origin(i: number): { x: number; y: number };
}

/** Paint every face and the back into one canvas (the atlas's source; also the card preview). */
export async function bakeCardSheet(
  cellW: number,
  onProgress?: (done: number) => void,
): Promise<CardSheet> {
  const cellH = Math.round(cellW * CARD_ASPECT);
  const stepX = cellW + GUTTER * 2;
  const stepY = cellH + GUTTER * 2;
  const rows = Math.ceil(53 / COLS);
  const canvas = document.createElement('canvas');
  canvas.width = stepX * COLS;
  canvas.height = stepY * rows;
  const ctx = canvas.getContext('2d')!;
  await ensureFonts();
  const origin = (i: number) => ({
    x: (i % COLS) * stepX + GUTTER,
    y: Math.floor(i / COLS) * stepY + GUTTER,
  });
  const drawAt = (i: number, paint: (x: CanvasRenderingContext2D) => void) => {
    const o = origin(i);
    ctx.save();
    ctx.translate(o.x, o.y);
    paint(ctx);
    ctx.restore();
  };
  const logo = await loadLogo();
  drawAt(52, (x) => paintBack(x, cellW, cellH, logo));
  let done = 0;
  for (const c of bakeOrder()) {
    let art: HTMLImageElement | null = null;
    try {
      art = await decodeSvg(c, cellW, cellH);
    } catch (err) {
      console.warn(err);
    }
    drawAt(c, (x) => paintFace(x, c, art, cellW, cellH));
    onProgress?.(++done);
  }
  return { canvas, cellW, cellH, origin };
}

/**
 * Bake the atlas. `onProgress` gets each card as it lands; the caller paints
 * the table and yields a frame first.
 */
export async function bakeCardAtlas(
  cellW: number,
  cssCardW: number,
  onProgress?: (done: number) => void,
): Promise<CardAtlas> {
  const sheet = await bakeCardSheet(cellW, onProgress);
  const base = Texture.from({ resource: sheet.canvas, antialias: true });
  base.source.scaleMode = 'linear';
  base.source.autoGenerateMipmaps = true;
  base.source.updateMipmaps();
  const frame = (i: number) => {
    const o = sheet.origin(i);
    return new Texture({
      source: base.source,
      frame: new Rectangle(o.x, o.y, sheet.cellW, sheet.cellH),
    });
  };
  return {
    faces: Array.from({ length: 52 }, (_, i) => frame(i)),
    back: frame(52),
    cellW: sheet.cellW,
    cellH: sheet.cellH,
    pxPerCss: sheet.cellW / Math.max(1, cssCardW),
  };
}

/** Dev preview: one back in a given theme, as its own canvas. */
export async function bakeBackPreview(cellW: number, theme: BackThemeId): Promise<HTMLCanvasElement> {
  await ensureFonts();
  const cellH = Math.round(cellW * CARD_ASPECT);
  const c = document.createElement('canvas');
  c.width = cellW;
  c.height = cellH;
  paintBack(c.getContext('2d')!, cellW, cellH, await loadLogo(), BACK_THEMES[theme]);
  return c;
}
