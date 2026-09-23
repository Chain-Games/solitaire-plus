import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { api, type ChallengeView, type XpProgress } from '../api/client.js';
import { useRankUp } from '../state/rankup.js';
import { useSession } from '../state/session.js';
import { useSoloLaunch } from '../shell/handoff.js';
import {
  Avatar,
  Icons,
  Logo,
  MiniCards,
  Odometer,
  RankBadge,
  RankName,
  XpBar,
  XpChip,
  feeLabel,
  rankClass,
  timeAgo,
  useCrossingHold,
  type MiniCard,
} from '../shell/ui.js';
import { progressBefore } from '../shell/xp-view.js';
import { openTutorial } from '../tutorial/guide.js';
import { statusLabel } from './ChallengeDetail.js';

/** Practice: a fanned hand, the ace of spades on top. */
const SOLO_CARDS: readonly MiniCard[] = [
  { x: 12, y: 28, rot: -18, back: true },
  { x: 52, y: 28, rot: 18, back: true },
  { x: 32, y: 21, rank: 'A', suit: 'S' },
];

/** Create: the stock, and the king of hearts dealt off it. */
const CREATE_CARDS: readonly MiniCard[] = [
  { x: 8, y: 31, back: true },
  { x: 11, y: 27, back: true },
  { x: 14, y: 23, back: true },
  { x: 50, y: 26, rot: 10, rank: 'K', suit: 'H' },
];

/** Take: two aces face off. */
const TAKE_CARDS: readonly MiniCard[] = [
  { x: 14, y: 27, rot: -14, rank: 'A', suit: 'H' },
  { x: 50, y: 23, rot: 14, rank: 'A', suit: 'S' },
];

export function Home() {
  const { user, loading, logout } = useSession();
  const launchSolo = useSoloLaunch();
  return (
    <>
      <section className="hero">
        <div className="hero-logo">
          <Logo size={560} priority />
        </div>
        <p className="hero-tagline">
          <span className="phrase">
            Same deal
            <span className="dot" />
            Same draws
          </span>
          <span className="phrase">
            Five-min clock
            <span className="dot" />
            <em>Best score wins</em>
          </span>
        </p>
        {!user && !loading && (
          <div className="hero-cta row">
            <Link to="/play/solo" className="btn primary lg" onClick={launchSolo}>
              Play free
            </Link>
            <Link to="/auth" className="btn lg">
              Sign in to compete
            </Link>
          </div>
        )}
      </section>

      <div className="modes">
        <Link
          to="/play/solo"
          className="mode-card"
          style={{ '--k': 0 } as CSSProperties}
          onClick={launchSolo}
        >
          <span className="mode-glyph">
            <MiniCards cards={SOLO_CARDS} glow="rgba(61,230,201,0.55)" />
          </span>
          <span className="tag">Solo</span>
          <h3>Practice</h3>
          <p>A random deal, no fee, no opponent. Pause any time.</p>
          <span className="cta">Play now</span>
        </Link>
        <Link
          to={user ? '/create' : '/auth'}
          className="mode-card amber"
          style={{ '--k': 1 } as CSSProperties}
        >
          <span className="mode-glyph">
            <MiniCards cards={CREATE_CARDS} glow="rgba(255,197,61,0.55)" />
          </span>
          <span className="tag">Create</span>
          <h3>Create Challenge</h3>
          <p>Stake $CHAIN, play your deal, and wait for a challenger to beat your score.</p>
          <span className="cta">Set the bar</span>
        </Link>
        <Link
          to={user ? '/take' : '/auth'}
          className="mode-card rose"
          style={{ '--k': 2 } as CSSProperties}
        >
          <span className="mode-glyph">
            <MiniCards cards={TAKE_CARDS} glow="rgba(255,92,138,0.55)" />
          </span>
          <span className="tag">Take</span>
          <h3>Take Challenge</h3>
          <p>Match an open challenge. You get their exact deal. Beat them.</p>
          <span className="cta">Find a match</span>
        </Link>
      </div>

      <div className="strip">
        <HowItWorks />
        <div className="panel">
          {loading ? (
            <div className="stack tight" aria-hidden>
              <div className="skeleton line short" />
              <div className="skeleton line" />
              <div className="skeleton card" />
            </div>
          ) : user ? (
            <SignedIn
              username={user.username}
              isGuest={user.isGuest}
              balance={user.balance}
              xp={user}
              onLogout={() => void logout()}
            />
          ) : (
            <SignedOut />
          )}
        </div>
      </div>

      <p className="legal">
        Alpha build. $CHAIN balances here are off-chain play tokens with no value. On-chain wallets
        come later.
      </p>
    </>
  );
}

function HowItWorks() {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>How it works</h3>
        <span className="chip indigo">5:00 on the clock</span>
      </div>
      <div className="steps">
        <div className="step">
          <MiniCards
            size={56}
            cards={[
              { x: 6, y: 25, rot: -6, rank: '7', suit: 'D' },
              { x: 58, y: 25, rot: 6, rank: '7', suit: 'D' },
            ]}
          />
          <div>
            <span className="step-n">01</span>
            <b>Same deal</b>
            <span>Both players get the identical card sequence. No luck, only play.</span>
          </div>
        </div>
        <div className="step">
          <MiniCards
            size={56}
            cards={[
              { x: 32, y: 4, rank: 'K', suit: 'S' },
              { x: 32, y: 21, rank: 'Q', suit: 'H' },
              { x: 32, y: 38, rank: 'J', suit: 'C' },
            ]}
          />
          <div>
            <span className="step-n">02</span>
            <b>Send cards home</b>
            <span>Draw one, build down, send cards home. Chain plays home for a streak.</span>
          </div>
        </div>
        <div className="step">
          <MiniCards
            size={56}
            cards={[{ x: 32, y: 25, rank: 'K', suit: 'H' }]}
            glow="rgba(255,197,61,0.6)"
          />
          <div>
            <span className="step-n">03</span>
            <b>Winner takes the pot</b>
            <span>Higher score takes both entry fees. Ties go to the faster finish.</span>
          </div>
        </div>
      </div>
      {/* Plain, not primary: the page's primaries are the three mode cards. */}
      <button type="button" className="btn block tutorial" onClick={openTutorial}>
        Tutorial
      </button>
    </div>
  );
}

function SignedOut() {
  return (
    <div className="signin-card">
      <h3>Compete for $CHAIN</h3>
      <div className="perks">
        <ul>
          <li>New accounts start with 1000 mock $CHAIN</li>
          <li>Create a challenge and share a six-letter code</li>
          <li>Take the oldest open challenge at any stake</li>
        </ul>
      </div>
      <div className="row">
        <Link to="/auth" className="btn primary">
          Sign in
        </Link>
        <Link to="/auth" className="btn ghost">
          Play as guest
        </Link>
      </div>
    </div>
  );
}

function SignedIn({
  username,
  isGuest,
  balance,
  xp,
  onLogout,
}: {
  username: string;
  isGuest: boolean;
  balance: number;
  xp: XpProgress;
  onLogout: () => void;
}) {
  const [recent, setRecent] = useState<ChallengeView[] | null>(null);
  // A fired crossing: the card reads the state before it until the miniature's reveal, then
  // the badge, the name, the chip and the bar change together and the ring sweeps.
  const sweep = useRankUp((s) => s.active);
  const { crossing, before } = useCrossingHold(true, xp.rank.index);
  // Latched: once a crossing has played on this mount, the bar and the odometer stay keyed to it
  // (its retiring must not remount them into a page-mount reveal — the settled bar would collapse
  // and regrow). A plain load keeps the page-mount reveal.
  const played = useRef<number | null>(null);
  if (crossing) played.current = crossing.seq;
  const seq = played.current;
  const shown = before
    ? progressBefore(xp.rank.index)
    : {
        rank: xp.rank,
        level: xp.xpLevel,
        xp: xp.xp,
        prev: xp.prevThreshold,
        next: xp.nextThreshold,
      };
  useEffect(() => {
    let alive = true;
    api.myChallenges().then(
      (r) => alive && setRecent(r.challenges.slice(0, 3)),
      () => alive && setRecent([]),
    );
    return () => {
      alive = false;
    };
  }, []);
  return (
    <>
      <div className={`who ${rankClass(shown.rank)}`}>
        <Avatar name={username} large xp={xp} sweep={sweep} />
        <div style={{ minWidth: 0 }}>
          <div className="name">
            <Link to="/profile">{username}</Link>
          </div>
          <div className="rank-line">
            <RankBadge rank={xp.rank} size={24} mine />
            <RankName rank={xp.rank} mine className="rank-name" />
            <XpChip level={shown.level} rank={shown.rank} size="sm">
              <b>
                {/* Keyed on the crossing: a firing remounts the odometer AT the old level (it never
                    flips down from the new one it may have rendered, unpainted, a moment before). */}
                <Odometer key={seq ?? 0} value={shown.level} />
              </b>
            </XpChip>
          </div>
          <div className="sub">
            {isGuest ? 'Guest session' : 'Signed in'} · {balance.toLocaleString()} $CHAIN
          </div>
        </div>
        <div className="actions">
          <Link to="/profile" className="btn sm">
            Profile
          </Link>
          <button className="btn sm ghost" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </div>
      <div className="who-xp">
        {/* Keyed on the crossing's phase: the hold's bar is static, full on the old span; the new
            span's bar mounts at the reveal and grows in from that commit; it stays through the settle. */}
        <XpBar
          key={seq === null ? 'plain' : before ? `hold${seq}` : `new${seq}`}
          xp={shown.xp}
          prev={shown.prev}
          next={shown.next}
          level={shown.level}
          rank={shown.rank}
          reveal={seq === null}
          revealNow={seq !== null && !before}
        />
      </div>
      <div className="divider labelled" style={{ margin: '16px 0 4px' }}>
        Recent
      </div>
      {recent === null ? (
        <div className="recent-list" aria-hidden>
          <div className="skeleton line" />
          <div className="skeleton line short" />
        </div>
      ) : recent.length === 0 ? (
        <p className="muted" style={{ marginTop: 10 }}>
          No challenges yet. Create one or take the oldest in the queue.
        </p>
      ) : (
        <div className="recent-list">
          {recent.map((c) => {
            const s = statusLabel(c);
            return (
              <Link
                key={c.id}
                to={`/challenge/${c.id}`}
                className="match"
                style={{ '--k': 0 } as CSSProperties}
              >
                <span className="head">
                  <span className="fee">{feeLabel(c.entryFee)}</span>
                  <span className="chip">{c.role === 'creator' ? 'Created' : 'Taken'}</span>
                </span>
                <span className={`status ${s.cls}`}>{s.text}</span>
                <span className="when">
                  {timeAgo(c.createdAt)}
                  {c.opponent ? ` · vs ${c.opponent.username}` : ''}
                </span>
              </Link>
            );
          })}
          <Link to="/history" className="btn ghost sm" style={{ justifySelf: 'start' }}>
            All challenges <Icons.arrow />
          </Link>
        </div>
      )}
    </>
  );
}
