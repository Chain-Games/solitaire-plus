/**
 * The screens registry. Each screen is a list of states; each state is one
 * frame, captured from its own fresh browser context and its own page load.
 *
 *   auth:   'guest' mints a guest (POST /api/auth/guest from the page) before the load
 *   setup:  API calls made as that user before the route loads; returns values for `route`
 *   route:  string, or (ctx) => string
 *   ready:  selector the page must show before anything else happens
 *   run:    drives the page into the state (clicks, hooks); may throw Skip
 *
 * Selectors are Blockari's class names, which the Solitaire Plus shell keeps.
 */
import {
  Skip,
  hooks,
  pressStart,
  waitStarted,
  playMoves,
  dragCandidate,
  anchor,
  step,
} from './play.mjs';

const SEED = process.env.CAPTURE_SEED ?? 'qa-capture-1';
const playRoute = (ctx) => `/play/solo?seed=${encodeURIComponent(ctx.seed ?? SEED)}&debug=1`;
const SHELL = '.app .page';

/** A text-matched click that turns "not there" into a Skip, not a crash. */
async function clickText(page, sel, text, what) {
  const l = page.locator(sel, { hasText: text }).first();
  if (!(await l.count())) throw new Skip(`${what}: no ${sel} with text ${text}`);
  await l.click();
}

async function apiJson(page, method, url, body) {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u, {
        method: m,
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
    },
    [method, url, body],
  );
}

/** Open a challenge as this guest at the smallest fee; returns its id. */
async function openChallenge(page) {
  const fees = await apiJson(page, 'GET', '/api/challenges/fees');
  const fee = fees.body?.fees?.[0] ?? 10;
  const r = await apiJson(page, 'POST', '/api/challenges', { entryFee: fee, isPrivate: false });
  if (!r.ok)
    throw new Skip(`POST /api/challenges -> ${r.status} ${JSON.stringify(r.body)?.slice(0, 120)}`);
  return { challengeId: r.body.challengeId, code: r.body.code };
}

export const SCREENS = {
  home: [
    { state: 'signed-out', route: '/', ready: SHELL },
    { state: 'signed-in', auth: 'guest', route: '/', ready: SHELL },
    { state: 'scrolled', auth: 'guest', route: '/', ready: SHELL, scroll: 600 },
  ],
  auth: [
    { state: 'sign-in', route: '/auth', ready: `${SHELL} form` },
    {
      state: 'create-account',
      route: '/auth',
      ready: `${SHELL} form`,
      run: (page) =>
        clickText(
          page,
          '.seg button, .seg [role="radio"], .seg-item',
          /create account/i,
          'register tab',
        ),
    },
    {
      state: 'error',
      route: '/auth',
      ready: `${SHELL} form`,
      run: async (page) => {
        await page.fill('input[autocomplete="username"]', 'qa_nobody_here');
        await page.fill('input[type="password"]', 'wrong-password-1');
        await page.locator('form button[type="submit"], form .btn.primary').first().click();
        await page.waitForSelector('.note, .error, [role="alert"]', { timeout: 8000 }).catch(() => {
          throw new Skip('no error note after a bad sign-in');
        });
      },
    },
  ],
  create: [
    { state: 'default', auth: 'guest', route: '/create', ready: `${SHELL} .panel` },
    {
      state: 'fee-changed',
      auth: 'guest',
      route: '/create',
      ready: `${SHELL} .seg`,
      run: async (page) => {
        const items = page.locator('.seg button, .seg [role="radio"], .seg-item');
        if ((await items.count()) < 2) throw new Skip('fee picker has < 2 options');
        await items.nth(1).click();
      },
    },
  ],
  take: [
    { state: 'queue', auth: 'guest', route: '/take', ready: `${SHELL} .panel` },
    {
      state: 'code-typed',
      auth: 'guest',
      route: '/take',
      ready: `${SHELL} .panel`,
      run: async (page) => {
        const input = page
          .locator('.code-slots input, input[inputmode], input[name="code"]')
          .first();
        if (!(await input.count())) throw new Skip('no code input');
        await input.fill('ABC1');
      },
    },
  ],
  history: [
    {
      state: 'empty',
      auth: 'guest',
      route: '/history',
      ready: `${SHELL} .panel, ${SHELL} .column`,
    },
    {
      state: 'one-open',
      auth: 'guest',
      setup: openChallenge,
      route: '/history',
      ready: `${SHELL} .panel, ${SHELL} .column`,
    },
  ],
  profile: [
    { state: 'own', auth: 'guest', route: '/profile', ready: `${SHELL} .panel, ${SHELL} .profile` },
  ],
  challenge: [
    {
      state: 'open',
      auth: 'guest',
      setup: openChallenge,
      route: (c) => `/challenge/${c.challengeId}`,
      ready: `${SHELL} .panel`,
    },
  ],
  play: [
    {
      state: 'ready',
      route: playRoute,
      ready: '.dialog',
      run: async (page) => {
        await page
          .locator('.dialog button', { hasText: /start/i })
          .first()
          .waitFor({ timeout: 30000 });
      },
    },
    {
      state: 'countdown',
      route: playRoute,
      ready: '.dialog',
      settleMs: 0,
      noFinish: true,
      run: async (page) => {
        await hooks(page);
        await pressStart(page);
        await page.waitForTimeout(700);
      },
    },
    {
      state: 'mid-game',
      route: playRoute,
      ready: '.dialog',
      run: async (page) => {
        await hooks(page);
        await pressStart(page);
        await waitStarted(page);
        const made = await playMoves(page, Number(process.env.CAPTURE_MOVES ?? 14));
        if (made === 0) throw new Skip('the bot made no moves');
        await page.waitForTimeout(900); // let the last flight land
        return { note: `${made} moves` };
      },
    },
    {
      state: 'drag',
      route: playRoute,
      ready: '.dialog',
      noFinish: true,
      run: async (page) => {
        const h = await hooks(page);
        await pressStart(page);
        await waitStarted(page);
        await playMoves(page, 4);
        await page.waitForTimeout(700);
        if (!h.anchor)
          throw new Skip(
            `no card-anchor hook on playfield (wanted one of: cardPoint(pile, n) -> {x,y} CSS px)`,
          );
        const m = await dragCandidate(page);
        if (!m) throw new Skip('no legal card move to drag');
        const a = await anchor(page, h.anchor, m.from, m.n);
        const b = await anchor(page, h.anchor, m.to, 0);
        if (!a || !b)
          throw new Skip(`${h.anchor}(${m.from}, ${m.n}) or (${m.to}, 0) returned nothing`);
        // Real pointer events, the path a finger takes: down on the card, most of the way over.
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        for (let i = 1; i <= 12; i++) {
          const t = (i / 12) * 0.7;
          await page.mouse.move(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
          await page.waitForTimeout(16);
        }
        await page.waitForTimeout(500);
        if (h.debugStep) await step(page, 0.1);
        return { note: `${m.from}x${m.n} -> ${m.to}` };
      },
    },
    {
      state: 'results',
      route: playRoute,
      ready: '.dialog',
      run: async (page) => {
        const h = await hooks(page);
        await pressStart(page);
        await waitStarted(page);
        await playMoves(page, 8).catch(() => 0);
        if (!h.forfeit) throw new Skip('controller.forfeit() missing');
        await page.evaluate(() => (window.__solitaire ?? window.__blockari).controller.forfeit());
        // The cinematic, then the buttons once the result is recorded.
        await page
          .waitForFunction(
            () =>
              [...document.querySelectorAll('button')].some(
                (b) =>
                  /again|home|new game|play/i.test(b.textContent ?? '') &&
                  b.getClientRects().length,
              ),
            null,
            { timeout: 30000 },
          )
          .catch(() => undefined);
        await page.waitForTimeout(1500);
      },
    },
  ],
};
