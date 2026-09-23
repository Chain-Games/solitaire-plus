/**
 * The one way these tools start Chromium on this box (KLONDIKE-BRIEF.md §10).
 *
 * Playwright, headless, SwiftShader: CPU rendering, deterministic, and it never
 * touches the discrete GPU (the RTX 5080 belongs to the model server). This is
 * the flag set of the known-good screenshot launcher and of
 * /home/adam/pixi-test/render.mjs `swiftshader`. Do not add GPU flags here; the
 * iGPU path is for performance runs only and lives in `/home/adam/pixi-test/run.sh igpu`.
 *
 * Playwright is imported from /home/adam/pixi-test/node_modules (the install
 * whose browsers are in ~/.cache/ms-playwright); PLAYWRIGHT_MODULE overrides it.
 */
const PW =
  process.env.PLAYWRIGHT_MODULE ?? '/home/adam/pixi-test/node_modules/playwright/index.mjs';

export const SWIFTSHADER_ARGS = Object.freeze([
  '--headless=new',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--ozone-platform=headless',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--font-render-hinting=none',
]);

/** The two presets the critic grades: CSS px, always @2x. */
export const DEVICES = Object.freeze({
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  desktop: {
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
  },
});

export async function launch() {
  const { chromium } = await import(PW);
  // Never let a stray env var steer ANGLE onto a hardware backend.
  const env = { ...process.env };
  delete env.MESA_VK_DEVICE_SELECT;
  return chromium.launch({ headless: true, args: [...SWIFTSHADER_ARGS], env });
}

/** Strip the `--` separators pnpm forwards, then read `--key value` / `--flag`. */
export function parseArgs(argv, flags = []) {
  const a = argv.filter((x) => x !== '--');
  const out = { _: [] };
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (!t.startsWith('--')) {
      out._.push(t);
      continue;
    }
    const [k, inline] = t.slice(2).split('=', 2);
    if (inline !== undefined) out[k] = inline;
    else if (flags.includes(k) || a[i + 1] === undefined || a[i + 1].startsWith('--'))
      out[k] = true;
    else out[k] = a[++i];
  }
  return out;
}

/** Fonts loaded, every running animation/transition finished, two frames painted. */
export async function settle(page, ms = 250) {
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  await page
    .evaluate(() => {
      for (const a of document.getAnimations()) {
        try {
          a.finish();
        } catch {
          /* infinite: leave it */
        }
      }
    })
    .catch(() => undefined);
  await page
    .evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    )
    .catch(() => undefined);
  if (ms) await page.waitForTimeout(ms);
}

/**
 * Collect page errors and console errors. Some are expected and harmless (a
 * signed-out `/api/auth/me` answering 401); those are listed here, by pattern,
 * and printed as "ignored" so nothing is silently swallowed.
 */
export const IGNORED_CONSOLE = [
  /status of 401/, // signed-out /api/auth/me probe
];
export function watchErrors(page, sink) {
  page.on('pageerror', (e) =>
    sink.push({
      kind: 'pageerror',
      text: `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`.split('\n')[0],
    }),
  );
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const loc = m.location?.()?.url ?? '';
    sink.push({
      kind: 'console',
      text: loc ? `${text} (${loc})` : text,
      ignored: IGNORED_CONSOLE.some((r) => r.test(text)),
    });
  });
}

/** Mint a guest session in the page context (cookie lands on the page's origin). */
export async function signInGuest(page) {
  return page.evaluate(async () => {
    const r = await fetch('/api/auth/guest', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, user: body?.user ?? null };
  });
}
