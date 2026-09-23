import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useOutlet,
} from 'react-router-dom';
import type { XpProgress } from './api/client.js';
import { installUiAudio } from './audio/ui.js';
import { useNotifications } from './state/notifications.js';
import { useRankUp } from './state/rankup.js';
import { useSession } from './state/session.js';
import { Auth } from './screens/Auth.js';
import { ChallengeDetail } from './screens/ChallengeDetail.js';
import { CreateChallenge } from './screens/CreateChallenge.js';
import { History } from './screens/History.js';
import { Home } from './screens/Home.js';
import { PlayChallenge, PlaySolo } from './screens/Play.js';
import { Profile } from './screens/Profile.js';
import { TakeChallenge } from './screens/TakeChallenge.js';
import { Backdrop } from './shell/Backdrop.js';
import { backdropWorld } from './shell/backdrop-world.js';
import { useSoloLaunch } from './shell/handoff.js';
import { InboxPage, InboxPopover } from './shell/Inbox.js';
import { NotifyToasts } from './shell/NotifyToast.js';
import { sfx } from './shell/sfx.js';
import { Avatar, Coin, Loading, Logo } from './shell/ui.js';
import { TutorialLayer } from './tutorial/Tutorial.js';

/** Past this scroll the glass bar takes more ink (the hero's smear under it). */
const SCROLLED_PX = 40;

/** Single-column routes centre their card in the remaining height. */
const CENTRED = new Set(['/auth', '/create']);
const isCentred = (pathname: string) => CENTRED.has(pathname) || pathname.startsWith('/challenge/');

function Shell() {
  const { user, loading } = useSession();
  const location = useLocation();
  const home = location.pathname === '/';
  const centred = isCentred(location.pathname);
  const navClass = ({ isActive }: { isActive: boolean }) => (isActive && !loading ? 'active' : '');
  const launchSolo = useSoloLaunch();
  // Back in the shell (from a game, or fresh): the backdrop returns to its own ground —
  // dissolving from the world the game left, when there was one.
  useEffect(() => backdropWorld.set(null), []);
  // A rank crossing the session has seen plays here, where the badges are. A LAYOUT effect: the
  // firing re-renders every placement into the state before the crossing BEFORE the browser
  // paints the render that carried the new rank, so no frame ever shows the new level first.
  const armed = useRankUp((s) => s.armed);
  const fire = useRankUp((s) => s.fire);
  const setShellUp = useRankUp((s) => s.setShellUp);
  useLayoutEffect(() => {
    setShellUp(true);
    if (armed) fire();
    return () => setShellUp(false);
  }, [armed, fire, setShellUp]);
  // Every press in the shell has its cue (the engine decides whether it sounds).
  // Outside a game the shared UI engine (audio/ui.ts) is the one that sounds.
  useEffect(() => installUiAudio(), []);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('.btn, .seg-item, .icon-btn, .mode-card, .avatar-link')) sfx('ui-press');
    };
    // A fine pointer entering a press target: the near-silent hover tick (the engine caps it at 12/s).
    const fine = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
    const onOver = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      const hit = el?.closest('.btn, .seg-item, .icon-btn, .mode-card, .avatar-link');
      if (hit && !(e.relatedTarget instanceof Element && hit.contains(e.relatedTarget)))
        sfx('ui-hover');
    };
    document.addEventListener('pointerdown', onDown, { passive: true });
    if (fine) document.addEventListener('pointerover', onOver, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointerover', onOver);
    };
  }, []);
  // On home the hero carries the wordmark: the header's only shows once the
  // hero has scrolled out, so there is one wordmark per viewport.
  const [heroGone, setHeroGone] = useState(false);
  // Content under the glass bar: more ink once the page has scrolled.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > SCROLLED_PX);
    onScroll();
    addEventListener('scroll', onScroll, { passive: true });
    return () => removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (!home) return;
    const hero = document.querySelector('.hero-logo');
    if (!hero || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setHeroGone(e ? !e.isIntersecting : false), {
      threshold: 0.05,
    });
    io.observe(hero);
    return () => io.disconnect();
  }, [home]);
  return (
    <div className="app">
      <Backdrop />
      <header
        className={`topbar${home && !heroGone ? ' brand-hidden' : ''}${scrolled ? ' scrolled' : ''}`}
      >
        <div className="topbar-inner">
          <Link to="/" className="brand" aria-label="Solitaire Plus home">
            <img
              className="brand-mark"
              src="/brand/mark-64.png"
              srcSet="/brand/mark-64.png 1x, /brand/mark-128.png 2x"
              width={28}
              height={28}
              alt=""
              decoding="async"
              aria-hidden
            />
            <Logo size={88} />
          </Link>
          <nav className="topnav" aria-label="Primary">
            {/* No lit pill while the session is still being checked. */}
            <NavLink to="/play/solo" className={navClass} onClick={launchSolo}>
              Play
            </NavLink>
            <NavLink to="/create" className={navClass}>
              Create
            </NavLink>
            <NavLink to="/take" className={navClass}>
              Take
            </NavLink>
            {user && <NavLink to="/history">History</NavLink>}
          </nav>
          <div className="top-right">
            {loading ? (
              <span className="skeleton pill" aria-hidden />
            ) : user ? (
              <>
                <Link
                  to="/profile"
                  className="balance"
                  title="Mock $CHAIN balance (off-chain alpha)"
                >
                  <Coin />
                  <b>
                    <CountTo value={user.balance} />
                  </b>
                  <small>$CHAIN</small>
                </Link>
                <DailyToast />
                <AvatarMenu username={user.username} xp={user} />
              </>
            ) : location.pathname !== '/auth' ? (
              <Link to="/auth" className="btn sm">
                Sign in
              </Link>
            ) : null}
          </div>
        </div>
      </header>
      <main className={`page${centred ? ' centred' : ''}`}>
        <RouteFade />
      </main>
      <NotifyToasts />
    </div>
  );
}

/** The outgoing screen leaves when its fade ends; this is the belt to that braces (styles: --t-page is 180 ms). */
const ROUTE_FALLBACK_MS = 1000;

/**
 * The route container: the incoming screen rises 6 px through a fade while
 * the outgoing one, kept for ROUTE_MS in a layer above the ground, fades out
 * — a cross-fade on every route, never a hard swap. The outgoing screen is
 * the element the outlet last rendered for its path (its route context
 * travels with it), inert and hidden from assistive tech. Reduced motion:
 * the swap.
 */
function RouteFade() {
  const { pathname } = useLocation();
  const outlet = useOutlet();
  const prev = useRef<{ key: string; el: ReactElement | null }>({ key: pathname, el: outlet });
  const [leaving, setLeaving] = useState<{ key: string; el: ReactElement | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    if (prev.current.key === pathname) {
      prev.current.el = outlet;
      return;
    }
    const out = prev.current;
    prev.current = { key: pathname, el: outlet };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setLeaving(out);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setLeaving(null), ROUTE_FALLBACK_MS);
  });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <>
      {leaving && (
        <div
          className={`route leaving${isCentred(leaving.key) ? ' centred' : ''}`}
          key={`out:${leaving.key}`}
          aria-hidden
          inert
          onAnimationEnd={(e) => e.target === e.currentTarget && setLeaving(null)}
        >
          {leaving.el}
        </div>
      )}
      <div className="route" key={pathname}>
        {outlet}
      </div>
    </>
  );
}

/**
 * The avatar with its unread badge: a button that opens the inbox popover
 * (a sheet on a phone). The profile stays a tap away at the popover's foot.
 */
function AvatarMenu({ username, xp }: { username: string; xp: XpProgress }) {
  const unread = useNotifications((s) => s.unread);
  const sweep = useRankUp((s) => s.active);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  // A route change (a row tapped, a link followed) closes it.
  useEffect(() => setOpen(false), [location.pathname]);
  const label =
    unread > 0
      ? `${unread} unread notification${unread === 1 ? '' : 's'} · ${username}`
      : `Notifications · ${username}`;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`avatar-link${unread > 0 ? ' has-unread' : ''}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar name={username} xp={xp} sweep={sweep} />
        {unread > 0 && (
          <span className="unread-dot" aria-hidden>
            {unread > 1 ? (unread > 9 ? '9+' : unread) : ''}
          </span>
        )}
      </button>
      {open && <InboxPopover onClose={() => setOpen(false)} returnTo={button.current} />}
    </>
  );
}

/** The balance's number counting to its new value over 600 ms whenever it changes (snaps under reduced motion). */
function CountTo({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (start === value) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = value;
      setShown(value);
      return;
    }
    // The clock is the frame's own (never performance.now(): a slowed document timeline —
    // the capture harness — would put the two clocks apart).
    let t0 = 0;
    let raf = 0;
    const tick = (now: number) => {
      if (!t0) t0 = now;
      const p = Math.max(0, Math.min(1, (now - t0) / COUNT_MS));
      const e = 1 - Math.pow(1 - p, 3);
      const v = Math.round(start + (value - start) * e);
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value]);
  return <>{shown.toLocaleString()}</>;
}

const COUNT_MS = 600;

function RequireUser() {
  const { user, loading } = useSession();
  const location = useLocation();
  if (loading)
    return (
      <div className="session-wait">
        <Loading label="Checking session" />
      </div>
    );
  if (!user) return <Navigate to="/auth" state={{ from: location.pathname }} replace />;
  return <Outlet />;
}

export function App() {
  const refresh = useSession((s) => s.refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // The live feed follows the session: connected while someone is signed in.
  const userId = useSession((s) => s.user?.id);
  const connect = useNotifications((s) => s.connect);
  const disconnect = useNotifications((s) => s.disconnect);
  useEffect(() => {
    if (userId) connect();
    else disconnect();
    return disconnect;
  }, [userId, connect, disconnect]);

  return (
    <>
      <Routes>
        <Route path="/play/solo" element={<PlaySolo />} />
        <Route element={<RequireUser />}>
          <Route path="/play/:gameId" element={<PlayChallenge />} />
        </Route>
        <Route element={<Shell />}>
          <Route index element={<Home />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/profile/:username" element={<Profile />} />
          <Route element={<RequireUser />}>
            <Route path="/profile" element={<Profile />} />
            <Route path="/create" element={<CreateChallenge />} />
            <Route path="/take" element={<TakeChallenge />} />
            <Route path="/challenge/:id" element={<ChallengeDetail />} />
            <Route path="/history" element={<History />} />
            <Route path="/inbox" element={<InboxPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      {/* The tutorial rides over whatever screen asked for it (a first deal, the home button). */}
      <TutorialLayer />
    </>
  );
}

/**
 * "+100 $CHAIN daily top-up" — shown once when /me just credited it, then
 * fades. Lives next to the balance pill so the number and the reason read
 * together.
 */
function DailyToast() {
  const amount = useSession((s) => s.dailyGranted);
  const clear = useSession((s) => s.clearDailyGranted);
  useEffect(() => {
    if (!amount) return;
    const t = setTimeout(clear, 4200);
    return () => clearTimeout(t);
  }, [amount, clear]);
  if (!amount) return null;
  return (
    <div className="daily-toast" role="status">
      <Coin /> +{amount} $CHAIN daily top-up
    </div>
  );
}
