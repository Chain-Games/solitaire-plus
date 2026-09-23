import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { NotificationItem } from '../api/client.js';
import { useNotifications } from '../state/notifications.js';
import { CHIP, TONE, chainText, lineText, scoresText } from './notify-copy.js';
import { sfx } from './sfx.js';
import { Coin, Icons, timeAgo } from './ui.js';

/** Rows on screen this long count as seen: the server is told, the badge clears. */
const SEEN_AFTER_MS = 1000;

/**
 * Marks what is on screen read after a second, and remembers when it was
 * opened so the rows that were new THEN keep their rule until it closes —
 * the reader sees what was new; the badge is what clears.
 */
function useSeen(items: NotificationItem[]): string {
  const markRead = useNotifications((s) => s.markRead);
  const [openedAt] = useState(() => new Date().toISOString());
  const pending = items.filter((i) => i.readAt === null).map((i) => i.id);
  const key = pending.join(',');
  useEffect(() => {
    if (!key) return;
    const t = setTimeout(() => void markRead(key.split(',')), SEEN_AFTER_MS);
    return () => clearTimeout(t);
  }, [key, markRead]);
  return openedAt;
}

/** The list: outcome chip, amount, who, scores, when. `openedAt` keeps just-read rows looking new. */
export function InboxList({
  items,
  openedAt,
  onOpen,
}: {
  items: NotificationItem[];
  openedAt: string;
  onOpen?: (() => void) | undefined;
}) {
  const markRead = useNotifications((s) => s.markRead);
  if (items.length === 0)
    return (
      <p className="inbox-empty">
        Nothing yet. You'll hear here when someone takes your challenge and when a match settles.
      </p>
    );
  return (
    <ul className="inbox-list">
      {items.map((n) => {
        const tone = TONE[n.kind];
        const fresh = n.readAt === null || n.readAt >= openedAt;
        const scores = scoresText(n);
        return (
          <li key={n.id} className={`inbox-row ${tone}${fresh ? ' unread' : ''}`}>
            <Link
              to={`/challenge/${n.challengeId}`}
              onClick={() => {
                if (n.readAt === null) void markRead([n.id]);
                onOpen?.();
              }}
            >
              <span
                className={`chip ${tone === 'won' ? 'mint' : tone === 'lost' ? 'rose' : tone === 'taken' ? 'indigo' : ''}`}
              >
                {CHIP[tone]}
              </span>
              <span className="ir-main">
                {n.amount !== 0 && (
                  <b className="ir-amount">
                    {tone === 'won' && <Coin />}
                    {chainText(n.amount)}
                  </b>
                )}
                <span className="ir-line">{lineText(n)}</span>
              </span>
              <span className="ir-side">
                {scores && <span className="ir-scores">{scores}</span>}
                <time dateTime={n.createdAt}>{timeAgo(n.createdAt)}</time>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** "Notifications" + Mark all read, shared by the popover and the /inbox page. */
export function InboxHead({ onClose }: { onClose?: (() => void) | undefined }) {
  const unread = useNotifications((s) => s.unread);
  const markRead = useNotifications((s) => s.markRead);
  return (
    <div className="inbox-head">
      <h3 id="inbox-title">Notifications</h3>
      <div className="row">
        {unread > 0 && (
          <button className="btn ghost sm" onClick={() => void markRead()}>
            Mark all read
          </button>
        )}
        {onClose && (
          <button className="icon-btn sm" aria-label="Close" onClick={onClose}>
            <Icons.close />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The inbox under the avatar: a popover on a desktop, a bottom sheet on a
 * phone (≤ 600 px, styles). Escape, a click outside or a row closes it;
 * focus goes in on open and back to the avatar on close.
 */
export function InboxPopover({
  onClose,
  returnTo,
}: {
  onClose: () => void;
  returnTo: HTMLElement | null;
}) {
  const items = useNotifications((s) => s.items);
  const loaded = useNotifications((s) => s.loaded);
  const openedAt = useSeen(items);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
    return () => returnTo?.focus();
  }, [returnTo]);
  useEffect(() => sfx('inbox-open'), []);

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };

  return createPortal(
    <div className="inbox-layer" onClick={onClose}>
      <div
        ref={panel}
        className="inbox-pop"
        role="dialog"
        aria-labelledby="inbox-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <InboxHead onClose={onClose} />
        <div className="inbox-scroll">
          {loaded ? (
            <InboxList items={items} openedAt={openedAt} onOpen={onClose} />
          ) : (
            <p className="inbox-empty">Loading…</p>
          )}
        </div>
        <div className="inbox-foot">
          <Link to="/inbox" className="btn sm" onClick={onClose}>
            All notifications
          </Link>
          <Link to="/profile" className="inbox-profile" onClick={onClose}>
            Profile <Icons.arrow />
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The full page at /inbox — the same list with room to breathe. */
export function InboxPage() {
  const items = useNotifications((s) => s.items);
  const loaded = useNotifications((s) => s.loaded);
  const openedAt = useSeen(items);
  return (
    <div className="column wide">
      <div className="panel inbox-page">
        <InboxHead />
        {loaded ? (
          <InboxList items={items} openedAt={openedAt} />
        ) : (
          <p className="inbox-empty">Loading…</p>
        )}
      </div>
    </div>
  );
}
