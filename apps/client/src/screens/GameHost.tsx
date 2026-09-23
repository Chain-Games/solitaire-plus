import {
  RULES,
  isError,
  legalPlacements,
  place,
  type GameEvent,
  type ScoreBreakdown,
  type TimedMove,
} from '@solitaire-plus/sim';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AudioEngine } from '../audio/engine.js';
import { GameController } from '../game/controller.js';
import { Playfield, type ResolutionInfo } from '../render/playfield.js';
import { worldFor } from '../render/world-table.js';
import { resultsPanelRect, type ResultsOutcome } from '../render/results-scene.js';
import { QUALITY_TIERS, type QualityTier } from '../render/quality.js';
import { renderShareCard } from '../share/card.js';
import { useNotifications } from '../state/notifications.js';
import { useSettings, type Volumes } from '../state/settings.js';
import { usePush, type PushState } from '../shell/push.js';
import { registerSfxEngine } from '../shell/sfx.js';
import { HapticsRow, Icons, Logo, MiniBoard, Segmented, Switch } from '../shell/ui.js';
import type { ResultsFx } from './ResultsXp.js';

export type Phase =
  'loading' | 'ready' | 'countdown' | 'playing' | 'paused' | 'ending' | 'ended' | 'error';

export interface GameHostProps {
  seed: string;
  pausable: boolean;
  modeLabel: string;
  resume?: { moves: readonly TimedMove[]; elapsedMs: number } | undefined;
  /** Called when the player taps start. Return when the clock may begin. */
  onStart?: (() => Promise<void>) | undefined;
  /** Called after every placement with the full move list. */
  onMove?: ((moves: readonly TimedMove[]) => void) | undefined;
  /** Called once when the sim ends. Return when the result has been recorded. */
  onEnd?: ((breakdown: ScoreBreakdown, moves: readonly TimedMove[]) => Promise<void>) | undefined;
  onQuit: () => void;
  /**
   * Rendered inside the results tray under the breakdown; `fx` reaches the
   * engine and the audio for the XP beats. `live` is false while the tray is
   * only being measured (hidden, during the ceremony) and until the scene
   * says its own beats are done (the rows in; on a win, the last coin gone —
   * the scene's clock, never the wall's), so nothing in it may start its
   * beat until it is true.
   */
  renderResultActions: (breakdown: ScoreBreakdown, fx: ResultsFx, live: boolean) => React.ReactNode;
  readyCopy: string;
  /** Personal best, shown in the HUD (solo). */
  best?: number | undefined;
  /**
   * A challenge's outcome for the results hero: known, `'pending'` (the
   * opponent has played; the server settles it once this game is submitted),
   * or null / absent (solo, a creator waiting: the plain headline).
   */
  outcome?: ResultsOutcome | 'pending' | null | undefined;
}

/**
 * Mounts the playfield and owns the game's lifecycle overlays. All rendering is
 * Pixi; React here only shows the ready / pause / results dialogs.
 */
/** The tray's content never gets narrower than this: below it, buttons and the XP beat overflow to the right. */
const TRAY_MIN_CONTENT_PX = 300;
const TRAY_MIN_PAD_PX = 16;

/**
 * Where the tray docks. On a short window the board — and so the panel — is
 * small; the breakdown column's inset would leave the tray's content
 * narrower than it can be, and its children overflowed past the panel's
 * right edge. The inset shrinks to keep the content width, and when even
 * the panel is too narrow the tray widens past it, centred on it.
 */
function trayDock(x: number, y: number, w: number, r: number, inset: number, shift: number) {
  const minW = TRAY_MIN_CONTENT_PX + 2 * TRAY_MIN_PAD_PX;
  const width = Math.max(w, minW);
  const left = x - (width - w) / 2;
  const pad = Math.max(TRAY_MIN_PAD_PX, Math.min(inset, (width - TRAY_MIN_CONTENT_PX) / 2));
  return { x: left, y, w: width, r, inset: pad, shift };
}

export function GameHost(props: GameHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [breakdown, setBreakdown] = useState<ScoreBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** What the renderer draws at (the settings sheet's Quality hint); null until init. */
  const [resolution, setResolution] = useState<ResolutionInfo | null>(null);
  const quality = useSettings((s) => s.quality);
  const sound = useSettings((s) => s.sound);
  const volumes = useSettings((s) => s.volumes);
  const setVolume = useSettings((s) => s.setVolume);
  const setQuality = useSettings((s) => s.setQuality);
  const setSound = useSettings((s) => s.setSound);

  const session = useRef<{
    controller: GameController;
    playfield: Playfield;
    audio: AudioEngine;
  } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    const controller = new GameController({
      seed: props.seed,
      pausable: props.pausable,
      resume: props.resume,
    });
    const audio = new AudioEngine(useSettings.getState().sound);
    audio.setMix(useSettings.getState().volumes);
    const playfield = new Playfield({
      controller,
      quality: useSettings.getState().quality,
      parent,
      modeLabel: props.modeLabel,
      best: props.best,
      ssaaCap: useSettings.getState().ssaaCap,
    });
    session.current = { controller, playfield, audio };
    // The supersampling governor stepped down: the session keeps the cap so
    // the next game starts there, and the settings hint follows.
    playfield.onResolutionStep = (info) => {
      useSettings.getState().setSsaaCap(info.resolution);
      setResolution(info);
    };
    playfield.onRejected = () => audio.rejected();
    playfield.onCountdown = (v) => audio.countdown(v);
    // The feel cues (`place` / `place-heavy` at the landing's contact,
    // `end-slow` at the game's end): the audio engine maps the names
    // (docs/audio.md); until it has a `cue`, they are dropped here.
    playfield.onCue = (name) => audio.cue(name);
    playfield.onClock = (ms) => audio.setClock(ms);
    playfield.onHeat = (h) => audio.setHeat?.(h);
    // The world's ambience bed (docs/audio.md); the shell's cues route to this engine while it lives.
    audio.setWorld(worldFor(props.seed).id);
    registerSfxEngine({ cue: (name) => audio.cue(name), rankUp: () => audio.rankUp() });
    playfield.onResultsBeat = (k) => {
      if (k === 'xp-go') setXpGo(true);
      else audio.resultsBeat?.(k);
    };
    if (new URLSearchParams(location.search).has('debug')) {
      // Tooling hook (capture harness, critics): the live session plus the sim for planning moves.
      (window as unknown as { __blockari?: unknown }).__blockari = {
        ...session.current,
        sim: { place, isError, legalPlacements },
        // The share card renderer, so a proof script can draw a card for any result.
        share: { renderShareCard },
      };
    }

    const unsub = controller.subscribe((e: GameEvent) => {
      audio.handle(e);
      if (e.type === 'piecePlaced') propsRef.current.onMove?.(controller.moves);
      if (e.type === 'ended') {
        setBreakdown(e.breakdown);
        setPhase('ending');
        // The results play in-engine (the cinematic) while the server records
        // the game; the buttons appear when both are done.
        // A solo run the player ended is over, not forfeited; challenge quits forfeit.
        const cinematic = playfield.playResults(
          e.breakdown,
          propsRef.current.pausable ? 'RUN OVER' : undefined,
          propsRef.current.outcome ?? null,
        );
        const done = propsRef.current.onEnd?.(e.breakdown, controller.moves) ?? Promise.resolve();
        // The tray has everything it will show once the result is recorded
        // (the XP beat, the outcome): measure it for the panel's fit. If the
        // recording failed there will be no outcome: the scene stops waiting.
        const settle = (): void => setSettled(true);
        const failed = (): void => {
          settle();
          playfield.setResultsOutcome(null);
        };
        Promise.all([cinematic, done.then(settle, failed)]).then(
          () => setPhase('ended'),
          (err: unknown) => {
            setError(err instanceof Error ? err.message : 'Could not submit result');
            setPhase('ended');
          },
        );
      }
    });

    let cancelled = false;
    playfield.init().then(
      () => {
        if (cancelled) return;
        playfield.lockInput(true);
        setResolution(playfield.resolutionInfo);
        setPhase(controller.current.status === 'ended' ? 'ended' : 'ready');
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Renderer failed to start');
        setPhase('error');
      },
    );

    const unlock = () => audio.unlock();
    parent.addEventListener('pointerdown', unlock, { passive: true });

    const onVisibility = () => {
      if (
        document.hidden &&
        controller.pausable &&
        controller.started &&
        !controller.paused &&
        controller.current.status === 'playing'
      ) {
        controller.pause();
        playfield.lockInput(true);
        setPhase('paused');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      unsub();
      parent.removeEventListener('pointerdown', unlock);
      document.removeEventListener('visibilitychange', onVisibility);
      playfield.destroy();
      registerSfxEngine(null);
      audio.dispose();
      session.current = null;
    };
    // The game is created once per mount; a new seed means a new mount (key on the parent).
  }, []);

  // Nothing is ever toasted over the board: while the game runs (and through
  // the results cinematic) notifications queue and show on the results tray.
  const setInGame = useNotifications((s) => s.setInGame);
  useEffect(() => {
    setInGame(
      phase === 'countdown' || phase === 'playing' || phase === 'paused' || phase === 'ending',
    );
  }, [phase, setInGame]);
  useEffect(() => () => setInGame(false), [setInGame]);

  useEffect(() => {
    const pf = session.current?.playfield;
    if (!pf) return;
    pf.setQuality(quality);
    // After init the tier may have changed the supersampling factor.
    if (pf.app.renderer) setResolution(pf.resolutionInfo);
  }, [quality]);
  useEffect(() => {
    session.current?.playfield.setBest(props.best);
  }, [props.best]);
  // The outcome arrives after the results begin (the server settles it on
  // submission); null after 'pending' means it will not come.
  useEffect(() => {
    const o = props.outcome;
    if (o === 'pending') return;
    session.current?.playfield.setResultsOutcome(o ?? null);
  }, [props.outcome]);
  useEffect(() => {
    session.current?.audio.setEnabled(sound);
  }, [sound]);
  useEffect(() => {
    session.current?.audio.setMix(volumes);
  }, [volumes]);

  const start = async () => {
    const s = session.current;
    if (!s) return;
    s.audio.unlock();
    setPhase('loading');
    try {
      await props.onStart?.();
      setPhase('countdown');
      if (!props.resume) await s.playfield.startCountdown();
      s.controller.start();
      s.playfield.lockInput(false);
      setPhase('playing');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start');
      setPhase('error');
    }
  };

  const pause = () => {
    const s = session.current;
    if (!s || !s.controller.pausable) return;
    s.controller.pause();
    s.playfield.lockInput(true);
    setPhase('paused');
  };

  const resume = () => {
    const s = session.current;
    if (!s) return;
    s.controller.resume();
    s.playfield.lockInput(false);
    setPhase('playing');
  };

  const forfeit = () => {
    session.current?.controller.forfeit();
  };

  // The results tray docks to the engine's panel. It is rendered — hidden —
  // from the moment the game ends, so its height is measured before the
  // score counts and the panel can make room for it (the rank-up's stage is
  // reserved from the tray's first frame): the scene decides the fit
  // (results-layout.ts) and answers with the edge to dock to.
  const [dock, setDock] = useState<{
    x: number;
    y: number;
    w: number;
    r: number;
    inset: number;
    /** How far the ceremony (and the tray with it) is shifted up so the tray fits on screen. */
    shift: number;
  } | null>(null);
  const trayRef = useRef<HTMLDivElement | null>(null);
  /** The result is recorded: the tray shows everything it will (the XP beat, the outcome). */
  const [settled, setSettled] = useState(false);
  /** The scene's beats are done (its 'xp-go'): the tray's own beat may start. */
  const [xpGo, setXpGo] = useState(false);
  // The XP beats reach the table and the mix: the rank-up's rim pulse and
  // sheen in the rank colour, the level-up chime once, the rank-up's twice.
  const resultsFx = useRef<ResultsFx>({
    rankUp: (i) => {
      session.current?.playfield.rankUp(i);
      session.current?.audio.rankUp();
    },
    levelUp: () => session.current?.audio.xpLevelUp(),
  });
  useEffect(() => {
    if (phase !== 'ending' && phase !== 'ended') return;
    const measure = () => {
      const pf = session.current?.playfield;
      const tray = trayRef.current;
      if (!pf || !tray) return;
      const safe = safeInsets();
      const fit = pf.fitResults({
        trayH: tray.offsetHeight,
        viewportH: window.innerHeight,
        safeTop: safe.top,
        safeBottom: safe.bottom,
        final: settled,
      });
      if (fit) {
        setDock(trayDock(fit.x, fit.y, fit.w, fit.r, fit.inset, fit.shift));
        return;
      }
      const P = resultsPanelRect(pf.layoutInfo);
      setDock(trayDock(P.x, P.y + P.h, P.w, P.r, P.inset, 0));
    };
    measure();
    // Measure again once the tray has rendered at its docked width, and
    // whenever it grows (the XP beat arrives; its rank-up ceremony expands it).
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    const ro =
      typeof ResizeObserver !== 'undefined' && trayRef.current
        ? new ResizeObserver(() => measure())
        : null;
    if (ro && trayRef.current) ro.observe(trayRef.current);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [phase, settled]);

  // Pause header: the score and the clock as they stood when the game paused.
  const paused = phase === 'paused' ? snapshot(session.current?.controller) : null;

  const inPlay = phase === 'playing' || phase === 'paused';
  const settingsOpen =
    phase === 'paused' ||
    (showSettings && (phase === 'playing' || phase === 'ready' || phase === 'ended'));

  return (
    <div className="game-root">
      <div className="game-canvas" ref={containerRef} />
      <div className="game-chrome">
        <button
          className="icon-btn"
          aria-label={inPlay ? (props.pausable ? 'Pause' : 'Options') : 'Quit'}
          onClick={() =>
            inPlay
              ? props.pausable
                ? (pause(), setShowSettings(false))
                : setShowSettings(true)
              : props.onQuit()
          }
        >
          <Icons.close />
        </button>
        <div className="row">
          <button
            className="icon-btn"
            aria-label="Settings"
            onClick={() => {
              // Not during the countdown, the results run-in or a load: the
              // panel would otherwise pop up on its own once play starts. On
              // the results screen it opens like anywhere else (a gear that
              // does nothing reads as broken).
              if (
                phase !== 'ready' &&
                phase !== 'playing' &&
                phase !== 'paused' &&
                phase !== 'ended'
              )
                return;
              if (props.pausable && phase === 'playing') pause();
              setShowSettings(true);
            }}
          >
            <Icons.gear />
          </button>
        </div>
      </div>

      {phase === 'loading' && (
        <div className="overlay">
          <div className="loading-block">
            <div className="spinner" style={{ margin: 0 }} />
            <span>Setting the table</span>
          </div>
        </div>
      )}

      {phase === 'ready' && (
        <div className="overlay">
          <div className="dialog" role="dialog" aria-labelledby="start-title">
            <div className="dialog-logo">
              <Logo size={150} />
            </div>
            <div className="kicker">
              <span className="chip mint">{props.modeLabel}</span>
            </div>
            <h2 id="start-title">Ready?</h2>
            <HowToStrip />
            <p className="lede">{props.readyCopy}</p>
            <div className="actions">
              <button className="btn primary block lg" onClick={() => void start()} autoFocus>
                Start <span className="kbd">· {RULES.durationMs / 60000}:00 on the clock</span>
              </button>
              <button className="btn ghost block" onClick={props.onQuit}>
                Back
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="overlay">
          <div className="dialog" role="dialog" aria-labelledby="settings-title">
            <h2 id="settings-title">{phase === 'paused' ? 'Paused' : 'Settings'}</h2>
            {paused && (
              <div className="pause-strip" aria-label="Game so far">
                <div className="stat">
                  <span className="t-label">Score</span>
                  <b>{paused.score.toLocaleString()}</b>
                </div>
                <div className="stat">
                  <span className="t-label">Left</span>
                  <b>{paused.left}</b>
                </div>
                <span className="chip mint">{props.modeLabel}</span>
              </div>
            )}
            {paused && <div className="divider labelled">Settings</div>}
            <SettingsPanel
              quality={quality}
              setQuality={setQuality}
              resolution={resolution}
              sound={sound}
              setSound={setSound}
              volumes={volumes}
              setVolume={setVolume}
            />
            <div className="actions">
              {phase === 'paused' ? (
                <button
                  className="btn primary block lg"
                  onClick={() => {
                    setShowSettings(false);
                    resume();
                  }}
                  autoFocus
                >
                  Resume
                </button>
              ) : (
                <button
                  className="btn primary block lg"
                  onClick={() => setShowSettings(false)}
                  autoFocus
                >
                  {phase === 'playing' ? 'Back to the game' : 'Done'}
                </button>
              )}
              {(phase === 'playing' || phase === 'paused') && (
                <button
                  className={`btn block ${props.pausable ? 'ghost' : 'danger'}`}
                  onClick={() => {
                    setShowSettings(false);
                    if (props.pausable) props.onQuit();
                    else forfeit();
                  }}
                >
                  {props.pausable ? 'Quit game' : 'Forfeit — submit current score'}
                </button>
              )}
              {!props.pausable && phase === 'playing' && (
                <p className="lede">Challenge games can't be paused; the clock is running.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {(phase === 'ending' || phase === 'ended') && breakdown && (
        <div className="overlay actions-only">
          <div
            ref={trayRef}
            className={`results-tray${dock ? ' docked' : ''}${phase === 'ending' ? ' measuring' : ''}`}
            style={
              dock
                ? ({
                    // The panel's 1 px stroke is centred on its edge: straddle it.
                    left: dock.x - 0.5,
                    // Docked to the panel's bottom edge, already shifted with
                    // the ceremony when the block would not fit (see measure).
                    top: dock.y,
                    width: dock.w + 1,
                    '--dock-r': `${dock.r}px`,
                    '--dock-inset': `${dock.inset}px`,
                  } as CSSProperties)
                : undefined
            }
            aria-hidden={phase === 'ending'}
          >
            {error ? (
              <div className="error" role="alert" style={{ marginBottom: 8 }}>
                <Icons.alert />
                <span>{error}</span>
              </div>
            ) : null}
            <div className="result-flow">
              {props.renderResultActions(breakdown, resultsFx.current, phase === 'ended' && xpGo)}
            </div>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="overlay">
          <div className="dialog" role="alertdialog">
            <h2>Something went wrong</h2>
            <div className="error" style={{ marginTop: 12 }}>
              <Icons.alert />
              <span>{error}</span>
            </div>
            <div className="actions">
              <button className="btn block" onClick={props.onQuit}>
                Back
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const TIER_HINT: Record<QualityTier, string> = {
  ultra: 'Everything on: lit tiles, reflections, bloom, streak VFX. Desktop GPUs.',
  high: 'The full look with a lighter post chain. Laptops and recent phones.',
  medium: 'The 1080p60 floor: lit tiles, fewer particles, no god rays.',
  low: 'Rescue tier: flat tiles, no post-processing, still backdrop.',
};

/** "Ultra · 2× supersampled" / "Ultra · native": the tier and what the renderer draws at. */
function resolutionLine(quality: QualityTier, r: ResolutionInfo | null): string {
  const tier = quality[0]!.toUpperCase() + quality.slice(1);
  if (!r) return tier;
  const factor = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0$/, ''));
  const line = r.supersampled
    ? `${tier} · ${factor(r.resolution)}× supersampled`
    : `${tier} · native${r.resolution > 1 ? ` (${factor(r.resolution)}×)` : ''}`;
  // The board's own resolution when it is under the renderer's (a phone: capped at 2, or the governor stepped it).
  return r.world + 1e-3 < r.resolution ? `${line} · board ${factor(r.world)}×` : line;
}

function SettingsPanel({
  quality,
  setQuality,
  resolution,
  sound,
  setSound,
  volumes,
  setVolume,
}: {
  quality: QualityTier;
  setQuality: (q: QualityTier) => void;
  resolution: ResolutionInfo | null;
  sound: boolean;
  setSound: (b: boolean) => void;
  volumes: Volumes;
  setVolume: (key: keyof Volumes, value: number) => void;
}) {
  const slider = (key: keyof Volumes, label: string) => {
    const v = Math.round(volumes[key] * 100);
    return (
      <label className="slider" key={key}>
        <span>{label}</span>
        <input
          type="range"
          className="range"
          min={0}
          max={100}
          value={v}
          disabled={!sound}
          style={{ '--v': `${v}%` } as CSSProperties}
          onChange={(e) => setVolume(key, Number(e.target.value) / 100)}
          aria-label={`${label} volume`}
        />
        <b>{v}</b>
      </label>
    );
  };
  return (
    <div className="settings">
      <div className="group">
        <div className="group-head">
          <span className="field-label">Quality</span>
        </div>
        <Segmented<QualityTier>
          label="Quality tier"
          value={quality}
          onChange={setQuality}
          options={QUALITY_TIERS.map((t) => ({ value: t, label: t }))}
        />
        <div className="tier-hint">{TIER_HINT[quality]}</div>
        <div className="tier-hint">{resolutionLine(quality, resolution)}</div>
      </div>
      <div className="group">
        <Switch
          checked={sound}
          onChange={setSound}
          label="Sound"
          hint={sound ? 'Music leads; effects sit under it.' : 'Muted'}
        />
        <div className="sliders">
          {slider('master', 'Master')}
          {slider('music', 'Music')}
          {slider('sfx', 'Effects')}
        </div>
      </div>
      <div className="group">
        <NotificationsRow />
        <HapticsRow />
      </div>
    </div>
  );
}

const PUSH_HINT: Record<PushState, string> = {
  checking: 'Checking…',
  on: 'When someone takes your challenge and when a match settles — even with Blockari closed.',
  off: 'Get told when someone takes your challenge and when a match settles.',
  denied: "Blocked in the browser's site settings for Blockari.",
  'needs-install':
    'Add Blockari to your Home Screen (Share → Add to Home Screen) to turn these on.',
  unsupported: 'Not available in this browser, or not set up on this server.',
};

/** The Settings row: the push state as a switch, with why it cannot move when it cannot. */
export function NotificationsRow({ force }: { force?: PushState | undefined }) {
  const push = usePush();
  const state = force ?? push.state;
  const [busy, setBusy] = useState(false);
  const canToggle = state === 'on' || state === 'off';
  return (
    <div className={`notify-row${canToggle ? '' : ' locked'}`}>
      <Switch
        checked={state === 'on'}
        onChange={(on) => {
          if (!canToggle || busy) return;
          setBusy(true);
          void (on ? push.enable() : push.disable()).finally(() => setBusy(false));
        }}
        label="Notifications"
        hint={PUSH_HINT[state]}
      />
    </div>
  );
}

/** The safe-area insets in px, read from the root's `--safe-top` / `--safe-bottom` (env() is not readable directly). */
function safeInsets(): { top: number; bottom: number } {
  try {
    const cs = getComputedStyle(document.documentElement);
    const px = (v: string) => Number.parseFloat(v) || 0;
    return {
      top: px(cs.getPropertyValue('--safe-top')),
      bottom: px(cs.getPropertyValue('--safe-bottom')),
    };
  } catch {
    return { top: 0, bottom: 0 };
  }
}

/** Score and remaining clock of a paused game, for the pause header. */
function snapshot(c: GameController | undefined): { score: number; left: string } | null {
  if (!c) return null;
  const ms = Math.max(0, c.remainingMs);
  const m = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return { score: c.current.score, left: `${m}:${String(sec).padStart(2, '0')}` };
}

const MINT = '#3de6c9';
const GOLD = '#ffd60a';

/** Three-frame strip in the mini-board dialect: piece in hand → placed → the row clears. */
function HowToStrip() {
  const row: [number, number, string][] = [
    [0, 4, MINT],
    [1, 4, MINT],
    [2, 4, MINT],
    [3, 4, MINT],
  ];
  return (
    <div className="howto" aria-hidden>
      <MiniBoard
        size={72}
        cells={[...row, [4, 1, GOLD], [4, 2, GOLD]]}
        ghost={[
          [4, 3, ''],
          [4, 4, ''],
        ]}
      />
      <span className="chev">
        <Icons.chevron />
      </span>
      <MiniBoard
        size={72}
        cells={[...row, [4, 3, GOLD], [4, 4, GOLD]]}
        glow="rgba(255,214,10,0.5)"
      />
      <span className="chev">
        <Icons.chevron />
      </span>
      <MiniBoard
        size={72}
        cells={[[4, 3, GOLD]]}
        hot={[
          [0, 4, ''],
          [1, 4, ''],
          [2, 4, ''],
          [3, 4, ''],
          [4, 4, ''],
        ]}
      />
    </div>
  );
}
