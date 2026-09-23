/**
 * Art direction in numbers. See docs/art-direction.md for the reasoning.
 * Colours are 0xRRGGBB for Pixi.
 */
export const PALETTE = {
  /** Page and canvas ground. */
  bg: 0x0b0d1a,
  bgDeep: 0x05060d,
  /** Board plate (top of gradient → bottom), rim, sockets. */
  plateTop: 0x171b36,
  plateBottom: 0x0f1226,
  plateRim: 0x242a4a,
  socket: 0x14172c,
  /** Text and chrome. */
  text: 0xf2f4ff,
  textDim: 0x8b90b8,
  accent: 0x3de6c9,
  accentWarm: 0xffb84d,
  danger: 0xff5c8a,
  indigo: 0x7c6bff,
  /** Warm white: the high-key grade, light leaks, the results sting core. */
  warmWhite: 0xffe8c8,
  /** Spotlight pool under the board. */
  spotlight: 0x2b2f6e,
} as const;

/**
 * Piece colours, indexed by Piece.color (0..8). Nine hues ~40° apart in
 * OKLCH at L 0.78–0.85, ordered so consecutive indices are never hue
 * neighbours. Saturation is preserved by the tile bake (the top face is
 * lightened at most 14%).
 */
export const PIECE_COLORS: readonly number[] = [
  0x3de6c9, // 0 mint      160°
  0xff5c7a, // 1 rose        0°
  0xffd60a, // 2 gold       80°
  0x6a5cff, // 3 indigo    240°
  0xff8c3a, // 4 orange     40°
  0x4fb3ff, // 5 sky       200°
  0xe040fb, // 6 magenta   295°
  0xa3e635, // 7 lime      120°
  0xb06bff, // 8 violet    280°
];

/**
 * Rank colours by rank index (the account XP ladder), cool → hot → white-gold,
 * mirrored by `--rank-0 … --rank-8` in styles.css: the shell's badges and
 * the engine's rank-up rim pulse must agree.
 */
export const RANK_COLORS: readonly number[] = [
  0x9aa3c7, // 0 Pebble    stone
  0x7c6bff, // 1 Brick     indigo
  0x4fb3ff, // 2 Mason     sky
  0x3de6c9, // 3 Builder   mint
  0xa3e635, // 4 Architect lime
  0xffd60a, // 5 Keystone  gold
  0xff8c3a, // 6 Monolith  orange
  0xff5c8a, // 7 Titan     rose
  0xffeaa6, // 8 Legend    white-gold
];

export function rankColor(index: number): number {
  return RANK_COLORS[Math.max(0, Math.min(RANK_COLORS.length - 1, index))] ?? PALETTE.accent;
}

export function pieceColor(index: number): number {
  return PIECE_COLORS[index] ?? 0xffffff;
}

/** Pixi colour -> CSS hex string. */
export function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

// --- colour math for the tile bake -------------------------------------------

export function rgbOf(c: number): [number, number, number] {
  return [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
}

export function toHsl(c: number): [number, number, number] {
  const [r0, g0, b0] = rgbOf(c);
  const r = r0 / 255;
  const g = g0 / 255;
  const b = b0 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

export function fromHsl(h: number, s: number, l: number): number {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const r = Math.round(f(0) * 255);
  const g = Math.round(f(8) * 255);
  const b = Math.round(f(4) * 255);
  return (r << 16) | (g << 8) | b;
}

/** Lighten (+) or darken (−) by a fraction of the remaining range. */
export function shade(c: number, amount: number): number {
  const [h, s, l] = toHsl(c);
  const nl = amount >= 0 ? l + (1 - l) * amount : l * (1 + amount);
  return fromHsl(h, s, Math.max(0, Math.min(1, nl)));
}
