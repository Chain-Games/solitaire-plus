#!/usr/bin/env node
/**
 * DOM layout parity: the same route on Solitaire Plus and on Blockari's
 * reference build, every rendered element measured on both, matched class to
 * class, and every dimension more than 4 px apart listed. Port of 21 Wild's
 * tools/parity/measure.mjs, but live on both sides instead of against a frozen
 * TSV, and over every element rather than a fixed selector list.
 *
 *   node tools/parity/src/measure.mjs --screen home [--state signed-in]
 *        [--sol http://127.0.0.1:5373] [--ref http://127.0.0.1:4179]
 *        [--device phone|desktop|both] [--tol 4] [--dims w,h,x,y,tw,th,fs,lh,ls]
 *        [--ref-api auto|mirror|live] [--out /tmp/aaa2/parity] [--shots] [--all]
 *
 * Measured per element (CSS px, page coordinates): box x/y/w/h; and for an
 * element with its own text: font-size, line-height, letter-spacing and the
 * text box (a Range over its direct text nodes) width/height. Colours are not
 * measured: Solitaire Plus has its own palette.
 *
 * Matching: an element's key is the chain of its classed ancestors
 * (`tag.class.class`, classes sorted, state classes in parity-map.json
 * `ignoreClasses` dropped) plus its own token, plus its index among identical
 * keys in document order. Classless elements are keyed under their nearest
 * classed ancestor, so `.hero > h1` matches `.hero > h1`.
 *
 * Signed-in screens on Blockari: :4179 is a vite preview whose /api proxy may
 * have nothing behind it. `--ref-api auto` (default) probes <ref>/api/health;
 * if it is not 200 every Blockari /api request is answered by the Solitaire
 * Plus API as the SAME guest ("mirror"), so both sides render the same
 * account, balance and challenges. `live` never mirrors. Either way the
 * header says which, and if Blockari lands on a different path than asked
 * (a redirect to /auth), that is printed and the diff is still what rendered.
 *
 * Exit: 0 when nothing is out of tolerance and nothing on Blockari is missing
 * on Solitaire Plus; 1 otherwise; 2 on bad usage / unreachable hosts.
 * Output: <out>/<screen>-<state>-<device>.{tsv,json}, and <out>/<screen>-<state>.fails.tsv.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launch,
  DEVICES,
  parseArgs,
  settle,
  watchErrors,
  signInGuest,
} from '../../capture/src/browser.mjs';
import { SCREENS } from '../../capture/src/screens.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2), ['shots', 'all', 'help']);
const screen = args.screen ?? args._[0];
if (!screen || !SCREENS[screen] || args.help) {
  console.error(
    `usage: node tools/parity/src/measure.mjs --screen <${Object.keys(SCREENS).join('|')}> [--state <name>] [--device phone|desktop|both]`,
  );
  process.exit(2);
}
const st = args.state ? SCREENS[screen].find((s) => s.state === args.state) : SCREENS[screen][0];
if (!st) {
  console.error(
    `no state ${args.state} on ${screen}: ${SCREENS[screen].map((s) => s.state).join(', ')}`,
  );
  process.exit(2);
}
const SOL = String(args.sol ?? 'http://127.0.0.1:5373').replace(/\/$/, '');
const REF = String(args.ref ?? 'http://127.0.0.1:4179').replace(/\/$/, '');
const TOL = Number(args.tol ?? 4);
const DIMS = String(args.dims ?? 'x,y,w,h,tw,th,fs,lh,ls').split(',');
const OUT = String(args.out ?? '/tmp/aaa2/parity');
const devices =
  !args.device || args.device === 'both' ? ['phone', 'desktop'] : String(args.device).split(',');
const MAP = JSON.parse(readFileSync(path.join(HERE, '..', 'parity-map.json'), 'utf8'));
mkdirSync(OUT, { recursive: true });

async function probe(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return r.status;
  } catch {
    return 0;
  }
}
for (const [name, base] of [
  ['solitaire', SOL],
  ['blockari', REF],
]) {
  if (!(await probe(base + '/'))) {
    console.error(`${name} is not answering at ${base}`);
    process.exit(2);
  }
}
const refApiLive = (await probe(REF + '/api/health')) === 200;
const refApi =
  args['ref-api'] === 'live'
    ? 'live'
    : args['ref-api'] === 'mirror'
      ? 'mirror'
      : refApiLive
        ? 'live'
        : 'mirror';

/** Runs in the page: every rendered element, keyed and measured. */
function collect(cfg) {
  const ignore = new Set(cfg.ignoreClasses);
  const rename = cfg.rename;
  const skipSel = cfg.skip.join(',');
  const r2 = (v) => Math.round(v * 100) / 100;
  const px = (v) => (v === 'normal' ? 'normal' : r2(parseFloat(v)));
  const token = (el) => {
    const cls = [...el.classList]
      .filter((c) => !ignore.has(c))
      .map((c) => rename[c] ?? c)
      .sort();
    return el.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '');
  };
  const rows = [];
  const seen = new Map();
  const walk = (el, chain) => {
    for (const child of el.children) {
      if (skipSel && child.matches(skipSel)) continue;
      const cs = getComputedStyle(child);
      if (cs.display === 'none') continue;
      const tok = token(child);
      const classed = child.classList.length > 0;
      const key = [...chain, tok].join(' > ');
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      const rects = child.getClientRects();
      if (rects.length && cs.visibility !== 'hidden' && Number(cs.opacity) > 0) {
        const b = child.getBoundingClientRect();
        const row = {
          key: `${key} #${n}`,
          x: r2(b.left + scrollX),
          y: r2(b.top + scrollY),
          w: r2(b.width),
          h: r2(b.height),
        };
        let text = '';
        let l = Infinity,
          t = Infinity,
          rt = -Infinity,
          bt = -Infinity;
        for (const node of child.childNodes) {
          if (node.nodeType !== 3 || !node.textContent.trim()) continue;
          text += node.textContent.trim() + ' ';
          const rg = document.createRange();
          rg.selectNodeContents(node);
          const tb = rg.getBoundingClientRect();
          if (!tb.width) continue;
          l = Math.min(l, tb.left);
          t = Math.min(t, tb.top);
          rt = Math.max(rt, tb.right);
          bt = Math.max(bt, tb.bottom);
        }
        if (text) {
          row.text = text.trim().slice(0, 60);
          row.fs = px(cs.fontSize);
          row.lh = px(cs.lineHeight);
          row.ls = px(cs.letterSpacing === 'normal' ? '0' : cs.letterSpacing);
          row.font = `${cs.fontWeight} ${cs.fontFamily.split(',')[0].replace(/"/g, '')}`;
          if (l < rt) {
            row.tw = r2(rt - l);
            row.th = r2(bt - t);
          }
        }
        rows.push(row);
      }
      walk(child, classed ? [...chain, tok] : chain);
    }
  };
  walk(document.body, []);
  return { path: location.pathname, rows };
}

async function open(browser, device, base, side, ctxShare) {
  const ctx = await browser.newContext(DEVICES[device]);
  const page = await ctx.newPage();
  const errors = [];
  watchErrors(page, errors);
  let vars = ctxShare.vars;
  if (side === 'sol') {
    if (st.auth === 'guest' || st.setup) {
      await page.goto(`${base}/api/health`, { waitUntil: 'domcontentloaded' });
      const g = await signInGuest(page);
      if (!g.ok) throw new Error(`Solitaire Plus: POST /api/auth/guest -> ${g.status}`);
      if (st.setup) vars = ctxShare.vars = (await st.setup(page)) ?? {};
    }
    ctxShare.solCtx = ctx;
  } else if (refApi === 'mirror' && ctxShare.solCtx) {
    // Blockari's /api answered by Solitaire Plus's, as the same guest.
    const solReq = ctxShare.solCtx.request;
    await ctx.route(/\/api\//, async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      try {
        const resp = await solReq.fetch(SOL + u.pathname + u.search, {
          method: req.method(),
          headers: { 'content-type': req.headers()['content-type'] ?? 'application/json' },
          data: req.postDataBuffer() ?? undefined,
          failOnStatusCode: false,
        });
        await route.fulfill({ response: resp });
      } catch {
        await route.abort();
      }
    });
  }
  const route = typeof st.route === 'function' ? st.route(vars ?? {}) : st.route;
  await page.goto(base + route, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
  let note = '';
  if (st.ready)
    await page.waitForSelector(st.ready, { state: 'visible', timeout: 20000 }).catch(() => {
      note = `never showed ${st.ready}`;
    });
  await settle(page, 400);
  if (st.run && !note) {
    try {
      await st.run(page, vars ?? {});
    } catch (e) {
      note = `state not reached: ${String(e.message).split('\n')[0]}`;
    }
  }
  if (st.scroll) {
    await page.evaluate((y) => window.scrollTo(0, y), st.scroll);
    await page.waitForTimeout(400);
  }
  await settle(page, 300);
  const data = await page.evaluate(collect, {
    ignoreClasses: MAP.ignoreClasses ?? [],
    rename: MAP.rename ?? {},
    skip: MAP.skip ?? [],
  });
  if (args.shots)
    await page.screenshot({ path: path.join(OUT, `${screen}-${st.state}-${device}-${side}.png`) });
  return { ctx, route, note, errors, ...data };
}

const LABEL = {
  x: 'x',
  y: 'y',
  w: 'width',
  h: 'height',
  tw: 'text w',
  th: 'text h',
  fs: 'font-size',
  lh: 'line-height',
  ls: 'letter-sp',
};
const browser = await launch();
let totalFail = 0,
  totalMissing = 0;
const failRows = [];
console.log(
  `parity ${screen}/${st.state}  sol ${SOL}  ref ${REF}  tol ±${TOL}px  dims ${DIMS.join(',')}`,
);
console.log(
  `blockari api: ${refApi}${refApi === 'mirror' ? ` (${REF}/api/health is not 200; Blockari's /api is served by Solitaire Plus's, same guest)` : ''}`,
);
try {
  for (const device of devices) {
    const share = { vars: {} };
    const sol = await open(browser, device, SOL, 'sol', share);
    const ref = await open(browser, device, REF, 'ref', share);
    const S = new Map(sol.rows.map((r) => [r.key, r]));
    const R = new Map(ref.rows.map((r) => [r.key, r]));
    const tsv = [['key', 'dim', 'blockari', 'solitaire', 'delta', 'status', 'text'].join('\t')];
    const fails = [],
      missing = [],
      extra = [];
    let pass = 0;
    // A leaf whose classes changed (an added modifier, a renamed icon) keeps
    // its place: same classed-ancestor chain, same tag, same order among the
    // unmatched. Pair those, compare them, and call them RECLASSED — not a
    // missing element plus an extra one.
    const loose = (k) => k.replace(/ #\d+$/, '').replace(/([a-z0-9]+)(\.[^ >]+)?$/, '$1');
    const spare = new Map();
    for (const [key, sr] of S)
      if (!R.has(key)) {
        const l = loose(key);
        spare.set(l, [...(spare.get(l) ?? []), sr]);
      }
    const reclassed = [];
    const compare = (key, r, s) => {
      for (const d of DIMS) {
        if (r[d] === undefined && s[d] === undefined) continue;
        const a = r[d],
          b = s[d];
        let delta, ok;
        if (typeof a === 'number' && typeof b === 'number') {
          delta = Math.round((b - a) * 100) / 100;
          ok = Math.abs(delta) <= TOL;
        } else {
          delta = '';
          ok = a === b;
        }
        tsv.push(
          [key, d, a ?? '', b ?? '', delta, ok ? 'PASS' : 'FAIL', s.text ?? r.text ?? ''].join(
            '\t',
          ),
        );
        if (ok) pass++;
        else
          fails.push({ key, d, a, b, delta, text: s.text ?? r.text ?? '', refText: r.text ?? '' });
      }
    };
    for (const [key, r] of R) {
      let s = S.get(key);
      if (!s) {
        s = spare.get(loose(key))?.shift();
        if (s) {
          reclassed.push([key, s.key]);
          S.delete(s.key);
          tsv.push([key, '-', '', '', '', 'RECLASSED', s.key].join('\t'));
        }
      }
      if (!s) {
        missing.push(r);
        tsv.push([key, '-', '', '', '', 'MISSING', r.text ?? ''].join('\t'));
        continue;
      }
      compare(key, r, s);
    }
    for (const [key, s] of S)
      if (!R.has(key)) {
        extra.push(s);
        tsv.push([key, '-', '', '', '', 'EXTRA', s.text ?? ''].join('\t'));
      }
    const base = path.join(OUT, `${screen}-${st.state}-${device}`);
    writeFileSync(`${base}.tsv`, tsv.join('\n') + '\n');
    writeFileSync(
      `${base}.json`,
      JSON.stringify(
        {
          screen,
          state: st.state,
          device,
          tol: TOL,
          refApi,
          sol: {
            url: SOL + sol.route,
            landed: sol.path,
            note: sol.note,
            errors: sol.errors,
            rows: sol.rows,
          },
          ref: {
            url: REF + ref.route,
            landed: ref.path,
            note: ref.note,
            errors: ref.errors,
            rows: ref.rows,
          },
          fails,
          missing: missing.map((m) => m.key),
          reclassed,
          extra: extra.map((m) => m.key),
        },
        null,
        1,
      ),
    );

    console.log(
      `\n── ${device} ── solitaire ${sol.path}${sol.note ? ` (${sol.note})` : ''} · blockari ${ref.path}${ref.note ? ` (${ref.note})` : ''}`,
    );
    if (sol.path !== ref.path)
      console.log(`   ! the two landed on different paths; this diff compares what rendered`);
    const errs = (e) => e.filter((x) => !x.ignored).length;
    if (errs(sol.errors) || errs(ref.errors))
      console.log(
        `   page errors: solitaire ${errs(sol.errors)} · blockari ${errs(ref.errors)} (see json)`,
      );
    console.log(
      `   ${ref.rows.length} blockari elements · ${sol.rows.length} solitaire · ${pass} dims pass · ${fails.length} out · ${missing.length} missing · ${reclassed.length} reclassed · ${extra.length} extra`,
    );
    const show = args.all ? fails : fails.slice(0, 60);
    if (show.length) {
      console.log(
        `   ${'element'.padEnd(64)} ${'dim'.padEnd(11)} ${'blockari'.padStart(9)} ${'solitaire'.padStart(9)} ${'Δ'.padStart(8)}  text`,
      );
      const short = (k) => (k.length > 64 ? '…' + k.slice(-63) : k);
      for (const f of show)
        console.log(
          `   ${short(f.key).padEnd(64)} ${LABEL[f.d].padEnd(11)} ${String(f.a ?? '-').padStart(9)} ${String(f.b ?? '-').padStart(9)} ${String(f.delta === '' ? '≠' : (f.delta > 0 ? '+' : '') + f.delta).padStart(8)}  ${f.text ? JSON.stringify(f.text.slice(0, 24)) : ''}${f.refText && f.refText !== f.text ? ` (blockari ${JSON.stringify(f.refText.slice(0, 24))})` : ''}`,
        );
      if (fails.length > show.length)
        console.log(`   … ${fails.length - show.length} more (--all, or ${base}.tsv)`);
    }
    if (missing.length) {
      console.log(`   missing on solitaire (present on blockari):`);
      for (const m of missing.slice(0, args.all ? Infinity : 25)) console.log(`     ${m.key}`);
      if (!args.all && missing.length > 25) console.log(`     … ${missing.length - 25} more`);
    }
    if (reclassed.length) {
      console.log(`   reclassed (paired by place, compared; classes differ):`);
      for (const [a, b] of reclassed.slice(0, args.all ? Infinity : 12))
        console.log(`     ${a.split(' > ').pop()}  →  ${b.split(' > ').pop()}`);
    }
    for (const f of fails)
      failRows.push([device, f.key, f.d, f.a ?? '', f.b ?? '', f.delta, f.text].join('\t'));
    for (const m of missing)
      failRows.push([device, m.key, '-', '', '', 'MISSING', m.text ?? ''].join('\t'));
    totalFail += fails.length;
    totalMissing += missing.length;
    await sol.ctx.close();
    await ref.ctx.close();
  }
} catch (e) {
  // A host that stops answering mid-run (an API restart) is an environment
  // failure, not a parity result.
  console.error(`\nparity aborted: ${String(e?.message ?? e).split('\n')[0]}`);
  await browser.close();
  process.exit(2);
} finally {
  await browser.close().catch(() => undefined);
}
writeFileSync(
  path.join(OUT, `${screen}-${st.state}.fails.tsv`),
  ['device\tkey\tdim\tblockari\tsolitaire\tdelta\ttext', ...failRows].join('\n') + '\n',
);
console.log(
  `\n${screen}/${st.state}: ${totalFail} dimensions out of ±${TOL}px · ${totalMissing} elements missing   → ${OUT}/${screen}-${st.state}*.{tsv,json}`,
);
process.exit(totalFail + totalMissing ? 1 : 0);
