# tools/

QA tooling for Solitaire Plus: the capture harness the critic's frames come from,
and the DOM parity check against Blockari.

Both tools start Chromium **only** through Playwright, headless, on SwiftShader
(`tools/capture/src/browser.mjs`, the one launcher; KLONDIKE-BRIEF.md §10). They never
touch the discrete GPU and always load pages over http. Playwright is imported from
`/home/adam/pixi-test/node_modules` (set `PLAYWRIGHT_MODULE` to override).

Device presets, both at `deviceScaleFactor: 2`:

| preset  | CSS viewport | PNG size  |
| ------- | ------------ | --------- |
| phone   | 390×844      | 780×1688  |
| desktop | 1920×1080    | 3840×2160 |

## Capture: `tools/capture` (`@solitaire-plus/capture`)

```bash
pnpm capture -- --screen home --base http://127.0.0.1:5373             # → /tmp/aaa2/sol-home/{phone,desktop}/NN-<state>.png
pnpm capture -- --screen play --base http://127.0.0.1:5373 --qa        # also → qa/sol-play/{phone,desktop}/ in the repo
pnpm capture -- --list                                                 # screens and their states
```

| flag                       | meaning                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `--screen <name>`          | required. One of the screens below.                                         |
| `--base <url>`             | required (no default, so production can't be captured by accident).       |
| `--out <dir>`              | default `/tmp/aaa2`.                                                        |
| `--qa`                     | also copy each frame to `qa/sol-<screen>/<device>/`.                        |
| `--device phone\|desktop`  | default both.                                                               |
| `--state a,b`              | only these states (the file numbers stay the same).                     |
| `--full`                   | full-page shots instead of viewport shots.                                  |
| `--strict`                 | a skipped frame fails the run too.                                          |

| screen    | route                              | states                                                  |
| --------- | ---------------------------------- | ------------------------------------------------------- |
| home      | `/`                                | signed-out, signed-in, scrolled (600 px)                |
| auth      | `/auth`                            | sign-in, create-account, error (bad sign-in)            |
| create    | `/create`                          | default, fee-changed                                    |
| take      | `/take`                            | queue, code-typed                                       |
| history   | `/history`                         | empty, one-open (a challenge opened via the API first)  |
| profile   | `/profile`                         | own                                                     |
| challenge | `/challenge/:id`                   | open (created via `POST /api/challenges`)               |
| play      | `/play/solo?seed=<seed>&debug=1`   | ready, countdown, mid-game, drag, results               |

Every frame gets a fresh browser context and **one** app page load. Signed-in states
first mint a guest from the page context (`POST /api/auth/guest` from a same-origin
non-app page, `/api/health`), then make any setup calls as that guest, then load the
route. Before each shot: `document.fonts.ready`, every running animation/transition
`finish()`ed, two rAFs. The countdown and drag frames are shot without finishing
animations, so the moment isn't skipped.

Env: `CAPTURE_SEED` (default `qa-capture-1`), `CAPTURE_MOVES` (mid-game moves, default 14).

**Exit status.** `1` if any frame logged a page error or a console error (ignored
patterns are printed as `(ignored)`; today that's only a 401 on the signed-out
`/api/auth/me` probe; see `IGNORED_CONSOLE` in `browser.mjs`), or if a screen never
reached its ready selector (a `NN-<state>.FAILED.png` is kept in `--out` for
diagnosis). A missing debug hook is a **SKIP** that names the hook, not a crash.
`2` means bad usage.

### Playfield hooks (play states)

Under `?debug`, the harness reads `window.__solitaire` (`window.__blockari` is
accepted until the rename lands). What each state needs:

| state     | needs                                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| ready     | the `.dialog` with a **Start** button                                                                                                    |
| countdown | `{ controller, playfield }` on the hook; Start                                                                                           |
| mid-game  | `controller.started`, `controller.move(move)` → `null \| refusal`, `controller.current` (GameState), `sim.legalMoves(state)`; `sim.faceUpCount` + `sim.pileSlots` let the bot prefer moves that turn a card |
| drag      | the above, plus a card anchor: `playfield.cardPoint(pile: PileId, n: number) → { x, y }`, the centre of the n-th card from the top of `pile` in canvas CSS px (`n = 0` on a target pile = where a dropped card would land). The harness then drags with **real** mouse events. `playfield.debugStep(dtSec)` is used when present. |
| results   | `controller.forfeit()`, then a visible button matching /again\|home\|new game\|play/                                                      |

The anchor name can also be `pileAnchor`, `cardCentre`, `cardCenter`, `pilePoint` or `pileCentre`
(`ANCHOR_HOOKS` in `src/play.mjs`), all with the same signature.

## Parity: `tools/parity` (`@solitaire-plus/parity`)

```bash
node tools/parity/src/measure.mjs --screen home --state signed-in            # sol :5373 vs blockari :4179, both devices
node tools/parity/src/measure.mjs --screen auth --device phone --shots --all
```

| flag                          | meaning                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `--screen`, `--state`         | the capture registry's screens/states (the state defaults to the first one)                    |
| `--sol <url>` / `--ref <url>` | default `http://127.0.0.1:5373` / `http://127.0.0.1:4179`                                     |
| `--tol <px>`                  | default 4                                                                                       |
| `--dims`                      | default `x,y,w,h,tw,th,fs,lh,ls` (box; text box w/h; font-size, line-height, letter-spacing)    |
| `--ref-api auto\|mirror\|live`| see below                                                                                       |
| `--out <dir>`                 | default `/tmp/aaa2/parity`                                                                      |
| `--shots`                     | also save both sides' viewport PNGs next to the tables                                          |
| `--all`                       | print every failing row (default: the first 60)                                                 |

**What is compared.** Every rendered element on the page (not `display:none`, not
`visibility:hidden`, not opacity 0; `parity-map.json` `skip` excludes the backdrop,
canvases, SVG internals and aria-hidden decoration). For each: page-coordinate box
x/y/w/h, and for elements with their own text: font-size, line-height,
letter-spacing, and the text box (a Range over the element's direct text nodes).
**Colours are not compared.**

**Matching.** Class to class. An element's key is its chain of classed ancestors
plus itself (`tag.class.class`, classes sorted, `ignoreClasses` dropped, `rename`
applied), plus its index among identical keys. A classless `h1` under `.hero` is
`section.hero > h1`. An element on Blockari with no match on Solitaire Plus is
**MISSING** (a failure); one only on Solitaire Plus is **EXTRA** (listed only).

**Blockari's API.** `:4179` is a vite preview whose `/api` proxy has nothing behind it
(500). With `--ref-api auto` (the default), if `<ref>/api/health` isn't 200, every
Blockari `/api` request is answered by the Solitaire Plus API **as the same guest**
(`mirror`), so both sides render the same account, balance, challenges and
history. The run header says which mode was used. If the two sides land on different
paths, that's printed and the diff compares what rendered.

**Output** (`--out`): `<screen>-<state>-<device>.tsv` (every compared dimension,
PASS/FAIL/MISSING/EXTRA), `<screen>-<state>-<device>.json` (both sides' raw rows,
page errors, fails), `<screen>-<state>.fails.tsv` (the failures only, both devices).
Exit `1` if anything is off by more than the tolerance or missing, `2` if a host is down.

A self-test: `--sol http://127.0.0.1:4179 --ref http://127.0.0.1:4179` must report 0 out, 0 missing.
