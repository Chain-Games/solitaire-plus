import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AudioEngine } from '../audio/engine.js';
import { GameController } from '../game/controller.js';
import { computeLayout, hudBottomOf, type LayoutInset } from '../render/layout.js';
import { Playfield } from '../render/playfield.js';
import { worldFor } from '../render/world-table.js';
import { useSettings } from '../state/settings.js';
import { registerSfxEngine } from '../shell/sfx.js';
import { rememberGuide, useTutorial, type GuideLabel } from './guide.js';
import { TutorialAborted, runTutorial } from './run.js';
import { TUTORIAL_BEATS, TUTORIAL_MOVES, TUTORIAL_SEED } from './script.js';

/** The caption hangs this far under the HUD's lowest readout (portrait). */
const PANEL_GAP_PX = 14;
/** The layer's fade out, before the deferred action runs (styles: .guide transition). */
const HIDE_MS = 240;

/**
 * The in-game tutorial: a narrated, auto-played demo on the real engine.
 *
 * A scripted game (tutorial/script.ts) is dealt to the real controller and
 * the real playfield plays it by itself — every move a drag through the
 * playfield's own pointer path — while one caption line narrates. The
 * layer adds nothing but that caption, one button and a soft shade behind
 * the words: no dim, no spotlight, no dots. It covers the whole viewport,
 * so the table takes no input; Escape and the button both end it. The
 * game is solo (no server, no XP), and the world, the sound and every
 * effect are the game's own.
 */
export function TutorialLayer() {
  const active = useTutorial((s) => s.active);
  if (!active) return null;
  return <Tutorial label={active.label} />;
}

function Tutorial({ label }: { label: GuideLabel }) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [caption, setCaption] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });
  const [shown, setShown] = useState(false);
  const [orient, setOrient] = useState<'portrait' | 'landscape'>(orientation);
  const [padTop, setPadTop] = useState<number | null>(null);
  const session = useRef<{ playfield: Playfield; abort: AbortController } | null>(null);
  const done = useRef(false);

  const exit = useCallback(() => {
    if (done.current) return;
    done.current = true;
    session.current?.abort.abort();
    rememberGuide();
    setShown(false);
    setTimeout(() => useTutorial.getState().close(), HIDE_MS);
  }, []);

  // The table's layout makes room for the caption: a band between the HUD
  // and the board in portrait (the panel then hangs PANEL_GAP_PX under the
  // HUD's lowest readout), a band under the hand in landscape (the panel
  // sits at the foot). Measured from the DOM, so the copy's own height rules,
  // and computed from the layout function itself, so the layer can be up
  // before the renderer is — the table arrives under a caption slot and a
  // button that are already where they will stay.
  const inset = useRef<LayoutInset>({ top: 0, bottom: 0 });
  const measure = useCallback(() => {
    const body = bodyRef.current;
    const panel = panelRef.current;
    if (!body || !panel) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w > h) {
      const top = panel.getBoundingClientRect().top;
      inset.current = { top: 0, bottom: Math.ceil(h - top) };
      session.current?.playfield.setGuideInset(inset.current);
      setPadTop(null);
      return;
    }
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const bare = computeLayout(w, h, coarse);
    const air = bare.hudHeight - (hudBottomOf(bare) - bare.hudY);
    const need = PANEL_GAP_PX + body.offsetHeight;
    inset.current = { top: Math.max(0, Math.ceil(need - air)), bottom: 0 };
    session.current?.playfield.setGuideInset(inset.current);
    const L = computeLayout(w, h, coarse, inset.current);
    setPadTop(Math.round(hudBottomOf(L)) + PANEL_GAP_PX);
  }, []);

  // The layer is up at once: the caption slot (empty) and the button over
  // the table being set, never a blank wait.
  useLayoutEffect(() => {
    measure();
    setShown(true);
  }, [measure]);

  useEffect(() => {
    const parent = canvasRef.current;
    if (!parent) return;
    const controller = new GameController({ seed: TUTORIAL_SEED, pausable: true });
    const audio = new AudioEngine(useSettings.getState().sound);
    audio.setMix(useSettings.getState().volumes);
    const playfield = new Playfield({
      controller,
      quality: useSettings.getState().quality,
      parent,
      modeLabel: 'TUTORIAL',
      ssaaCap: useSettings.getState().ssaaCap,
    });
    playfield.setGuideInset(inset.current);
    const abort = new AbortController();
    session.current = { playfield, abort };
    playfield.onRejected = () => audio.rejected();
    playfield.onCue = (name) => audio.cue(name);
    playfield.onClock = (ms) => audio.setClock(ms);
    playfield.onHeat = (h) => audio.setHeat?.(h);
    audio.setWorld(worldFor(TUTORIAL_SEED).id);
    registerSfxEngine({ cue: (name) => audio.cue(name), rankUp: () => audio.rankUp() });
    const unsub = controller.subscribe((e) => audio.handle(e));
    if (new URLSearchParams(location.search).has('debug')) {
      // Tooling hook (the evidence harness): the live session behind the layer.
      (window as unknown as { __blockariTutorial?: unknown }).__blockariTutorial = {
        controller,
        playfield,
      };
    }
    // The press that opened the tutorial is the gesture the audio needs.
    audio.unlock();
    const unlock = () => audio.unlock();
    document.addEventListener('pointerdown', unlock, { passive: true });
    // Nothing under the layer scrolls while it is up.
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = 'hidden';

    let cancelled = false;
    playfield.init().then(
      () => {
        if (cancelled) return;
        playfield.revealWorld();
        controller.start();
        runTutorial(
          {
            playfield,
            controller,
            moves: TUTORIAL_MOVES,
            beats: TUTORIAL_BEATS,
            voice: { caption: (text) => setCaption((c) => ({ text, seq: c.seq + 1 })) },
          },
          abort.signal,
        ).then(exit, (err: unknown) => {
          if (!(err instanceof TutorialAborted)) console.error(err);
        });
      },
      (err: unknown) => {
        console.error('tutorial: renderer failed to start', err);
        exit();
      },
    );

    return () => {
      cancelled = true;
      abort.abort();
      unsub();
      document.removeEventListener('pointerdown', unlock);
      html.style.overflow = overflow;
      playfield.destroy();
      registerSfxEngine(null);
      audio.dispose();
      session.current = null;
    };
  }, [exit, measure]);

  // The layout follows a resize or a turn; the panel is re-measured with it.
  useLayoutEffect(() => {
    const onResize = () => {
      setOrient(orientation());
      // After the DOM has taken the new orientation's styles.
      requestAnimationFrame(measure);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measure]);

  // Escape ends it and never reaches anything under the layer (capture, stopped).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      exit();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [exit]);

  useEffect(() => {
    if (shown) buttonRef.current?.focus({ preventScroll: true });
  }, [shown]);

  return (
    <div className="game-root tutorial-root">
      <div className="game-canvas" ref={canvasRef} />
      <div
        className="guide"
        role="dialog"
        aria-modal="true"
        aria-label="How to play"
        data-active={shown ? 'true' : 'false'}
        data-orient={orient}
      >
        <div
          className="guide-panel"
          ref={panelRef}
          style={padTop !== null && orient === 'portrait' ? { paddingTop: padTop } : undefined}
        >
          <div className="guide-body" ref={bodyRef}>
            <p className="guide-caption" key={caption.seq} aria-live="polite">
              {caption.text}
            </p>
            <div className="guide-actions">
              <button type="button" className="btn primary" ref={buttonRef} onClick={exit}>
                {label}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function orientation(): 'portrait' | 'landscape' {
  return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
}
