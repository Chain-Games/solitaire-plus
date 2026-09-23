import { orientation, type GameState } from '@solitaire-plus/sim';
import type { GameController } from '../game/controller.js';
import type { Layout } from '../render/layout.js';
import type { Playfield } from '../render/playfield.js';
import type { Beat, ScriptMove } from './script.js';

/** One scripted drag: grab in the tray, an eased path to the drop, release. */
export const DRAG_MS = 550;
/** A rest at the target before the release, so the magnet locks in. */
export const DRAG_REST_MS = 120;
/** A longer rest when the drop completes a line: the preview frames the line about to clear — the pointer at WHICH row. */
export const DRAG_REST_CLEAR_MS = 380;
/** Between two moves under one caption. */
export const MOVE_GAP_MS = 500;
/** Between the priming moves of a silent beat (the line above them is already read). */
export const PRIME_GAP_MS = 300;
/** The table has to go quiet before a hold starts; a stuck choreography is not waited on past this. */
export const QUIET_CAP_MS = 4000;
const QUIET_POLL_MS = 60;
/** Before the first beat: the hand is on the table, the caption slot is empty. */
export const OPENING_MS = 1000;
/** After the last hold, before the layer leaves. */
export const TAIL_MS = 800;

export interface GuideVoice {
  caption: (text: string) => void;
}

export class TutorialAborted extends Error {
  constructor() {
    super('tutorial aborted');
    this.name = 'TutorialAborted';
  }
}

function abortable<T>(
  signal: AbortSignal,
  run: (resolve: (v: T) => void) => () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new TutorialAborted());
      return;
    }
    const cancel = run((v) => {
      signal.removeEventListener('abort', onAbort);
      resolve(v);
    });
    function onAbort() {
      cancel();
      reject(new TutorialAborted());
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return abortable(signal, (resolve) => {
    const t = setTimeout(resolve, ms);
    return () => clearTimeout(t);
  });
}

/** A frame-driven tween over `ms` wall-clock milliseconds, `step(t)` with t in 0..1 (1 exactly last). */
function tween(ms: number, step: (t: number) => void, signal: AbortSignal): Promise<void> {
  return abortable(signal, (resolve) => {
    let raf = 0;
    let t0 = 0;
    const tick = (now: number) => {
      if (!t0) t0 = now;
      const t = Math.min(1, (now - t0) / ms);
      step(t);
      if (t < 1) raf = requestAnimationFrame(tick);
      else resolve();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Pointer position that drops the piece in `slot` with its origin at
 * (row, col). The grab is at the slot centre, which is the piece's centre,
 * so the grab offset in cells is (cols/2, rows/2) — the arithmetic
 * `beginDrag` does, mirrored (the shot harness's `dropPoint`).
 */
export function dropPoint(
  L: Layout,
  state: GameState,
  slot: number,
  row: number,
  col: number,
): { x: number; y: number } {
  const piece = state.hand[slot];
  if (!piece) throw new Error(`tutorial: slot ${slot} is empty`);
  const o = orientation(piece.shape, piece.rotation);
  const pitch = L.cell + L.gap;
  return {
    x: L.boardX + col * pitch + (o.cols / 2) * pitch,
    y: L.boardY + row * pitch + (o.rows / 2) * pitch + L.dragLift,
  };
}

/** Wait for the table's choreography to finish (capped). */
export async function quiet(playfield: Playfield, signal: AbortSignal): Promise<void> {
  const t0 = performance.now();
  while (playfield.busy && performance.now() - t0 < QUIET_CAP_MS) {
    await pause(QUIET_POLL_MS, signal);
  }
}

/**
 * One move, performed as a real drag through the playfield's own pointer
 * path: grab → an eased travel over DRAG_MS → a rest → release. The player
 * sees the lift, the ghost, the line preview and the landing exactly as a
 * finger would produce them. Resolves false when the drop did not place
 * (the script and the table disagree — the run stops there).
 */
export async function performMove(
  playfield: Playfield,
  controller: GameController,
  move: ScriptMove,
  signal: AbortSignal,
): Promise<boolean> {
  const from = playfield.slotCentre(move.slot);
  const to = dropPoint(playfield.layoutInfo, controller.current, move.slot, move.row, move.col);
  if (!playfield.pointerGrab(move.slot, from.x, from.y)) return false;
  await tween(
    DRAG_MS,
    (t) => {
      const k = easeInOut(t);
      playfield.pointerMove(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
    },
    signal,
  );
  const p = controller.previewLines(move.slot, move.row, move.col);
  await pause(p.rows.length + p.cols.length > 0 ? DRAG_REST_CLEAR_MS : DRAG_REST_MS, signal);
  return playfield.pointerRelease();
}

/**
 * The narrated demo: per beat, the caption (a null keeps the last one up),
 * then its moves (each a drag, then the table going quiet, then a gap),
 * then the beat's hold. Pacing is
 * event-driven plus a hold — a slow device stretches it, nothing overlaps.
 * Ends when the beats run out, the game ends on its own, or the signal aborts.
 */
export async function runTutorial(
  o: {
    playfield: Playfield;
    controller: GameController;
    moves: readonly ScriptMove[];
    beats: readonly Beat[];
    voice: GuideVoice;
  },
  signal: AbortSignal,
): Promise<void> {
  let next = 0;
  await pause(OPENING_MS, signal);
  for (const beat of o.beats) {
    if (o.controller.current.status !== 'playing') return;
    if (beat.caption !== null) o.voice.caption(beat.caption);
    for (let i = 0; i < beat.moves; i++) {
      const move = o.moves[next++];
      if (!move) return;
      const placed = await performMove(o.playfield, o.controller, move, signal);
      if (!placed) return;
      await quiet(o.playfield, signal);
      if (i < beat.moves - 1)
        await pause(beat.caption === null ? PRIME_GAP_MS : MOVE_GAP_MS, signal);
      if (o.controller.current.status !== 'playing') return;
    }
    await pause(beat.hold * 1000, signal);
  }
  await pause(TAIL_MS, signal);
}
