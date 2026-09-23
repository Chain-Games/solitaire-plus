import type { ScoreBreakdown } from '@solitaire-plus/sim';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSession } from '../state/session.js';
import { CopyButton, Icons } from '../shell/ui.js';
import type { CardChallenge } from './layout.js';
import { shareResult, type ShareOutcome } from './share.js';

/**
 * The results tray's Share button: renders the card, opens the system share
 * sheet where there is one, and otherwise the preview dialog with the image,
 * the link and the text ready to copy. Sits beside the tray's secondary
 * action as a primary-adjacent button (`.btn.accent`).
 */
export function ShareButton({
  breakdown,
  gameId,
  challenge,
  newBest,
}: {
  breakdown: ScoreBreakdown;
  /** The server game id the cards are stored against; a solo run has none. */
  gameId?: string | undefined;
  /** The challenge behind the game, by state: open (the dare) or complete (the result). */
  challenge?: CardChallenge | undefined;
  newBest: boolean;
}) {
  const user = useSession((s) => s.user);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Extract<ShareOutcome, { mode: 'preview' }> | null>(null);

  const share = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const out = await shareResult({
        breakdown,
        user: user ? { username: user.username, xpLevel: user.xpLevel, rank: user.rank } : null,
        gameId,
        challenge,
        newBest,
      });
      if (out.mode === 'preview') setPreview(out);
    } catch {
      // The card could not be drawn at all (no canvas): nothing to show.
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="btn accent block" onClick={() => void share()} disabled={busy}>
        {busy ? (
          <>
            <span className="spinner inline" aria-hidden /> Sharing
          </>
        ) : (
          <>
            <Icons.share /> Share
          </>
        )}
      </button>
      {preview && <SharePreview {...preview} onClose={() => setPreview(null)} />}
    </>
  );
}

const DOWNLOAD_NAME = 'solitaire-plus-score.jpg';

/** The preview dialog: the story card scaled to fit, copy link / download / copy text. */
function SharePreview({
  story,
  text,
  url,
  unfurls,
  onClose,
}: Extract<ShareOutcome, { mode: 'preview' }> & { onClose: () => void }) {
  const src = useMemo(() => URL.createObjectURL(story), [story]);
  useEffect(() => () => URL.revokeObjectURL(src), [src]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const full = `${text}\n${url}`;
  return createPortal(
    <div className="overlay fixed" onClick={onClose}>
      <div
        className="dialog share-dialog"
        role="dialog"
        aria-labelledby="share-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="share-title">Share your score</h2>
        <div className="share-preview">
          <img src={src} alt="Your score card" />
        </div>
        <pre className="share-text">{text}</pre>
        {/* The card prints the take link; this one is the share link — said once, here. */}
        <div className="share-link">
          <span className="t-label">{unfurls ? 'Link (unfurls into this card)' : 'Link'}</span>
          <code>{url}</code>
        </div>
        <div className="actions">
          <div className="row split">
            <CopyButton text={url} label="Copy link" className="primary" />
            <a className="btn" href={src} download={DOWNLOAD_NAME}>
              <Icons.download /> Download image
            </a>
          </div>
          <CopyButton text={full} label="Copy text" className="block ghost" />
          <p className="lede">
            {unfurls
              ? 'Paste the link anywhere\u00a0— it unfurls into this card.'
              : 'Post the image with the link\u00a0— it opens Solitaire Plus.'}
          </p>
          <button className="btn ghost block" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
