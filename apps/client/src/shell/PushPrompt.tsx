import { useState } from 'react';
import { usePush, type PushState } from './push.js';
import { Icons } from './ui.js';

/** Once dismissed, the card stays away this long. */
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const KEY = 'solitaire.push.prompt';

function snoozed(): boolean {
  try {
    const at = Number(localStorage.getItem(KEY) ?? 0);
    return Date.now() - at < SNOOZE_MS;
  } catch {
    return false;
  }
}

function snooze(): void {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {
    // ignore
  }
}

/**
 * The one ask, on the challenge page the creator lands on: "Get told when
 * someone takes it" with [Turn on notifications] — or, on iOS Safari in the
 * browser, how to add Solitaire Plus to the Home Screen, which is the only way
 * push reaches an iPhone. Dismissible; stays away a week; gone for good
 * once notifications are on, blocked or impossible here.
 */
export function PushPrompt({ force }: { force?: PushState | undefined }) {
  const push = usePush();
  const [hidden, setHidden] = useState(snoozed);
  const [busy, setBusy] = useState(false);
  const state = force ?? push.state;
  if (hidden || (state !== 'off' && state !== 'needs-install')) return null;

  const dismiss = () => {
    snooze();
    setHidden(true);
  };

  const turnOn = async () => {
    setBusy(true);
    const next = await push.enable();
    setBusy(false);
    if (next === 'on' || next === 'denied') setHidden(true);
  };

  return (
    <div className="push-prompt" role="region" aria-label="Notifications">
      <button className="pp-close icon-btn sm" aria-label="Not now" onClick={dismiss}>
        <Icons.close />
      </button>
      <span className="pp-icon" aria-hidden>
        {state === 'needs-install' ? <Icons.share /> : <BellIcon />}
      </span>
      <b className="pp-title">
        <span className="pp-long">Get told when someone takes it</span>
        <span className="pp-short">Get told when it&rsquo;s taken</span>
      </b>
      {state === 'needs-install' ? (
        <span className="pp-body">
          Add Solitaire Plus to your Home Screen to get notifications: tap{' '}
          <b className="nowrap">
            Share{' '}
            <span className="pp-glyph">
              <Icons.share />
            </span>
          </b>{' '}
          then <b className="nowrap">Add to Home Screen</b>.
        </span>
      ) : (
        <>
          <span className="pp-body">Even with Solitaire Plus closed — and when the match settles.</span>
          <button className="btn primary sm" onClick={() => void turnOn()} disabled={busy}>
            {busy ? 'Asking…' : 'Turn on notifications'}
          </button>
        </>
      )}
    </div>
  );
}

export function BellIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </svg>
  );
}
