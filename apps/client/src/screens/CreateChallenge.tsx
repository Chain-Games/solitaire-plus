import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useSession } from '../state/session.js';
import { backdropWorld } from '../shell/backdrop-world.js';
import { stakeAndGo } from '../shell/handoff.js';
import { ErrorNote, Note, Switch, errorCopy } from '../shell/ui.js';
import { explainFirst } from '../tutorial/guide.js';
import { FeePicker } from './FeePicker.js';

export function CreateChallenge() {
  const navigate = useNavigate();
  const { user, refresh } = useSession();
  const [fee, setFee] = useState(10);
  const [isPrivate, setPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLDivElement>(null);

  // A first-timer sees the tutorial before the stake is paid; the deal follows it.
  const create = () => explainFirst(() => void createNow());

  const createNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.createChallenge(fee, isPrivate);
      // The stake is paid: the coin flies to the pill, the world comes up, then the game.
      await stakeAndGo({
        coin: picker.current?.querySelector('.pot .coin') ?? null,
        stake: fee,
        seed: res.seed,
        refresh,
        go: () =>
          navigate(`/play/${res.gameId}`, { replace: true, state: { code: res.code, isPrivate } }),
      });
    } catch (err) {
      backdropWorld.set(null);
      setError(errorCopy(err));
      setBusy(false);
    }
  };

  const short = user !== null && user.balance < fee;

  return (
    <div className="column">
      <div className="panel">
        <div className="panel-head">
          <h2>Create Challenge</h2>
          <span className="chip amber">Set the bar</span>
        </div>
        <p className="panel-lede">
          You pay the entry fee and play a fresh seed right now. The challenge then waits up to 24
          hours for someone to take it — they play the exact same pieces. Winner takes both fees.
        </p>
        <div className="stack">
          <div>
            <div className="field-label" style={{ marginBottom: 8 }}>
              Entry fee
            </div>
            <div ref={picker}>
              <FeePicker value={fee} onChange={setFee} balance={user?.balance} />
            </div>
          </div>
          <Switch
            checked={isPrivate}
            onChange={setPrivate}
            label="Private challenge"
            hint="Only joinable with the share code; hidden from matchmaking."
          />
          {short && (
            <ErrorNote>Not enough $CHAIN for this fee — you have {user?.balance ?? 0}.</ErrorNote>
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
          <button className="btn warm block lg" onClick={create} disabled={busy || short}>
            {busy ? (
              <>
                <span className="spinner inline dark" /> Creating
              </>
            ) : (
              `Stake ${fee} $CHAIN and play`
            )}
          </button>
          <Note>Your game starts right away: three minutes on the clock, no pauses.</Note>
        </div>
      </div>
    </div>
  );
}
