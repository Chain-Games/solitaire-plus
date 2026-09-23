import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { api, type ChallengeView } from '../api/client.js';
import { useSession } from '../state/session.js';
import { Empty, PlayerTag, SkeletonCards, feeLabel, timeAgo } from '../shell/ui.js';
import { LevelChip, statusLabel } from './ChallengeDetail.js';

export function History() {
  const [items, setItems] = useState<ChallengeView[] | null>(null);
  const refresh = useSession((s) => s.refresh);
  useEffect(() => {
    void refresh();
    api.myChallenges().then(
      (r) => setItems(r.challenges),
      () => setItems([]),
    );
  }, [refresh]);

  const record = items ? items.filter((c) => c.status === 'complete') : [];
  const won = record.filter((c) => c.result?.won).length;
  const lost = record.length - won;
  const rate = record.length ? (won / record.length) * 100 : 0;

  return (
    <div className="column wide">
      <div className="row between">
        <h2>Your challenges</h2>
        {record.length > 0 && (
          <div className="record" title={`${Math.round(rate)}% win rate`}>
            <span className="wl">
              <span className="w">{won}W</span> – <span className="l">{lost}L</span>
            </span>
            <span className="bar">
              <i style={{ '--w': `${rate}%` } as CSSProperties} />
            </span>
          </div>
        )}
      </div>
      {items === null ? (
        <div style={{ marginTop: 16 }}>
          <SkeletonCards n={4} />
        </div>
      ) : items.length === 0 ? (
        <div className="panel">
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
            Create a challenge and share the code, or take the oldest open one at your stake.
          </Empty>
        </div>
      ) : (
        <div className="timeline">
          {items.map((c, k) => (
            <MatchCard key={c.id} c={c} k={k} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One challenge in the timeline: fee, status, both scores with a small rank badge before each name. */
export function MatchCard({ c, k }: { c: ChallengeView; k: number }) {
  const s = statusLabel(c);
  const sessionUser = useSession((s) => s.user);
  const me = c.me?.score;
  const opp = c.opponent?.finished ? c.opponent.score : undefined;
  const decided = c.status === 'complete' && c.result !== null;
  const meCls = decided ? (c.result?.won ? 'win' : 'lose') : '';
  const oppCls = decided ? (c.result?.won ? 'lose' : 'win') : '';
  return (
    <Link
      to={`/challenge/${c.id}`}
      className={`match ${s.cls}`}
      style={{ '--k': k } as CSSProperties}
    >
      <span className="head">
        <span className="fee">
          {feeLabel(c.entryFee)}
          {c.entryFee > 0 && <small>· pot {c.entryFee * 2}</small>}
        </span>
        <span className="chip">{c.role === 'creator' ? 'Created' : 'Taken'}</span>
        {c.isPrivate && <span className="chip indigo">Private</span>}
      </span>
      <span className={`status ${s.cls}`}>{s.text}</span>
      <span className="scores">
        <span className={`p ${meCls}`}>
          {c.me ? (
            <PlayerTag
              name="You"
              level={sessionUser?.xpLevel ?? c.me.xpLevel}
              rank={sessionUser?.rank ?? c.me.rank}
              size="sm"
            />
          ) : (
            <span className="n">You</span>
          )}
          <span className="sc">
            <span className="s">{me ?? '—'}</span>
            {me !== undefined && <LevelChip level={c.me?.levelReached} />}
          </span>
        </span>
        <span className="x">VS</span>
        <span className={`p ${oppCls}`}>
          <span className="sc">
            {opp !== undefined && <LevelChip level={c.opponent?.levelReached} />}
            <span className="s">
              {c.opponent ? (c.opponent.finished ? (opp ?? '?') : '…') : '—'}
            </span>
          </span>
          {c.opponent ? (
            <PlayerTag
              name={c.opponent.username}
              level={c.opponent.xpLevel}
              rank={c.opponent.rank}
              size="sm"
              mirror
            />
          ) : (
            <span className="n">waiting</span>
          )}
        </span>
      </span>
      <span className="when">
        {c.code} · {timeAgo(c.activityAt)}
        {c.result?.won && c.result.payout > 0 ? ` · +${c.result.payout} $CHAIN` : ''}
      </span>
    </Link>
  );
}
