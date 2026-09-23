import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { RANKS, rankFor, type Rank } from '@solitaire-plus/sim';
import { ApiError, type XpProgress } from '../api/client.js';
import { useRankUp, type ActiveCrossing } from '../state/rankup.js';
import { useSettings } from '../state/settings.js';
import {
  CHAIN_MARK,
  CHAIN_MARK_CX,
  CHAIN_MARK_CY,
  CHAIN_MARK_R,
  COIN_FACE,
  COIN_RIM,
  COIN_WELL,
} from './chain-mark.js';
import { sfx } from './sfx.js';
import { isLegend, rankAtIndex, rankLabel, tierLabel, xpProgress } from './xp-view.js';

export { CHAIN_MARK };

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* --------------------------------------------------------------------------
   Brand
   -------------------------------------------------------------------------- */

const LOGO = {
  master: '/brand/logo.png',
  l1024: '/brand/logo-1024.png',
  l640: '/brand/logo-640.png',
  l320: '/brand/logo-320.png',
} as const;

/** The logo's aspect: every size shares the 1179×705 master's proportions. */
const LOGO_RATIO = 705 / 1179;

/**
 * The official wordmark as an `<img>`: never recoloured, explicit box so it
 * cannot shift layout, `srcset` so a dpr-2 phone gets a sharp file.
 */
export function Logo({
  size,
  priority = false,
  className,
}: {
  /** Rendered CSS width in px (height follows the master's ratio). */
  size: number;
  /** Hero image: eager + high fetch priority (it is also preloaded in index.html). */
  priority?: boolean;
  className?: string | undefined;
}) {
  const height = Math.round(size * LOGO_RATIO);
  const srcSet = `${LOGO.l320} 320w, ${LOGO.l640} 640w, ${LOGO.l1024} 1024w, ${LOGO.master} 1179w`;
  return (
    <img
      src={size <= 320 ? LOGO.l320 : size <= 640 ? LOGO.l640 : LOGO.l1024}
      srcSet={srcSet}
      sizes={`${size}px`}
      width={size}
      height={height}
      alt="Blockari"
      decoding="async"
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      draggable={false}
      className={className}
    />
  );
}

/**
 * The $CHAIN coin: the Chain Games mark (shell/chain-mark.ts, the owner's
 * brand) as a dark emboss on an amber gradient disc with a lit rim. The
 * mark's own circle IS the coin; its inner shape is cut out of the disc so
 * the tinted face shows through it.
 */
export function Coin({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="-4.5 0 337 337" className={className ?? 'coin'} aria-hidden>
      <defs>
        <linearGradient id="coin-face" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={COIN_FACE[0]} />
          <stop offset="0.55" stopColor={COIN_FACE[1]} />
          <stop offset="1" stopColor={COIN_FACE[2]} />
        </linearGradient>
        <linearGradient id="coin-rim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={COIN_RIM[0]} />
          <stop offset="1" stopColor={COIN_RIM[1]} />
        </linearGradient>
      </defs>
      <circle cx={CHAIN_MARK_CX} cy={CHAIN_MARK_CY} r={CHAIN_MARK_R + 4} fill="url(#coin-rim)" />
      <circle cx={CHAIN_MARK_CX} cy={CHAIN_MARK_CY} r={CHAIN_MARK_R - 10} fill={COIN_WELL} />
      <path d={CHAIN_MARK} fill="url(#coin-face)" />
    </svg>
  );
}

/**
 * Avatar disc with initials; the hue is derived from the name so it is
 * stable. With `xp` it wears a progress ring: a 3 px stroke in the rank's
 * colour that fills clockwise from the top as the player closes on the next
 * XP level, over a faint full track. Drawn as SVG strokes — a conic
 * gradient under a radial mask was the first attempt and iOS Safari painted
 * the whole wedge as a grey crescent.
 */
export function Avatar({
  name,
  large = false,
  xp,
  sweep,
}: {
  name: string;
  large?: boolean;
  xp?: XpProgress | undefined;
  /**
   * A rank crossing to announce (the top bar): the ring does one full sweep
   * in the new rank's colour, then its colour snaps. Played once per firing.
   */
  sweep?: ActiveCrossing | null | undefined;
}) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const initials =
    name
      .replace(/^guest_/, '')
      .slice(0, 2)
      .toUpperCase() || '??';
  const ring = xp ? xpProgress(xp.xp, xp.prevThreshold, xp.nextThreshold) : null;
  // Everything here derives from the crossing's one timeline (state/rankup.ts): no timer of its own.
  // hold: the ring wears the OLD rank's colour with its arc held FULL on the old span; reveal: the
  // packet and the new-colour arc (the real value) mount in the same commit as the badge, the name,
  // the chip and the bar, the new arc snapping in as the packet's head passes 12 o'clock (CSS from
  // that mount, no delay); settled: the plain ring in the new rank.
  const live = sweep && sweep.to === xp?.rank.index && sweep.phase !== 'settled' ? sweep : null;
  const sweeping = live !== null && !reducedMotion();
  const cued = useRef(0);
  useEffect(() => {
    if (!live || cued.current === live.seq) return;
    cued.current = live.seq;
    sfx('rank-up');
  }, [live]);
  const ringRank = sweeping && live ? live.from : xp?.rank;
  const revealed = sweeping && live?.phase === 'reveal';
  return (
    <span
      className={`avatar${large ? ' lg' : ''}${xp ? ` ringed ${rankClass(ringRank ?? 0)}` : ''}${sweeping ? ' sweeping' : ''}${revealed ? ' revealed' : ''}`}
      style={{ '--hue': hue } as CSSProperties}
      aria-hidden
    >
      {initials}
      {ring !== null && (
        <ProgressRing
          value={sweeping ? 1 : ring}
          newValue={ring}
          sweepTo={revealed && live ? live.to : undefined}
        />
      )}
    </span>
  );
}

/**
 * The ring around an avatar: a full faint track and the progress arc, both
 * strokes on a unit circle (r = 50 − stroke/2 in a 100-box), the arc
 * measured with `pathLength` so the dash is a plain fraction. Starts at the
 * top, runs clockwise, round caps; ≥ 3 % shown at zero so the ring is never
 * just a track (the XP bar's ≥ 6 px rule).
 */
export function ProgressRing({
  value,
  newValue = value,
  sweepTo,
}: {
  value: number;
  /** The value the new-colour arc shows during a sweep (the old arc holds `value`). */
  newValue?: number;
  sweepTo?: number | undefined;
}) {
  const shown = Math.max(0.03, Math.min(1, value));
  const shownNew = Math.max(0.03, Math.min(1, newValue));
  return (
    <svg className="avatar-ring" viewBox="0 0 100 100" aria-hidden>
      <circle className="track" cx="50" cy="50" r="46" pathLength={1} />
      {/* Keyed on the sweep: after it the arc remounts with its new value, never tweening from the held one. */}
      <circle
        key={sweepTo === undefined ? 'arc' : 'arc-held'}
        className="arc"
        cx="50"
        cy="50"
        r="46"
        pathLength={1}
        strokeDasharray={`${shown} ${1 - shown}`}
      />
      {sweepTo !== undefined && (
        <>
          {/* The arc in the NEW colour: snaps in as the packet's head passes 12 o'clock. */}
          <circle
            className={`arc arc-new ${rankClass(sweepTo)}`}
            cx="50"
            cy="50"
            r="46"
            pathLength={1}
            strokeDasharray={`${shownNew} ${1 - shownNew}`}
          />
          {/* A PACKET (0.35 of the turn) in the NEW rank's colour, run once round the old ring
              (dashoffset 1.35 → 0 on a unit path) — never a closed hoop. */}
          <circle
            className={`sweep ${rankClass(sweepTo)}`}
            cx="50"
            cy="50"
            r="46"
            pathLength={1}
            strokeDasharray="0.35 0.65"
          />
        </>
      )}
    </svg>
  );
}

/* --------------------------------------------------------------------------
   Rank and XP (account-level progression; docs/art-direction.md "XP")
   -------------------------------------------------------------------------- */

/** The `rank-N` class that binds `--rank` / `--rank-rgb` to the rank's tokens. */
export function rankClass(rank: Rank | number): string {
  const i = typeof rank === 'number' ? rank : rank.index;
  return `rank-${Math.max(0, Math.min(RANKS.length - 1, i))}`;
}

/** The cube's three faces and its pips, in a 64-unit box (the cube sits high so the pips fit). Shared with the share card's canvas badge. */
export const CUBE = {
  top: '32,4 52,15 32,26 12,15',
  left: '12,15 32,26 32,48 12,37',
  right: '32,26 52,15 52,37 32,48',
  /** The cube's silhouette (outline and the shimmer's clip). */
  hull: '32,4 52,15 52,37 32,48 12,37 12,15',
  /** Rim light along the two lit edges (top-left of the cube). */
  rim: 'M12,15 L32,4 L52,15',
  /** Specular on the top face at ~(0.28, 0.18) of it, like the tile bake. */
  spec: { cx: 26, cy: 12, rx: 5, ry: 2.4, rot: -28 },
  pipsY: 57,
  pipsX: [16, 24, 32, 40, 48],
  pipHalf: 3.2,
} as const;

/** Max pips drawn: tiers past five (Legend) show the numeral instead. */
export const PIP_MAX = 5;
/** Below this size the badge is the cube alone (no pips, no light): 18–40 px are plain marks. */
export const PIPS_FROM = 56;

/**
 * Rank badge: a faceted block in the rank's colour — the same cube language
 * as the tiles (top face lifted, side faces in shade, a rim light and one
 * specular) — with the tier as pips under it (1–5) or a numeral for Legend's
 * open-ended tiers. Reads at 18/24/40/72 px; below 56 the pips and the
 * light are dropped and the cube fills the box. Legend wears a slow shimmer
 * (transform only).
 */
export function RankBadge({
  rank,
  size = 24,
  className,
  title,
  mine = false,
}: {
  rank: Rank;
  size?: number;
  className?: string | undefined;
  /** Tooltip; defaults to "Mason III". */
  title?: string | undefined;
  /** The session user's own badge: a fired rank crossing plays the miniature ceremony on it. */
  mine?: boolean;
}) {
  const active = useRankUp((s) => (mine ? s.active : null));
  // The miniature is a view of the crossing's one timeline: no timer of its own.
  const mini =
    active && active.to === rank.index && active.phase !== 'settled' && !reducedMotion()
      ? active
      : null;
  if (mini)
    return (
      <RankBadgeMini
        from={rankAtIndex(mini.from)}
        to={rank}
        size={size}
        className={className}
        revealed={mini.phase === 'reveal'}
      />
    );
  const compact = size < PIPS_FROM;
  const legend = isLegend(rank);
  const numeral = rank.tier > PIP_MAX;
  const label = title ?? rankLabel(rank);
  return (
    <span
      className={`rank-badge ${rankClass(rank)}${compact ? ' compact' : ' lit'}${legend ? ' legend' : ''}${className ? ` ${className}` : ''}`}
      style={{ '--size': `${size}px` } as CSSProperties}
      title={label}
      role="img"
      aria-label={label}
    >
      <svg viewBox={compact ? '10 2 44 48' : '0 0 64 64'} aria-hidden>
        {legend && (
          <defs>
            <linearGradient id="rank-sheen" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#fff" stopOpacity="0" />
              <stop offset="0.5" stopColor="#fff" stopOpacity="0.55" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
            {/* The shimmer never leaves the cube. */}
            <clipPath id="rank-cube">
              <polygon points={CUBE.hull} />
            </clipPath>
          </defs>
        )}
        <polygon className="f-left" points={CUBE.left} />
        <polygon className="f-right" points={CUBE.right} />
        <polygon className="f-top" points={CUBE.top} />
        <ellipse
          className="spec"
          cx={CUBE.spec.cx}
          cy={CUBE.spec.cy}
          rx={CUBE.spec.rx}
          ry={CUBE.spec.ry}
          transform={`rotate(${CUBE.spec.rot} ${CUBE.spec.cx} ${CUBE.spec.cy})`}
        />
        <path className="rim" d={CUBE.rim} />
        <polygon className="outline" points={CUBE.hull} />
        {legend && (
          <g clipPath="url(#rank-cube)">
            <g className="sheen">
              <rect x="-30" y="-10" width="26" height="84" fill="url(#rank-sheen)" />
            </g>
          </g>
        )}
        {!compact &&
          (numeral ? (
            <text className="tier-num" x="32" y={CUBE.pipsY + 5} textAnchor="middle">
              {tierLabel(rank.tier)}
            </text>
          ) : (
            CUBE.pipsX.map((x, i) => (
              <polygon
                key={x}
                className={`pip${i < rank.tier ? ' lit' : ''}`}
                points={`${x},${CUBE.pipsY - CUBE.pipHalf} ${x + CUBE.pipHalf},${CUBE.pipsY} ${x},${CUBE.pipsY + CUBE.pipHalf} ${x - CUBE.pipHalf},${CUBE.pipsY}`}
              />
            ))
          ))}
      </svg>
    </span>
  );
}

/* --- the miniature ceremony: a badge on a rank crossing ---------------------
   The results tray's rank-up at badge scale (docs/art-direction.md "XP and
   ranks"): the old cube dissolves into six cored shards while a filled light
   blooms behind it; at MINI_REVEAL_MS the new cube scales in 0.4 → 1.12 → 1
   over 240 ms and the rank's name flips like the split-flap. The box never
   changes size: only the cube and its light move. */

/** Shards in the miniature (styles: --mini-shards). */
const MINI_SHARDS = 6;
/** The name's split-flap (styles: --mini-flip). */
export const MINI_FLIP_MS = 90;

/** Two per lobe in three lobes, jittered like the full ceremony's; distances scale with the badge. */
const MINI_LOBES = [-72, 28, 158] as const;
function miniShardStyle(i: number, size: number): CSSProperties {
  const j = ((i * 7919) % 97) / 97;
  const k = ((i * 104729) % 89) / 89;
  const lobe = MINI_LOBES[i % MINI_LOBES.length] ?? 0;
  const slot = Math.floor(i / MINI_LOBES.length) - 0.5;
  const angle = lobe + slot * 22 + (j - 0.5) * 12;
  const dist = size * (0.9 + k * 0.6);
  const len = Math.max(4, Math.round(size * (0.16 + j * 0.16)));
  return {
    '--a': `${angle.toFixed(1)}deg`,
    '--d': `${dist.toFixed(0)}px`,
    '--l': `${len}px`,
    '--t0': `${Math.round(k * 40)}ms`,
  } as CSSProperties;
}

function RankBadgeMini({
  from,
  to,
  size,
  className,
  revealed,
}: {
  from: Rank;
  to: Rank;
  size: number;
  className?: string | undefined;
  /** The timeline's reveal has landed: the new cube mounts here (its pop runs from this commit). */
  revealed: boolean;
}) {
  return (
    <span
      className={`rank-mini ${rankClass(to)}${revealed ? ' revealed' : ''}${className ? ` ${className}` : ''}`}
      style={{ '--size': `${size}px` } as CSSProperties}
      role="img"
      aria-label={`Rank up: ${rankLabel(to)}`}
    >
      <i className="rank-mini-light" aria-hidden />
      <span className={`rank-mini-old ${rankClass(from)}`} aria-hidden>
        <RankBadge rank={from} size={size} />
      </span>
      {Array.from({ length: MINI_SHARDS }, (_, i) => (
        <i
          key={i}
          className={`rank-mini-shard ${rankClass(from)}`}
          style={miniShardStyle(i, size)}
          aria-hidden
        />
      ))}
      {revealed && (
        <span className="rank-mini-new" aria-hidden>
          <RankBadge rank={to} size={size} />
        </span>
      )}
    </span>
  );
}

/**
 * A placement of "me" (the home card, the profile hero) holding the state
 * BEFORE a fired crossing — old rank, old level, bar full on the old span —
 * until the miniature's reveal (MINI_REVEAL_MS after the firing reaches it),
 * when the badge, the name, the chip and the bar all change together. Returns
 * the crossing while it is live here, and whether the placement still reads
 * the state before it. `?hold=1` keeps whichever state a seek left.
 */
export function useCrossingHold(
  mine: boolean,
  rankIndex: number,
): { crossing: ActiveCrossing | null; before: boolean } {
  const active = useRankUp((s) => (mine ? s.active : null));
  const live = active && active.to === rankIndex ? active : null;
  // Derived, never an effect: the first render after the firing is already the state before.
  return { crossing: live, before: live !== null && live.phase === 'hold' && !reducedMotion() };
}

/**
 * The rank's name ("Mason III") wherever it sits beside a badge. `mine`: on
 * a fired crossing it reads the OLD name until the miniature's reveal, then
 * flips to the new one like the split-flap (whole word, 90 ms).
 */
export function RankName({
  rank,
  mine = false,
  className,
}: {
  rank: Rank;
  mine?: boolean;
  className?: string | undefined;
}) {
  const active = useRankUp((s) => (mine ? s.active : null));
  // A view of the crossing's one timeline: hold → the old word; reveal → the split-flap mounts
  // in the same commit as the cube, the chip and the bar (its 90 ms run from that mount, no
  // delay); settled → the new word.
  const live = active && active.to === rank.index && !reducedMotion() ? active : null;
  const cued = useRef(0);
  useEffect(() => {
    if (!live || live.phase !== 'reveal' || cued.current === live.seq) return;
    cued.current = live.seq;
    sfx('odometer-flip');
  }, [live]);
  const label = rankLabel(rank);
  if (!live || live.phase === 'settled') return <span className={className}>{label}</span>;
  if (live.phase === 'hold')
    return <span className={className}>{rankLabel(rankAtIndex(live.from))}</span>;
  // A split-flap: the old word turns down (rotateX 0 → −90°), then the new one turns in (90° → 0,
  // a 6 % overshoot); one word per frame, never two.
  return (
    <span className={className} aria-label={label}>
      <span className="rank-flip">
        <span className="flap-out" aria-hidden>
          {rankLabel(rankAtIndex(live.from))}
        </span>
        <span className="flap-in">{label}</span>
      </span>
    </span>
  );
}

/** "XP LV 12": the account level chip, toned in the rank's colour (a sibling of the in-match `.chip.indigo` "LV 5"). */
export function XpChip({
  level,
  rank,
  size,
  children,
}: {
  level: number;
  rank?: Rank | undefined;
  size?: 'sm' | 'lg' | undefined;
  /** Replaces the number (the results odometer). */
  children?: ReactNode;
}) {
  const r = rank ?? rankFor(level);
  return (
    <span
      className={`chip xp ${rankClass(r)}${size ? ` ${size}` : ''}`}
      title={`XP level ${level} · ${rankLabel(r)}`}
    >
      <small>XP</small>
      <span className="lv">LV</span>
      {children ?? <b>{level}</b>}
    </span>
  );
}

/**
 * Badge + name (+ chip) as one unit, wherever a player is named. `size`
 * picks the badge: sm 18 (history rows), md 24 (queue rows), lg 40 (VS).
 */
export function PlayerTag({
  name,
  level,
  rank,
  size = 'md',
  chip = size !== 'sm',
  to,
  className,
  mirror = false,
}: {
  name: ReactNode;
  level: number;
  rank: Rank;
  size?: 'sm' | 'md' | 'lg';
  /** Show the XP level chip after the name. */
  chip?: boolean;
  /** Link the unit to a profile. */
  to?: string | undefined;
  className?: string | undefined;
  /** Badge after the name (the right-hand side of a VS row reads outward). */
  mirror?: boolean;
}) {
  const px = size === 'lg' ? 40 : size === 'md' ? 24 : 18;
  const cls = `player-tag ${size} ${rankClass(rank)}${className ? ` ${className}` : ''}`;
  const badge = <RankBadge rank={rank} size={px} />;
  const body = (
    <>
      {!mirror && badge}
      <span className="pt-name">{name}</span>
      {chip && <XpChip level={level} rank={rank} size="sm" />}
      {mirror && badge}
    </>
  );
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <span className={cls}>{body}</span>
  );
}

/**
 * The XP bar: the level's span (prevThreshold → nextThreshold) with the fill
 * in the rank's colour, "1,240 / 1,800 XP · 560 to Mason III" under it. The
 * fill is a transform (never a width tween); `pulse` flashes the cool
 * level-up pulse when it changes.
 */
export function XpBar({
  xp,
  prev,
  next,
  level,
  rank,
  size = 'md',
  pulse = 0,
  legend = true,
  reveal = false,
  revealNow = false,
}: {
  xp: number;
  prev: number;
  next: number;
  level: number;
  rank: Rank;
  size?: 'md' | 'lg';
  /** Bump to replay the level-up pulse. */
  pulse?: number;
  legend?: boolean;
  /** A static bar: the fill grows in once on mount. */
  reveal?: boolean;
  /** The reveal's own bar: mounts at the crossing's reveal, so its grow-in runs from that commit with no delay. */
  revealNow?: boolean;
}) {
  const p = xpProgress(xp, prev, next);
  const nextRank = rankFor(level + 1);
  const toGo = Math.max(0, next - Math.round(xp));
  return (
    <div
      className={`xp-bar ${size} ${rankClass(rank)}${reveal ? ' reveal' : ''}${revealNow ? ' reveal now' : ''}`}
      style={{ '--p': p } as CSSProperties}
      role="progressbar"
      aria-valuemin={prev}
      aria-valuemax={next}
      aria-valuenow={Math.round(xp)}
      aria-label={`XP level ${level}: ${Math.round(xp).toLocaleString()} of ${next.toLocaleString()}`}
    >
      <div className="xp-track">
        <i className="xp-fill" />
        {pulse > 0 && <i className="xp-pulse" key={pulse} />}
      </div>
      {legend && (
        <div className="xp-legend">
          <span className="xp-nums">
            <b>{Math.round(xp).toLocaleString()}</b> / {next.toLocaleString()} XP
          </span>
          <span className="xp-next">
            {toGo.toLocaleString()} to {rankLabel(nextRank)}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * A number whose changed digits flip like the HUD odometer (docs/art-direction
 * "Score roll"): the old glyph holds 40 ms, then fades out drifting up 0.12
 * row while the new one fades in from below — never two solid glyphs, never
 * an empty slot. Columns that appear snap in.
 */
export function Odometer({ value, min = 1 }: { value: number; min?: number }) {
  const digits = String(Math.max(0, Math.floor(value))).padStart(min, '0');
  // The flips are derived DURING the render that carries the new value (never an effect a frame
  // later), so the old glyph's fade-out and the new one's fade-in start on the same frame the
  // number changes — the one the rank-up's reveal changes everything else on.
  const [state, setState] = useState<{ digits: string; flips: Record<number, string> }>({
    digits,
    flips: {},
  });
  if (state.digits !== digits) {
    const prev = state.digits;
    const flips: Record<number, string> = {};
    const shift = digits.length - prev.length;
    for (let i = 0; i < digits.length; i++) {
      const was = prev[i - shift]; // right-aligned: a column that appears has no old glyph
      if (was !== undefined && was !== digits[i]) flips[i] = was;
    }
    setState({ digits, flips });
  }
  const flips = state.digits === digits ? state.flips : {};
  const flipping = Object.keys(flips).length > 0;
  useEffect(() => {
    if (!flipping) return;
    sfx('odometer-flip');
    const t = setTimeout(() => setState((s) => ({ digits: s.digits, flips: {} })), ODO_FLIP_MS);
    return () => clearTimeout(t);
  }, [flipping, digits]);
  return (
    <span className="odo" aria-label={String(value)}>
      {Array.from(digits, (d, i) => (
        <span className="odo-col" key={digits.length - i}>
          {flips[i] !== undefined && (
            <span className="odo-out" aria-hidden>
              {flips[i]}
            </span>
          )}
          <span className={flips[i] !== undefined ? 'odo-in' : undefined}>{d}</span>
        </span>
      ))}
    </span>
  );
}

/** The split-flap's length (styles: --odo-flip). */
const ODO_FLIP_MS = 90;

/* --------------------------------------------------------------------------
   Icons (stroke, currentColor)
   -------------------------------------------------------------------------- */

const icon = (d: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {d}
  </svg>
);

export const Icons = {
  close: () => icon(<path d="M6 6l12 12M18 6L6 18" />),
  gear: () =>
    icon(
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </>,
    ),
  paste: () =>
    icon(
      <>
        <rect x="8" y="2" width="8" height="4" rx="1" />
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        <path d="M9 13h6M9 17h4" />
      </>,
    ),
  copy: () =>
    icon(
      <>
        <rect x="9" y="9" width="12" height="12" rx="2" />
        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
      </>,
    ),
  check: () => icon(<path d="M5 12l5 5L20 7" />),
  alert: () =>
    icon(
      <>
        <path d="M12 3l10 18H2z" />
        <path d="M12 10v5M12 18v.5" />
      </>,
    ),
  info: () =>
    icon(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7v.5" />
      </>,
    ),
  chevron: () => icon(<path d="M9 6l6 6-6 6" />),
  arrow: () => icon(<path d="M5 12h14M13 6l6 6-6 6" />),
  clock: () =>
    icon(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>,
    ),
  /** The share sheet's arrow out of a tray. */
  share: () =>
    icon(
      <>
        <path d="M12 3v12" />
        <path d="M8 7l4-4 4 4" />
        <path d="M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
      </>,
    ),
  download: () =>
    icon(
      <>
        <path d="M12 3v12" />
        <path d="M8 11l4 4 4-4" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </>,
    ),
  swords: () =>
    icon(
      <>
        <path d="M4 4l11 11" />
        <path d="M20 4L9 15" />
        <path d="M12.5 12.5L6 19M11.5 12.5L18 19" />
        <path d="M4.5 16.5l3 3M19.5 16.5l-3 3" />
        <path d="M5 21l2-2M19 21l-2-2" />
      </>,
    ),
};

/* --------------------------------------------------------------------------
   Controls
   -------------------------------------------------------------------------- */

export interface SegmentOption<T> {
  value: T;
  label: ReactNode;
  /** Small second line inside the cell (a count, a unit). */
  hint?: ReactNode;
}

/**
 * Equal-cell segmented control with a sliding thumb. A radiogroup: one tab
 * stop (the checked cell), arrows and Home/End move the selection.
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  tone,
  disabled,
}: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  tone?: 'mint' | 'warm';
  disabled?: boolean;
}) {
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = options.length;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next < 0) return;
    e.preventDefault();
    const o = options[next];
    if (!o) return;
    onChange(o.value);
    const cell = e.currentTarget.querySelectorAll<HTMLButtonElement>('.seg-item')[next];
    cell?.focus();
  };
  return (
    <div
      className={`seg${tone === 'warm' ? ' warm' : ''}`}
      role="radiogroup"
      aria-label={label}
      style={{ '--n': options.length, '--i': idx } as CSSProperties}
      onKeyDown={onKey}
    >
      <span className="seg-thumb" aria-hidden />
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === idx ? 0 : -1}
          className="seg-item"
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.hint !== undefined && o.hint !== null && <small>{o.hint}</small>}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden />
      <span className="switch-label">
        <span>{label}</span>
        {hint !== undefined && <small>{hint}</small>}
      </span>
    </label>
  );
}

/** The Settings row for haptics: vibration on the beats that earn it (audio/haptics.ts reads the setting). */
export function HapticsRow() {
  const haptics = useSettings((s) => s.haptics);
  const setHaptics = useSettings((s) => s.setHaptics);
  // A motor, not just the API: desktop Chrome defines navigator.vibrate and has nothing to shake.
  const supported =
    typeof navigator !== 'undefined' &&
    typeof navigator.vibrate === 'function' &&
    typeof matchMedia === 'function' &&
    matchMedia('(pointer: coarse)').matches;
  return (
    <div className={`haptics-row${supported ? '' : ' locked'}`}>
      <Switch
        checked={haptics && supported}
        onChange={(on) => supported && setHaptics(on)}
        label="Haptics"
        hint={
          supported
            ? haptics
              ? 'A tap on a placement, a clear and a rank-up.'
              : 'Off'
            : 'Not available on this device.'
        }
      />
    </div>
  );
}

/**
 * Copy text to the clipboard. `navigator.clipboard` exists only in a secure
 * context (HTTPS or localhost) — on a plain-HTTP LAN build it is undefined —
 * so fall back to the selection + execCommand path, which every mobile
 * browser still honours inside a user gesture.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    ta.style.fontSize = '16px'; // no iOS zoom
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Copy-to-clipboard button that confirms itself for a moment, or says it could not. */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string | undefined;
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), COPY_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      className={`btn${state === 'failed' ? ' danger' : ''}${className ? ` ${className}` : ''}`}
      onClick={() => {
        void copyText(text).then((ok) => setState(ok ? 'done' : 'failed'));
      }}
    >
      {state === 'done' ? (
        <>
          <Icons.check /> Copied
        </>
      ) : state === 'failed' ? (
        <>
          <Icons.alert /> Select it above
        </>
      ) : (
        <>
          <Icons.copy /> {label}
        </>
      )}
    </button>
  );
}

/** How long "Copied" shows before the button reads its label again. */
const COPY_CONFIRM_MS = 1600;

/* --------------------------------------------------------------------------
   Feedback
   -------------------------------------------------------------------------- */

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="error" role="alert">
      <Icons.alert />
      <span>{children}</span>
    </div>
  );
}

export function Note({ children, warm = false }: { children: ReactNode; warm?: boolean }) {
  return (
    <div className={`note${warm ? ' warm' : ''}`}>
      <Icons.info />
      <span>{children}</span>
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading-block" role="status" aria-live="polite">
      <div className="spinner" style={{ margin: 0 }} />
      <span>{label}</span>
    </div>
  );
}

export function SkeletonCards({ n = 3 }: { n?: number }) {
  return (
    <div className="stack tight" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="skeleton card" style={{ animationDelay: `${i * 80}ms` }} />
      ))}
    </div>
  );
}

/** Empty state: an empty board with one piece hovering, and a CTA row. */
export function Empty({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="empty">
      <EmptyBoardArt />
      <h3>{title}</h3>
      <p>{children}</p>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

/** An empty board with one mint piece hovering over it, in the mini-board dialect. */
function EmptyBoardArt() {
  return (
    <MiniBoard
      cols={6}
      rows={5}
      size={120}
      cells={[
        [3, 0, '#3de6c9'],
        [4, 0, '#3de6c9'],
        [4, 1, '#3de6c9'],
      ]}
      ghost={[
        [4, 3, ''],
        [5, 3, ''],
        [5, 4, ''],
      ]}
      glow="rgba(61,230,201,0.6)"
    />
  );
}

/* --------------------------------------------------------------------------
   Mini-board glyphs for the mode cards and steps
   -------------------------------------------------------------------------- */

export type Cell = readonly [x: number, y: number, color: string];

/**
 * A tiny board rendered from the palette: recessed sockets and jewel tiles
 * with a top-face highlight and a darker side band, the tile bake in SVG.
 */
export function MiniBoard({
  cols = 5,
  rows = 5,
  cells,
  hot = [],
  ghost = [],
  size = 72,
  glow,
}: {
  cols?: number;
  rows?: number;
  cells: readonly Cell[];
  /** Cells drawn as a highlighted clear line (white-hot). */
  hot?: readonly Cell[];
  /** Cells outlined as a drop preview (dashed mint). */
  ghost?: readonly Cell[];
  size?: number;
  /** Drop-shadow glow colour for the placed tiles. */
  glow?: string;
}) {
  const unit = 100 / Math.max(cols, rows);
  const gap = unit * 0.12;
  const tile = unit - gap;
  const r = tile * 0.18;
  const sockets: ReactNode[] = [];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++)
      sockets.push(
        <rect
          key={`s${x}-${y}`}
          x={x * unit + gap / 2}
          y={y * unit + gap / 2}
          width={tile}
          height={tile}
          rx={r}
          fill="#14172c"
          stroke="#1f2440"
          strokeWidth={0.8}
        />,
      );
  const tiles = cells.map(([x, y, c], i) => (
    <g key={`t${i}`} transform={`translate(${x * unit + gap / 2} ${y * unit + gap / 2})`}>
      <rect width={tile} height={tile} rx={r} fill={c} />
      <rect width={tile} height={tile * 0.5} rx={r} fill="#fff" opacity={0.22} />
      <rect
        y={tile * 0.82}
        width={tile}
        height={tile * 0.18}
        rx={r * 0.6}
        fill="#000"
        opacity={0.28}
      />
      <rect
        x={0.6}
        y={0.6}
        width={tile - 1.2}
        height={tile - 1.2}
        rx={r}
        fill="none"
        stroke="#000"
        strokeOpacity={0.35}
        strokeWidth={0.8}
      />
    </g>
  ));
  const hots = hot.map(([x, y], i) => (
    <rect
      key={`h${i}`}
      x={x * unit + gap / 2}
      y={y * unit + gap / 2}
      width={tile}
      height={tile}
      rx={r}
      fill="#ffe8c8"
      opacity={0.9}
    />
  ));
  const ghosts = ghost.map(([x, y], i) => (
    <rect
      key={`g${i}`}
      x={x * unit + gap / 2 + 1}
      y={y * unit + gap / 2 + 1}
      width={tile - 2}
      height={tile - 2}
      rx={r}
      fill="rgba(61,230,201,0.12)"
      stroke="#3de6c9"
      strokeWidth={1.2}
      strokeDasharray="3 2.5"
      opacity={0.8}
    />
  ));
  const vw = cols * unit;
  const vh = rows * unit;
  return (
    <svg viewBox={`0 0 ${vw} ${vh}`} width={size} height={Math.round((size * vh) / vw)} aria-hidden>
      {sockets}
      <g style={glow ? { filter: `drop-shadow(0 0 6px ${glow})` } : undefined}>{tiles}</g>
      {hots}
      {ghosts}
    </svg>
  );
}

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

/** "just now", "4 min ago", "2 h ago", "3 d ago", else a short date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Player-facing copy for API error codes; never a machine string. */
const ERROR_COPY: Record<string, string> = {
  'bad-credentials': "That username and password don't match.",
  'username-taken': 'That username is taken — try another.',
  'bad-request': 'Check the fields and try again.',
  unauthorized: 'Please sign in again.',
  forbidden: "You can't do that from this account.",
  'insufficient-balance': 'Not enough $CHAIN for this entry fee.',
  'no-open-challenge': 'Nobody is waiting at this fee. Create a challenge instead?',
  'own-challenge': "You can't take your own challenge.",
  'challenge-not-open': 'That challenge has already been taken.',
  'challenge-expired': 'That challenge has expired.',
  'challenge-pending': 'The challenger is still playing. Try again in a few minutes.',
  'challenge-not-found': 'No challenge with that code.',
  'bad-fee': 'That entry fee is not available.',
};

const CODE_LIKE = /^[a-z0-9]+(-[a-z0-9]+)+$/;

export function errorCopy(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (err instanceof ApiError) {
    const mapped = ERROR_COPY[err.code];
    if (mapped) return mapped;
    // A server-written sentence passes; a bare code never does.
    if (err.message && !CODE_LIKE.test(err.message) && err.message !== err.code) return err.message;
    return fallback;
  }
  return fallback;
}

export function feeLabel(fee: number): string {
  return `${fee} $CHAIN`;
}
