import type { Rank } from '@solitaire-plus/sim';
import { drawCoin } from '../shell/chain-mark.js';
import { CUBE, PIPS_FROM, PIP_MAX } from '../shell/ui.js';
import { tierLabel } from '../shell/xp-view.js';
import {
  PLATE,
  layoutCard,
  type BadgeOp,
  type CardInput,
  type CoinOp,
  type Face,
  type Measure,
  type PanelOp,
  type PlateOp,
  type QrOp,
  type SlabOp,
  type TextOp,
  type Tone,
} from './layout.js';

/**
 * Draws a share card (see `layout.ts` for the composition) on a plain Canvas
 * 2D context — the owner's painted scene full-bleed, the score plate over
 * it — and exports it as a JPEG. Colours and faces are the shell's own
 * tokens, read from the stylesheet at draw time, so the card and the UI can
 * never drift; the fallbacks below are the same values for a context with no
 * stylesheet.
 */

export type RenderShareCardOptions = CardInput;

/* --------------------------------------------------------------------------
   Tokens
   -------------------------------------------------------------------------- */

/** CSS custom property → fallback (styles.css `:root`). */
const TOKEN_FALLBACK = {
  '--c-bg': '#06110d',
  '--c-bg-deep': '#030907',
  '--c-rim': '#1f5a47',
  '--c-text': '#f5f1e6',
  '--c-text-dim': '#9fb5a8',
  '--c-mint': '#3de6c9',
  '--c-amber': '#ffc53d',
  '--c-rose': '#ff5c8a',
  '--c-indigo': '#6d8cff',
  '--font-display': "'Rajdhani', 'Space Grotesk', system-ui, sans-serif",
  '--font-body': "'Space Grotesk', system-ui, sans-serif",
  '--rank-0': '#c4cde6',
  '--rank-1': '#7c6bff',
  '--rank-2': '#4fb3ff',
  '--rank-3': '#3de6c9',
  '--rank-4': '#a3e635',
  '--rank-5': '#ffd60a',
  '--rank-6': '#ff8c3a',
  '--rank-7': '#ff5c8a',
  '--rank-8': '#ffeaa6',
} as const;
type Token = keyof typeof TOKEN_FALLBACK;

function token(name: Token): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || TOKEN_FALLBACK[name];
  } catch {
    return TOKEN_FALLBACK[name];
  }
}

/** The badge's three faces, mirrored from `.rank-badge` (styles.css). */
const FACE_MIX = { topWhite: 0.24, rightBlack: 0.4 } as const;
/** Ranks whose faces the stylesheet sets by hand: Pip's cold slate and Klondike's white-gold. */
const FACE_OVERRIDE: Record<number, { top: string; left: string; right: string; rim: string }> = {
  0: { top: '#e6ecff', left: '#c4cde6', right: '#7f8ab0', rim: 'rgba(255,255,255,0.6)' },
  8: { top: '#f4f1ff', left: '#ffe2a8', right: '#b89a00', rim: '#f5d90a' },
};
const RIM_DEFAULT = 'rgba(255,255,255,0.6)';
/** The outline mixes the right face 70% into the deep ground. */
const OUTLINE_MIX = 0.3;
/** A lit pip's stroke: the rank 60% toward white. */
const PIP_STROKE_MIX = 0.4;
/** The compact badge's view of the 64-unit cube (`RankBadge` under 56 px: `viewBox="10 2 44 48"`). */
const COMPACT_BOX = { x: 10, y: 2, w: 44, h: 48 } as const;
/** The lit badge's cast light (`.rank-badge.lit`): blur as a fraction of the size. */
const BADGE_LIGHT = { blur: 0.18, alpha: 0.45 } as const;

/**
 * The QR tile: a light plate (dark modules on light scan most reliably off a
 * screen) with ink modules, and a quiet zone of at least `quiet` modules on
 * every side (3: the 160 tile then fits 4 px cells, a 132 px symbol with a
 * 14 px margin; scanners want ≥ 2, the spec says 4, the light tile forgives).
 */
const QR = { tile: '#fbf6ea', module: '#06110d', level: 'M', quiet: 3 } as const;

/** Surfaces on the plate (the shell's `.code` slab and a tinted panel), as alphas over ink and the tone. */
const SURFACE = {
  slabFill: 'rgba(3,9,7,0.45)',
  slabEdgeAlpha: 0.45,
  slabEdgeW: 3,
  slabDash: [14, 10] as [number, number],
  slabGlow: 36,
  panelEdgeW: 2,
} as const;

/** JPEG quality for the export: the painted art needs a photo codec; 0.9 keeps the QR's 4 px modules crisp. */
const JPEG_QUALITY = 0.9;

/* --------------------------------------------------------------------------
   Colour math (sRGB ↔ OKLab, for the badge faces)
   -------------------------------------------------------------------------- */

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const toHex = (c: Rgb) =>
  `#${c
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const gam = (c: number) => {
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return s * 255;
};
function toOklab([r, g, b]: Rgb): [number, number, number] {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function fromOklab([L, a, b]: [number, number, number]): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
/** `color-mix(in oklab, a (1−t), b t)`. */
export function mixOklab(a: string, b: string, t: number): string {
  const A = toOklab(parseHex(a));
  const B = toOklab(parseHex(b));
  return toHex(
    fromOklab([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]),
  );
}

/* --------------------------------------------------------------------------
   Assets: fonts and the logo, loaded once
   -------------------------------------------------------------------------- */

/** How long to wait for the faces before drawing with whatever is available. */
const FONT_WAIT_MS = 1500;
/** Weights the card uses, so `document.fonts.load` resolves the right faces. */
const FONT_LOADS = [
  "700 100px 'Rajdhani'",
  "600 100px 'Rajdhani'",
  "500 100px 'Space Grotesk'",
  "400 100px 'Space Grotesk'",
];

const images = new Map<string, Promise<HTMLImageElement | null>>();
/** The art for a size, loaded once per session; null if it cannot load (the plate still carries the card). */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  let p = images.get(src);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
    images.set(src, p);
  }
  return p;
}

/** The QR module matrix for a text: `qrcode` is pulled in on the first share, not with the game. */
type QrMatrix = { size: number; get(row: number, col: number): number };
async function qrMatrix(text: string): Promise<QrMatrix> {
  const { create } = await import('qrcode');
  return create(text, { errorCorrectionLevel: QR.level }).modules;
}

let fontsPromise: Promise<void> | null = null;
function loadFonts(): Promise<void> {
  if (!fontsPromise)
    fontsPromise = (async () => {
      if (typeof document === 'undefined' || !('fonts' in document)) return;
      const timeout = new Promise<void>((r) => setTimeout(r, FONT_WAIT_MS));
      await Promise.race([
        Promise.all(FONT_LOADS.map((f) => document.fonts.load(f).catch(() => []))).then(() => {}),
        timeout,
      ]);
    })();
  return fontsPromise;
}

/* --------------------------------------------------------------------------
   Drawing
   -------------------------------------------------------------------------- */

interface Palette {
  bg: string;
  bgDeep: string;
  rim: string;
  text: string;
  dim: string;
  mint: string;
  amber: string;
  rose: string;
  indigo: string;
  fontDisplay: string;
  fontBody: string;
  rank: (i: number) => string;
}

function palette(): Palette {
  const ranks = Array.from({ length: 9 }, (_, i) => token(`--rank-${i}` as Token));
  return {
    bg: token('--c-bg'),
    bgDeep: token('--c-bg-deep'),
    rim: token('--c-rim'),
    text: token('--c-text'),
    dim: token('--c-text-dim'),
    mint: token('--c-mint'),
    amber: token('--c-amber'),
    rose: token('--c-rose'),
    indigo: token('--c-indigo'),
    fontDisplay: token('--font-display'),
    fontBody: token('--font-body'),
    rank: (i) => ranks[Math.max(0, Math.min(ranks.length - 1, i))] ?? TOKEN_FALLBACK['--rank-0'],
  };
}

/** `color` at alpha `a`: a hex token, or an `rgba()` whose alpha is replaced. */
function withAlpha(color: string, a: number): string {
  const m = /^rgba?\(([^)]+)\)$/.exec(color);
  if (m) {
    const [r, g, b] = (m[1] ?? '').split(',').map((v) => v.trim());
    return `rgba(${r},${g},${b},${a})`;
  }
  const [r, g, b] = parseHex(color);
  return `rgba(${r},${g},${b},${a})`;
}

class Painter {
  private rankColor: string;
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    readonly p: Palette,
    rank: Rank | null,
  ) {
    this.rankColor = rank ? p.rank(rank.index) : p.dim;
  }

  tone(t: Tone): string {
    switch (t) {
      case 'text':
        return this.p.text;
      case 'dim':
        return this.p.dim;
      case 'mint':
        return this.p.mint;
      case 'amber':
        return this.p.amber;
      case 'rose':
        return this.p.rose;
      case 'indigo':
        return this.p.indigo;
      case 'rank':
        return this.rankColor;
    }
  }

  font(face: Face, size: number, weight: number): string {
    return `${weight} ${size}px ${face === 'display' ? this.p.fontDisplay : this.p.fontBody}`;
  }

  /** Letter-spacing on the context where the browser has it; the layout's estimate elsewhere. */
  private setTracking(px: number): boolean {
    const c = this.ctx as CanvasRenderingContext2D & { letterSpacing?: string };
    if (typeof c.letterSpacing === 'string') {
      c.letterSpacing = `${px}px`;
      return true;
    }
    return false;
  }

  measure: Measure = (text, face, size, weight, track) => {
    this.ctx.font = this.font(face, size, weight);
    const native = this.setTracking(track * size);
    const w = this.ctx.measureText(text).width;
    // Native tracking adds a trailing space after the last glyph; ours would not.
    const out = native ? w - track * size : w + track * size * (text.length - 1);
    this.setTracking(0);
    return out;
  };

  text(o: TextOp): void {
    const { ctx } = this;
    const color = this.tone(o.tone);
    ctx.save();
    ctx.globalAlpha = o.alpha;
    ctx.font = this.font(o.face, o.size, o.weight);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    const trackPx = o.track * o.size;
    const native = this.setTracking(trackPx);
    // With native tracking the run carries a trailing gap: centre and right
    // alignment shift by it (the `.code` style pads for the same reason).
    const shift = native
      ? o.align === 'center'
        ? trackPx / 2
        : o.align === 'right'
          ? trackPx
          : 0
      : 0;
    const draw = () => {
      if (native || trackPx === 0) {
        ctx.textAlign = o.align;
        ctx.fillText(o.text, o.x + shift, o.y);
        return;
      }
      // Manual tracking: glyph by glyph from the run's left edge.
      const w = this.measure(o.text, o.face, o.size, o.weight, o.track);
      ctx.font = this.font(o.face, o.size, o.weight);
      ctx.textAlign = 'left';
      let x = o.align === 'center' ? o.x - w / 2 : o.align === 'right' ? o.x - w : o.x;
      for (const ch of o.text) {
        ctx.fillText(ch, x, o.y);
        x += ctx.measureText(ch).width + trackPx;
      }
    };
    if (o.glow > 0) {
      ctx.shadowColor = color;
      ctx.shadowBlur = o.glow;
      draw();
      ctx.shadowBlur = 0;
    }
    draw();
    this.setTracking(0);
    ctx.restore();
  }

  roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** A glass panel in its tone: the stat tiles and the pill in white, the pot block in amber, the outcome in mint or rose. */
  panel(o: PanelOp): void {
    const { ctx } = this;
    const c = this.tone(o.tone);
    ctx.save();
    this.roundRect(o.x, o.y, o.w, o.h, o.r);
    ctx.fillStyle = withAlpha(c, o.fill);
    ctx.fill();
    ctx.strokeStyle = withAlpha(c, o.edge);
    ctx.lineWidth = SURFACE.panelEdgeW;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The score plate: a fade above its top edge melts the art into it, then
   * the slab itself with a soft outer shadow and a 1-unit rim.
   */
  plate(o: PlateOp, canvasW: number): void {
    const { ctx } = this;
    ctx.save();
    const fade = ctx.createLinearGradient(0, o.y - o.fade, 0, o.y);
    fade.addColorStop(0, withAlpha(PLATE.fill, 0));
    fade.addColorStop(1, withAlpha(PLATE.fill, PLATE.fadeAlpha));
    ctx.fillStyle = fade;
    ctx.fillRect(0, o.y - o.fade, canvasW, o.fade);
    ctx.shadowColor = PLATE.shadow;
    ctx.shadowBlur = PLATE.shadowBlur;
    this.roundRect(o.x, o.y, o.w, o.h, o.r);
    ctx.fillStyle = PLATE.fill;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = PLATE.rim;
    ctx.lineWidth = PLATE.rimW;
    ctx.stroke();
    ctx.restore();
  }

  slab(o: SlabOp): void {
    const { ctx } = this;
    ctx.save();
    this.roundRect(o.x, o.y, o.w, o.h, o.r);
    ctx.fillStyle = SURFACE.slabFill;
    ctx.fill();
    ctx.setLineDash(SURFACE.slabDash);
    ctx.strokeStyle = withAlpha(this.p.mint, SURFACE.slabEdgeAlpha);
    ctx.lineWidth = SURFACE.slabEdgeW;
    ctx.stroke();
    ctx.restore();
    this.text({
      kind: 'text',
      id: o.id,
      text: o.text,
      x: o.x + o.w / 2,
      y: o.y + o.h / 2,
      size: o.size,
      face: 'display',
      weight: 700,
      tone: 'mint',
      align: 'center',
      track: o.track,
      glow: SURFACE.slabGlow,
      alpha: 1,
    });
  }

  /** The rank badge: the shell's cube (`RankBadge`), drawn from the same 64-unit geometry. */
  badge(o: BadgeOp): void {
    const { ctx, p } = this;
    const rank = p.rank(o.rank.index);
    const faces = FACE_OVERRIDE[o.rank.index] ?? {
      top: mixOklab(rank, '#ffffff', FACE_MIX.topWhite),
      left: rank,
      right: mixOklab(rank, '#000000', FACE_MIX.rightBlack),
      rim: RIM_DEFAULT,
    };
    // Compact (< 56 px): the cube alone fills the box, the shell's `viewBox="10 2 44 48"`.
    const compact = o.size < PIPS_FROM;
    const k = compact ? o.size / COMPACT_BOX.h : o.size / 64;
    const poly = (pts: string) => {
      ctx.beginPath();
      pts.split(' ').forEach((pt, i) => {
        const [x, y] = pt.split(',').map(Number) as [number, number];
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    };
    ctx.save();
    if (compact)
      ctx.translate(
        o.x + (o.size - COMPACT_BOX.w * k) / 2 - COMPACT_BOX.x * k,
        o.y - COMPACT_BOX.y * k,
      );
    else ctx.translate(o.x, o.y);
    ctx.scale(k, k);
    // The lit badge casts its light (the `.lit` drop-shadow): drawn under the hull once; a compact one is a plain cube.
    if (!compact) {
      ctx.save();
      // Shadow blur is in device px, untouched by the transform.
      ctx.shadowColor = withAlpha(rank, BADGE_LIGHT.alpha);
      ctx.shadowBlur = o.size * BADGE_LIGHT.blur;
      ctx.fillStyle = faces.left;
      poly(CUBE.hull);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = faces.left;
    poly(CUBE.left);
    ctx.fill();
    ctx.fillStyle = faces.right;
    poly(CUBE.right);
    ctx.fill();
    ctx.fillStyle = faces.top;
    poly(CUBE.top);
    ctx.fill();
    // Specular.
    ctx.save();
    ctx.translate(CUBE.spec.cx, CUBE.spec.cy);
    ctx.rotate((CUBE.spec.rot * Math.PI) / 180);
    ctx.beginPath();
    ctx.ellipse(0, 0, CUBE.spec.rx, CUBE.spec.ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fill();
    ctx.restore();
    // Rim light on the two lit edges, then the outline.
    ctx.lineJoin = 'round';
    ctx.strokeStyle = faces.rim;
    ctx.lineWidth = 1.6;
    ctx.stroke(new Path2D(CUBE.rim));
    ctx.strokeStyle = mixOklab(faces.right, p.bgDeep, OUTLINE_MIX);
    ctx.lineWidth = 1.5;
    poly(CUBE.hull);
    ctx.stroke();
    // Pips (or the numeral past the ladder) only from 56 px; a small badge is the cube alone.
    if (compact) {
      ctx.restore();
      return;
    }
    if (o.rank.tier > PIP_MAX) {
      ctx.font = `700 15px ${p.fontDisplay}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = rank;
      ctx.fillText(tierLabel(o.rank.tier), 32, CUBE.pipsY);
    } else {
      for (let i = 0; i < CUBE.pipsX.length; i++) {
        const x = CUBE.pipsX[i] ?? 32;
        const lit = i < o.rank.tier;
        ctx.beginPath();
        ctx.moveTo(x, CUBE.pipsY - CUBE.pipHalf);
        ctx.lineTo(x + CUBE.pipHalf, CUBE.pipsY);
        ctx.lineTo(x, CUBE.pipsY + CUBE.pipHalf);
        ctx.lineTo(x - CUBE.pipHalf, CUBE.pipsY);
        ctx.closePath();
        ctx.fillStyle = lit ? rank : p.rim;
        ctx.fill();
        ctx.strokeStyle = lit ? mixOklab(rank, '#ffffff', PIP_STROKE_MIX) : 'rgba(2,7,5,0.6)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** The $CHAIN coin (`Coin` in ui.tsx): rim, dark disc, the mark on the amber face. */
  coin(o: CoinOp): void {
    drawCoin(this.ctx, o.x, o.y, o.size);
  }

  /** The QR tile: modules snapped to whole pixels and centred, so every edge is crisp for a scanner. */
  qr(o: QrOp, m: QrMatrix): void {
    const { ctx } = this;
    ctx.save();
    this.roundRect(o.x, o.y, o.size, o.size, o.r);
    ctx.fillStyle = QR.tile;
    ctx.fill();
    const inner = o.size - 2 * o.pad;
    const cell = Math.floor(Math.min(inner / m.size, o.size / (m.size + 2 * QR.quiet)));
    const x0 = o.x + Math.round((o.size - cell * m.size) / 2);
    const y0 = o.y + Math.round((o.size - cell * m.size) / 2);
    ctx.fillStyle = QR.module;
    for (let r = 0; r < m.size; r++)
      for (let c = 0; c < m.size; c++)
        if (m.get(r, c)) ctx.fillRect(x0 + c * cell, y0 + r * cell, cell, cell);
    ctx.restore();
  }
}

/**
 * Renders one card size to a PNG blob. Waits (briefly) for the game's faces
 * and the logo; draws with whatever is there after that, so a share never
 * hangs on a font.
 */
export async function renderShareCard(opts: RenderShareCardOptions): Promise<Blob> {
  await loadFonts();
  const p = palette();
  const canvas = document.createElement('canvas');
  const probe = canvas.getContext('2d');
  if (!probe) throw new Error('canvas 2d unavailable');
  // Measure with the real faces, then lay out, then draw.
  const painter0 = new Painter(probe, p, opts.user?.rank ?? null);
  const L = layoutCard(opts, painter0.measure);
  canvas.width = L.w;
  canvas.height = L.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  const painter = new Painter(ctx, p, opts.user?.rank ?? null);
  // Everything async (the art, the QR matrices) is resolved before the first stroke.
  const arts = new Map<string, HTMLImageElement | null>();
  const qrs = new Map<string, QrMatrix>();
  for (const op of L.ops) {
    if (op.kind === 'art') arts.set(op.src, await loadImage(op.src));
    if (op.kind === 'qr') qrs.set(op.text, await qrMatrix(op.text));
  }
  // Under the art, in case it never loads: the ground colour.
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, L.w, L.h);
  for (const op of L.ops) {
    switch (op.kind) {
      case 'art': {
        const img = arts.get(op.src);
        if (img) ctx.drawImage(img, op.x, op.y, op.w, op.h);
        break;
      }
      case 'plate':
        painter.plate(op, L.w);
        break;
      case 'panel':
        painter.panel(op);
        break;
      case 'text':
        painter.text(op);
        break;
      case 'badge':
        painter.badge(op);
        break;
      case 'slab':
        painter.slab(op);
        break;
      case 'coin':
        painter.coin(op);
        break;
      case 'qr': {
        const m = qrs.get(op.text);
        if (m) painter.qr(op, m);
        break;
      }
    }
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}
