/**
 * Events emitted by the sim. The renderer and audio engine subscribe to these;
 * they never poll state to decide what to draw or play.
 */

/** A pile: the stock, the waste, a foundation (one per suit) or a tableau column. */
export type PileId =
  'stock' | 'waste' | 'f0' | 'f1' | 'f2' | 'f3' | 't0' | 't1' | 't2' | 't3' | 't4' | 't5' | 't6';

export type EndReason = 'cleared' | 'timeout' | 'forfeit';

/** What a scoring event was for — the renderer picks its float and sound from it. */
export type ScoreKind = 'foundation' | 'reveal' | 'waste' | 'return' | 'auto';

export interface ScoreBreakdown {
  /** Net foundation points: foundationPoints per card home, minus returns. */
  readonly foundation: number;
  /** revealPoints per face-down card turned up. */
  readonly reveals: number;
  /** wastePoints per waste card played to the tableau. */
  readonly tableau: number;
  /** In-play streak steps. */
  readonly streak: number;
  /** Points accrued during play: foundation + reveals + tableau + streak. */
  readonly base: number;
  /** (min(bestStreak, streakCap) - 1) * streakEndStep, min 0. */
  readonly streakBonus: number;
  /** clearBonus if cleared, else 0. */
  readonly clearBonus: number;
  /** clearPerSecond per whole second left at the clear, else 0. */
  readonly timeBonus: number;
  /** base + streakBonus + clearBonus + timeBonus, never below 0. */
  readonly total: number;
  readonly bestStreak: number;
  /** Cards on the foundations at the end, 0..52. */
  readonly cardsHome: number;
  readonly revealed: number;
  /** Moves made (plays, draws, recycles, autocomplete); undo is not a move. */
  readonly moves: number;
  readonly undos: number;
  /** Game clock at the end: the clear time for a clear, else the full duration. */
  readonly elapsedMs: number;
  readonly endReason: EndReason;
  /** Highest level reached during play (in-play score; end bonuses do not count). Cosmetic. */
  readonly levelReached: number;
}

export type GameEvent =
  | { readonly type: 'dealt' }
  | {
      readonly type: 'moved';
      readonly from: PileId;
      readonly to: PileId;
      /** Slots moved, bottom to top as they now sit on `to`. */
      readonly slots: readonly number[];
      /** True when this move is one step of an autocomplete cascade. */
      readonly auto: boolean;
    }
  | {
      /** A face-down tableau card turned up. `card` is null until the server reveals it. */
      readonly type: 'flipped';
      readonly pile: PileId;
      readonly slot: number;
      readonly card: number | null;
    }
  | {
      /** Stock to waste. Slots in the order they now sit on the waste (last is the top). */
      readonly type: 'drew';
      readonly slots: readonly number[];
    }
  | { readonly type: 'recycled'; readonly count: number }
  | { readonly type: 'undone'; readonly remaining: number }
  | {
      readonly type: 'scored';
      readonly kind: ScoreKind;
      readonly points: number;
      /** Streak length after this move; 0 if none. */
      readonly streak: number;
      readonly total: number;
      /** Where the score float anchors. */
      readonly pile: PileId;
    }
  | {
      /** Emitted right after `scored` when the level rose. */
      readonly type: 'levelUp';
      readonly level: number;
      readonly from: number;
      readonly atScore: number;
      readonly nextThreshold: number;
    }
  | { readonly type: 'streakBroken'; readonly length: number }
  | { readonly type: 'ended'; readonly reason: EndReason; readonly breakdown: ScoreBreakdown };
