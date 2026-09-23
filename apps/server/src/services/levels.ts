import { levelFor } from '@solitaire-plus/sim';
import type { Game } from '../db/schema.js';

/**
 * The level a finished game reached, as the server's replay computed it. The
 * client never sends a level. Games scored before the column existed fall
 * back to the level of the replay's stored in-play score, which is the same
 * number by definition (see packages/sim levels.ts).
 */
export function levelReachedOf(game: Game): number {
  return game.levelReached ?? levelFor(game.breakdown?.base ?? 0);
}
