#!/usr/bin/env node
/**
 * QA capture: one screen, every state, phone 390×844 and desktop 1920×1080, @2x.
 *
 *   pnpm capture -- --screen home --base http://127.0.0.1:5373 [--out /tmp/aaa2] [--qa]
 *                   [--device phone|desktop|both] [--state <name>[,<name>]] [--full] [--strict]
 *   pnpm capture -- --list
 *
 * Writes <out>/sol-<screen>/{phone,desktop}/NN-<state>.png; with --qa also
 * <repo>/qa/sol-<screen>/{phone,desktop}/NN-<state>.png. NN is the state's
 * position in the registry (stable even when a state is filtered or skipped).
 *
 * One fresh browser context and one app page load per frame. Fonts are awaited
 * and running animations/transitions finished before every shot.
 *
 * Exit status: 0 clean; 1 when any frame logged a page error or a console
 * error (or, with --strict, when any frame was skipped); 2 on bad usage.
 * A missing debug hook is a SKIP with the hook's name, never a crash.
 */
import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, DEVICES, parseArgs, settle, watchErrors, signInGuest } from './browser.mjs';
import { SCREENS } from './screens.mjs';
import { Skip } from './play.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = parseArgs(process.argv.slice(2), ['qa', 'full', 'strict', 'list', 'help']);

if (args.list || args.help) {
  for (const [k, v] of Object.entries(SCREENS))
    console.log(`${k.padEnd(10)} ${v.map((s) => s.state).join(', ')}`);
  process.exit(0);
}
const screen = args.screen ?? args._[0];
if (!screen || !SCREENS[screen]) {
  console.error(
    `usage: pnpm capture -- --screen <${Object.keys(SCREENS).join('|')}> --base http://127.0.0.1:5373 [--out /tmp/aaa2] [--qa]`,
  );
  process.exit(2);
}
if (!args.base) {
  // No default on purpose: a capture must name the host it photographs.
  console.error('--base is required, e.g. --base http://127.0.0.1:5373 (never production)');
  process.exit(2);
}
const base = String(args.base).replace(/\/$/, '');
const outRoot = String(args.out ?? '/tmp/aaa2');
const devices =
  !args.device || args.device === 'both' ? ['phone', 'desktop'] : String(args.device).split(',');
const only = args.state ? String(args.state).split(',') : null;
for (const d of devices)
  if (!DEVICES[d]) {
    console.error(`unknown device ${d}`);
    process.exit(2);
  }

const browser = await launch();
const results = [];
try {
  for (const device of devices) {
    const states = SCREENS[screen];
    for (let i = 0; i < states.length; i++) {
      const st = states[i];
      if (only && !only.includes(st.state)) continue;
      const file = `${String(i + 1).padStart(2, '0')}-${st.state}.png`;
      results.push(await frame(device, st, file));
    }
  }
} finally {
  await browser.close();
}

async function frame(device, st, file) {
  const ctx = await browser.newContext({ ...DEVICES[device], reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  const errors = [];
  watchErrors(page, errors);
  const tag = `sol-${screen}/${device}/${file}`;
  const res = { tag, device, state: st.state, status: 'ok', note: '', errors };
  try {
    let vars = {};
    if (st.auth === 'guest' || st.setup) {
      // A same-origin page that is not the app: the guest cookie and any setup
      // calls are made from the page context without costing an app load.
      await page.goto(`${base}/api/health`, { waitUntil: 'domcontentloaded' });
      const g = await signInGuest(page);
      if (!g.ok)
        throw new Error(`POST /api/auth/guest -> ${g.status} (is the API up behind ${base}?)`);
      if (st.setup) vars = (await st.setup(page)) ?? {};
    }
    const route = typeof st.route === 'function' ? st.route(vars) : st.route;
    await page.goto(base + route, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    if (st.ready) {
      const shown = await page.waitForSelector(st.ready, { state: 'visible', timeout: 20000 }).then(
        () => true,
        () => false,
      );
      if (!shown) {
        // Not a skip: the screen itself did not come up. Keep what it did show, for diagnosis.
        const dir = path.join(outRoot, `sol-${screen}`, device);
        mkdirSync(dir, { recursive: true });
        await page
          .screenshot({ path: path.join(dir, file.replace(/\.png$/, '.FAILED.png')) })
          .catch(() => undefined);
        throw new Error(
          `never showed ${st.ready} at ${route} (landed on ${new URL(page.url()).pathname}); see ${file.replace(/\.png$/, '.FAILED.png')}`,
        );
      }
    }
    await settle(page, 400);
    if (st.run) {
      const r = await st.run(page, vars);
      if (r?.note) res.note = r.note;
    }
    if (st.scroll) {
      await page.evaluate((y) => window.scrollTo(0, y), st.scroll);
      await page.waitForTimeout(400);
    }
    if (st.noFinish) await page.evaluate(() => document.fonts.ready);
    else await settle(page, st.settleMs ?? 300);
    const dir = path.join(outRoot, `sol-${screen}`, device);
    mkdirSync(dir, { recursive: true });
    const out = path.join(dir, file);
    await page.screenshot({ path: out, fullPage: !!args.full, timeout: 90000 });
    res.path = out;
    if (args.qa) {
      const qdir = path.join(REPO, 'qa', `sol-${screen}`, device);
      mkdirSync(qdir, { recursive: true });
      copyFileSync(out, path.join(qdir, file));
    }
  } catch (e) {
    if (e instanceof Skip) {
      res.status = 'skip';
      res.note = e.message;
    } else {
      res.status = 'error';
      res.note = String(e?.message ?? e).split('\n')[0];
    }
  } finally {
    await ctx.close();
  }
  const bad = errors.filter((x) => !x.ignored);
  // Page/console errors fail the frame whatever else happened (a skip included).
  if (res.status !== 'error' && bad.length) res.status = 'page-errors';
  const mark = { ok: 'OK  ', skip: 'SKIP', error: 'FAIL', 'page-errors': 'ERR ' }[res.status];
  console.log(`${mark} ${tag}${res.note ? `  — ${res.note}` : ''}`);
  for (const x of errors)
    console.log(`       ${x.ignored ? '(ignored) ' : ''}${x.kind}: ${x.text.slice(0, 220)}`);
  return res;
}

const n = (s) => results.filter((r) => r.status === s).length;
console.log(
  `\n${screen}: ${n('ok')} ok · ${n('skip')} skipped · ${n('page-errors')} with page/console errors · ${n('error')} failed`,
);
console.log(
  `frames: ${path.join(outRoot, `sol-${screen}`)}${args.qa ? `  +  ${path.join(REPO, 'qa', `sol-${screen}`)}` : ''}`,
);
const failed = n('error') + n('page-errors') + (args.strict ? n('skip') : 0);
process.exit(failed ? 1 : 0);
