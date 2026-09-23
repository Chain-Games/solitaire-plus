# Klondike Solitaire — build brief

A single-player Klondike Solitaire for the browser, mobile first. This document
is the whole specification: stack, architecture, rules, layout, interaction and
the traps worth knowing before writing anything.

---

## 1. What is being built

Klondike, draw-3, unlimited redeals, unlimited undo. One deck of 52 cards.

It must be **excellent on a phone in portrait**, good in landscape, and good on
a desktop. Portrait phone is the hard case and the one to design against; the
others are easier and must not be allowed to drive the layout.

There is no timer, no combo system, no score multiplier and no fail state. A
game of Klondike is either won, abandoned, or still going. Do not add pressure
mechanics — the appeal of this game is that it is calm.

---

## 2. Stack

Use these exact libraries. Versions are the ones known to work together; take
patch updates freely, hold major versions.

### Client

| | version | role |
|---|---|---|
| **PixiJS** | 8.20.1 | WebGL renderer. All gameplay is drawn here — no DOM inside the play area. |
| **GSAP** | 3.15.0 | Every tween and timeline: deal, drag, flip, snap-back, win cascade. |
| **pixi-filters** | 6.1.5 | Base filters for the post-processing chain. |
| **TypeScript** | 5.9.3 | `strict: true` **and** `noUncheckedIndexedAccess: true`. |
| **Vite** | 7.3.6 | Dev server and build. |
| **Vitest** | 3.2.7 | Unit tests. |
| **svgo** | 3.3.4 | Build-time card artwork compression only. |

**No UI framework.** No React, no Vue, no state management library, no CSS
framework, no component library. Menus and the HUD are hand-written DOM plus one
stylesheet. This is not asceticism — a canvas game with five screens does not
benefit from a virtual DOM, and every one of those dependencies is weight on a
phone.

### Server — optional, and probably not for v1

Klondike is single-player. There is nothing to cheat at until there is a shared
board or a public leaderboard, so **ship v1 with no server at all** and keep
progress in `localStorage`.

Add a server only when you want a **daily deal** (everyone gets the same shuffle
today), a **leaderboard**, or **cross-device resume**. When you do:

| | version | role |
|---|---|---|
| **Node** | 24 (alpine) | Node 20 lacks a global `WebSocket` and some test setups fail on it. |
| **Fastify** | 5.12.1 | The API. |
| **pg** | 8.23.0 | Postgres client. No ORM. |
| **PostgreSQL** | 16 (alpine) | Schema applied on boot; every statement `IF NOT EXISTS`. |
| **esbuild** | 0.28.2 | Bundles the server together with the client's rules engine. |

**If a server is added, it must share the client's rules engine** — the same
`src/game` modules, bundled into the server build. Never write the rules twice.
A second implementation of "is this move legal" will disagree with the first
eventually, and it will do so in production.

### Infrastructure

| | version | role |
|---|---|---|
| **Caddy** | 2 (alpine) | TLS with automatic Let's Encrypt. |
| **nginx** | 1.27 (alpine) | Serves the built static bundle inside the container. |
| **Docker Compose** | — | `game`, plus `api` and `db` if and when they exist. |

---

## 3. Project shape

```
src/
  core/        tokens (colour, type, motion), event bus — no rendering, no rules
  game/        THE RULES. Pure functions and one engine class. No PixiJS import.
  pixi/        renderer: app, stage, layout, card sprites, table, filters
  motion/      choreographer — owns every animation and its timing
  ui/          DOM screens, HUD, one stylesheet
  main.ts      wiring: engine events in, renderer calls out
tools/         build and audit scripts
public/
  cards/       52 card face SVGs plus a back
  fonts/       self-hosted display and body faces
  audio/       generated sound effects
```

**`src/game` must not import from `src/pixi`.** The rules engine has to be
testable in Node with no canvas, no WebGL and no DOM. This is what makes the
test suite fast and honest, and it is what allows a server to share it later.
Enforce it in review; it is the single most valuable boundary in the codebase.

---

## 4. The rules — implement exactly this

### Layout of a game

- **Stock** — face-down pile of undealt cards, top-left.
- **Waste** — face-up pile beside the stock, dealt from it.
- **Four foundations** — one per suit, built **up** from Ace to King.
- **Seven tableau columns** — column *n* is dealt *n* cards (1 to 7), only the
  last card in each face up. 28 cards total; the remaining 24 form the stock.

### Legal moves

**To a foundation:** an Ace onto an empty foundation, or a card of the same suit
and exactly one rank higher than the foundation's top card. Only one card at a
time — never a run.

**To a tableau column:** a King onto an *empty* column, or a card of the
**opposite colour** and exactly one rank **lower** than the column's top card
(red on black, black on red). A face-up **run** may be moved as a unit provided
the run is itself a valid descending alternating-colour sequence.

**From the waste:** only its top card, to a tableau or a foundation.

**From a foundation back to a tableau:** allowed. Players need it to unblock.

**Turning a face-down tableau card:** when a face-down card becomes the last
card in its column, it flips face up. This is automatic and is not a move the
player makes — but it *is* part of the move that exposed it, so undo must put it
back face down.

### The stock

- **Draw 3.** Tapping the stock moves three cards to the waste, face up, top
  card playable. If fewer than three remain, move what remains.
- When the stock is empty, tapping the empty stock **recycles** the waste back
  into the stock, in order, face down. **Unlimited redeals.**
- The recycle is a move and must be undoable.

### Winning

All 52 cards on the foundations. When every remaining card is face up and the
stock and waste are empty, offer (or run automatically) an **auto-complete** that
sends every card home in a cascade. This is the game's one moment of spectacle —
give it real animation budget.

### Scoring — keep it simple

Track **moves** and **elapsed time**. Do not build a points system; Klondike's
traditional scoring is arbitrary and players ignore it. Moves and time are what
people compare.

---

## 5. Layout

Design in a fixed **design rect** in abstract units and letterbox it to whatever
viewport the player has, rather than writing breakpoints. Choose a portrait rect
and a landscape rect and configure which one is active at startup and on
orientation change.

**Portrait (the hard case).** Seven columns across a phone is roughly 50px per
card at 390px wide. That is legible but tight, so:
- Columns overlap vertically. Face-down cards get a small offset, face-up cards
  a larger one, so the player can read ranks down a stack.
- Foundations and stock/waste share the top row.
- The tableau gets everything below and is allowed to scroll *within itself* if a
  column grows very long — never let the page scroll.

**Landscape and desktop.** More width than needed; do not simply scale up. Cap
card size and centre the board, or the cards become absurd on a 27-inch monitor.

### Two layout rules that will save real time

1. **Bound anything visual by width AND height together.** A card sized as a
   percentage of its container's width, but clipped by its container's height,
   will be cut off at some aspect ratio nobody tested. Use `min()` of both — CSS
   container query units (`cqw`/`cqh`) are the right tool where the container is
   not the viewport.
2. **Anything that clips its own overflow will never make the page complain.**
   A board too wide for the screen inside an `overflow: hidden` box produces no
   scrollbar and no error. Measure such elements against their container
   directly in tests, or the bug ships.

---

## 6. Interaction

This is the biggest departure from a tap-only card game and deserves the most
care.

**Drag.** Press a face-up card and drag it, along with every card above it in
the column, as a unit. Use `setPointerCapture` on pointer-down so the gesture
cannot be stolen by a scrolling ancestor — this is the single most common cause
of "it only works sometimes" on touch. Set `touch-action: none` on the play
surface for the same reason.

**Drop.** Highlight legal targets while dragging. On release over a legal
target, animate into place. On release anywhere else, animate back to origin —
never leave the card where it was dropped, and never snap instantly.

**Tap to auto-place.** Tapping a card sends it to a legal foundation if there is
one, otherwise a legal tableau column. This is what most players use most of the
time; make it the fast path, and make it feel identical to a successful drag.

**Double-tap** should do the same as tap. Do not give it a separate meaning.

**Undo.** Unlimited, with a full move stack. Every state change is a move,
including the stock recycle and including the automatic face-up flip that a move
caused. Undo must restore the flip.

**Hit targets are never smaller than 44px**, whatever the card is drawn at. If
cards are drawn smaller than that in portrait, the hit area is larger than the
sprite. This is normal and correct.

---

## 7. Visuals

**Card faces.** Byron Knoll's Vector Playing Cards — **public domain**, no
licence obligations, no attribution required, safe in a commercial product.

Take them from **<https://github.com/notpeter/Vector-Playing-Cards>**, directory
`cards-svg/`. Name that repository specifically: editions of this deck differ,
and the measurements below were taken against this one. Fetch it yourself —
`curl` from the shell, or the web-fetch tool; no key is needed.

- 52 faces, 8.0 MB total, `viewBox` 167.087 x 242.667.
- **File names are short uppercase codes**: `AS.svg`, `10H.svg`, `KC.svg` —
  rank `A`/`2`–`10`/`J`/`Q`/`K` followed by suit `C`/`D`/`H`/`S`. Do not guess
  a naming scheme; map to your own card ids explicitly.
- The courts are heavy — `KC` 1109 KB, `QC` 1091 KB, `KH` 757 KB, `JS` 686 KB —
  against roughly 6 KB for a low pip card. This asymmetry matters for boot; see
  below.
- The courts in this repository are the **illustrated figures**, and there is
  nothing to choose: `cards-svg/` holds 54 files — the 52 faces plus two extras
  — and there is no second court set. Do not go looking for an
  illustrated-versus-plain variant; it does not exist here.

Three things to do to those files at load time:
- **Strip the white card body.** Paint your own paper — warm white with a
  subtle tooth, grain and vignette. An opaque white rectangle from the SVG hides
  all of it.
- **Strip the off-white plaque** behind the ace of clubs' pip (it is unique to
  that one file and shows as a visible box).
- **Redraw the two corner rank letters.** The source draws them as `<text>` in
  Arial. An SVG rasterised through an `Image` is a separate document and cannot
  see fonts loaded via `FontFace`, so those letters resolve to a different face
  on every platform. Draw them yourself in your own display face.

Every pip, court figure and corner suit is vector artwork — keep it as-is.

**Bake the cards into a texture atlas once at boot.** Do not rasterise SVGs
per-sprite. Size the atlas cell against the **display**, not the current window
— a player who opens in a small window and maximises would otherwise draw every
card from a texture baked for a fraction of the size, and rebaking mid-session
means rasterising 52 SVGs on the main thread, which is a visible freeze.

**Cap each atlas at 4096x4096.** `MAX_TEXTURE_SIZE` is 16384 on the build
machine and commonly 4096–8192 on phones, so the dev box will happily bake an
atlas that simply fails to upload on the target. 4096² RGBA is 64 MB per atlas,
which is affordable everywhere; size the cell from the *runtime* device pixel
ratio under that cap, never from what the dev box allows.

**Parameterise DPR and viewport in every test.** The build machine is headless
with no display, so "size against the display" resolves to DPR 1 at whatever
viewport the test happens to set. Tests that do not state both will silently
exercise a different atlas size than any phone.

**The bake costs about 200 ms and needs no loading state.** Measured on the
build machine, all 52 real faces into a 4096² atlas on the main thread:

| | |
|---|---|
| total | 196 ms (200 ms on a warm re-run) |
| SVG decode, 52 cards | **191 ms** — effectively the whole cost |
| `drawImage` into the atlas | 5 ms |
| raster flush | 13 ms |
| GPU upload | 4 ms |
| longest single stall | 26 ms — one dropped frame, once |
| heaviest card | `KC` 17.9 ms; lightest ~1.2 ms |

Two things follow. **SVG decode is not cached by the browser** — a warm re-run
costs the same, so there is nothing to be gained by baking twice. And the cost
is the *source* SVG, not the target size: a phone at DPR 3 driving a larger
atlas pays the same decode and only a larger upload.

The phone caveat is honest rather than alarming: SVG rasterisation is CPU-bound
and that measurement is one fast desktop core. A mid-range phone is plausibly
3–5x slower, so expect **0.6–1.0 s with stalls around 100 ms**. Still no second
pass.

**Mandatory: paint the table before the bake starts.** Draw the background, the
empty slot outlines and any chrome, and yield one frame, *then* begin the atlas
bake. The bake must never run ahead of first paint.

This is two lines of code and it is the difference between a game that looks
like it is loading and one that looks broken. The bake awaits each card's decode
in sequence, so the main thread yields between cards and the stalls are
per-card, not one solid block — on a phone, roughly 55–90 ms for each of the
five heaviest courts and 4–6 ms for a pip, spread across about a second. With
the table already on screen that reads as cards arriving. With a blank page it
reads as a hang, and a blank page is exactly what the obvious
`await bake(); start()` produces.

If you want a belt with the braces, bake the 47 pip cards first and the courts
after — same single pass, just ordered, and the pips finish in ~0.3 s with no
stall over 10 ms. Optional.

**Table.** A dark, low-saturation felt so that colour is spent on the cards.
Light the scene from one direction and keep it consistent — a per-card lighting
shader with a shared light vector is worth the effort and is most of what makes
a card game look expensive rather than flat.

Build it **behind a quality tier that can fall back to flat sprites** — but be
clear about why. On the build machine the per-pixel cost is unmeasurable: 52 lit
cards with two stacked fullscreen filters ran 2.38 ms/frame against 2.47 ms
without them. The tier is not for the dev box, which will never tell you it is
needed. It exists for phones, and **the phone is the only measurement that
decides whether it stays on**.

**Motion.** Never start an entrance below 0.9 scale and never overshoot by more
than a few percent. Large scale-ups with a back-ease read as cartoon motion; it
is the most common reason a polished-looking game feels cheap.

---

## 8. Audio

Short, dry, quiet. A card placing, a card flipping, a foundation accepting, the
shuffle, and the win cascade. Generate them once, commit the output, and keep
any API key out of the runtime.

Ship a mixer — master, music, effects — with **draggable** sliders (see the
pointer-capture note above; a range input that only responds to taps is the
classic mobile bug here). Persist the settings.

---

## 9. Testing

**The rules engine is pure, so test it properly.** This is where the bugs are
and it costs nothing to cover:
- Every legal and illegal move for every pair of card ranks and colours.
- Run moves: valid runs move, invalid runs do not.
- Stock draw with 3, 2, 1 and 0 cards remaining.
- Recycle, repeatedly.
- Undo of every move type, including the automatic flip and the recycle, back to
  the initial deal.
- A full solved game replays to a win.

**Write a viewport sweep.** A script that loads the game across a grid of
viewport sizes and asserts invariants — nothing scrolls sideways, no control is
off-screen, no element has collapsed, the board sits inside its container.
Layout bugs in this genre are almost always "correct at the size it was written
for, broken one viewport away", and a grid finds them in seconds. Run it
whenever layout changes.

**A software rasteriser lies about performance; a correctly configured headless
browser does not.** The distinction matters on this build machine, because both
are available and they disagree wildly. The same 52-card scene runs 2.4 ms/frame
on the hardware path and 48 ms/frame on the software one. Never conclude
anything about frame rate from software rendering — and never assume a headless
browser is software without checking which surface it actually got.

Use software rendering for **screenshots and pixel-diffing**, where its
determinism is the point. Use the hardware path for **performance**, and for
nothing else.

---

## 10. The build machine — read this before running anything

This is a shared box. A large language model is resident on the discrete GPU and
**the renderer's budget on that card is zero**.

### The one rule that matters

**Never launch Chromium directly.** Use the harness:

```bash
/home/adam/pixi-test/run.sh igpu          # hardware rendering — performance
/home/adam/pixi-test/run.sh swiftshader   # software — screenshots, pixel diffs
/home/adam/pixi-test/run.sh preflight     # check the environment before a run
/home/adam/pixi-test/run.sh probe         # report which surface you actually got
```

A bare `chromium --headless` silently does one of two harmful things: falls back
to software (and reports performance numbers that are off by 20x), or takes the
**discrete GPU** and competes with the model server for memory it does not have
to spare. The harness exits non-zero and says why if a render lands on the wrong
surface. It is the single most likely way to lose a day here.

If you must launch it yourself, this exact flag set is the only one that works —
ANGLE's GL and EGL backends cannot get a surfaceless context on this box:

```
args: --headless=new --no-sandbox --ignore-gpu-blocklist --use-gl=angle
      --use-angle=vulkan --use-vulkan=native
      --enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE
env:  MESA_VK_DEVICE_SELECT=1002:13c0
      __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json
      __GLX_VENDOR_LIBRARY_NAME=mesa
```

The launching process also needs the `render` group. The harness handles this
itself — both scripts re-exec through `sudo -n -u adam` when the group is
missing — so this only matters if you launch Chromium yourself, which you should
not be doing.

**Serve test pages over http, never `file://`.** A `file://` page cannot upload
an SVG-derived canvas to WebGL — the canvas is tainted and it throws
`SecurityError`. A served build has no such problem. Chasing this as a renderer
bug is a wasted afternoon; the fix is to use the dev server.

The two benchmark pages below are the exception that proves it: they *are*
`file://`, and they work only because `bench.mjs` passes
`--allow-file-access-from-files`. That flag is for those pages and nothing else.
Do not reach for it to make the game work from `file://` — serve the game.

Benchmark harness, re-runnable if the scene changes:

```bash
/home/adam/pixi-test/bench.mjs <page> igpu|swiftshader [--unthrottled]
# pages: atlas.html, tableau.html
```

### What the hardware is

| | |
|---|---|
| CPU | Ryzen 9 9900X, 12c/24t |
| RAM | 30.6 GB, ~24 GB free with the model resident |
| Renderer | AMD Radeon iGPU (RDNA2 display class), 512 MiB dedicated + ~15 GB shared |
| WebGL | Real WebGL2, ANGLE over Vulkan/RADV, `MAX_TEXTURE_SIZE` 16384 |
| Off limits | RTX 5080 — the model holds 15.6 of 16.3 GB, and the remainder is its prefill margin |

RAM is not a constraint: builds, the dev server and test sweeps fit comfortably.
The iGPU renders from system memory and does not touch the discrete card.

There is **no display, no phone and no DPR above 1** anywhere on this machine.
Anything that depends on a display must be parameterised.

### Commit early and often

The model server's vendor has documented a comparable card hard-hanging 12–18
minutes into sustained inference, requiring a power cycle. A long agentic session
is exactly that workload. Commit at every working point. If the host locks up,
`dmesg | grep -i xid` afterwards — that failure is the model server, not the
game.

Thermals under sustained load are unmeasured. Idle is 32°C at 23W.

---

## 11. Build and deploy

These four are what you can run on the build machine, and they are all you need:

```bash
npm run dev            # local dev server
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npx vite build
```

### Deployment — when you get there, not on the build machine

**Docker, Docker Compose, podman, nginx and Caddy are not installed on the build
machine.** None of the following can be run there, and an implementer who tries
will spend a turn discovering `docker: command not found`. It is recorded here
so the shape is known when the game is ready to go somewhere.

Serve the built bundle from nginx inside a container, with Caddy in front for
TLS. If a Vite build runs *inside* the Docker build (`COPY . .` then
`RUN npx vite build`), then **the working tree at build time is the release,
not the commit** — an uncommitted file ships and a committed one that is not
checked out does not. Check `git status --porcelain` is empty before building.
This failure is silent: the deploy succeeds and every check passes.

---

## 12. Scope for v1

**In:** Klondike draw-3, unlimited undo, unlimited redeals, drag and tap-to-place,
auto-complete on win, move and time counters, sound with a mixer, new game,
portrait and landscape, `localStorage` progress.

**Out, deliberately:** accounts, ads, in-app purchases, daily challenges,
leaderboards, statistics beyond the current game, themes, card-back selection,
hints, draw-1 mode, other Solitaire variants.

Every one of those is a reasonable second version. None of them makes the first
version better, and each one is a way to not finish it.

## 13. Build this first — two gates, and only one of them is yours

A full Klondike tableau plus foundations plus waste can have all 52 cards
visible at once. Whether the renderer can hold that at 60fps changes its
architecture, so it is settled on day one, before the rules or the layout are
built on top of it.

**Gate 1 — the build machine. Yours to run, first, before anything else.**
Put 52 card sprites on screen with the real artwork and the intended shader and
measure frame pacing on the hardware path. A pass here is *necessary and not
sufficient*: this iGPU is roughly comparable to a low/mid phone GPU in compute,
but it has more memory bandwidth (dual-channel DDR5 against a phone's LPDDR5)
and no thermal envelope at all. It will not fail in the ways a phone fails.

Two reference measurements already taken on this machine, both at 1080x1920,
DPR 1, unthrottled, against a 16.67 ms budget:

**A synthetic floor** — 52 sprites at 150x210 from a 256x358 texture, every one
animating every frame: **2.47 ms/frame flat, 2.38 ms with two stacked fullscreen
per-pixel filters.**

**A real Klondike scene** — seven fanned columns, four foundations, a stock,
plus a 13-card run being dragged along a path, with a naive topmost-first bounds
test over all 52 sprites *and* an AABB check against all 11 drop targets, every
frame:

| | |
|---|---|
| static tableau, still hit-testing every frame | 2.70 ms |
| dragging a 13-card run + hit-test + drop checks | **2.72 ms** |
| the same, plus a blur on the lifted run | 2.39 ms |

**The drag is free** — 0.02 ms over static — and static sprites cost nothing.
So the naive hit-test is fine to start with; do not optimise it before it shows
up in a measurement. A `p95` around 17 ms appears in every run and is a
periodic single-frame hitch from the compositor, not load.

These are floors, not a full game: no atlas of real faces in the scene, no
animation system, no audio. Beat them or explain why.

**Gate 2 — a real mid-range phone. Not yours; hand it back.**
There is no phone and no display on the build machine, so this gate cannot be
run by the implementer at all. When gate 1 passes, **stop and hand over** a
build for a human to run on a real device. The quality tier that drops per-card
lighting to flat sprites exists for this gate and no other — the dev box will
never tell you whether it is needed.
