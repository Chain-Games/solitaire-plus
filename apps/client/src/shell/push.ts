import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api/client.js';

/**
 * Web Push from the client's side.
 *
 *   unsupported   no service worker / PushManager / Notification here, or the
 *                 server has no VAPID keys (push is off)
 *   needs-install iOS Safari in the browser: push only works from a Home
 *                 Screen app there (16.4+), so the ask is "add to Home Screen"
 *   denied        the browser blocked notifications for this site
 *   off           possible, not on
 *   on            subscribed, and the server has the subscription
 *
 * The service worker (`public/sw.js`) is registered from main.tsx; it does
 * nothing but show pushes and open the challenge on a tap — no caching.
 */
export type PushState = 'unsupported' | 'needs-install' | 'off' | 'on' | 'denied' | 'checking';

export const SW_URL = '/sw.js';

function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Running as an installed (Home Screen) app. */
export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
  );
}

function supported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    window.isSecureContext
  );
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  // After load: the game's first paint must not share the network with it.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(SW_URL).catch(() => {
      // No push, nothing else changes.
    });
  });
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

/** The VAPID public key as the browser wants it. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Read the state once (used by the hook and by anything that needs it without React). */
export async function readPushState(): Promise<PushState> {
  // Every iOS browser is WebKit, and WebKit only pushes to a Home Screen app.
  if (isIOS() && !isStandalone()) return 'needs-install';
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    await api.pushVapid();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return 'unsupported';
    // A network blip: assume the server can, and let enable() find out.
  }
  try {
    const sub = await currentSubscription();
    return sub ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

export interface PushControls {
  state: PushState;
  /** Ask for permission, subscribe, tell the server. Resolves to the new state. */
  enable: () => Promise<PushState>;
  disable: () => Promise<PushState>;
  refresh: () => Promise<void>;
}

export function usePush(): PushControls {
  const [state, setState] = useState<PushState>('checking');

  const refresh = useCallback(async () => {
    setState(await readPushState());
  }, []);

  useEffect(() => {
    let alive = true;
    void readPushState().then((s) => alive && setState(s));
    return () => {
      alive = false;
    };
  }, []);

  const enable = useCallback(async (): Promise<PushState> => {
    let next: PushState;
    try {
      next = await enablePush();
    } catch {
      next = await readPushState();
    }
    setState(next);
    return next;
  }, []);

  const disable = useCallback(async (): Promise<PushState> => {
    try {
      const sub = await currentSubscription();
      if (sub) {
        await sub.unsubscribe();
        await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
      }
    } catch {
      // the state below says what is true
    }
    const next = await readPushState();
    setState(next);
    return next;
  }, []);

  return { state, enable, disable, refresh };
}

async function enablePush(): Promise<PushState> {
  if (isIOS() && !isStandalone()) return 'needs-install';
  if (!supported()) return 'unsupported';
  const { publicKey } = await api.pushVapid();
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return 'denied';
  if (permission !== 'granted') return 'off';
  const reg = await navigator.serviceWorker.register(SW_URL);
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    }));
  await api.pushSubscribe(sub.toJSON());
  return 'on';
}
