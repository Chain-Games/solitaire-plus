import { rankFor, xpLevelFor, xpThreshold, type Rank } from '@solitaire-plus/sim';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { XpGained } from '../api/client.js';
import { Icons, Odometer, RankBadge, XpBar, XpChip, rankClass } from '../shell/ui.js';
import { rankLabel } from '../shell/xp-view.js';

/**
 * The results tray's XP beat (docs/art-direction.md "XP"), above the buttons
 * once the in-engine ceremony has played its breakdown:
 *
 *   0.00 s  "+612 XP" punches in (15%, like a score float); the parts
 *           itemise on hover / tap
 *   0.35 s  the bar counts xpBefore → xpAfter over 1.2 s (cubic out), the
 *           number counting with it
 *   a LEVEL crossed: the bar fills, snaps to the new level's span, the chip's
 *           odometer flips, one cool pulse fills the track; the chime once
 *   a RANK crossed: the RANK-UP ceremony, in order — at the crossing the
 *           bar holds FULL on the old span and the rank row hides (the text
 *           never spoils the reveal); the old badge lifts and dissolves into
 *           a dozen cored shards while a hard warm core lights inside the
 *           bloom; at the REVEAL (+300 ms, a stage of the count's own ticker: the new
 *           badge and the banner MOUNT then, nothing in CSS waits for it) the new badge scales in with an
 *           overshoot, the bar snaps to the new span, the chip flips, the
 *           engine's halo fires (`fx.rankUp`) and the chime plays twice;
 *           "RANK UP · MASON" slams in letter by letter (18 ms apart) and
 *           once it has retired (+1100 ms) the rank row returns, reading
 *           the new rank. The tray reserves the ceremony's height from the
 *           start so nothing but the badge moves.
 *
 * Reduced motion: the final state, no count, the ceremony as a still.
 */

export interface ResultsFx {
  /** A rank crossed: the engine's rim pulse + sheen in the rank's colour, the chime twice. */
  rankUp(rankIndex: number): void;
  /** An XP level crossed (no rank): the chime once. */
  levelUp(): void;
}

/** The count starts this long after the tray shows (its rise-in is 420 ms). */
const START_DELAY_MS = 350;
/** The count's length (styles: --xp-count). */
const COUNT_MS = 1200;
/** Shard count cap (styles: --rank-shards). */
const SHARDS = 12;
/** The reveal (new badge, span snap, chip flip, engine halo) lands this long after the crossing (styles: --rank-reveal-at). */
const REVEAL_MS = 300;
/** The banner has retired (held, then faded out — styles: --rank-banner-hold + --rank-banner-out) this long after the crossing; the rank row returns. */
const BANNER_RETIRE_MS = 1200;

/** The ceremony's stages, by time since the crossing. */
export type Stage = 0 | 1 | 2 | 3; // none | shatter | revealed | banner retired

const PART_LABELS: readonly [keyof XpGained['parts'], string][] = [
  ['played', 'played'],
  ['score', 'score'],
  ['lines', 'lines'],
  ['levels', 'levels'],
  ['streak', 'streak'],
  ['challenge', 'challenge'],
  ['win', 'win'],
];

function easeOutCubic(u: number): number {
  const v = 1 - u;
  return 1 - v * v * v;
}

/** Tooling hook (`?debug`): the capture harness seeks the beat to an exact time. */
interface XpDebug {
  /** Freeze the beat at `ms` since the tray showed: the count, the crossings and the ceremony's CSS. Resolves once pinned. */
  seek(ms: number): Promise<void>;
  /** When the count crosses into the new rank (ms since the tray showed); Infinity without one. */
  readonly crossMs: number;
  /** True once the count has landed on xpAfter (live or seeked past the end). */
  readonly settled: boolean;
}

function debugOn(): boolean {
  try {
    return new URLSearchParams(location.search).has('debug');
  } catch {
    return false;
  }
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface Shown {
  xp: number;
  level: number;
  rank: Rank;
  prev: number;
  next: number;
}

function shownFor(xp: number, level = xpLevelFor(xp)): Shown {
  return {
    xp,
    level,
    rank: rankFor(level),
    prev: xpThreshold(level),
    next: xpThreshold(level + 1),
  };
}

export function XpBeat({
  gained: input,
  fx,
  active = true,
}: {
  gained: XpGained;
  fx?: ResultsFx | undefined;
  /** False while the tray is only being measured (hidden) and until the scene's own beats are done: the count waits for true. */
  active?: boolean | undefined;
}) {
  // The beat plays once per mount: the award is snapshotted so a re-render of
  // the tray (it re-measures as the ceremony grows it) never restarts the count.
  const [gained] = useState(input);
  const [shown, setShown] = useState<Shown>(() =>
    reducedMotion()
      ? shownFor(gained.xpAfter, gained.levelAfter)
      : shownFor(gained.xpBefore, gained.levelBefore),
  );
  const [pulse, setPulse] = useState(0);
  const rankCrossed = gained.rankAfter.index !== gained.rankBefore.index;
  const [stage, setStage] = useState<Stage>(() => (reducedMotion() && rankCrossed ? 3 : 0));
  // The parts open on a tap/click only. A hover used to open them, but Chrome fires
  // mouseenter when the tray ANIMATES IN under a parked cursor — so on a short desktop
  // window the breakdown appeared "by itself" over the bar and never left.
  const [open, setOpen] = useState(false);
  const fxRef = useRef(fx);
  fxRef.current = fx;

  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (reducedMotion() || !active) return;
    let raf = 0;
    let level = gained.levelBefore;
    let start = 0;
    let frozen: number | null = null;
    let settled = false;
    let stageNow: Stage = 0;
    // The first level of the new rank: the crossing is its threshold.
    let crossLevel = gained.levelAfter;
    while (
      crossLevel > gained.levelBefore + 1 &&
      rankFor(crossLevel - 1).index === gained.rankAfter.index
    )
      crossLevel--;
    // The time (ms since the tray showed) at which the count reaches an XP total.
    const timeOf = (xp: number): number => {
      const ue = (xp - gained.xpBefore) / Math.max(1, gained.xpAfter - gained.xpBefore);
      const u = 1 - Math.cbrt(Math.max(0, 1 - ue));
      return START_DELAY_MS + u * COUNT_MS;
    };
    const rankCrossMs = rankCrossed ? timeOf(xpThreshold(crossLevel)) : Infinity;
    // Apply the beat at `e` ms since the tray showed.
    const applyAt = (e: number) => {
      const u = Math.max(0, Math.min(1, (e - START_DELAY_MS) / COUNT_MS));
      const xp = gained.xpBefore + (gained.xpAfter - gained.xpBefore) * easeOutCubic(u);
      let lv = Math.min(gained.levelAfter, xpLevelFor(xp));
      let shownXp = u >= 1 ? gained.xpAfter : xp;
      // The ceremony's stages from the crossing; until the reveal the bar
      // holds full on the old span and no text says the new rank.
      const since = e - rankCrossMs;
      const next: Stage =
        !rankCrossed || since < 0 ? 0 : since < REVEAL_MS ? 1 : since < BANNER_RETIRE_MS ? 2 : 3;
      if (next >= 1 && next < 2) {
        lv = Math.min(lv, crossLevel - 1);
        shownXp = Math.min(shownXp, xpThreshold(crossLevel));
      }
      if (next !== stageNow) {
        if (next >= 2 && stageNow < 2) fxRef.current?.rankUp(gained.rankAfter.index);
        stageNow = next;
        setStage(next);
      }
      if (lv > level) {
        // A level crossed: the bar snaps to the new span, the chip flips, the pulse.
        level = lv;
        setPulse((p) => p + 1);
        if (rankFor(lv).index === gained.rankBefore.index || !rankCrossed) fxRef.current?.levelUp();
      }
      setShown(shownFor(shownXp, level));
      settled = u >= 1;
      return u;
    };
    const tick = (now: number) => {
      if (frozen !== null) return;
      if (!start) start = now - START_DELAY_MS;
      const u = applyAt(now - start);
      // Keep ticking past the end of the count while a ceremony is still
      // staging: a rank crossed in the count's last 300 ms would otherwise
      // freeze on the hold (bar full on the old span, row hidden, no reveal).
      if (u < 1 || (rankCrossed && stageNow < 3)) raf = requestAnimationFrame(tick);
    };
    const t = setTimeout(() => {
      raf = requestAnimationFrame(tick);
    }, START_DELAY_MS);
    if (debugOn()) {
      const hook: XpDebug = {
        crossMs: rankCrossMs,
        get settled() {
          return settled;
        },
        seek: async (ms) => {
          frozen = ms;
          clearTimeout(t);
          cancelAnimationFrame(raf);
          level = gained.levelBefore;
          stageNow = 0;
          applyAt(ms);
          // After React commits (a macrotask later) the ceremony's elements
          // exist: pin every animation — the ceremony's run from the
          // crossing, everything else from the tray.
          await new Promise((r) => setTimeout(r, 0));
          await new Promise((r) => requestAnimationFrame(r));
          const root = rootRef.current;
          if (!root) return;
          for (const a of root.getAnimations({ subtree: true })) {
            const el = (a as { effect?: { target?: Element | null } }).effect?.target;
            const inCeremony = Boolean(el?.closest('.rank-up, .xp-pulse, .odo-col'));
            // The reveal's elements (the new badge, the banner) mount at the reveal.
            const fromReveal = Boolean(el?.closest('.rank-up-new, .rank-up-banner'));
            a.pause();
            a.currentTime = Math.max(
              0,
              inCeremony ? ms - rankCrossMs - (fromReveal ? REVEAL_MS : 0) : ms,
            );
          }
        },
      };
      (window as unknown as { __blockariXp?: XpDebug }).__blockariXp = hook;
    }
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(raf);
      if (debugOn()) delete (window as unknown as { __blockariXp?: XpDebug }).__blockariXp;
    };
  }, [gained, active]);

  const parts = PART_LABELS.filter(([k]) => gained.parts[k] > 0);
  const cls = [
    'xp-beat',
    rankClass(shown.rank),
    stage >= 1 ? 'rankup' : '',
    stage >= 1 && stage < 3 ? 'row-hidden' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div ref={rootRef} className={cls}>
      {/* The ceremony's slot is reserved from the start (its height never moves the panel). */}
      {rankCrossed && <RankUp from={gained.rankBefore} to={gained.rankAfter} stage={stage} />}
      <div className="xp-beat-head">
        <div className="who" aria-hidden={stage >= 1 && stage < 3}>
          {!rankCrossed && <RankBadge rank={shown.rank} size={24} />}
          <span className="rank-name">{rankLabel(shown.rank)}</span>
          <XpChip level={shown.level} rank={shown.rank} size="sm">
            <b>
              <Odometer value={shown.level} />
            </b>
          </XpChip>
        </div>
        <button
          type="button"
          className="xp-delta"
          aria-expanded={open}
          aria-label={`${gained.total} XP gained; show the breakdown`}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="num">
            +{gained.total.toLocaleString()}
            <small>XP</small>
          </span>
          <span className="caret">
            <Icons.chevron />
          </span>
        </button>
      </div>
      <div className={`xp-parts${open ? ' open' : ''}`} role="list" aria-hidden={!open}>
        {parts.map(([k, label]) => (
          <span key={k} role="listitem">
            {label}
            <b>+{gained.parts[k]}</b>
          </span>
        ))}
      </div>
      <XpBar
        xp={shown.xp}
        prev={shown.prev}
        next={shown.next}
        level={shown.level}
        rank={shown.rank}
        pulse={pulse}
      />
    </div>
  );
}

/**
 * Shard throw: a dozen, four per lobe in three lobes, spread inside each lobe
 * with a little jitter (never even spokes), staggered over the first 60 ms
 * so all twelve are out together; each a tapered stroke with a white core.
 */
const SHARD_LOBES = [-72, 28, 158] as const;
function shardStyle(i: number, n: number): CSSProperties {
  // Deterministic jitter: the same throw every time, no two shards alike.
  const j = ((i * 7919) % 97) / 97;
  const k = ((i * 104729) % 89) / 89;
  const perLobe = Math.ceil(n / SHARD_LOBES.length);
  const lobe = SHARD_LOBES[i % SHARD_LOBES.length] ?? 0;
  const slot = Math.floor(i / SHARD_LOBES.length) - (perLobe - 1) / 2;
  const angle = lobe + slot * 20 + (j - 0.5) * 10;
  const dist = 44 + k * 32;
  const len = 6 + Math.round(j * 8); // 6–14 px
  return {
    '--a': `${angle.toFixed(1)}deg`,
    '--d': `${dist.toFixed(0)}px`,
    '--l': `${len}px`,
    '--t0': `${Math.round(k * 60)}ms`,
  } as CSSProperties;
}

/**
 * The ceremony slot, reserved from the first frame with the outgoing badge
 * already in place: the shatter from stage 1 (it lifts and dissolves, the
 * core lights, the shards leave), the reveal from stage 2 (shards culled).
 * `size` is the badge's (72 in the tray; the profile hero replays it at 56).
 */
export function RankUp({
  from,
  to,
  stage,
  size = 72,
  banner = true,
}: {
  from: Rank;
  to: Rank;
  stage: Stage;
  size?: number;
  /** False: the caller places the banner itself (RankUpBanner) — the profile puts it over the rank line. */
  banner?: boolean;
}) {
  const cls = `rank-up ${rankClass(to)}${stage >= 1 ? ' shatter' : ''}${stage >= 2 ? ' revealed' : ''}`;
  return (
    <div
      className={cls}
      style={{ '--stage': `${size + 12}px` } as CSSProperties}
      role="status"
      aria-live="polite"
    >
      <div className="rank-up-stage" aria-hidden>
        {stage >= 1 && (
          <>
            <i className="rank-up-light" />
            <i className="rank-up-core" />
          </>
        )}
        <span className={`rank-up-old ${rankClass(from)}`}>
          <RankBadge rank={from} size={size} />
        </span>
        {stage >= 1 &&
          Array.from({ length: SHARDS }, (_, s) => (
            <i key={s} className={`rank-shard ${rankClass(from)}`} style={shardStyle(s, SHARDS)} />
          ))}
        {/* The reveal's elements mount AT the reveal (stage 2): their animations run from that
            commit, never from a CSS delay counted from the crossing. */}
        {stage >= 2 && (
          <span className="rank-up-new">
            <RankBadge rank={to} size={size} />
          </span>
        )}
      </div>
      {banner && stage >= 2 && <RankUpBanner to={to} />}
    </div>
  );
}

/** "RANK UP · MASON" in the banner's letter-slam (its delays run from the crossing, styles). */
export function RankUpBanner({ to }: { to: Rank }) {
  const text = `RANK UP · ${to.name.toUpperCase()}`;
  let i = 0;
  return (
    <div className="rank-up-banner" aria-label={text}>
      {Array.from(text, (ch, k) =>
        ch === ' ' ? (
          <span key={k} className="ltr gap" aria-hidden />
        ) : (
          <span key={k} className="ltr" style={{ '--i': i++ } as CSSProperties} aria-hidden>
            {ch}
          </span>
        ),
      )}
    </div>
  );
}
