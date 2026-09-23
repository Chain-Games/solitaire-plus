import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { requireUserId } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { SHARE_ID_RE } from '../ids.js';
import {
  CARD_EXT,
  CARD_MIME,
  SHARE_MAX_IMAGE_BYTES,
  SHARE_SIZES,
  createShareCard,
  decodeCardImage,
  renderSharePage,
  shareCardFile,
  shareCardPage,
  shareLanding,
} from '../services/share.js';

/**
 * Two JPEGs, base64 in JSON, each under SHARE_MAX_IMAGE_BYTES: the route accepts
 * a body that size plus base64's growth and a little envelope, and no more.
 */
const SHARE_BODY_LIMIT = Math.ceil((SHARE_MAX_IMAGE_BYTES * 2 * 4) / 3) + 4096;

const upload = z.object({
  gameId: z.string().uuid(),
  story: z.string().min(1),
  link: z.string().min(1),
});

const cardId = z.object({ id: z.string().regex(SHARE_ID_RE) });
const cardFile = cardId.extend({ file: z.enum(SHARE_SIZES.map((s) => `${s}.${CARD_EXT}`)) });

/**
 * Share cards. `POST /api/share` (session) stores a finished game's cards;
 * `GET /s/:id` is the page a pasted link unfurls into (scrapers read the
 * tags, people are sent on to the take page); `/s/:id/{story,link}.jpg`
 * serve the files, immutable — an id is never reused.
 */
export const shareRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/share', { bodyLimit: SHARE_BODY_LIMIT }, async (req) => {
    const userId = requireUserId(req);
    const b = upload.safeParse(req.body);
    if (!b.success) throw badRequest('bad-request', b.error.issues[0]?.message);
    const pngs = {
      story: decodeCardImage(b.data.story, 'story'),
      link: decodeCardImage(b.data.link, 'link'),
    };
    return createShareCard(app.db, app.cfg, userId, b.data.gameId, pngs);
  });

  app.get('/s/:id', async (req, reply) => {
    const p = cardId.safeParse(req.params);
    if (!p.success) return reply.redirect(shareLanding(null));
    try {
      const page = await shareCardPage(app.db, p.data.id);
      return reply
        .header('cache-control', 'public, max-age=300')
        .type('text/html; charset=utf-8')
        .send(renderSharePage(app.cfg, page));
    } catch {
      // A dead link still lands somewhere useful: home.
      return reply.redirect(shareLanding(null));
    }
  });

  app.get('/s/:id/:file', async (req, reply) => {
    const p = cardFile.safeParse(req.params);
    if (!p.success) throw notFound('share-not-found');
    const size = SHARE_SIZES.find((s) => `${s}.${CARD_EXT}` === p.data.file);
    if (!size) throw notFound('share-not-found');
    const file = await shareCardFile(app.cfg, p.data.id, size);
    if (!file) throw notFound('share-not-found');
    return reply
      .header('cache-control', 'public, max-age=31536000, immutable')
      .type(CARD_MIME)
      .send(createReadStream(file));
  });
};
