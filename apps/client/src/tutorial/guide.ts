import { create } from 'zustand';

/**
 * The tutorial's gate and its one flag.
 *
 * `blockari.guide.seen` is written on EVERY exit — the demo finishing, Done,
 * Deal me in, Escape — so a skipped tutorial counts as seen and nobody is
 * shown it twice. Storage failure (a private window) means it shows again;
 * it never blocks play.
 */
export const GUIDE_SEEN_KEY = 'blockari.guide.seen';

export function guideSeen(): boolean {
  try {
    return localStorage.getItem(GUIDE_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberGuide(): void {
  try {
    localStorage.setItem(GUIDE_SEEN_KEY, '1');
  } catch {
    // ignore: shown again next time
  }
}

/** What the one button says: where you pressed (home) or what you asked for (a deal). */
export type GuideLabel = 'Done' | 'Deal me in';

export interface GuideRequest {
  label: GuideLabel;
  /** Runs once the layer is gone: nothing (home), or the deal the player asked for. */
  then: () => void;
}

interface TutorialStore {
  active: GuideRequest | null;
  open: (req: GuideRequest) => void;
  /** The layer has left: the deferred action runs. */
  close: () => void;
}

export const useTutorial = create<TutorialStore>((set, get) => ({
  active: null,
  open: (req) => {
    if (get().active) return;
    set({ active: req });
  },
  close: () => {
    const req = get().active;
    if (!req) return;
    set({ active: null });
    req.then();
  },
}));

/** Home › How it works › Tutorial: the demo, then back where you were. */
export function openTutorial(): void {
  useTutorial.getState().open({ label: 'Done', then: () => undefined });
}

/**
 * The first-run gate: wraps every action that DEALS a game (Practice,
 * Create, Take). A first-timer sees the demo with "Deal me in", and the deal
 * they asked for happens as it closes; everyone else goes straight through.
 */
export function explainFirst(then: () => void): void {
  if (guideSeen()) {
    then();
    return;
  }
  useTutorial.getState().open({ label: 'Deal me in', then });
}
