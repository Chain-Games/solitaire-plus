import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, type OpenChallenge } from '../api/client.js';
import { useSession } from '../state/session.js';
import { backdropWorld } from '../shell/backdrop-world.js';
import { stakeAndGo } from '../shell/handoff.js';
import { explainFirst } from '../tutorial/guide.js';
import {
  Avatar,
  Empty,
  ErrorNote,
  Icons,
  PlayerTag,
  SkeletonCards,
  errorCopy,
  feeLabel,
  timeAgo,
} from '../shell/ui.js';
import { FeePicker } from './FeePicker.js';

/** Queue refresh cadence; the badges are "live" at this resolution. */
const POLL_MS = 8_000;

function cleanCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

export function TakeChallenge() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { user, refresh } = useSession();
  const [fee, setFee] = useState(10);
  const [code, setCode] = useState(() => cleanCode(params.get('code') ?? ''));
  const [open, setOpen] = useState<OpenChallenge[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'match' | 'code' | string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLDivElement>(null);

  // One poll of every open challenge; the per-fee counts and the queue at
  // the chosen fee both derive from it.
  const load = useCallback(async () => {
    try {
      const r = await api.openChallenges();
      setOpen(r.challenges);
    } catch {
      setOpen((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    const onVis = () => !document.hidden && void load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  const counts: Record<number, number> = {};
  const atFee: OpenChallenge[] = [];
  for (const c of open ?? []) {
    counts[c.entryFee] = (counts[c.entryFee] ?? 0) + 1;
    if (c.entryFee === fee) atFee.push(c);
  }
  const oldest = atFee.reduce<OpenChallenge | null>(
    (a, c) => (a === null || c.createdAt < a.createdAt ? c : a),
    null,
  );

  // A first-timer sees the tutorial before the stake is paid; the deal follows it.
  const go = (
    kind: string,
    stake: number | undefined,
    fn: () => ReturnType<typeof api.takeRandom>,
  ) => explainFirst(() => void goNow(kind, stake, fn));

  const goNow = async (
    kind: string,
    stake: number | undefined,
    fn: () => ReturnType<typeof api.takeRandom>,
  ) => {
    setBusy(kind);
    setError(null);
    try {
      const res = await fn();
      // The stake is paid: the coin flies to the pill, the world comes up, then the game.
      await stakeAndGo({
        coin: picker.current?.querySelector('.pot .coin') ?? null,
        stake,
        seed: res.seed,
        refresh,
        go: () => navigate(`/play/${res.gameId}`, { replace: true, state: { code: res.code } }),
      });
    } catch (err) {
      backdropWorld.set(null);
      setError(errorCopy(err));
      setBusy(null);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    const m = /code=([A-Za-z0-9]{6})/.exec(text);
    const next = cleanCode(m ? (m[1] ?? '') : text);
    if (next.length > 0) {
      e.preventDefault();
      setCode(next);
    }
  };

  // Reading the clipboard needs a secure context (HTTPS or localhost) AND
  // the user's consent; on a plain-HTTP LAN build the API does not exist and
  // there is no fallback (browsers never allowed a scripted paste). The
  // button then focuses the field and points at the native long-press Paste.
  const canReadClipboard =
    typeof navigator.clipboard?.readText === 'function' && window.isSecureContext;
  const [pasteHint, setPasteHint] = useState(false);
  useEffect(() => {
    if (!pasteHint) return;
    const t = setTimeout(() => setPasteHint(false), 2600);
    return () => clearTimeout(t);
  }, [pasteHint]);

  const pasteFromClipboard = async () => {
    if (!canReadClipboard) {
      codeInput.current?.focus();
      setPasteHint(true);
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      const m = /code=([A-Za-z0-9]{6})/.exec(text);
      setCode(cleanCode(m ? (m[1] ?? '') : text));
    } catch {
      // Refused: fall back to the native paste the same way.
      codeInput.current?.focus();
      setPasteHint(true);
    }
  };

  const short = user !== null && user.balance < fee;

  return (
    <div className="take-layout">
      <div className="column">
        <div className="panel">
          <div className="panel-head">
            <h2>Take Challenge</h2>
            <span className="live">Live queue</span>
          </div>
          <p className="panel-lede">
            Pick a fee and you are matched with the oldest open challenge at that stake. You play
            their exact deal — same cards, same order. Beat their score to take the pot.
          </p>
          <div className="stack">
            <div ref={picker}>
              <FeePicker value={fee} onChange={setFee} counts={counts} balance={user?.balance} />
            </div>
            <div className="queue" aria-live="polite">
              {open === null ? (
                <>
                  <span className="spinner inline" />
                  Checking the queue
                </>
              ) : atFee.length === 0 ? (
                <>Nobody is waiting at this fee right now.</>
              ) : (
                <>
                  <b>{atFee.length}</b> open at this fee — oldest from{' '}
                  <b>{oldest?.creator.username}</b>
                  {oldest ? `, ${timeAgo(oldest.createdAt)}` : ''}.
                </>
              )}
            </div>
            {short && (
              <ErrorNote>Not enough $CHAIN for this fee — you have {user?.balance ?? 0}.</ErrorNote>
            )}
            <button
              className={`btn block lg${code.length === 6 ? '' : ' primary'}`}
              onClick={() => go('match', fee, () => api.takeRandom(fee))}
              disabled={busy !== null || short || open === null || atFee.length === 0}
            >
              {busy === 'match' ? (
                <>
                  <span className={`spinner inline${code.length === 6 ? '' : ' dark'}`} /> Matching
                </>
              ) : (
                <>
                  <Icons.swords /> Match me
                </>
              )}
            </button>
          </div>

          <div className="divider labelled">or join with a code</div>

          <div className="stack tight">
            <div className="code-field">
              <div className="code-slots" onClick={() => codeInput.current?.focus()}>
                {Array.from({ length: 6 }, (_, i) => (
                  <span
                    key={i}
                    className={`slot ${code[i] ? 'filled' : 'empty'}${i === code.length ? ' cursor' : ''}`}
                    aria-hidden
                  >
                    {code[i] ?? ''}
                  </span>
                ))}
                <input
                  ref={codeInput}
                  type="text"
                  value={code}
                  onChange={(e) => setCode(cleanCode(e.target.value))}
                  onPaste={onPaste}
                  inputMode="text"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={6}
                  aria-label="Challenge code"
                />
              </div>
              <button
                type="button"
                className="btn paste"
                onClick={() => void pasteFromClipboard()}
                aria-label="Paste code"
                title="Paste"
              >
                <Icons.paste />
                <span className="lbl">
                  {pasteHint
                    ? 'Hold the code field and choose Paste'
                    : canReadClipboard
                      ? 'Paste from clipboard'
                      : 'Paste'}
                </span>
              </button>
            </div>
            <button
              className={`btn block${code.length === 6 ? ' primary' : ''}`}
              onClick={() => go('code', undefined, () => api.takeByCode(code))}
              disabled={busy !== null || code.length !== 6}
            >
              {busy === 'code' ? <span className="spinner inline" /> : 'Join challenge'}
            </button>
            {error && <ErrorNote>{error}</ErrorNote>}
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h3>Open now</h3>
          <span className="live">{open ? `${open.length} waiting` : 'Live'}</span>
        </div>
        {open === null ? (
          <SkeletonCards n={3} />
        ) : open.length === 0 ? (
          <Empty title="The queue is empty">
            Nobody is waiting right now. Create a challenge and set the bar instead.
          </Empty>
        ) : (
          <div className="queue-list">
            {open
              .slice()
              .sort(
                (a, b) =>
                  Number(b.entryFee === fee) - Number(a.entryFee === fee) ||
                  (a.createdAt < b.createdAt ? -1 : 1),
              )
              .slice(0, 8)
              .map((c, k) => {
                const mine = c.creator.id === user?.id;
                const cannot = user !== null && user.balance < c.entryFee;
                return (
                  <div
                    key={c.id}
                    className={`queue-row${mine ? ' mine' : ''}`}
                    style={{ '--k': k } as CSSProperties}
                  >
                    <Avatar name={c.creator.username} />
                    <div style={{ minWidth: 0 }}>
                      <div className="who-name">
                        <PlayerTag
                          name={c.creator.username}
                          level={c.creator.xpLevel}
                          rank={c.creator.rank}
                          size="md"
                          to={
                            mine ? '/profile' : `/profile/${encodeURIComponent(c.creator.username)}`
                          }
                        />
                      </div>
                      <div className="who-sub">
                        <div className="money-line">
                          <span className="stake">Stake {c.entryFee}</span>
                          {' · '}
                          <span className="pot-inline">Pot {c.entryFee * 2}</span>
                          <span className="unit"> $CHAIN</span>
                        </div>
                        <div>
                          {mine ? 'Your challenge · ' : ''}
                          {timeAgo(c.createdAt)} · {c.code}
                        </div>
                      </div>
                    </div>
                    <button
                      className="btn sm primary"
                      disabled={busy !== null || mine || cannot}
                      onClick={() => go(c.id, c.entryFee, () => api.takeByCode(c.code))}
                      aria-label={`Take ${c.creator.username}'s ${feeLabel(c.entryFee)} challenge`}
                    >
                      {busy === c.id ? <span className="spinner inline dark" /> : 'Take'}
                    </button>
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}
