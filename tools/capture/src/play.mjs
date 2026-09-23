/**
 * Driving the Klondike playfield through its `?debug` hooks.
 *
 * The hook object is `window.__solitaire` (the shell's older name
 * `window.__blockari` is accepted while the rename lands). Everything here is
 * defensive: the playfield is being rewritten, so a hook that is not there
 * yet throws `Skip` with the name it wanted, and the frame is reported as
 * skipped rather than crashing the run. The contract the harness wants is in
 * tools/README.md ("Playfield hooks").
 */
export class Skip extends Error {}

/** Names tried, in order, for "where on screen is card n of pile p" (CSS px, page coords). */
export const ANCHOR_HOOKS = [
  'cardPoint',
  'pileAnchor',
  'cardCentre',
  'cardCenter',
  'pilePoint',
  'pileCentre',
];

export async function hooks(page, timeout = 20000) {
  const ok = await page
    .waitForFunction(
      () => {
        const S = window.__solitaire ?? window.__blockari;
        return !!(S && S.controller && S.playfield);
      },
      null,
      { timeout },
    )
    .then(
      () => true,
      () => false,
    );
  if (!ok)
    throw new Skip(
      'window.__solitaire {controller, playfield} never appeared (is ?debug=1 wired on /play/solo?)',
    );
  return page.evaluate((anchors) => {
    const S = window.__solitaire ?? window.__blockari;
    const pf = S.playfield;
    const fn = (o, k) => !!o && typeof o[k] === 'function';
    return {
      name: window.__solitaire ? '__solitaire' : '__blockari',
      debugStep: fn(pf, 'debugStep'),
      debugResume: fn(pf, 'debugResume'),
      anchor: anchors.find((k) => fn(pf, k)) ?? null,
      pointerGrab: fn(pf, 'pointerGrab'),
      pointerMove: fn(pf, 'pointerMove'),
      pointerRelease: fn(pf, 'pointerRelease'),
      legalMoves: fn(S.sim, 'legalMoves'),
      move: fn(S.controller, 'move'),
      forfeit: fn(S.controller, 'forfeit'),
    };
  }, ANCHOR_HOOKS);
}

/** Press the ready dialog's Start button. */
export async function pressStart(page) {
  const btn = page.locator('.dialog button', { hasText: /start/i }).first();
  await btn.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {
    throw new Skip('no ready dialog with a Start button');
  });
  await btn.click();
}

export async function waitStarted(page, timeout = 30000) {
  const ok = await page
    .waitForFunction(
      () => (window.__solitaire ?? window.__blockari)?.controller?.started === true,
      null,
      { timeout },
    )
    .then(
      () => true,
      () => false,
    );
  if (!ok) throw new Skip('controller.started never became true after Start');
  // SwiftShader runs well under real time: slow the game clock so the capture
  // never runs out of it.
  await page.evaluate(() => {
    const c = (window.__solitaire ?? window.__blockari).controller;
    if ('debugTimeScale' in c) c.debugTimeScale = 0.25;
  });
}

/**
 * Play `count` moves through the controller with a small greedy bot:
 * home first, then moves that turn a card, then the waste, then a draw.
 * Never undoes, never pulls from a foundation, never shuffles between
 * tableau piles without revealing something (so it cannot loop).
 */
export async function playMoves(page, count) {
  const h = await hooks(page);
  if (!h.move) throw new Skip('controller.move() missing');
  if (!h.legalMoves)
    throw new Skip(
      `${h.name}.sim.legalMoves missing (expose { legalMoves } from @solitaire-plus/sim on the debug hook)`,
    );
  let made = 0;
  for (let i = 0; i < count * 3 && made < count; i++) {
    const r = await page.evaluate(() => {
      const S = window.__solitaire ?? window.__blockari;
      const st = S.controller.current;
      if (st.status !== 'playing') return { done: true };
      // A tableau move is only worth making if it turns a card: needs pileSlots + faceUpCount.
      const canSee =
        typeof S.sim.pileSlots === 'function' && typeof S.sim.faceUpCount === 'function';
      const turns = (p, n) =>
        canSee && n === S.sim.faceUpCount(st, p) && S.sim.pileSlots(st, p).length > n;
      const score = (m) => {
        if (m.t === 'draw') return 10;
        if (m.t !== 'mv') return -1;
        if (String(m.from).startsWith('f')) return -1;
        if (String(m.to).startsWith('f')) return 50;
        if (m.from === 'waste') return 30;
        if (String(m.from).startsWith('t')) {
          return turns(m.from, m.n) ? 40 : -1;
        }
        return -1;
      };
      const all = S.sim
        .legalMoves(st)
        .map((m) => [score(m), m])
        .filter(([s]) => s >= 0);
      all.sort((a, b) => b[0] - a[0]);
      if (!all.length) return { done: true };
      const refusal = S.controller.move(all[0][1]);
      return { move: all[0][1], refusal };
    });
    if (r.done) break;
    if (!r.refusal) made++;
    else if (r.refusal === 'pending') await page.waitForTimeout(300);
    await page.waitForTimeout(120);
  }
  return made;
}

/** A legal move whose source card is on screen, for the drag frame. */
export async function dragCandidate(page) {
  return page.evaluate(() => {
    const S = window.__solitaire ?? window.__blockari;
    const ms = S.sim
      .legalMoves(S.controller.current)
      .filter((m) => m.t === 'mv' && !String(m.from).startsWith('f'));
    return ms.find((m) => String(m.to).startsWith('t')) ?? ms[0] ?? null;
  });
}

/** Where card n (1 = top) of a pile is, in page CSS px, via whichever anchor hook exists. */
export async function anchor(page, name, pile, n) {
  return page.evaluate(
    ([k, p, nn]) => {
      const S = window.__solitaire ?? window.__blockari;
      const pt = S.playfield[k](p, nn);
      if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
      // Canvas-local → page: add the canvas's offset (zero for a full-bleed canvas).
      const c = S.playfield.app?.canvas ?? document.querySelector('canvas');
      const r = c?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
      return { x: pt.x + r.left, y: pt.y + r.top };
    },
    [name, pile, n],
  );
}

export async function step(page, dt) {
  await page.evaluate((d) => {
    const pf = (window.__solitaire ?? window.__blockari).playfield;
    if (typeof pf.debugStep === 'function') pf.debugStep(d);
  }, dt);
}
