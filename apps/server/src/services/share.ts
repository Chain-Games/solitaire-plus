import { eq } from 'drizzle-orm';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RULES } from '@solitaire-plus/sim';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { challenges, games, shareCards, users } from '../db/schema.js';
import { HttpError, badRequest, conflict, notFound } from '../errors.js';
import { newShareId } from '../ids.js';
import { getOwnGame } from './games.js';

/**
 * Share cards: a finished game's score card, rendered by the client, kept on
 * disk so `/s/:id` can unfurl into it. The server never draws anything — it
 * checks that the game is the caller's and over, that each file is a JPEG of
 * a sane size, and remembers which id belongs to which game.
 */

/** Each card at most this many bytes (the story JPEG at 1080×1920 sits around 350 KB). */
export const SHARE_MAX_IMAGE_BYTES = 600 * 1024;
/** The two card sizes a share carries, and the file each is kept as. */
export const SHARE_SIZES = ['story', 'link'] as const;
export type ShareSize = (typeof SHARE_SIZES)[number];
/** The link card's pixel size, declared to scrapers (`og:image:width/height`). */
export const LINK_CARD = { width: 1200, height: 630 } as const;

/** The cards are JPEGs (the painted art): SOI + a marker. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
export const CARD_EXT = 'jpg';
export const CARD_MIME = 'image/jpeg';

/** Decodes one uploaded card, refusing anything that is not a JPEG under the cap. */
export function decodeCardImage(b64: string, name: ShareSize): Buffer {
  // Base64 grows 4/3, so the cap on the text is a cheap first gate before decoding.
  if (b64.length > Math.ceil((SHARE_MAX_IMAGE_BYTES * 4) / 3) + 4)
    throw new HttpError(
      413,
      'card-too-large',
      `${name} card exceeds ${SHARE_MAX_IMAGE_BYTES} bytes`,
    );
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > SHARE_MAX_IMAGE_BYTES)
    throw new HttpError(
      413,
      'card-too-large',
      `${name} card exceeds ${SHARE_MAX_IMAGE_BYTES} bytes`,
    );
  if (buf.length < JPEG_MAGIC.length || !buf.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC))
    throw badRequest('bad-image', `${name} card is not a JPEG`);
  return buf;
}

export function cardPath(cfg: Config, id: string, size: ShareSize): string {
  return path.resolve(cfg.SHARE_DIR, id, `${size}.${CARD_EXT}`);
}

/** `PUBLIC_URL/s/:id` — the link that unfurls. */
export function shareUrl(cfg: Config, id: string): string {
  return `${cfg.PUBLIC_URL.replace(/\/+$/, '')}/s/${id}`;
}

/**
 * Stores a card for the caller's finished game. One card per game: a second
 * call returns the first id and writes nothing, so a re-tap of Share (or a
 * retry after a dropped response) never litters the disk.
 */
export async function createShareCard(
  db: Db,
  cfg: Config,
  userId: string,
  gameId: string,
  pngs: Record<ShareSize, Buffer>,
): Promise<{ id: string; url: string }> {
  const game = await getOwnGame(db, gameId, userId);
  if (game.status !== 'finished') throw conflict('game-not-finished');
  const existing = await db.query.shareCards.findFirst({ where: eq(shareCards.gameId, gameId) });
  if (existing) return { id: existing.id, url: shareUrl(cfg, existing.id) };

  const id = newShareId();
  const dir = path.dirname(cardPath(cfg, id, 'story'));
  await mkdir(dir, { recursive: true });
  await Promise.all(SHARE_SIZES.map((s) => writeFile(cardPath(cfg, id, s), pngs[s])));
  try {
    await db.insert(shareCards).values({ id, gameId, userId });
  } catch (err) {
    // Two taps raced: the unique game index kept the first; hand that one back.
    const won = await db.query.shareCards.findFirst({ where: eq(shareCards.gameId, gameId) });
    await rm(dir, { recursive: true, force: true });
    if (!won) throw err;
    return { id: won.id, url: shareUrl(cfg, won.id) };
  }
  return { id, url: shareUrl(cfg, id) };
}

export interface SharePage {
  id: string;
  score: number;
  username: string;
  /**
   * The challenge code, while the challenge is still OPEN (the creator has
   * played, nobody has taken it). A settled, taken or expired one has no code
   * here: the page then reads like a solo card and lands on the front door.
   */
  code: string | null;
}

/** What the `/s/:id` page needs: the score, who made it, the code to beat (while there is one). */
export async function shareCardPage(db: Db, id: string): Promise<SharePage> {
  const card = await db.query.shareCards.findFirst({ where: eq(shareCards.id, id) });
  if (!card) throw notFound('share-not-found');
  const [game, user] = await Promise.all([
    db.query.games.findFirst({ where: eq(games.id, card.gameId) }),
    db.query.users.findFirst({ where: eq(users.id, card.userId) }),
  ]);
  if (!game || !user) throw notFound('share-not-found');
  const challenge = game.challengeId
    ? await db.query.challenges.findFirst({ where: eq(challenges.id, game.challengeId) })
    : undefined;
  const code = challenge?.status === 'open' ? challenge.code : null;
  return { id, score: game.score ?? 0, username: user.username, code };
}

/** The stored file for a card, or null when the row exists but the file is gone. */
export async function shareCardFile(
  cfg: Config,
  id: string,
  size: ShareSize,
): Promise<string | null> {
  const p = cardPath(cfg, id, size);
  try {
    const s = await stat(p);
    return s.isFile() ? p : null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
   The page: what a scraper reads and where a person lands
   -------------------------------------------------------------------------- */

const MINUTES = RULES.durationMs / 60_000;

/** "Same deal, 5 minutes. Beat me: AGB2BS" — the card's line, shared with the client's share text. */
export function shareDescription(code: string | null): string {
  const base = `Same deal, ${MINUTES} minutes.`;
  return code ? `${base} Beat me: ${code}` : base;
}

export function shareTitle(score: number, username: string): string {
  return `Solitaire Plus — ${score.toLocaleString('en-US')} by ${username}`;
}

/** Where a person who follows the link lands: the take page for that code, else home. */
export function shareLanding(code: string | null): string {
  return code ? `/take?code=${encodeURIComponent(code)}` : '/';
}

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The tiny server-rendered page behind `/s/:id`: social-card tags for the
 * scrapers, an instant refresh to the take page for people, and a visible
 * link for anyone whose client honours neither. No script, no stylesheet
 * fetch — it has to read right from a link preview fetcher with a 1 s budget.
 */
export function renderSharePage(cfg: Config, page: SharePage): string {
  const url = shareUrl(cfg, page.id);
  const title = shareTitle(page.score, page.username);
  const desc = shareDescription(page.code);
  const image = `${url}/link.${CARD_EXT}`;
  const landing = shareLanding(page.code);
  const alt = `${page.username} scored ${page.score.toLocaleString('en-US')} in Solitaire Plus`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Solitaire Plus">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:type" content="${CARD_MIME}">
<meta property="og:image:width" content="${LINK_CARD.width}">
<meta property="og:image:height" content="${LINK_CARD.height}">
<meta property="og:image:alt" content="${esc(alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="twitter:image:alt" content="${esc(alt)}">
<meta http-equiv="refresh" content="0; url=${esc(landing)}">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d1a;color:#f2f4ff;font:16px/1.5 system-ui,sans-serif}
a{color:#3de6c9;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
</style>
</head>
<body><p><a href="${esc(landing)}">Open Solitaire Plus</a></p></body>
</html>
`;
}
