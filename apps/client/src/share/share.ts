import type { ScoreBreakdown } from '@solitaire-plus/sim';
import { api } from '../api/client.js';
import { renderShareCard } from './card.js';
import { shareText, takeCode, type CardChallenge, type CardUser } from './layout.js';

/**
 * The share flow. Renders both card sizes, gets the link that unfurls (a
 * challenge game's cards go to the server for `/s/:id`; a solo run has no
 * server row and shares the plain origin), then hands the story image to the
 * system share sheet — or, where there is none, back to the caller for the
 * preview modal. The server is never on the critical path: an upload that
 * fails or dawdles falls back to the plain `/take?code=` link (the origin
 * for a settled challenge — nobody can take it).
 *
 * The stored card is a snapshot: a share made while the challenge was open
 * keeps its dare at `/s/:id` after the match is settled (the page's own
 * words and landing follow the live state; the image does not).
 */

export interface ShareInput {
  breakdown: ScoreBreakdown;
  user: CardUser | null;
  /** The server game id the cards are stored against (`/s/:id`); a solo run has none and never uploads. */
  gameId?: string | undefined;
  /** The challenge behind the game, by state (open: the dare; complete: the result); undefined for a solo card. */
  challenge?: CardChallenge | undefined;
  newBest: boolean;
}

export type ShareOutcome =
  /** The system sheet took it (or the player dismissed it). */
  | { mode: 'native' }
  /** No sheet here: the caller shows the preview with these. */
  | {
      mode: 'preview';
      story: Blob;
      text: string;
      url: string;
      /** True when `url` is a `/s/:id` link that unfurls into the card. */
      unfurls: boolean;
    };

/** The plain link a share falls back to when the server cannot be reached. */
export function fallbackUrl(origin: string, code: string | null | undefined): string {
  return code ? `${origin}/take?code=${encodeURIComponent(code)}` : origin;
}

/** The upload's budget before the share goes out with the plain link instead. */
const UPLOAD_TIMEOUT_MS = 4000;
const FILE_NAME = 'blockari-score.jpg';
const FILE_MIME = 'image/jpeg';
const SHARE_TITLE = 'Blockari';

async function toBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK)
    s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  return btoa(s);
}

/** Stores the cards for a challenge game; null on any failure (the share carries on). */
async function upload(gameId: string, story: Blob, link: Blob): Promise<string | null> {
  try {
    const [s, l] = await Promise.all([toBase64(story), toBase64(link)]);
    const res = await Promise.race([
      api.shareCard(gameId, s, l),
      new Promise<null>((r) => setTimeout(() => r(null), UPLOAD_TIMEOUT_MS)),
    ]);
    return res?.url ?? null;
  } catch {
    return null;
  }
}

/** Whether this browser can hand an image to a share sheet. */
export function canShareFiles(files: File[]): boolean {
  try {
    return typeof navigator.share === 'function' && navigator.canShare?.({ files }) === true;
  } catch {
    return false;
  }
}

export async function shareResult(input: ShareInput): Promise<ShareOutcome> {
  // The take link only while the challenge can be taken; a settled one links the front door.
  const code = takeCode(input.challenge);
  const base = {
    breakdown: input.breakdown,
    user: input.user,
    challenge: input.challenge,
    newBest: input.newBest,
    host: location.host,
    origin: location.origin,
  };
  const [story, link] = await Promise.all([
    renderShareCard({ ...base, size: 'story' }),
    renderShareCard({ ...base, size: 'link' }),
  ]);

  let url = fallbackUrl(location.origin, code);
  let unfurls = false;
  if (input.gameId) {
    const stored = await upload(input.gameId, story, link);
    if (stored) {
      url = stored;
      unfurls = true;
    }
  }
  const text = shareText(input.breakdown.total, input.challenge, location.host);

  const files = [new File([story], FILE_NAME, { type: FILE_MIME })];
  if (canShareFiles(files)) {
    try {
      await navigator.share({ files, title: SHARE_TITLE, text, url });
      return { mode: 'native' };
    } catch (err) {
      // Dismissed: nothing more to do. Anything else: the preview still works.
      if (err instanceof Error && err.name === 'AbortError') return { mode: 'native' };
    }
  }
  return { mode: 'preview', story, text, url, unfurls };
}
