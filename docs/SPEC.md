# Solitaire Plus — rules + architecture spec (v1, for grading)

Klondike inside the Blockari product: same shell, screens, economy, XP, share
cards and async challenge model. References read: `KLONDIKE-BRIEF.md`; Blockari
@ `c8a96a0` (docs/architecture, rules, art-direction, critique-log; sim, server,
client); 21 Wild `prod-accounts` (`wild21-pixi/`: HANDOFF, DEPLOY, src/share,
src/pixi card lighting).

---

## 0. Headline decisions

| Call | Recommendation |
|---|---|
| Win condition | **Score duel on a fixed clock.** Higher score → shorter game clock → earlier server finish. |
| Deals | **Solvable-only**, filtered server-side from a precomputed pool. Not needed for fairness (both players get the same deal); it's there for the pitch and so the clear bonus is always reachable. |
| Clock | **300 s** (5:00). |
| Scoring | **Our own points table**, calibrated to Blockari's ranges (typical 3–6k, a strong clear ~11–12k). Blockari's level curve and XP shape are unchanged. |
| Draw / redeals / undo / autocomplete | **Draw-3, unlimited redeals, barrier undo, one-tap autocomplete.** All are fixed constants in `rules.ts`, identical for both players and in practice. |
| Hidden information | **The seed never leaves the server** in staked play. Face-down cards and the unseen stock are revealed card by card, as the server replays the moves. This is the one real departure from Blockari. See §4. |

---

## 1. Rules (sim is the only implementation; every constant lives in `packages/sim/src/rules.ts`)

### 1.1 Cards and deal
- One 52-card deck. The deal comes from `Rng(seed)`, using Blockari's exact Rng (FNV-1a → mulberry32, burn 4). The shuffle is Fisher–Yates over the canonical order (suits C,D,H,S; ranks A..K). The shuffle order is pinned by a golden test.
- Tableau column *n* gets *n* cards (1–7), with only the last one face up. The other 24 cards form the stock.

### 1.2 Legal moves
These follow brief §4 exactly:
- **Foundation:** a single card only, same suit, ascending from the Ace.
- **Tableau:** a card or run in alternating colour, one rank lower than the top card. Only a King goes on an empty column.
- **Waste:** only the top waste card can be played.
- **Foundation → tableau:** allowed.
- **Auto-flip:** a newly exposed face-down card flips automatically, as part of the move that exposed it.

### 1.3 Stock
- **Draw-3.** A draw moves 3 cards (or however many remain) to the waste; the top one is playable.
- **Recycle.** Tapping an empty stock turns the waste back over into the stock.
- **Redeals are unlimited.**

### 1.4 Undo in staked play: *barrier undo*
Unlimited undo leaks information. A player could expose a face-down card, see it, and take the move back. That turns the deal into a peek-and-rewind puzzle.

The rule:
- Undo pops moves back to the most recent **information barrier**. A barrier is any move that revealed a card the player had never seen: a tableau flip, or a stock draw that showed a first-time card.
- Recycles, and draws of cards already seen, are **not** barriers.
- Undo restores the full state: score, streak and level. It does not give back any clock time.
- Undo is recorded in the move log as `{t:'undo'}`, and the server replays it.
- Practice uses the same rule, so practice trains the real game.

### 1.5 Tap-to-place, drag and autocomplete
- **Tap / double-tap.** The sim's `autoTarget(state, card)` picks the destination: a foundation if one is legal, otherwise the first legal tableau column scanning left to right. The move log still records an explicit `{from,to,n}`. Tap is a client convenience and never an ambiguity.
- **Autocomplete.** It is offered when the stock and waste are empty and every tableau card is face up. One tap logs `{t:'auto'}`.
  - The sim resolves the whole cascade at that `tMs` in a fixed order: lowest foundation rank first, ties broken left to right.
  - The game clock stops at that `tMs`. The cascade animation (the brief's "moment of spectacle") never costs game time.

### 1.6 Ending
The game ends when one of these happens:
- **`cleared`:** all 52 cards are on the foundations. Autocomplete counts.
- **`timeout`:** the 300 s clock reaches 0.
- **`forfeit`:** the player taps End ("Call it").

There is **no automatic `stuck` detection.** In Klondike, "no progress possible" requires cycling the stock, which is expensive and ambiguous.
- The client shows a soft prompt: "No moves left — end game?". It fires when a full stock cycle passes with no legal non-stock move.
- Ending early changes nothing: forfeit is scored exactly like timeout (§1.8).

### 1.7 Scoring
| Event | Points |
|---|---|
| Card to foundation (manual) | **+100** |
| Card to foundation (autocomplete) | **+100** (does not touch the streak) |
| Face-down tableau card revealed | **+50** |
| Waste → tableau | **+25** |
| Foundation → tableau | **−150** (bouncing a card down and back up nets −50, so there is nothing to farm) |
| Tableau → tableau, draw, recycle, undo | 0 (undo reverts to the popped state's score) |
| **Streak step** | **+25 × min(streak − 1, 4)** on that move (calibrated, see below) |
| End: best streak | **+100 × (min(bestStreak, 5) − 1)** |
| End: clear bonus | **+2000 + 10 × whole seconds remaining** (only if `cleared`) |

Every positive source is bounded per card, so scores cannot be farmed:
- A card reaches the foundation from outside it at most 52 times in net terms.
- Each face-down card flips once.
- A card leaves the waste once.

**Streak** is Blockari's streak, reshaped for solitaire. It maps 1:1 onto the HUD's `NX STREAK` pill and its 6 s pressure ring. As in Blockari, where a placement that clears nothing resets the streak, **any move that scores nothing breaks it**.
- Scoring moves are *to foundation* and *reveal*. A move that does both counts once.
- The streak grows on back-to-back scoring moves, each made **≤ 6.0 s after the previous one** (`streakWindowMs = 6000`). This is measured in game time, so it is deterministic from `tMs`.
- It resets to 0 on:
  - any non-scoring move: a draw, a recycle, a plain tableau move, a waste → tableau play
  - a foundation → tableau return
  - the window running out, which is resolved in `tick`
- The step stops growing at 5X (`streakCap`). Undo restores the streak along with everything else.
- The pill shows from 2X, exactly as Blockari does.

**Measured magnitudes.** `SWEEP=1 vitest run test/sweep.test.ts` plays 1000 seeds with a greedy bot. The bot never plans, so its numbers are a floor for a real player.

| Game | Estimate |
|---|---|
| Bot, all games | p10 550 · **p50 1,625** · p90 3,625 · 2% clears · avg 7 cards home. A human sends 15–25 home in 5 min, so a typical human game lands at ~3–6k. |
| Bot clears | **11.8k–14.1k** (F 5200 + R 1050 + T ~300 + streak 2.2–4.9k + 400 best + 2000 + time 170–900), cleared at 3:30–4:45 → LV 10 |

This matches Blockari's spread. Its admin buckets run 0–1k / 1–3k / 3–6k / 6–10k / 10k+, and the owner's reference game is 9,520 at LV 8. The first draft (+50 per step up to 10 steps, streak held through plain moves) put bot clears at 15–30k. The streak made up most of the total, so it was cut to the rule above.

**Levels:** Blockari's `levelThreshold(n) = 100·(n−1)(n+3)`, unchanged and cosmetic, counted on in-play score only. End bonuses (best streak, clear, time) don't raise it. It emits the same `levelUp` event.

**Results breakdown rows:** Foundation · Reveals · Tableau plays · Streak · Best streak · Clear bonus · Time bonus · **Total**.

**Stat tiles** (results and share card): **CARDS HOME n/52** in the slot of Blockari's LINES, then BEST STREAK, then LEVEL.

### 1.8 Winning a challenge
1. The higher final score wins.
2. On a tie, the shorter game clock wins. A `cleared` game's clock is its clear `tMs`; `timeout` and `forfeit` both count as the full 300 000 ms, so giving up never earns the faster tiebreak.
3. If still tied, the earlier server `finishedAt` wins.

### 1.9 XP (Blockari's shape and constants; only the `lines` slot is renamed)
| Part | Blockari | Solitaire Plus |
|---|---|---|
| played | 50 | 50 |
| score | ⌊score/50⌋ | ⌊score/50⌋ |
| lines → **cards** | 10 / line (~23 typical) | **5 / card home** (typical ~20 → 100; clear 52 → 260) |
| levels | 25 × (level − 1) | same |
| streak | 40 if best ≥ 4 | same |
| challenge | 25 | same |
| win | 100 + ⌊pot/2⌋ | same |

- A game with no moves pays 0 XP.
- The XP level curve is `150·(n−1)(n+3)`, with the same 5-level span and tiers 1–5.
- Rank names are themed, as 21 Wild did (owner's decision, "a different game gets different names"). Proposed: **Pip, Deal, Run, Stack, Cascade, Tableau, Foundation, Royal, Klondike** (then Klondike II, III …). They use the same cool → hot → white-gold colour order.
- Owner to confirm the names.

---

## 2. The open rules calls, answered

**1. Win condition: score duel on a clock (your default).**
- **Race-to-clear is worse.** A race is decided almost entirely by whether the deal is solvable and by stock luck on the first pass. A score duel still rewards clearing (+2000 plus the time bonus) but ranks every non-clear game too.
- **Can KLONDIKE-BRIEF's dealer produce solvable deals? No.** It specifies a plain shuffle, with no solver and no dealer constraints.
- **Cost of solvable-only deals:**
  - A deterministic bounded solver (DFS with move ordering and a transposition table over canonical state, draw-3 aware) goes in `packages/sim/src/solver.ts`. It is pure and has golden tests. Only the server calls it.
  - Draw-3 with unlimited redeals is roughly 80% solvable.
  - At a 250k-node budget (~50–150 ms on one core), most deals resolve. Deals that come back "unknown" are rejected along with the "unsolvable" ones.
  - Expected ~1.4 attempts per accepted seed, i.e. **~0.1–0.3 s CPU per deal**.
  - To keep this off the request path, a boot-time + interval worker keeps a Redis list of ≥ 64 verified seeds (`deals:pool`). `POST /challenges` pops one.
  - Each accepted seed stores `solverNodes` and the length of the solution, as data for future difficulty tiers.
  - Flag: `DEALS=solvable|any` (default `solvable`).
- **Build order:** the solver comes *after* the playable core. The flag defaults to `any` until the solver's golden tests pass.

**2. Clock: 300 s.**
- Expert draw-3 clears take ~2–4 min, and a median player needs 6–10 min.
- At 300 s a strong player clears with time to spare, so the time bonus means something. A median player sends ~20–30 cards home, so scores spread across the whole range, which is what a duel needs.
- At 180 s, clears become rare and scores collapse into reveals.
- At 600 s, an async mobile session is too long (the Blockari/21 Wild loop is "one short burst").
- The Blockari server constants are unchanged: `GAME_GRACE_MS` 15 s, `PENDING_GAME_TTL_MS` 10 min, `CLOCK_TOLERANCE_MS` 2 s.

**3. Scoring: our own table, §1.7.**
- **Why not Standard Windows scoring:** it gives 10 per foundation card and −15 for foundation → tableau. It is also time-decayed (−2 per 10 s) and pays a time bonus formula of 700 000 / seconds that dwarfs everything else.
- **Why not Vegas:** −52 buy-in, +5 per card. It is a money model and would collide with the $CHAIN stake.
- Ours keeps Windows' shape (foundation ≫ reveal > waste play, with a penalty for pulling a card back down).
- It is scaled ×10 into Blockari's magnitude, and adds streak and level so the HUD, results breakdown and XP read the same across all three games.

**4. Draw mode, redeals, undo, autocomplete: all fixed, all in `rules.ts`, identical for both players and in practice.**
- **Draw-3.** The brief's choice; it has more skill expression. `drawCount` is a single constant if the owner would rather have draw-1 for accessibility. It would change the golden hashes, so it has to be decided before the first seed is stored.
- **Unlimited redeals, no recycle penalty.** The clock is the cost.
- **Barrier undo** (§1.4).
- **One-tap autocomplete** (§1.5).

**5. Conflicts with KLONDIKE-BRIEF.md: what I'd keep.**
| Brief says | Keep |
|---|---|
| "There is no timer, no combo system, no score multiplier and no fail state… Do not add pressure mechanics" (§1) | **Owner's brief.** Clock, streak and levels are the product. The brief's calm framing survives only in practice mode's pacing and audio. |
| "Do not build a points system… Moves and time are what people compare" (§4) | **Owner's brief.** A score duel needs points. Moves and time still show in the results. |
| "Unlimited undo… The recycle is a move and must be undoable" (§6, §4) | **Barrier undo** (§1.4). Unlimited undo is an information exploit when money is staked. Recycle stays undoable because it is not a barrier. |
| "No UI framework. No React… no state management library" (§2) | **Blockari stack** (React 19 + Zustand). The shell parity is graded against React screens, and 1:1 means cloning them. |
| "ship v1 with no server at all… localStorage" (§2) and "Out: accounts, daily challenges, leaderboards…" (§12) | **Owner's brief.** Full server, accounts and challenges. |
| Server: raw `pg`, no ORM, esbuild bundle of `src/game` (§2) | **Blockari:** Drizzle + migrations, and `packages/sim` as a workspace package. The brief's principle ("never write the rules twice") is preserved. |
| Infra: nginx inside the container + Caddy (§2) | **Blockari:** one server container serves the built client, with Caddy in front. |
| GSAP 3.15 for every tween (§2) | **Blockari's motion stack** (its easings/effects modules). GSAP only if Blockari already uses it for the matching beat. Parity beats library choice. |
| Draw-3, unlimited redeals, auto-flip, tap = double-tap, 44 px hit targets, drag with pointer capture, snap-back, card art source and SVG cleanup, atlas ≤ 4096², paint table before bake, quality tier fallback, pixi-test harness, never launch Chromium directly, `file://` trap, `git status --porcelain` before build | **Brief, as written.** None of it conflicts. |
| Layout "design rect + letterbox, no breakpoints" (§5) | **Blockari's `layout.ts`** (compact < 600 px, pads 16/24, HUD strip). Parity is measured against it. The brief's two layout rules (min of width/height; measure clipped boxes) stay as test rules. |

---

## 3. Architecture

A clone of Blockari's monorepo shape, renamed.

```
packages/sim        @solitaire-plus/sim — pure TS, zero deps. rules, rng, deck, game, undo,
                    autoTarget, levels, xp, ranking, replay, hash, solver, mask (§4)
apps/server         Fastify 5 + Drizzle + Postgres 17 + Redis 7; serves built client
apps/client         Vite + React 19 + Zustand; PixiJS 8 playfield
tools/capture       PNG stills: phone 390×844 + desktop 1440×900 (adds the 1440 preset)
tools/parity        measure.mjs port from 21 Wild — DOM geometry diff vs Blockari, ≤4 px
qa/<screen>/        committed PNG captures for the critic (see §6)
```

### 3.1 Sim contract (the same as Blockari's)
- No `Math.random` and no `Date.now`. Time comes in only through `tick(dtMs)`.
- `createGame(deal)`, `apply(state, move) → {state, events} | {error}`, `tick`, `forfeit`, `replay(seed, moves)`, `stateHash`, `deckHash`.
- Moves:
  - `{t:'mv', from, to, n, tMs}`, where `from`/`to` ∈ `stock|waste|f0..f3|t0..t6`
  - `{t:'draw', tMs}`
  - `{t:'undo', tMs}`
  - `{t:'auto', tMs}`
- Events: `dealt`, `moved`, `flipped`, `drew`, `recycled`, `undone`, `scored{points,streak,total}`, `levelUp`, `streakBroken`, `autoStep`, `ended{reason,breakdown}`.
- **Golden tests:**
  - `deckHash` of seed `'golden'`
  - a scripted random-legal-move bot game (final `stateHash` + total)
  - a scripted **solved** game that replays to `cleared`
  - the solver's verdict on 20 pinned seeds
  - the full brief §9 matrix: every rank/colour pair, runs, draw with 3/2/1/0 cards, repeated recycle, undo of every move type back to the barrier

### 3.2 Server
- Blockari's routes, 1:1: auth, challenges, games, users, notifications with SSE, push, share, `/s/:id`, admin.
- **Tables:** `users`, `ledger`, `games`, `challenges`, `xp_events`, `share_cards`, `notifications`, `push_subscriptions`, `client_meta`.
- `xp_events` is **`UNIQUE (ref_id, kind, user_id)`**. Blockari @ c8a96a0 is still `(ref_id, kind)`, so this is fixed here from migration 0000.
- `services/economy.ts` is the only writer of `balance`, via `debit`/`credit`, each writing a ledger row in the caller's transaction.
- **Economy constants:**
  - `STARTING_BALANCE` 1000
  - `DAILY_GRANT` 100 every 24 h, measured from the last `daily` row, under a row lock
  - `ENTRY_FEES` [5, 10, 25, 50, 100]
  - pot = 2 × fee, `RAKE_BPS` 0
  - `CHALLENGE_TTL_MS` 24 h, after which the challenge expires and the stake is refunded
  - practice is free, client-only and pays no XP
- **Challenge lifecycle:** `pending → open → taken → complete`, or `open → expired`.
- **XP payouts:**
  - Game XP is paid in `finalizeGame`.
  - Win XP is paid in `resolveChallengeIfReady`.
  - Both happen inside the finalising transaction, and notifications go through the outbox.
- **Deal pool worker** (§2.1), Redis list `deals:pool`.

### 3.3 Client
- **Screens, 1:1:** Auth, Home, CreateChallenge, FeePicker, TakeChallenge, GameHost, Play, ResultsXp, ChallengeDetail, History, Profile.
- **Shell, 1:1:** Inbox, NotifyToast, PushPrompt, Backdrop/WorldVeil, settings sheet, haptics, the narrated tutorial, and share.
- The tutorial becomes a scripted Klondike demo: a fixed seed and ~12 moves covering drag, tap-to-place, a flip, a draw, and autocomplete.
- **Share cards:** a copy of Blockari's `share/layout.ts` with its OPEN / COMPLETE / SOLO variants exactly as specified in the brief.
  - OPEN: pot as the second hero, code slab, QR to `/take?code=`, "BEAT n TO WIN".
  - COMPLETE: `YOU WON +N $CHAIN` in mint with the coin, or `YOU LOST −N` in rose, plus `vs <opp> · <score>`. No code; the QR goes to the root with "PLAY FREE AT host".
  - SOLO: the front door.
  - LINES becomes CARDS HOME. Link card is 1200×630, story card 1080×1920.
- **Play HUD** (Blockari's, in Pixi): SCORE odometer + BEST, timer 5:00 + bar, `NX STREAK` pill with the 6 s pressure ring, `LV n` pill, mode pill.
- **Board:** HUD, then the top row (stock, waste, gap, 4 foundations), then the tableau. The tableau scrolls within itself if needed; the page never scrolls.

### 3.4 Rendering
- **Cards** are lit Meshes. The approach is ported from 21 Wild's `cardLighting` (one shared `LIGHT`, per-pixel normal + perspective for flips, contact shadow stamp), but **re-tuned into Blockari's material language:**
  - bevel rim light on the top/left edges
  - specular sheen
  - baked down-right contact shadow, whose offset grows with lift while dragging
  - Blockari's `PostFilter` chain (bloom, grain off the cards, vignette, filmic tonemap) and its quality tiers, with low = flat sprites
- **Faces:** Byron Knoll's Vector Playing Cards (notpeter repo). The cleanup follows brief §7: strip the body, strip the AC plaque, redraw the corner ranks in Rajdhani, bake a ≤ 4096² atlas sized to the display, paint the table before the bake, pips before courts.
- **Table:** Blockari's plate/socket/spotlight materials. Empty piles are recessed sockets.
- **Colour tokens** keep Blockari's `:root` token names and roles in Solitaire Plus's own values:
  - a deep green-black ground (#07120f / plate #0f211c → #091612, rim #1e3a32)
  - a low-saturation felt spotlight
  - accents kept by role: mint = win/positive, rose = loss/danger, amber = streak/pot, indigo = level
  - Final values go in `docs/art-direction.md` with the first screen.
- **WebGL only,** per 21 Wild HANDOFF §5 (its GLSL programs are silently skipped on WebGPU).

---

## 4. Hidden information: the one real departure from Blockari

**The problem.** In Blockari the client receives the seed, and that's fine because the hand is visible anyway. In Klondike the seed *is* the answer key: all 21 face-down cards and the stock order. With it, a player can solve the deal offline before taking the challenge. So for staked play **the seed never leaves the server**, the approach 21 Wild's ranked mode took.

**The protocol:**
1. `POST /api/challenges` returns `{challengeId, code, gameId}`, with no seed. `GET /api/games/:id` returns a **masked deal**: the 7 face-up tableau cards, plus every card the player has already seen if this is a resume.
2. The sim accepts a deal with unknown slots (`Card | null`, in `mask.ts`). A move that would expose an unknown card is **reveal-bound**: a tableau flip, or a draw of never-seen stock cards.
3. Moves that don't reveal anything apply locally and instantly, and are batched to the server every 250 ms (Blockari's `MoveSync`).
4. For a reveal-bound move:
   - The client sends that move immediately (`POST /games/:id/moves`).
   - The server replays it against the full deck and answers `{reveals:[{pos,card}], stateHash}`.
   - The client injects the reveal and applies the move.
   - The flip or draw animation starts on input. The face texture swaps in at the flip's midpoint (~120 ms), which hides a normal round trip. Only the revealed card's own input waits for the reply.
   - If p95 round-trip time measures over 150 ms, the fallback is to pre-send the next draw's 3 cards. The leak is one draw ahead, and it disappears after the first stock pass anyway.
5. `tMs` is stamped at input, not when the reply arrives, so network latency never costs a player clock time.
   - The server keeps Blockari's checks: monotonic `tMs`, below 300 000, and ≤ wall-elapsed + 2 s.
   - A replay failure truncates to the longest valid prefix.
6. The server's replay is the only score.
   - The client compares its `stateHash` with the server's after each reveal; a mismatch is a hard error with telemetry.
   - **The client never sends a score, XP number, level or rank.**
7. **Practice** is client-only with a local seed, so there is nothing to protect. It may request a pool seed (`GET /api/practice/deal`, which returns a solvable seed that is never used for a challenge).

**Remaining leak and its cost.** A taker can't know the creator's moves; they only see the creator's final score, and only after finishing. The shared seed is revealed on the results screen after *both* games are done, which enables a "replay the deal" feature later.

---

## 5. Repo, dev URL, Postgres and Redis

- **Repo:** `git@github.com:Chain-Games/solitaire-plus` already exists, containing one "Initial commit" with a README. My key reads it; push is untested. Work goes on branch **`dev`**; `main` only gets screens that have passed.
  - If push is refused, I'll build on a local `dev` branch and say so.
  - Local checkout: `/home/adam/solitaire-new`.
- **Postgres 17 + Redis 7 run in Docker** (`compose.yaml`, mirroring Blockari's compose + devports). Docker 29.1.3 and Compose 2.40.3 come from the Ubuntu archive.
  - Postgres 17.11 on `127.0.0.1:5459`, database/user `solitaire`.
  - Redis 7 on `127.0.0.1:6399`.
  - Named volumes, `restart: unless-stopped`, both healthchecked.
  - Start with `sudo -n -u adam docker compose up -d --wait`. The re-exec picks up the docker group; `sg` is not installed on this box.
  - `compose.prod.yaml` will mirror Blockari's for the eventual prod deploy.
  - Tests use a separate `solitaire_test` database, and refuse to run against the dev one.
- **Ports:** server `3030`, Vite dev `5373`, preview `4379`. None of these collide with anything in use on this box (4179 is a live Blockari preview; 7860 and 8090 are taken).
- **Dev URL:** `http://192.168.8.226:5373`, LAN only. There is **no public dev host.**
  - **For the critic:** every capture is committed to `qa/sol-<screen>/{phone-390x844,desktop-1440x900}/*.png` on `dev` and is also written to `/tmp/aaa2/sol-<screen>/` on this machine. Each "screen X ready @ sha" report lists the exact paths.
  - If you need a live URL from off-LAN, a Cloudflare quick tunnel is the option, but it exposes a dev box publicly, so I'd want Adam's OK first.

---

## 6. Build order (after approval)

Nothing in this list starts before the spec is approved.

1. The sim, with the full brief §9 test matrix and golden hashes, plus a bot sweep over 1000 seeds that pins the §1.7 magnitudes.
2. Server skeleton, migrations (including the 3-column `xp_events` unique), the economy, the reveal protocol, and replay scoring.
3. Card atlas + lit card Mesh gate. Brief §13 gate 1: 52 cards on the igpu harness with frame pacing measured.
4. Screens one at a time, each reported as **"screen <name> ready @ <sha>"** with phone and desktop PNGs. The first is **Play/GameHost**, since the card look sets everything else. Then Home, Auth, Create+FeePicker, Take, ResultsXp, ChallengeDetail, History, Profile, and the shell pieces. Share cards come with ResultsXp.
5. The solver + deal pool, switching `DEALS=solvable` on.
6. Brief §13 gate 2 (real phone) handed back to Adam. The prod deploy happens only when Adam says so.

---

## 7. Decisions needed from the owner
1. **Rank names:** Pip … Klondike (§1.9)?
2. **Draw-3 vs draw-1.** Draw-3 is recommended. This must be settled before the first seed is stored.
3. **Public tunnel for a live dev URL**, or are committed PNGs enough?
