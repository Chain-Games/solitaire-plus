import type { ScoreBreakdown, TimedMove } from '@solitaire-plus/sim';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, type ChallengeView, type GameView, type XpGained } from '../api/client.js';
import { MoveSync } from '../game/sync.js';
import { useNotifications } from '../state/notifications.js';
import type { ResultsOutcome } from '../render/results-scene.js';
import { worldFor } from '../render/world-table.js';
import { useSession } from '../state/session.js';
import type { CardChallenge } from '../share/layout.js';
import { ShareButton } from '../share/ShareButton.js';
import { backdropWorld } from '../shell/backdrop-world.js';
import { randomSeed } from '../shell/handoff.js';
import { Icons, Loading } from '../shell/ui.js';
import { WorldVeil } from '../shell/WorldVeil.js';
import { demoGained, xpDemo } from '../shell/xp-view.js';
import { GameHost } from './GameHost.js';
import { XpBeat } from './ResultsXp.js';

const BEST_KEY = 'blockari.solo.best';

/**
 * The shell's backdrop follows the game's world: set here too (a reload, a
 * direct link) so the backdrop that comes back after the results starts on
 * the world and dissolves home from it.
 */
function useWorldHandoff(seed: string | undefined): string | null {
  useEffect(() => {
    if (seed) backdropWorld.set(worldFor(seed).id);
  }, [seed]);
  return seed ? worldFor(seed).id : null;
}

function readBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** Solo: local seed, pausable, best score in localStorage. No server involved. */
export function PlaySolo() {
  const navigate = useNavigate();
  const route = useLocation();
  // ?seed=... makes a solo game reproducible (capture harness, bug reports);
  // a launch from the shell picked its seed already (the backdrop is on its world).
  const [seed, setSeed] = useState(
    () =>
      new URLSearchParams(location.search).get('seed') ??
      (route.state as { seed?: string } | null)?.seed ??
      randomSeed(),
  );
  const worldId = useWorldHandoff(seed);
  // The READY frame sits on the world; the veil leaves once the game starts.
  const [started, setStarted] = useState(false);
  const [best, setBest] = useState(readBest);
  // Whether the run that just ended beat the best before it (the results scene's rule).
  const [newBest, setNewBest] = useState(false);

  const onEnd = async (b: ScoreBreakdown) => {
    setNewBest(b.total > 0 && b.total > best);
    if (b.total > best) {
      setBest(b.total);
      try {
        localStorage.setItem(BEST_KEY, String(b.total));
      } catch {
        // ignore
      }
    }
  };

  return (
    <>
      <WorldVeil key={seed} worldId={worldId} leaving={started} />
      <GameHost
        key={seed}
        seed={seed}
        pausable
        modeLabel="SOLO"
        best={best}
        onStart={async () => setStarted(true)}
        readyCopy={
          best > 0
            ? `Your best is ${best}. Fill rows or columns to clear them; chain clears for streaks.`
            : 'Fill a row or column to clear it. Chain clears for streaks.'
        }
        onEnd={onEnd}
        onQuit={() => navigate('/')}
        renderResultActions={(b, fx, live) => (
          <>
            {/* Solo games pay no XP (nothing is recorded); the demo flag previews the beat. */}
            {xpDemo() && <XpBeat gained={demoGained(b)} fx={fx} active={live} />}
            <button className="btn primary block lg" onClick={() => setSeed(randomSeed())}>
              Play again
            </button>
            <div className="secondary">
              <Link to="/create" className="btn warm block">
                New challenge
              </Link>
              <ShareButton breakdown={b} newBest={newBest} />
            </div>
            {/* Share took Home's slot; the tray's ✕ also leaves, but a word is clearer. */}
            <Link to="/" className="result-home">
              Home
            </Link>
          </>
        )}
      />
    </>
  );
}

/** Challenge: server-issued seed, wall-clock timer, moves streamed to the server. */
export function PlayChallenge() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const refresh = useSession((s) => s.refresh);
  const [game, setGame] = useState<GameView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ChallengeView | null>(null);
  // The outcome fetch after the game failed: the results hero stops waiting for it.
  const [outcomeFailed, setOutcomeFailed] = useState(false);
  // The challenge as it stood when the game opened: a taker's opponent (the
  // creator) has always played, so the results will have an OUTCOME to show
  // and the scene plays the outcome hero; a creator's results wait.
  const [expectOutcome, setExpectOutcome] = useState(false);
  const [gained, setGained] = useState<XpGained | null>(null);
  // The player's best BEFORE this game (profile, challenge games only): the
  // results scene compares against it and the share card's "NEW BEST" is
  // this score beating it. Unknown until the profile answers.
  const [prevBest, setPrevBest] = useState<number | undefined>(undefined);
  const [newBest, setNewBest] = useState(false);
  const username = useSession((s) => s.user?.username);
  useEffect(() => {
    if (!username) return;
    let alive = true;
    api.profile(username).then(
      ({ profile }) => alive && setPrevBest(profile.bestScore),
      () => alive && setPrevBest(undefined),
    );
    return () => {
      alive = false;
    };
  }, [username]);
  const sync = useRef<MoveSync | null>(null);
  const code = (location.state as { code?: string } | null)?.code;
  const worldId = useWorldHandoff(game?.seed);
  const [started, setStarted] = useState(false);
  // The results hero says the outcome: a notification about THIS challenge is read, not toasted.
  const setViewing = useNotifications((s) => s.setViewing);
  const challengeId = game?.challengeId ?? null;
  useEffect(() => {
    setViewing(challengeId);
    return () => setViewing(null);
  }, [challengeId, setViewing]);

  useEffect(() => {
    if (!gameId) return;
    let alive = true;
    api.game(gameId).then(
      (r) => {
        if (!alive) return;
        if (r.game.status === 'finished' && r.game.challengeId) {
          navigate(`/challenge/${r.game.challengeId}`, { replace: true });
          return;
        }
        setGame(r.game);
        if (r.game.challengeId)
          api.challenge(r.game.challengeId).then(
            ({ challenge }) => alive && setExpectOutcome(challenge.opponent?.finished === true),
            () => undefined,
          );
      },
      (err) => alive && setError(err instanceof ApiError ? err.message : 'Could not load game'),
    );
    return () => {
      alive = false;
    };
  }, [gameId, navigate]);

  const resume = useMemo(() => {
    if (!game || game.status !== 'playing' || !game.startedAt) return undefined;
    const elapsed = new Date(game.serverNow).getTime() - new Date(game.startedAt).getTime();
    return { moves: game.moves, elapsedMs: Math.max(0, elapsed) };
  }, [game]);

  if (error) {
    return (
      <div className="game-root">
        <div className="overlay">
          <div className="dialog" role="alertdialog">
            <h2>Can't open game</h2>
            <div className="error" style={{ marginTop: 12 }}>
              <Icons.alert />
              <span>{error}</span>
            </div>
            <div className="actions">
              <Link to="/" className="btn block">
                Home
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (!game)
    return (
      <div className="game-root">
        <div className="overlay">
          <Loading label="Opening game" />
        </div>
      </div>
    );

  const onStart = async () => {
    setStarted(true);
    if (resume) return;
    if (!sync.current) sync.current = new MoveSync(game.id, [], game.moves.length);
    await api.startGame(game.id);
  };

  const onMove = (moves: readonly TimedMove[]) => {
    if (!sync.current) sync.current = new MoveSync(game.id, moves, game.moves.length);
    else sync.current.bind(moves);
    sync.current.schedule();
  };

  const onEnd = async (b: ScoreBreakdown, moves: readonly TimedMove[]) => {
    if (!sync.current) sync.current = new MoveSync(game.id, moves, game.moves.length);
    else sync.current.bind(moves);
    const finished = await sync.current.finish();
    // The game's own award; a settled challenge's result folds the win in below.
    let xp = finished.xpGained;
    await refresh();
    // The share card's "NEW BEST": this score beats the best on record before it.
    setNewBest(prevBest !== undefined && b.total > prevBest);
    // The outcome, if the opponent already played: shown over the results.
    if (game.challengeId) {
      try {
        const r = await api.challenge(game.challengeId);
        setOutcome(r.challenge);
        if (r.challenge.result?.xpGained) xp = r.challenge.result.xpGained;
      } catch {
        // The challenge page shows it later.
        setOutcomeFailed(true);
      }
    }
    setGained(xp);
  };

  // The results hero's outcome: known, still pending (the taker's, until the
  // server settles it on submission), or none (the plain headline).
  const heroOutcome: ResultsOutcome | 'pending' | null = outcome?.result
    ? resultsOutcome(outcome)
    : expectOutcome && !outcomeFailed
      ? 'pending'
      : null;

  // The code rides in on the navigation state; a reload loses it, the outcome has it.
  const shareCode = outcome?.code ?? code;
  const shareChallenge = cardChallenge(outcome, shareCode);

  return (
    <>
      <WorldVeil key={game.id} worldId={worldId} leaving={started} />
      <GameHost
        key={game.id}
        seed={game.seed}
        pausable={false}
        best={prevBest}
        modeLabel={code ? `CHALLENGE ${code}` : 'CHALLENGE'}
        readyCopy={
          resume
            ? 'Your game is still running — the clock kept going while you were away.'
            : 'Once you start, the clock runs for real: no pauses. Your opponent plays these exact pieces.'
        }
        resume={resume}
        onStart={onStart}
        onMove={onMove}
        onEnd={onEnd}
        onQuit={() => navigate(game.challengeId ? `/challenge/${game.challengeId}` : '/')}
        outcome={heroOutcome}
        renderResultActions={(b, fx, live) => (
          <>
            {/* A settled outcome is the panel's hero; only a wait (or an expiry) is a strip here, and never last. */}
            <Outcome view={outcome} />
            {xpDemo() ? (
              <XpBeat gained={demoGained(b)} fx={fx} active={live} />
            ) : (
              gained && <XpBeat gained={gained} fx={fx} active={live} />
            )}
            <Link to={`/challenge/${game.challengeId}`} className="btn primary block lg">
              See challenge
            </Link>
            <div className="secondary">
              {outcome?.role === 'creator' ? (
                <Link to="/create" className="btn block">
                  Create another
                </Link>
              ) : (
                <Link to="/take" className="btn block">
                  Take another
                </Link>
              )}
              <ShareButton
                breakdown={b}
                newBest={newBest}
                gameId={game.id}
                challenge={shareChallenge}
              />
            </div>
            <Link to="/" className="result-home">
              Home
            </Link>
          </>
        )}
      />
    </>
  );
}

/**
 * The settled challenge as the results scene shows it: the stake won (the
 * payout) or lost (the entry fee), both scores and the in-match levels.
 */
function resultsOutcome(v: ChallengeView): ResultsOutcome | null {
  if (!v.result) return null;
  return {
    won: v.result.won,
    chain: v.result.won ? v.result.payout : v.entryFee,
    myScore: v.me?.score ?? 0,
    theirScore: v.opponent?.score ?? 0,
    myLevel: v.me?.levelReached,
    theirLevel: v.opponent?.levelReached,
  };
}

/**
 * The challenge as the share card tells it. Settled (the taker's results,
 * always; the creator's when the taker finished first): the RESULT — never
 * the code, nobody can take it. Open (the creator just finished): the dare.
 * Anything else (taken and still being played, expired): the score alone,
 * like a solo card. No outcome to read (the fetch failed) but a code from
 * the navigation: the dare, as before.
 */
function cardChallenge(
  v: ChallengeView | null,
  code: string | undefined,
): CardChallenge | undefined {
  if (!v) return code ? { status: 'open', code } : undefined;
  if (v.result)
    return {
      status: 'complete',
      code: v.code,
      entryFee: v.entryFee,
      result: {
        won: v.result.won,
        payout: v.result.payout,
        opponent:
          v.opponent && v.opponent.score !== undefined
            ? { username: v.opponent.username, score: v.opponent.score }
            : undefined,
      },
    };
  if (v.status === 'open' || v.status === 'pending')
    return { status: 'open', code: v.code, entryFee: v.entryFee };
  return undefined;
}

/**
 * The strip in the tray for a challenge still waiting for the other side (or
 * expired). A settled outcome is the panel's hero (results-scene.ts), not a strip.
 */
function Outcome({ view }: { view: ChallengeView | null }) {
  if (!view || view.result) return null;
  if (view.status === 'expired') return <div className="result-outcome">Challenge expired</div>;
  return (
    <div className="result-outcome waiting">
      <span className="spinner" />
      {view.opponent
        ? `Waiting for ${view.opponent.username}`
        : `Waiting for a challenger · ${view.code}`}
    </div>
  );
}
