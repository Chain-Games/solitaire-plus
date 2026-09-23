/**
 * Which painted world the shell's backdrop should be showing. Pixi-free, so
 * screens set it without pulling the renderer in; the ShellBackdrop
 * subscribes and cross-dissolves toward it (600 ms). `shown` is the hand-off
 * across a route change: a backdrop torn down mid-world (the game took over)
 * or a game that just played a world writes it here, and the next backdrop
 * starts ON that world and dissolves back to its own ground.
 */

/** The cross-dissolve toward (and back from) a world. */
export const WORLD_DISSOLVE_MS = 600;

type Listener = (id: string | null) => void;

let target: string | null = null;
let shown: string | null = null;
const listeners = new Set<Listener>();
let live = 0;

export const backdropWorld = {
  /** Ask the backdrop for a world (null = the shell's own ground). */
  set(id: string | null): void {
    if (id === target) return;
    target = id;
    // Nobody is drawing: the game is, and it shows the world itself, so that is what is on
    // screen. (A null with no backdrop up is the shell arriving: what is shown stays the
    // game's world until the new backdrop has dissolved away from it.)
    if (live === 0 && id !== null) shown = id;
    for (const l of listeners) l(id);
  },
  get(): string | null {
    return target;
  },
  /** What the last backdrop had on screen when it went away. */
  shown(): string | null {
    return shown;
  },
  /** A backdrop reports what it settled on (and at teardown). */
  report(id: string | null): void {
    shown = id;
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    live++;
    return () => {
      listeners.delete(l);
      live--;
    };
  },
};
