import { RULES, type Rank, type ScoreBreakdown } from '@solitaire-plus/sim';
import { rankLabel } from '../shell/xp-view.js';

/**
 * The share card's composition, as pure data: a list of draw ops the canvas
 * renderer (`card.ts`) executes. No DOM, no canvas — the layout is testable
 * in Node and every number in it is a named constant below. Two sizes come
 * from one function: the STORY (1080×1920, the share sheet) and the LINK
 * (1200×630, what a pasted link unfurls into), the same content re-flowed.
 *
 * The painted scene IS the card: the owner's art (blossoms, the pagoda,
 * Fuji, the logo) runs full-bleed and a dark plate sits over its painted
 * board carrying every word — text never lands on raw art.
 *
 * The card is an image with its own type scale; the shell's "nothing under
 * 12 px" rule is about the UI, not about this.
 */

export type CardSize = 'story' | 'link';

/** Export pixel sizes. The link size is what scrapers expect (`og:image`). */
export const CARD_PX: Record<CardSize, { w: number; h: number }> = {
  story: { w: 1080, h: 1920 },
  link: { w: 1200, h: 630 },
};

export interface CardUser {
  username: string;
  xpLevel: number;
  rank: Rank;
}

/** A settled challenge as the card tells it: the stake won (the payout) or lost, and who it was against. */
export interface CardResult {
  won: boolean;
  /** $CHAIN paid out on a win (the pot); the loss is the entry fee. */
  payout: number;
  opponent?: { username: string; score: number } | undefined;
}

/**
 * The challenge behind a card, by state. OPEN (the creator finished, nobody
 * has taken it): the dare — the pot, the code, a QR of the take link.
 * COMPLETE (matched and settled): the result — no code, no "beat me", the
 * front door instead, like a solo card.
 */
export type CardChallenge =
  | { status: 'open'; code: string; entryFee?: number | undefined }
  | { status: 'complete'; code: string; entryFee: number; result: CardResult };

export interface CardInput {
  size: CardSize;
  breakdown: ScoreBreakdown;
  /** The session user; null when nobody is signed in (a solo run) — the player line is left out. */
  user: CardUser | null;
  /** A challenge game, by state; undefined for a solo run. */
  challenge?: CardChallenge | undefined;
  newBest: boolean;
  /** `location.host` — no scheme, so the link reads as a handle: `blockari.example.com/take?code=…`. */
  host: string;
  /** `location.origin` — with the scheme, for the QR code (a scanner needs a full URL). */
  origin: string;
}

export type Face = 'display' | 'body';
/** Colour roles; the renderer resolves them to the design tokens. */
export type Tone = 'text' | 'dim' | 'mint' | 'amber' | 'rose' | 'indigo' | 'rank';

export interface TextOp {
  kind: 'text';
  id: string;
  text: string;
  x: number;
  /** Vertical centre of the line (the renderer draws with a middle baseline). */
  y: number;
  size: number;
  face: Face;
  weight: 400 | 500 | 600 | 700;
  tone: Tone;
  align: 'left' | 'center' | 'right';
  /** Letter-spacing in em. */
  track: number;
  /** Soft glow radius in px, in the text's own tone; 0 = none. */
  glow: number;
  alpha: number;
}
/** The owner's painted scene, full-bleed. */
export interface ArtOp {
  kind: 'art';
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
/** The score plate: a dark rounded slab with a rim, an outer shadow and a fade melting the art into its top edge. */
export interface PlateOp {
  kind: 'plate';
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  /** Height of the transparent → plate fade above the top edge. */
  fade: number;
}
/** A tinted panel behind a block (the pot, the outcome): a rounded fill with a rim in its tone. */
export interface PanelOp {
  kind: 'panel';
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  tone: Tone;
  /** Fill and rim alphas over the tone. */
  fill: number;
  edge: number;
}

/** The glass surfaces on the plate: the tiles and the identity pill (white 0.05 / 0.08), the pot (amber) and the outcome (mint / rose) at the same weight. */
export const GLASS = { fill: 0.05, edge: 0.08 } as const;
export const POT_GLASS = { fill: 0.2, edge: 0.5 } as const;
export interface BadgeOp {
  kind: 'badge';
  x: number;
  y: number;
  size: number;
  rank: Rank;
}
/** The code slab: the challenge code in the `.code` style — tracked, mint, dashed rim on ink. */
export interface SlabOp {
  kind: 'slab';
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  text: string;
  size: number;
  track: number;
}
export interface CoinOp {
  kind: 'coin';
  x: number;
  y: number;
  size: number;
}
/** A QR code of `text`, dark modules on a light rounded tile so any scanner reads it off a screen. */
export interface QrOp {
  kind: 'qr';
  id: string;
  /** The tile's box; the modules sit inside `pad`. */
  x: number;
  y: number;
  size: number;
  pad: number;
  r: number;
  text: string;
}
export type CardOp = TextOp | ArtOp | PlateOp | PanelOp | BadgeOp | SlabOp | CoinOp | QrOp;

export interface CardLayout {
  size: CardSize;
  w: number;
  h: number;
  ops: CardOp[];
}

/** The art behind each size (public/brand). */
export const CARD_ART: Record<CardSize, string> = {
  story: '/brand/share-bg-1080x1920.jpg',
  link: '/brand/og-card.jpg',
};

/** Measures a text run in px; the renderer passes `measureText`, tests use the estimate. */
export type Measure = (
  text: string,
  face: Face,
  size: number,
  weight: number,
  track: number,
) => number;

/** Average advance per glyph in em for the estimate (the display face is condensed; the body is not). */
const GLYPH_EM: Record<Face, number> = { display: 0.5, body: 0.58 };

/** A width estimate for when nothing can measure (tests, a renderer without fonts). */
export const estimateWidth: Measure = (text, face, size, _weight, track) =>
  text.length * size * (GLYPH_EM[face] + track);

/* --------------------------------------------------------------------------
   Copy
   -------------------------------------------------------------------------- */

const MINUTES = RULES.durationMs / 60_000;

/** Numbers on the card and in the text read the same: "9,520". */
export function formatScore(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * The line that travels with the card (the share sheet's text, the modal's
 * copy box). An open challenge: "I scored 9,520 in Blockari. Same pieces,
 * 3 minutes — beat me: AGB2BS". Solo: the same without the dare. A settled
 * one tells the result — "I scored 9,520 on Blockari and won 200 $CHAIN —
 * play free: <host>"; a loss keeps to the score (the card says the rest).
 * Never the code once the challenge is matched: nobody can take it.
 */
export function shareText(
  total: number,
  challenge: CardChallenge | null | undefined,
  host: string,
): string {
  if (challenge?.status === 'complete') {
    const won = challenge.result.won
      ? ` and won ${formatScore(challenge.result.payout)} ${CHAIN_UNIT}`
      : '';
    return `I scored ${formatScore(total)} on Blockari${won} — play free: ${host}`;
  }
  const lead = `I scored ${formatScore(total)} in Blockari. Same pieces, ${MINUTES} minutes`;
  return challenge ? `${lead} — beat me: ${challenge.code}` : `${lead}.`;
}

/** The eyebrow over the score: how the run ended (a solo run the player ended is over, a challenge quit is a forfeit). */
export function endLabel(b: ScoreBreakdown, challenge: boolean): string {
  return b.endReason === 'stuck'
    ? 'OUT OF MOVES'
    : b.endReason === 'forfeit'
      ? challenge
        ? 'FORFEITED'
        : 'RUN OVER'
      : "TIME'S UP";
}

/** "MASON II · XP LV 12": the account line under the name. */
export function rankLine(user: CardUser): string {
  return `${rankLabel(user.rank).toUpperCase()} · XP LV ${user.xpLevel}`;
}

/** The three stat tiles: lines, best streak, level — the results panel's headline rows (the level in the level language's mint). */
export function statTiles(b: ScoreBreakdown): { label: string; value: string; tone: Tone }[] {
  return [
    { label: 'LINES', value: String(b.linesCleared), tone: 'text' },
    { label: 'BEST STREAK', value: `${Math.max(1, b.bestStreak)}X`, tone: 'text' },
    { label: 'LEVEL', value: `LV ${b.levelReached}`, tone: 'mint' },
  ];
}

export const SCORE_LABEL = 'SCORE';
export const CHAIN_UNIT = '$CHAIN';

/** The second hero's three lines and its tone: the pot (amber) or the outcome (mint won / rose lost). */
export interface HeroCopy {
  eyebrow: string;
  value: string;
  unit: string;
  /** The small line under the number; empty for none. */
  sub: string;
  tone: Tone;
  /** Whether the $CHAIN coin sits before the number (a pot, a win — never a loss). */
  coin: boolean;
}

/** The pot block's three lines: "BEAT 9,520 TO WIN" / "200" + "$CHAIN" / "Stake 100 to play". */
export function potCopy(entryFee: number, total: number): HeroCopy {
  return {
    eyebrow: `BEAT ${formatScore(total)} TO WIN`,
    value: formatScore(entryFee * 2),
    unit: CHAIN_UNIT,
    sub: `Stake ${formatScore(entryFee)} to play`,
    tone: 'amber',
    coin: true,
  };
}

/**
 * The outcome block's lines: "YOU WON" / "+200" + "$CHAIN" / "vs mason · 8,470"
 * in mint, or "YOU LOST" / "−100" (the stake, a real minus sign) in rose — the
 * results scene's own words.
 */
export function resultCopy(r: CardResult, entryFee: number): HeroCopy {
  const chain = r.won ? r.payout : entryFee;
  return {
    eyebrow: r.won ? 'YOU WON' : 'YOU LOST',
    value: `${r.won ? '+' : '−'}${formatScore(chain)}`,
    unit: CHAIN_UNIT,
    sub: r.opponent ? `vs ${r.opponent.username} · ${formatScore(r.opponent.score)}` : '',
    tone: r.won ? 'mint' : 'rose',
    coin: r.won,
  };
}

export const SCAN_LABEL = 'SCAN TO PLAY';
export const PLAY_FREE_LABEL = 'PLAY FREE AT';

/** The take link with its scheme — what the QR encodes; solo cards point at the front door. */
export function takeUrl(origin: string, code: string | null | undefined): string {
  return code ? `${origin}/take?code=${code}` : origin;
}

/* --------------------------------------------------------------------------
   Metrics (px at export size)
   -------------------------------------------------------------------------- */

/** The plate's look, shared by both sizes (the renderer paints these). */
export const PLATE = {
  fill: 'rgba(10,12,26,0.94)',
  rim: 'rgba(255,255,255,0.12)',
  rimW: 2,
  shadow: 'rgba(5,6,13,0.6)',
  shadowBlur: 48,
  /** The fade above the top edge ends at the plate colour at this alpha. */
  fadeAlpha: 0.5,
} as const;

const STORY = {
  // The plate over the painted board; the art above it (logo, Fuji, the pagoda) stays clear.
  plate: { x: 48, y: 1000, w: 984, h: 894, r: 40, fade: 160 },
  padX: 48,
  // Small text is budgeted for the phone: a story is viewed at ~390 css px (×0.36).
  eyebrowY: 1030,
  eyebrowSize: 32,
  scoreY: 1122,
  scoreSize: 180,
  scoreGlow: 48,
  // Score → 40 → tiles → 32 → pill → 40 → pot: one axis, everything centred.
  tilesY: 1221,
  tileH: 88,
  tileGap: 24,
  tileR: 24,
  tileLabelSize: 26,
  tileLabelDy: 25,
  tileValueSize: 56,
  tileValueDy: 59,
  pillY: 1341,
  pillH: 76,
  pillPadX: 32,
  badge: 52,
  badgeGap: 16,
  nameSize: 40,
  nameGap: 20,
  rankSize: 26,
  // The pot: the second hero, a full-width amber block.
  pot: { y: 1457, h: 196, r: 24 },
  potEyebrowY: 1489,
  potEyebrowSize: 38,
  potY: 1565,
  potSize: 120,
  potUnitSize: 48,
  potCoin: 72,
  potGap: 18,
  potStakeY: 1625,
  potStakeSize: 32,
  // Solo: the front door instead of the pot, 67 under the pill; the QR alone under it,
  // centred between the host and the plate's foot (72 / 72).
  ctaLabelY: 1500,
  ctaLabelSize: 32,
  hostY: 1566,
  hostSize: 48,
  soloRowY: 1662,
  // The dare row: the code slab and the QR tile as one band.
  rowY: 1673,
  rowGap: 24,
  qrTile: 160,
  qrPad: 14,
  qrR: 20,
  slabH: 160,
  slabR: 22,
  slabSize: 96,
  slabTrack: 0.32,
  // Settled: the row 40 under the outcome and 41 over the plate's foot (no link line
  // under it — the host is already in the row), "PLAY FREE AT" over the host in the
  // slab's place, centred on the QR's height.
  rowSettledY: 1693,
  rowLabelDy: 48,
  rowHostDy: 112,
  // The take link under the dare row (open cards only).
  linkY: 1860,
  linkSize: 30,
} as const;

const LINK = {
  // The plate along the bottom, over the painted board; logo and both landmarks stay clear.
  plate: { x: 32, y: 338, w: 1136, h: 260, r: 32, fade: 160 },
  padX: 28,
  // Left: the score block, the stat strip and the identity pill.
  leftX: 60,
  leftW: 380,
  eyebrowY: 358,
  eyebrowSize: 20,
  scoreY: 426,
  scoreSize: 130,
  scoreGlow: 32,
  stripY: 478,
  stripH: 40,
  stripR: 12,
  stripLabelSize: 12,
  stripValueSize: 20,
  stripGap: 6,
  pillY: 522,
  pillH: 40,
  pillPadX: 14,
  badge: 30,
  badgeGap: 8,
  nameSize: 20,
  nameGap: 10,
  rankSize: 13,
  // Centre: the pot over the code (80 px from each neighbour).
  midX: 520,
  midW: 360,
  pot: { y: 352, h: 130, r: 16 },
  potEyebrowY: 374,
  potEyebrowSize: 22,
  potY: 420,
  potSize: 68,
  potUnitSize: 30,
  potCoin: 46,
  potGap: 10,
  potStakeY: 464,
  potStakeSize: 15,
  // Solo: the front door alone in the column, centred on the plate's height (no link line).
  ctaLabelY: 442,
  ctaLabelSize: 16,
  hostY: 486,
  hostSize: 34,
  slabY: 494,
  slabH: 64,
  slabR: 14,
  slabSize: 42,
  slabTrack: 0.3,
  // Settled: "PLAY FREE AT" over the host under the outcome, centred between it and the plate's foot (28 / 25).
  rowLabelY: 518,
  rowHostY: 556,
  // Right: the QR, its top on the pot's line.
  qrY: 352,
  qrTile: 180,
  qrPad: 14,
  qrR: 20,
  scanGap: 16,
  scanSize: 13,
  // The take link along the plate's bottom edge (open cards only).
  linkY: 581,
  linkSize: 15,
} as const;

/* --------------------------------------------------------------------------
   Layout
   -------------------------------------------------------------------------- */

export function layoutCard(input: CardInput, measure: Measure = estimateWidth): CardLayout {
  return input.size === 'story' ? layoutStory(input, measure) : layoutLink(input, measure);
}

/** A run at its set size, shrunk only if it would spill past `maxW` (the score, the code, a long host). */
function fit(
  text: string,
  base: number,
  maxW: number,
  measure: Measure,
  face: Face = 'display',
  weight = 700,
  track = 0,
): number {
  const w = measure(text, face, base, weight, track);
  return w <= maxW ? base : Math.floor((base * maxW) / w);
}

/** Inner padding of the code slab: the code never touches its dashed rim. */
const SLAB_PAD_EM = 0.36;

function text(
  id: string,
  t: string,
  x: number,
  y: number,
  size: number,
  o: Partial<Omit<TextOp, 'kind' | 'id' | 'text' | 'x' | 'y' | 'size'>> = {},
): TextOp {
  return {
    kind: 'text',
    id,
    text: t,
    x,
    y,
    size,
    face: o.face ?? 'display',
    weight: o.weight ?? 700,
    tone: o.tone ?? 'text',
    align: o.align ?? 'center',
    track: o.track ?? 0,
    glow: o.glow ?? 0,
    alpha: o.alpha ?? 1,
  };
}

/** Label tracking (the shell's `--track-label`). */
export const TRACK_LABEL = 0.12;
/** Display tracking for the score (`--track-display`). */
export const TRACK_DISPLAY = 0.04;
/** Names and tile values: a touch of air, less than a label. */
export const TRACK_NUMBER = 0.02;

/** A glass panel: a rounded fill with a rim, white for the tiles and the pill, amber for the pot. */
function panel(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  tone: Tone,
  glass: { fill: number; edge: number },
): PanelOp {
  return { kind: 'panel', id, x, y, w, h, r, tone, fill: glass.fill, edge: glass.edge };
}

/**
 * The identity pill: badge · username · "PEBBLE II · XP LV 2" on one line
 * inside a rounded glass pill, centred on `cx`.
 */
function pillOps(
  user: CardUser,
  cx: number,
  y: number,
  m: {
    pillH: number;
    pillPadX: number;
    badge: number;
    badgeGap: number;
    nameSize: number;
    nameGap: number;
    rankSize: number;
  },
  measure: Measure,
): CardOp[] {
  const line = rankLine(user);
  const nameW = measure(user.username, 'display', m.nameSize, 700, TRACK_NUMBER);
  const lineW = measure(line, 'display', m.rankSize, 600, TRACK_LABEL);
  const inner = m.badge + m.badgeGap + nameW + m.nameGap + lineW;
  const w = inner + 2 * m.pillPadX;
  const x0 = cx - w / 2;
  const cy = y + m.pillH / 2;
  const bx = x0 + m.pillPadX;
  const nx = bx + m.badge + m.badgeGap;
  return [
    panel('pill', x0, y, w, m.pillH, m.pillH / 2, 'text', GLASS),
    { kind: 'badge', x: bx, y: cy - m.badge / 2, size: m.badge, rank: user.rank },
    text('name', user.username, nx, cy, m.nameSize, { align: 'left', track: TRACK_NUMBER }),
    text('rank', line, nx + nameW + m.nameGap, cy, m.rankSize, {
      align: 'left',
      weight: 600,
      tone: 'rank',
      track: TRACK_LABEL,
    }),
  ];
}

/** Three equal stat tiles in one row across `totalW`: the label over the value, the game's stats-grid language. */
function tileOps(
  b: ScoreBreakdown,
  x0: number,
  y: number,
  totalW: number,
  m: {
    tileH: number;
    tileGap: number;
    tileR: number;
    tileLabelSize: number;
    tileLabelDy: number;
    tileValueSize: number;
    tileValueDy: number;
  },
): CardOp[] {
  const tiles = statTiles(b);
  const w = (totalW - m.tileGap * (tiles.length - 1)) / tiles.length;
  return tiles.flatMap((t, i) => {
    const x = x0 + i * (w + m.tileGap);
    const cx = x + w / 2;
    return [
      panel(`tile-${i}`, x, y, w, m.tileH, m.tileR, 'text', GLASS),
      text(`tile-${i}-label`, t.label, cx, y + m.tileLabelDy, m.tileLabelSize, {
        tone: 'dim',
        weight: 600,
        track: TRACK_LABEL,
      }),
      text(`tile-${i}-value`, t.value, cx, y + m.tileValueDy, m.tileValueSize, {
        tone: t.tone,
        track: TRACK_NUMBER,
      }),
    ];
  });
}

/** The link card's stat strip: one glass tile with the three label·value pairs in thirds. */
function stripOps(
  b: ScoreBreakdown,
  x0: number,
  y: number,
  totalW: number,
  m: {
    stripH: number;
    stripR: number;
    stripLabelSize: number;
    stripValueSize: number;
    stripGap: number;
  },
  measure: Measure,
): CardOp[] {
  const tiles = statTiles(b);
  const third = totalW / tiles.length;
  const cy = y + m.stripH / 2;
  return [
    panel('strip', x0, y, totalW, m.stripH, m.stripR, 'text', GLASS),
    ...tiles.flatMap((t, i) => {
      const lw = measure(t.label, 'display', m.stripLabelSize, 600, TRACK_LABEL);
      const vw = measure(t.value, 'display', m.stripValueSize, 700, TRACK_NUMBER);
      const lx = x0 + i * third + (third - (lw + m.stripGap + vw)) / 2;
      return [
        text(`strip-${i}-label`, t.label, lx, cy, m.stripLabelSize, {
          align: 'left',
          tone: 'dim',
          weight: 600,
          track: TRACK_LABEL,
        }),
        text(`strip-${i}-value`, t.value, lx + lw + m.stripGap, cy, m.stripValueSize, {
          align: 'left',
          tone: t.tone,
          track: TRACK_NUMBER,
        }),
      ];
    }),
  ];
}

/** The second hero's geometry: one slot, shared by the pot and the outcome. */
interface HeroMetrics {
  pot: { y: number; h: number; r: number };
  potEyebrowY: number;
  potEyebrowSize: number;
  potY: number;
  potSize: number;
  potUnitSize: number;
  potCoin: number;
  potGap: number;
  potStakeY: number;
  potStakeSize: number;
}

/**
 * The second hero: a tinted panel with an eyebrow over the number ("200" at
 * hero size, the coin at cap height before it, "$CHAIN" after) and a small
 * line under it. The pot ("BEAT 9,520 TO WIN" / "Stake 100 to play", amber)
 * and the outcome ("YOU WON" / "vs mason · 8,470", mint or rose) are one
 * block with different words — the same slot, the same weight.
 */
function heroOps(
  id: string,
  c: HeroCopy,
  x: number,
  w: number,
  m: HeroMetrics,
  measure: Measure,
): CardOp[] {
  const cx = x + w / 2;
  const valueW = measure(c.value, 'display', m.potSize, 700, TRACK_DISPLAY);
  const unitW = measure(c.unit, 'display', m.potUnitSize, 700, TRACK_LABEL);
  const coinW = c.coin ? m.potCoin + m.potGap : 0;
  const total = coinW + valueW + m.potGap + unitW;
  const x0 = cx - total / 2;
  const ops: CardOp[] = [
    panel(id, x, m.pot.y, w, m.pot.h, m.pot.r, c.tone, POT_GLASS),
    text(`${id}-eyebrow`, c.eyebrow, cx, m.potEyebrowY, m.potEyebrowSize, {
      tone: c.tone,
      weight: 600,
      track: TRACK_LABEL,
    }),
  ];
  // The coin and the unit centre on the number's CAP box, not its em box.
  if (c.coin)
    ops.push({
      kind: 'coin',
      x: x0,
      y: m.potY - CAP_MID_EM * m.potSize - m.potCoin / 2,
      size: m.potCoin,
    });
  ops.push(
    text(id, c.value, x0 + coinW, m.potY, m.potSize, {
      align: 'left',
      tone: c.tone,
      track: TRACK_DISPLAY,
      glow: m.potSize * POT_GLOW_EM,
    }),
    text(
      `${id}-unit`,
      c.unit,
      x0 + coinW + valueW + m.potGap,
      m.potY - CAP_MID_EM * (m.potSize - m.potUnitSize),
      m.potUnitSize,
      {
        align: 'left',
        tone: c.tone,
        track: TRACK_LABEL,
      },
    ),
  );
  if (c.sub)
    ops.push(
      text(`${id}-sub`, c.sub, cx, m.potStakeY, m.potStakeSize, {
        face: 'body',
        weight: 500,
        tone: 'dim',
      }),
    );
  return ops;
}

/** The pot block, the open challenge's second hero. */
function potOps(
  entryFee: number,
  total: number,
  x: number,
  w: number,
  m: HeroMetrics,
  measure: Measure,
): CardOp[] {
  return heroOps('pot', potCopy(entryFee, total), x, w, m, measure);
}

/** The outcome block, the settled challenge's second hero, in the pot's slot. */
function outcomeOps(
  r: CardResult,
  entryFee: number,
  x: number,
  w: number,
  m: HeroMetrics,
  measure: Measure,
): CardOp[] {
  return heroOps('outcome', resultCopy(r, entryFee), x, w, m, measure);
}

/** The pot number's glow, relative to its size (the score's is 0.24). */
const POT_GLOW_EM = 0.2;
/** With a middle baseline the display face's cap box sits this far above the em centre, in em. */
export const CAP_MID_EM = 0.093;

/** The code slab, its code shrunk if six wide glyphs would touch the rim. */
function slabOp(
  code: string,
  x: number,
  y: number,
  w: number,
  m: { slabH: number; slabR: number; slabSize: number; slabTrack: number },
  measure: Measure,
): SlabOp {
  const inner = w - 2 * SLAB_PAD_EM * m.slabSize;
  return {
    kind: 'slab',
    id: 'code',
    x,
    y,
    w,
    h: m.slabH,
    r: m.slabR,
    text: code,
    size: fit(code, m.slabSize, inner, measure, 'display', 700, m.slabTrack),
    track: m.slabTrack,
  };
}

/** "PLAY FREE AT" over the host, centred on `cx`: the front door, where a card has no dare. */
function doorOps(
  host: string,
  cx: number,
  labelY: number,
  hostY: number,
  maxW: number,
  m: { ctaLabelSize: number; hostSize: number },
  hostGlow: number,
  measure: Measure,
): CardOp[] {
  return [
    text('cta-label', PLAY_FREE_LABEL, cx, labelY, m.ctaLabelSize, {
      tone: 'amber',
      weight: 600,
      track: TRACK_LABEL,
    }),
    text(
      'host',
      host,
      cx,
      hostY,
      fit(host, m.hostSize, maxW, measure, 'display', 700, TRACK_NUMBER),
      { tone: 'mint', track: TRACK_NUMBER, glow: hostGlow },
    ),
  ];
}

function qrOp(
  text: string,
  x: number,
  y: number,
  m: { qrTile: number; qrPad: number; qrR: number },
): QrOp {
  return { kind: 'qr', id: 'qr', x, y, size: m.qrTile, pad: m.qrPad, r: m.qrR, text };
}

function plateOp(p: {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  fade: number;
}): PlateOp {
  return { kind: 'plate', ...p };
}

function layoutStory(input: CardInput, measure: Measure): CardLayout {
  const { w, h } = CARD_PX.story;
  const M = STORY;
  const cx = w / 2;
  const x0 = M.plate.x + M.padX;
  const contentW = M.plate.w - 2 * M.padX;
  const b = input.breakdown;
  const score = formatScore(b.total);
  const ops: CardOp[] = [{ kind: 'art', src: CARD_ART.story, x: 0, y: 0, w, h }, plateOp(M.plate)];

  // "SCORE" → the hero → the stat tiles → the identity pill.
  ops.push(
    text('eyebrow', SCORE_LABEL, cx, M.eyebrowY, M.eyebrowSize, {
      tone: 'dim',
      weight: 600,
      track: TRACK_LABEL,
    }),
    text(
      'score',
      score,
      cx,
      M.scoreY,
      fit(score, M.scoreSize, contentW, measure, 'display', 700, TRACK_DISPLAY),
      { tone: 'mint', track: TRACK_DISPLAY, glow: M.scoreGlow },
    ),
    ...tileOps(b, x0, M.tilesY, contentW, M),
  );
  if (input.user) ops.push(...pillOps(input.user, cx, M.pillY, M, measure));

  // The second hero → the row: open, the stake → code + QR of the take link;
  // settled, the outcome → the front door + QR of the site; solo, the front door → QR.
  const qrX = x0 + contentW - M.qrTile;
  const leftW = contentW - M.qrTile - M.rowGap;
  const ch = input.challenge;
  if (ch?.status === 'open') {
    if (ch.entryFee !== undefined)
      ops.push(...potOps(ch.entryFee, b.total, x0, contentW, M, measure));
    else
      ops.push(
        text('cta-label', `BEAT ${score}`, cx, M.potY, M.ctaLabelSize, {
          tone: 'amber',
          weight: 600,
          track: TRACK_LABEL,
        }),
      );
    ops.push(
      slabOp(ch.code, x0, M.rowY + (M.qrTile - M.slabH) / 2, leftW, M, measure),
      qrOp(takeUrl(input.origin, ch.code), qrX, M.rowY, M),
    );
  } else if (ch) {
    ops.push(
      ...outcomeOps(ch.result, ch.entryFee, x0, contentW, M, measure),
      // No code once it is matched: the front door takes the slab's place beside the QR.
      ...doorOps(
        input.host,
        x0 + leftW / 2,
        M.rowSettledY + M.rowLabelDy,
        M.rowSettledY + M.rowHostDy,
        leftW,
        M,
        20,
        measure,
      ),
      qrOp(takeUrl(input.origin, null), qrX, M.rowSettledY, M),
    );
  } else {
    ops.push(
      ...doorOps(input.host, cx, M.ctaLabelY, M.hostY, contentW, M, 20, measure),
      // No code to sit beside it: the QR takes the middle of the row.
      qrOp(takeUrl(input.origin, null), cx - M.qrTile / 2, M.soloRowY, M),
    );
  }

  // The take link on ONE line, shrunk until it fits the plate; never wrapped.
  // Only the dare has one: elsewhere the host is already on the card, in mint.
  if (ch?.status === 'open') {
    const link = displayUrl(input.host, ch.code);
    ops.push(
      text('link', link, cx, M.linkY, fit(link, M.linkSize, contentW, measure, 'body', 500), {
        face: 'body',
        weight: 500,
        tone: 'dim',
      }),
    );
  }

  return { size: 'story', w, h, ops };
}

/** `host/take?code=…` as printed under the dare row; with no code, the host alone. */
export function displayUrl(host: string, code: string | null | undefined): string {
  return code ? `${host}/take?code=${code}` : host;
}

/** The code a card's links carry: only while the challenge can still be taken. */
export function takeCode(challenge: CardChallenge | null | undefined): string | null {
  return challenge?.status === 'open' ? challenge.code : null;
}

function layoutLink(input: CardInput, measure: Measure): CardLayout {
  const { w, h } = CARD_PX.link;
  const M = LINK;
  const b = input.breakdown;
  const score = formatScore(b.total);
  const ops: CardOp[] = [{ kind: 'art', src: CARD_ART.link, x: 0, y: 0, w, h }, plateOp(M.plate)];

  // Left: "SCORE" → the hero → the stat strip → the identity pill.
  const leftCx = M.leftX + M.leftW / 2;
  ops.push(
    text('eyebrow', SCORE_LABEL, leftCx, M.eyebrowY, M.eyebrowSize, {
      tone: 'dim',
      weight: 600,
      track: TRACK_LABEL,
    }),
    text(
      'score',
      score,
      leftCx,
      M.scoreY,
      fit(score, M.scoreSize, M.leftW, measure, 'display', 700, TRACK_DISPLAY),
      { tone: 'mint', track: TRACK_DISPLAY, glow: M.scoreGlow },
    ),
    ...stripOps(b, M.leftX, M.stripY, M.leftW, M, measure),
  );
  if (input.user) ops.push(...pillOps(input.user, leftCx, M.pillY, M, measure));

  // Centre: the pot over the code; settled, the outcome over the front door; solo, the front door.
  const midCx = M.midX + M.midW / 2;
  const ch = input.challenge;
  if (ch?.status === 'open') {
    if (ch.entryFee !== undefined)
      ops.push(...potOps(ch.entryFee, b.total, M.midX, M.midW, M, measure));
    else
      ops.push(
        text('cta-label', `BEAT ${score}`, midCx, M.potY, M.ctaLabelSize, {
          tone: 'amber',
          weight: 600,
          track: TRACK_LABEL,
        }),
      );
    ops.push(slabOp(ch.code, M.midX, M.slabY, M.midW, M, measure));
  } else if (ch) {
    ops.push(
      ...outcomeOps(ch.result, ch.entryFee, M.midX, M.midW, M, measure),
      ...doorOps(input.host, midCx, M.rowLabelY, M.rowHostY, M.midW, M, 14, measure),
    );
  } else {
    ops.push(...doorOps(input.host, midCx, M.ctaLabelY, M.hostY, M.midW, M, 14, measure));
  }

  // Right: the QR with its label.
  const qrX = M.plate.x + M.plate.w - M.padX - M.qrTile;
  ops.push(
    qrOp(takeUrl(input.origin, takeCode(ch)), qrX, M.qrY, M),
    text('scan', SCAN_LABEL, qrX + M.qrTile / 2, M.qrY + M.qrTile + M.scanGap, M.scanSize, {
      tone: 'dim',
      weight: 600,
      track: TRACK_LABEL,
    }),
  );

  // The take link along the plate's bottom edge, one line — the dare's only.
  if (ch?.status === 'open') {
    const link = displayUrl(input.host, ch.code);
    const plateW = M.plate.w - 2 * M.padX;
    ops.push(
      text('link', link, midCx, M.linkY, fit(link, M.linkSize, plateW, measure, 'body', 500), {
        face: 'body',
        weight: 500,
        tone: 'dim',
      }),
    );
  }

  return { size: 'link', w, h, ops };
}
