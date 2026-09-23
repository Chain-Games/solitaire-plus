import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { NotificationItem } from '../api/client.js';
import { useNotifications } from '../state/notifications.js';
import {
  CHIP,
  TONE,
  chainText,
  lineText,
  scoresText,
  suffixText,
  summaryText,
} from './notify-copy.js';
import { payoutCoin, pulsePill } from './money.js';
import { sfx } from './sfx.js';
import { Coin, Icons } from './ui.js';

/** How long a toast stays before it leaves on its own. */
export const TOAST_MS = 6000;
/** Sideways travel that counts as a swipe-to-dismiss. */
const SWIPE_PX = 72;
/** Under this the pointer did not move: it was a tap. */
const TAP_PX = 6;

/**
 * The live notification toasts: bottom-centre on a phone, top-right on a
 * desktop, at most three stacked (state/notifications.ts). Each auto-dismisses
 * after six seconds with a hairline counting it down (paused while hovered
 * or focused), swipes or ✕ away, and taps through to the challenge.
 */
export function NotifyToasts() {
  const toasts = useNotifications((s) => s.toasts);
  if (toasts.length === 0) return null;
  return createPortal(
    <div className="notify-stack" aria-label="Notifications">
      {toasts.map((t) => (
        <Toast key={t.id} item={t} />
      ))}
    </div>,
    document.body,
  );
}

function Toast({ item }: { item: NotificationItem }) {
  const navigate = useNavigate();
  const dismiss = useNotifications((s) => s.dismissToast);
  const markRead = useNotifications((s) => s.markRead);
  const tone = TONE[item.kind];
  const [dx, setDx] = useState(0);
  const [hold, setHold] = useState(false);
  const [leaving, setLeaving] = useState<'left' | 'right' | null>(null);
  const drag = useRef<{ x0: number; id: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // Arrival: the cue, and on a payout the toast's coin flies to the balance pill, which
  // pulses as its number counts up (the session refresh waits for the landing).
  useEffect(() => {
    sfx('toast-in');
    if (tone === 'won') void payoutCoin(root.current?.querySelector('.nt-amount .coin') ?? null);
    else if (item.kind === 'challenge_expired') pulsePill();
  }, [tone, item.kind]);

  // Auto-dismiss on a clock that pauses while the toast is held (hover,
  // focus, drag) and resumes with what was left.
  const left = useRef(TOAST_MS);
  const since = useRef(0);
  useEffect(() => {
    if (hold || leaving) return;
    since.current = performance.now();
    const t = setTimeout(() => dismiss(item.id), left.current);
    return () => {
      clearTimeout(t);
      left.current = Math.max(0, left.current - (performance.now() - since.current));
    };
  }, [hold, leaving, dismiss, item.id]);

  const open = () => {
    void markRead([item.id]);
    dismiss(item.id);
    navigate(`/challenge/${item.challengeId}`);
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { x0: e.clientX, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    setHold(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    setDx(e.clientX - drag.current.x0);
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    const travelled = e.clientX - drag.current.x0;
    drag.current = null;
    setHold(false);
    if (Math.abs(travelled) >= SWIPE_PX) {
      setLeaving(travelled < 0 ? 'left' : 'right');
      setTimeout(() => dismiss(item.id), 160);
      return;
    }
    setDx(0);
    // A tap on the body (not the ✕) opens the challenge.
    if (Math.abs(travelled) < TAP_PX && !(e.target as HTMLElement).closest('.nt-close')) open();
  };

  const scores = scoresText(item);
  const remaining = left.current / TOAST_MS;
  return (
    <div
      ref={root}
      className={`notify-toast ${tone}${hold ? ' held' : ''}${leaving ? ` leave-${leaving}` : ''}`}
      style={{ '--dx': `${dx}px`, '--left': remaining } as CSSProperties}
      role="status"
      aria-label={summaryText(item)}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onMouseEnter={() => setHold(true)}
      onMouseLeave={() => !drag.current && setHold(false)}
      onFocus={() => setHold(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setHold(false)}
    >
      <button
        className="nt-body"
        onClick={(e) => {
          // Pointer taps are handled on the toast (so a swipe never also opens);
          // this is the keyboard's way in.
          if (e.detail === 0) open();
        }}
      >
        <span className="nt-eyebrow">
          {tone === 'won' ? 'You won' : tone === 'lost' ? 'You lost' : CHIP[tone]}
        </span>
        {tone === 'won' && (
          <span className="nt-amount">
            <Coin />
            {chainText(item.amount)}
          </span>
        )}
        {tone === 'lost' && <span className="nt-amount">{chainText(item.amount)}</span>}
        <span className="nt-line">
          {lineText(item)}
          {suffixText(item) && <span className="nt-suffix">{suffixText(item)}</span>}
        </span>
        {scores && <span className="nt-scores">{scores}</span>}
      </button>
      <span className="nt-close">
        <button className="icon-btn sm" aria-label="Dismiss" onClick={() => dismiss(item.id)}>
          <Icons.close />
        </button>
      </span>
      <i className="nt-hairline" aria-hidden />
    </div>
  );
}
