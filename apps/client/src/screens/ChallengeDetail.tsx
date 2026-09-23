import type { Rank } from '@solitaire-plus/sim';
import { useEffect, useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, type ChallengeView } from '../api/client.js';
import {
  CopyButton,
  Empty,
  ErrorNote,
  Loading,
  Note,
  PlayerTag,
  feeLabel,
  rankClass,
  timeAgo,
} from '../shell/ui.js';
import { useNotifications } from '../state/notifications.js';
import { useSession } from '../state/session.js';
import { PushPrompt } from '../shell/PushPrompt.js';
import { rankLabel } from '../shell/xp-view.js';

function marginText(v: ChallengeView): string {
  if (!v.result) return '';
  const m = v.result.margin;
  const who = v.result.won ? 'You won' : 'You lost';
  if (m.by === 'score') return `${who} by ${m.amount} points.`;
  if (m.by === 'time')
    return `${who} on the clock — scores tied, ${(m.amountMs / 1000).toFixed(1)}s apart.`;
  return `${who} on submission time — scores and clocks were identical.`;
}

/** "You reached level 7 · they reached level 5" — cosmetic, so it never explains the result. */
function levelsText(v: ChallengeView): string {
  const mine = v.me?.levelReached;
  const theirs = v.opponent?.levelReached;
  if (mine === undefined || theirs === undefined) return '';
  return `You reached level ${mine} · they reached level ${theirs}.`;
}

/** Small "MATCH LV n" chip beside a revealed score: the in-match level, named so it never reads as the account's XP LV. */
export function LevelChip({ level }: { level: number | undefined }) {
  if (level === undefined) return null;
  return (
    <span className="chip indigo" title={`In-match level ${level} reached`}>
      Match LV {level}
    </span>
  );
}

/** One player of the VS block: the large badge over the name, then ONE line "RUN I · XP LV 12". */
function PlayerSide({
  name,
  level,
  rank,
  to,
}: {
  name: string;
  level: number;
  rank: Rank;
  to: string;
}) {
  return (
    <>
      <PlayerTag name={name} level={level} rank={rank} size="lg" chip={false} to={to} />
      <div className={`rank-line ${rankClass(rank)}`}>
        <span className="rank-name">{rankLabel(rank)}</span>
        <span className="sep">·</span>
        <span className="xp-lv">
          XP LV <b>{level}</b>
        </span>
      </div>
    </>
  );
}

export function statusLabel(v: ChallengeView): { text: string; cls: string } {
  if (v.status === 'complete')
    return v.result?.won ? { text: 'WON', cls: 'won' } : { text: 'LOST', cls: 'lost' };
  if (v.status === 'expired') return { text: 'EXPIRED', cls: '' };
  if (v.myGameStatus !== 'finished') return { text: 'YOUR TURN', cls: 'pending' };
  if (v.status === 'taken') return { text: 'OPPONENT PLAYING', cls: 'taken' };
  return { text: 'WAITING', cls: 'open' };
}

export function ChallengeDetail() {
  const { id } = useParams();
  const [view, setView] = useState<ChallengeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Me" is the session user: its badge is the freshest (and carries the demo fixture).
  const sessionUser = useSession((s) => s.user);

  // This page says everything a notification about it would: it is read, not toasted.
  const setViewing = useNotifications((s) => s.setViewing);
  useEffect(() => {
    setViewing(id ?? null);
    return () => setViewing(null);
  }, [id, setViewing]);
  // A settlement or a take lands on this page live, not on the 15 s poll.
  const newest = useNotifications((s) => s.items[0]);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    if (newest && newest.challengeId === id) setBump((b) => b + 1);
  }, [newest, id]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    const load = () =>
      api.challenge(id).then(
        (r) => alive && setView(r.challenge),
        (err) =>
          alive && setError(err instanceof ApiError ? err.message : 'Could not load challenge'),
      );
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, bump]);

  if (error)
    return (
      <div className="column">
        <div className="panel">
          <Empty
            title="Challenge not found"
            actions={
              <Link to="/history" className="btn">
                Back to history
              </Link>
            }
          >
            {error}
          </Empty>
        </div>
      </div>
    );
  if (!view)
    return (
      <div className="column">
        <Loading label="Loading challenge" />
      </div>
    );

  const s = statusLabel(view);
  const shareUrl = `${location.origin}/take?code=${view.code}`;
  const me = view.me?.score;
  const opp = view.opponent?.finished ? view.opponent.score : undefined;
  const top = Math.max(me ?? 0, opp ?? 0, 1);
  const decided = view.status === 'complete' && view.result !== null;
  const meCls = decided ? (view.result?.won ? 'win' : 'lose') : '';
  const oppCls = decided ? (view.result?.won ? 'lose' : 'win') : '';

  return (
    <div className="column">
      <div className="panel">
        <div className="panel-head">
          <div>
            <div className="t-label">Challenge</div>
            <h2 style={{ letterSpacing: '0.18em' }}>{view.code}</h2>
          </div>
          <span className={`status ${s.cls}`}>{s.text}</span>
        </div>
        <div className="meta">
          <span>
            Stake <b>{feeLabel(view.entryFee)}</b>
          </span>
          <span>
            Pot <b>{view.entryFee > 0 ? `${view.entryFee * 2} $CHAIN` : 'Bragging rights'}</b>
          </span>
          <span>
            Visibility <b>{view.isPrivate ? 'Private' : 'Public'}</b>
          </span>
          <span>
            {view.role === 'creator' ? 'Created' : 'Taken'} <b>{timeAgo(view.createdAt)}</b>
          </span>
        </div>

        <div className="vs">
          <div className={`side ${meCls}`}>
            {view.me ? (
              <PlayerSide
                name={view.me.username}
                level={sessionUser?.xpLevel ?? view.me.xpLevel}
                rank={sessionUser?.rank ?? view.me.rank}
                to="/profile"
              />
            ) : (
              <div className="name">you</div>
            )}
            <div className="score">{me ?? '—'}</div>
            {me !== undefined && <LevelChip level={view.me?.levelReached} />}
            {me !== undefined && (
              <div className="bar">
                <i style={{ '--w': `${(me / top) * 100}%` } as CSSProperties} />
              </div>
            )}
          </div>
          <div className="mid">VS</div>
          <div className={`side ${oppCls}`}>
            {view.opponent ? (
              <PlayerSide
                name={view.opponent.username}
                level={view.opponent.xpLevel}
                rank={view.opponent.rank}
                to={`/profile/${encodeURIComponent(view.opponent.username)}`}
              />
            ) : (
              <div className="name">waiting</div>
            )}
            <div className="score">
              {view.opponent?.finished ? (opp ?? '?') : view.opponent ? '…' : '—'}
            </div>
            {opp !== undefined && <LevelChip level={view.opponent?.levelReached} />}
            {opp !== undefined && (
              <div className="bar">
                <i style={{ '--w': `${(opp / top) * 100}%` } as CSSProperties} />
              </div>
            )}
          </div>
        </div>

        <div className="stack">
          {view.result && (
            <div className={`outcome ${view.result.won ? 'won' : 'lost'}`}>
              {marginText(view)}
              {view.result.won && view.result.payout > 0 && ` +${view.result.payout} $CHAIN`}
              {levelsText(view) && <br />}
              {levelsText(view)}
            </div>
          )}
          {view.status === 'expired' && (
            <Note>Nobody took this challenge in time. Your fee was refunded.</Note>
          )}
          {view.myGameStatus !== 'finished' && view.myGameId && (
            <Link className="btn warm block lg" to={`/play/${view.myGameId}`}>
              {view.myGameStatus === 'playing' ? 'Resume your game' : 'Play your game'}
            </Link>
          )}
          {view.role === 'creator' && (view.status === 'open' || view.status === 'pending') && (
            <PushPrompt />
          )}
          {view.status === 'open' && view.role === 'creator' && (
            <>
              <div className="divider labelled">Share</div>
              <p className="muted">
                Waiting for a challenger. Send this code
                {view.isPrivate ? '' : ', or let matchmaking find one'}:
              </p>
              <div className="code">{view.code}</div>
              <div className="row split">
                <CopyButton text={shareUrl} label="Copy link" />
                <CopyButton text={view.code} label="Copy code" />
              </div>
            </>
          )}
          {view.status === 'taken' && view.myGameStatus === 'finished' && (
            <Note warm>
              {view.opponent?.username ?? 'Your opponent'} is playing now. Results appear here when
              they finish.
            </Note>
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="nav-row">
            <Link to="/history" className="btn ghost sm">
              History
            </Link>
            <Link to="/" className="btn ghost sm">
              Home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
