import { rankFor, type Rank } from '@solitaire-plus/sim';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, type ChallengeView, type UserProfile } from '../api/client.js';
import { useRankUp, type Crossing } from '../state/rankup.js';
import { useSession } from '../state/session.js';
import { sfx } from '../shell/sfx.js';
import {
  Coin,
  Empty,
  Loading,
  Note,
  Odometer,
  RankBadge,
  RankName,
  SkeletonCards,
  XpBar,
  XpChip,
  errorCopy,
  rankClass,
} from '../shell/ui.js';
import { demoProfile, progressBefore, rankAtIndex, xpDemo } from '../shell/xp-view.js';
import { MatchCard } from './History.js';
import { RankUp, RankUpBanner, type Stage } from './ResultsXp.js';

/**
 * `/profile/:username` (public) and `/profile` (mine): the hero card — the
 * rank badge at 72 px, the name, rank + tier, the XP bar to the next level —
 * a stats grid, and (mine only: the API has no public challenge list) the
 * recent challenges in History's cards. Two columns on a desktop, stacked
 * on a phone.
 *
 * A rank crossed since the profile was last seen (state/rankup.ts): the hero
 * replays the full ceremony once, IN the badge's own slot — the stage is an
 * overlay on the 72 px slot, the banner an overlay on the rank line — so the
 * card never re-lays out (the AD's reserved-slot rule): the old badge
 * shatters where it lives, "RANK UP · MASON" slams in where the rank line
 * was, then the slot's badge takes over and the row returns. The hero reads
 * the state before the crossing until the reveal. Never again for that rank.
 */
export function Profile() {
  const { username: param } = useParams();
  const user = useSession((s) => s.user);
  const loading = useSession((s) => s.loading);
  const username = param ?? user?.username;
  const mine = username !== undefined && username === user?.username;
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [error, setError] = useState<{ notFound: boolean; text: string } | null>(null);
  const [recent, setRecent] = useState<ChallengeView[] | null>(null);
  // The ceremony owed to this profile (mine, and the crossing lands on the rank shown).
  const ceremony = useRankUp((s) => s.ceremony);
  const ceremonyDone = useRankUp((s) => s.ceremonyDone);
  // before: the state before the crossing · hidden: the row is out (from the shatter) · revealed:
  // the bar and the wash say the new rank, the row still out · settled: the row is back, new.
  const [hero, setHero] = useState<'before' | 'hidden' | 'revealed' | 'settled'>('before');
  const played = useRef(false);

  useEffect(() => {
    if (!username) return;
    let alive = true;
    setProfile(null);
    setError(null);
    if (xpDemo()) {
      setProfile(demoProfile(username));
      return;
    }
    api.profile(username).then(
      (r) => alive && setProfile(r.profile),
      (err: unknown) =>
        alive &&
        setError({
          notFound: err instanceof ApiError && err.status === 404,
          text: errorCopy(err, 'Could not load this profile. Try again.'),
        }),
    );
    return () => {
      alive = false;
    };
  }, [username]);

  useEffect(() => {
    if (!mine) {
      setRecent(null);
      return;
    }
    let alive = true;
    api.myChallenges().then(
      (r) => alive && setRecent(r.challenges.slice(0, 6)),
      () => alive && setRecent([]),
    );
    return () => {
      alive = false;
    };
  }, [mine]);

  // The session decides which profile "/profile" is: wait for it.
  if (!username)
    return (
      <div className="column">{loading ? <Loading label="Checking session" /> : <Navigate />}</div>
    );

  if (error)
    return (
      <div className="column">
        <div className="panel">
          <Empty
            title={error.notFound ? 'No such player' : 'Profile unavailable'}
            actions={
              <Link to="/" className="btn">
                Home
              </Link>
            }
          >
            {error.notFound ? `Nobody here is called ${username}.` : error.text}
          </Empty>
        </div>
      </div>
    );

  if (!profile)
    return (
      <div className="profile" aria-busy>
        <div className="profile-hero" aria-hidden>
          <div className="stack tight">
            <div className="skeleton line short" />
            <div className="skeleton line" />
            <div className="skeleton card" />
          </div>
        </div>
        {mine && <SkeletonCards n={3} />}
      </div>
    );

  const p = profile;
  const winRate =
    p.challengesPlayed > 0 ? Math.round((p.challengesWon / p.challengesPlayed) * 100) : null;
  const since = new Date(p.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
  });
  const nextRank = rankFor(p.xpLevel + 1);
  const rankUpNext = nextRank.index !== p.rank.index;
  const playing = mine && ceremony !== null && ceremony.to === p.rank.index;
  // Latched (the ref lives with the other hooks, above the early returns): once the ceremony
  // has played on this mount the bar stays keyed to it — ceremonyDone retiring the crossing must
  // not remount it into a page-mount reveal.
  if (playing) played.current = true;
  const ceremonied = played.current;
  // Until the reveal the hero says the state BEFORE the crossing — the rank it is leaving, its
  // last level with the bar held full on that span — so the text never spoils it.
  const before = playing && (hero === 'before' || hero === 'hidden');
  const shownRank: Rank = before ? rankAtIndex(ceremony.from) : p.rank;
  const shown = before
    ? progressBefore(ceremony.to)
    : { level: p.xpLevel, xp: p.xp, prev: p.prevThreshold, next: p.nextThreshold };
  // The rank row (badge, name, chip) is out from the crossing until the settle — the tray's rule:
  // only the stage says a rank — and returns reading the new one, all of it together.
  const rowHidden = playing && (hero === 'hidden' || hero === 'revealed');
  // The slot's badge is out for the whole ceremony (the stage holds the badge, as in the tray);
  // it comes back at the settle, flipping in from the stage.
  const badgeOut = playing && hero !== 'settled';

  return (
    <div className={`profile${mine ? '' : ' solo'}`}>
      <section
        className={`profile-hero ${rankClass(shownRank)}${rowHidden ? ' row-hidden' : ''}${badgeOut ? ' badge-out' : ''}`}
        aria-label={`${p.username}'s profile`}
      >
        <div className="profile-id">
          {/* Its own miniature only when no full ceremony plays (or played) here. The ceremony's
              stage sits IN this slot (an overlay: the layout never moves). */}
          <span className={`hero-badge${hero === 'settled' && playing ? ' settle-in' : ''}`}>
            <RankBadge rank={shownRank} size={72} mine={!playing && hero === 'before'} />
            {playing && (
              <HeroRankUp
                crossing={ceremony}
                to={p.rank}
                onHold={() => setHero('before')}
                onShatter={() => setHero('hidden')}
                onRevealed={() => setHero('revealed')}
                onSettled={() => setHero('settled')}
                onDone={ceremonyDone}
              />
            )}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="t-label">{mine ? 'Your profile' : 'Player'}</div>
            <h2>{p.username}</h2>
            <div className="profile-rank">
              <RankName
                rank={shownRank}
                mine={!playing && hero === 'before'}
                className="rank-name"
              />
              <XpChip level={shown.level} rank={shownRank}>
                <b>
                  <Odometer value={shown.level} />
                </b>
              </XpChip>
              {/* The banner over the rank line's own box (the name and chip are out meanwhile). */}
              {/* Mounts at the reveal (the timeline's state): its letters run from that commit. */}
              {playing && hero === 'revealed' && (
                <div className={`hero-banner ${rankClass(p.rank)}`}>
                  <RankUpBanner to={p.rank} />
                </div>
              )}
            </div>
          </div>
        </div>
        {/* With a ceremony: the bar before the crossing is static, full on the old span; the new
            span's bar mounts at the reveal and grows in from that commit. */}
        <XpBar
          key={ceremonied ? (before ? 'hold' : 'new') : 'plain'}
          xp={shown.xp}
          prev={shown.prev}
          next={shown.next}
          level={shown.level}
          rank={shownRank}
          size="lg"
          reveal={!ceremonied}
          revealNow={ceremonied && !before}
        />
        {rankUpNext && (
          <p className="t-caption" style={{ marginTop: 8 }}>
            The next level is a new rank: <b style={{ color: 'var(--text)' }}>{nextRank.name}</b>.
          </p>
        )}
        <div className="stats">
          <Stat label="Games played" value={p.gamesPlayed} />
          <Stat
            label="Challenges"
            value={p.challengesWon}
            unit={`/ ${p.challengesPlayed}${winRate !== null ? ` · ${winRate}%` : ''}`}
          />
          <Stat label="Best score" value={p.bestScore} hi />
          <Stat label="Best match level" value={p.bestLevel > 0 ? `LV ${p.bestLevel}` : '—'} />
          <Stat label="Member since" value={since} />
        </div>
        <ChainLedger p={p} />
        {p.isGuest && mine && (
          <div className="profile-note">
            <Note warm>
              Guest progress is kept for this session only.{' '}
              <Link to="/auth" style={{ color: 'inherit' }}>
                Create an account
              </Link>{' '}
              to keep your rank.
            </Note>
          </div>
        )}
        {!mine && (
          <div className="profile-cta">
            <div>
              <b>
                Play <span className="name-case">{p.username}</span>
              </b>
              <span>Create a challenge and send them the code, or take one from the queue.</span>
            </div>
            <div className="row">
              <Link to="/create" className="btn warm">
                Challenge <span className="name-case">{p.username}</span>
              </Link>
              <Link to="/take" className="btn">
                Take a challenge
              </Link>
            </div>
          </div>
        )}
      </section>
      {mine && (
        <section className="panel profile-side">
          <div className="panel-head">
            <h3>Recent challenges</h3>
            <Link to="/history" className="btn ghost sm">
              All
            </Link>
          </div>
          {recent === null ? (
            <SkeletonCards n={3} />
          ) : recent.length === 0 ? (
            <Empty
              title="No challenges yet"
              actions={
                <>
                  <Link to="/create" className="btn warm">
                    Create one
                  </Link>
                  <Link to="/take" className="btn">
                    Take one
                  </Link>
                </>
              }
            >
              Every challenge game pays XP; a win pays more.
            </Empty>
          ) : (
            <div className="timeline">
              {recent.map((c, k) => (
                <MatchCard key={c.id} c={c} k={k} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** Tooling hook (`?debug`): the capture harness pins the hero's ceremony at a time since the crossing. */
interface HeroDebug {
  seek(ms: number): Promise<void>;
}

/** The ceremony waits for the card's rise-in, then runs on the tray's clock (styles: --rank-*). */
const HERO_HOLD_MS = 500;
const HERO_REVEAL_MS = 300;
/** The hero's text flips this long after the badge has begun its reveal: the badge first, then the word. */
const HERO_TEXT_AFTER_MS = 60;
const HERO_BANNER_RETIRE_MS = 1200;
/** The stage hands its badge to the hero this long after the crossing, once the banner has retired. */
const HERO_SETTLE_MS = 1400;
/** The stage overlay fades once the slot's badge has taken over (styles: --hero-out). */
const HERO_OUT_MS = 240;

/**
 * The profile's replay of the rank-up: the results tray's stage as an overlay
 * on the hero's badge slot (nothing below the hero moves), with the old badge
 * already on it. Shatter → reveal (+300, the chime twice) → banner retired
 * (+1200) → the slot's badge takes over (+1400) and the overlay fades.
 * Reduced motion: the end state at once.
 */
function HeroRankUp({
  crossing,
  to,
  onHold,
  onShatter,
  onRevealed,
  onSettled,
  onDone,
}: {
  crossing: Crossing;
  to: Rank;
  /** The hero should read the old rank again (the harness seeking back before the reveal). */
  onHold: () => void;
  /** The old badge has begun to shatter: the hero's rank row goes out. */
  onShatter: () => void;
  onRevealed: () => void;
  /** The stage hands over: the slot's badge returns (the pop), the row with it. */
  onSettled: () => void;
  onDone: () => void;
}) {
  const [stage, setStage] = useState<Stage>(0);
  const [settled, setSettled] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onRevealed();
      onSettled();
      onDone();
      return;
    }
    const at = (ms: number, f: () => void) => setTimeout(f, HERO_HOLD_MS + ms);
    const ts = [
      at(0, () => {
        setStage(1);
        onShatter();
      }),
      at(HERO_REVEAL_MS, () => {
        setStage(2);
        sfx('rank-up');
      }),
      at(HERO_REVEAL_MS + HERO_TEXT_AFTER_MS, onRevealed),
      at(HERO_BANNER_RETIRE_MS, () => setStage(3)),
      at(HERO_SETTLE_MS, () => {
        setSettled(true);
        onSettled();
      }),
      at(HERO_SETTLE_MS + HERO_OUT_MS, onDone),
    ];
    const debug = new URLSearchParams(location.search).has('debug');
    if (debug) {
      // Tooling hook (capture harness): pin the ceremony at `ms` since the crossing.
      const hook: HeroDebug = {
        seek: async (ms) => {
          ts.forEach(clearTimeout);
          setStage(ms < 0 ? 0 : ms < HERO_REVEAL_MS ? 1 : ms < HERO_BANNER_RETIRE_MS ? 2 : 3);
          if (ms >= HERO_REVEAL_MS + HERO_TEXT_AFTER_MS) onRevealed();
          else if (ms >= 0) onShatter();
          else onHold();
          const done = ms >= HERO_SETTLE_MS;
          setSettled(done);
          if (done) onSettled();
          await new Promise((r) => setTimeout(r, 0));
          await new Promise((r) => requestAnimationFrame(r));
          const scope = root.current?.closest('.profile') ?? document;
          for (const a of scope.getAnimations({ subtree: true })) {
            // The row's fades are transitions on state: a seek lands them.
            if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) {
              a.finish();
              continue;
            }
            const el = (a as { effect?: { target?: Element | null } }).effect?.target;
            const ours = Boolean(el?.closest('.profile-id'));
            a.pause();
            // The reveal's elements mount at the reveal: the stage's new badge at +300, the
            // banner with the text, +60 after it.
            const mountAt = el?.closest('.hero-banner')
              ? HERO_REVEAL_MS + HERO_TEXT_AFTER_MS
              : el?.closest('.rank-up-new')
                ? HERO_REVEAL_MS
                : 0;
            a.currentTime = ours ? Math.max(0, done ? ms - HERO_SETTLE_MS : ms - mountAt) : 10_000;
          }
        },
      };
      (window as unknown as { __blockariHero?: HeroDebug }).__blockariHero = hook;
    }
    return () => {
      ts.forEach(clearTimeout);
      if (debug) delete (window as unknown as { __blockariHero?: HeroDebug }).__blockariHero;
    };
    // Once per mount: the parent's setters are stable for the ceremony's life.
  }, []);
  return (
    <div ref={root} className={`hero-stage${settled ? ' settled' : ''}`}>
      <RankUp from={rankAtIndex(crossing.from)} to={to} stage={stage} size={72} banner={false} />
    </div>
  );
}

/**
 * The $CHAIN ledger: PnL as the headline ("+400 $CHAIN · +66.7%", mint when
 * ≥ 0, rose when the losses outweigh it): the headline is what was WON
 * (the owner's reading — "6 games at 100, won 5 = +500") with won ÷ staked
 * as the percent; then a thin split bar of won vs lost, and the three
 * columns WON / LOST / STAKED. Nothing staked yet: "No stakes yet", no bar.
 */
function ChainLedger({ p }: { p: UserProfile }) {
  const staked = p.chainPnlPct !== null;
  // Mint unless the losses outweigh what was won; zero is plain "0", never signed.
  const up = p.chainWon >= p.chainLost;
  const total = p.chainWon + p.chainLost;
  const wonShare = total > 0 ? p.chainWon / total : 0.5;
  const signed = (n: number) =>
    n === 0 ? '0' : `${n < 0 ? '−' : '+'}${Math.abs(n).toLocaleString()}`;
  return (
    <section
      className={`ledger${staked ? (up ? ' up' : ' down') : ' empty'}`}
      aria-label="$CHAIN won and lost"
    >
      <div className="ledger-head">
        <Coin />
        {staked ? (
          <b className="pnl">
            {signed(p.chainWon)} $CHAIN
            <span className="sep">·</span>
            {(p.chainPnlPct ?? 0).toLocaleString()}%
          </b>
        ) : (
          <b className="pnl none">No stakes yet</b>
        )}
      </div>
      {staked && (
        <div
          className="ledger-bar"
          style={{ '--won': wonShare } as CSSProperties}
          role="img"
          aria-label={`${p.chainWon} won, ${p.chainLost} lost`}
        >
          {p.chainWon > 0 && <i className="won" />}
          {p.chainLost > 0 && <i className="lost" />}
        </div>
      )}
      <div className="ledger-cols">
        <div className={`col won${p.chainWon === 0 ? ' zero' : ''}`}>
          <span className="t-label">Won</span>
          <b>{signed(p.chainWon)}</b>
        </div>
        <div className={`col lost${p.chainLost === 0 ? ' zero' : ''}`}>
          <span className="t-label">Lost</span>
          <b>{signed(-p.chainLost)}</b>
        </div>
        <div className="col">
          <span className="t-label">Staked</span>
          <b>{p.chainStaked.toLocaleString()}</b>
        </div>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  unit,
  hi = false,
}: {
  label: string;
  value: number | string;
  unit?: string | undefined;
  hi?: boolean;
}) {
  return (
    <div className={`stat${hi ? ' hi' : ''}`}>
      <span className="t-label">{label}</span>
      <b>
        {typeof value === 'number' ? value.toLocaleString() : value}
        {unit && <small>{unit}</small>}
      </b>
    </div>
  );
}

/** "/profile" with no session: RequireUser already redirects; this is the belt to its braces. */
function Navigate() {
  return (
    <div className="panel">
      <Empty
        title="Sign in to see your profile"
        actions={
          <Link to="/auth" className="btn primary">
            Sign in
          </Link>
        }
      >
        Your rank and XP live on your account.
      </Empty>
    </div>
  );
}
