import {
  Assets,
  Container,
  Graphics,
  Sprite,
  autoDetectRenderer,
  type Renderer,
  type Texture,
} from 'pixi.js';
import { assetUrl } from '../assets.js';
import { MoteField } from '../render/motes.js';
import { PALETTE } from '../render/palette.js';
import { QUALITY, type QualityTier } from '../render/quality.js';
import { Background } from '../render/shaders/background.js';
import { WORLD_DISSOLVE_MS, backdropWorld } from './backdrop-world.js';

/**
 * The lobby's living backdrop: the game's fbm-and-shafts background shader
 * with its drifting motes, in a renderer of its own behind the React shell.
 *
 * It is deliberately lightweight: one full-screen mesh and 30 sprites, drawn
 * at a reduced resolution (the noise is soft, nothing here is crisp), driven
 * by its own rAF loop rather than a Pixi Application so it can be parked
 * outright. It stops when the tab is hidden, on the low quality tier and
 * under `prefers-reduced-motion` (one frame is drawn, then nothing), and it
 * allocates nothing per frame outside the debug probe.
 *
 * Cost probes: `stats()` reports the CPU time spent inside the frame (update
 * + render submission) and, where `EXT_disjoint_timer_query_webgl2` exists,
 * the GPU time of the last resolved frame. The Backdrop component exposes
 * the instance as `window.__blockariBackdrop` when the URL has `?debug=1`.
 *
 * Menu → game continuity: `setWorld(id)` cross-dissolves the chosen world's
 * flat painting (tinted toward the shell's ground) over the shader in
 * WORLD_DISSOLVE_MS, so the game's countdown starts on a world the player
 * has already been looking at; `setWorld(null)` is the reverse on the way
 * home. A backdrop created while `backdropWorld.shown()` names a world
 * starts ON it (the game just left it on screen) before dissolving back.
 */

/** Resolution multiplier: the backdrop renders at this fraction of CSS pixels. */
const RENDER_SCALE = 0.6;
/** Motes in the field, matching the playfield's count. */
const MOTE_COUNT = 30;
/** The "board" the mote layout keeps its big motes beside: a centred column. */
const CENTRE_COLUMN = 640;
/**
 * The world layer's tint: the painting at the exposure the game's READY frame
 * shows it — the shell's cool tint (WorldVeil's #9aa0c8) under the ready
 * overlay's 0.6 ink scrim, i.e. × 0.4, then lifted (× 1.38) to land on the
 * READY frame as measured — Pixi's multiply and CSS's do not agree to the
 * digit — so the route change is no cut in luminance (the sky moves ≤ 8 RGB
 * across it, measured on the READY frame against the return, per scene).
 */
const WORLD_TINT = 0x555870;
/** The world layer's alpha once in: the shader's motes still read through it. */
const WORLD_ALPHA = 0.92;
/** The flat painting ships at its small size only. */
const WORLD_FLAT_SIZE = 1280;
/** How much of the motes' glow a world takes away (they have no counterpart in the game's READY frame). */
const MOTES_UNDER_WORLD = 0.85;

/** The ease of the dissolve (in-out). */
function easeInOut(u: number): number {
  return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** One world layer: its sprite (once loaded) and where its alpha is going. */
interface WorldLayer {
  id: string;
  sprite: Sprite | null;
  /** 0..1 progress of the alpha toward `to`. */
  u: number;
  from: number;
  to: number;
  alpha: number;
}

export interface BackdropStats {
  /** Frames rendered since start. */
  frames: number;
  /** CPU ms per frame, exponential average over the last ~60 frames. */
  cpuMs: number;
  /** Worst CPU ms seen. */
  cpuMaxMs: number;
  /** GPU ms of the last resolved timer query, or null if unsupported. */
  gpuMs: number | null;
  /** GPU ms exponential average, or null if unsupported. */
  gpuAvgMs: number | null;
  /** Whether the loop is currently scheduling frames. */
  running: boolean;
}

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export class ShellBackdrop {
  private renderer: Renderer | null = null;
  private readonly stage = new Container();
  private background: Background | null = null;
  private motes: MoteField | null = null;
  /** The world layer between the shader and the motes. */
  private readonly worlds = new Container();
  private world: WorldLayer | null = null;
  /** The layer on its way out while another comes in (a world swapped for another). */
  private outgoing: WorldLayer | null = null;
  private unsubscribeWorld: (() => void) | null = null;
  /** The loop is running only to drive a dissolve (parked otherwise). */
  private transient = false;
  /** Debug: the dissolve pinned at a progress, ignoring the clock. */
  private pinned: number | null = null;
  private startedOn = false;
  /** The last --world-cover written to the document. */
  private coverShown = -1;
  private raf = 0;
  private running = false;
  private destroyed = false;
  private animate = true;
  private last = 0;
  private timeSec = 0;
  private width = 1;
  private height = 1;
  private ro: ResizeObserver | null = null;

  private frames = 0;
  private cpuMs = 0;
  private cpuMaxMs = 0;
  private gpuMs: number | null = null;
  private gpuAvgMs: number | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private timerExt: TimerExt | null = null;
  private pendingQuery: WebGLQuery | null = null;

  private readonly onVisibility = (): void => {
    if (document.hidden) this.stop();
    else if (this.animate) this.start();
    else if (this.dissolving()) this.pulse();
  };

  /**
   * Create the renderer inside `parent`. `animate` false (low tier, reduced
   * motion) draws a single frame and leaves the loop parked.
   */
  async init(parent: HTMLElement, tier: QualityTier, animate: boolean): Promise<void> {
    const q = QUALITY[tier];
    this.animate = animate;
    const renderer = await autoDetectRenderer({
      preference: 'webgl',
      width: Math.max(1, parent.clientWidth),
      height: Math.max(1, parent.clientHeight),
      resolution: Math.min(window.devicePixelRatio || 1, 1.5) * RENDER_SCALE,
      autoDensity: true,
      antialias: false,
      background: PALETTE.bg,
      powerPreference: 'low-power',
      // The shell's canvas is never read back; let the compositor keep it.
      preserveDrawingBuffer: false,
    });
    if (this.destroyed) {
      renderer.destroy();
      return;
    }
    this.renderer = renderer;
    parent.appendChild(renderer.canvas);

    this.background = new Background(Math.max(2, q.bgOctaves - 1));
    this.stage.addChild(this.background.mesh);
    this.stage.addChild(this.worlds);
    this.motes = new MoteField({ glow: bakeGlow(renderer) }, MOTE_COUNT);
    this.stage.addChild(this.motes.container);

    // The world the game left on screen: start on it, then follow the target.
    const shown = backdropWorld.shown();
    if (shown) {
      this.world = {
        id: shown,
        sprite: null,
        u: 1,
        from: WORLD_ALPHA,
        to: WORLD_ALPHA,
        alpha: WORLD_ALPHA,
      };
      this.startedOn = true;
      // Wait for the painting (capped): the first frame should be the world, not a cut through the shader.
      await Promise.race([this.attach(this.world), new Promise((r) => setTimeout(r, 400))]);
      if (this.destroyed) return;
    }
    this.unsubscribeWorld = backdropWorld.subscribe((id) => this.setWorld(id));
    if (backdropWorld.get() !== shown) this.setWorld(backdropWorld.get());

    // GPU timer queries only under the debug probe: one query object per frame otherwise.
    if (new URLSearchParams(location.search).has('debug')) this.setupTimer(renderer);
    this.layout(parent.clientWidth, parent.clientHeight);
    this.ro = new ResizeObserver(() => this.layout(parent.clientWidth, parent.clientHeight));
    this.ro.observe(parent);
    document.addEventListener('visibilitychange', this.onVisibility);

    // Always paint one frame so a parked backdrop is still a backdrop.
    this.frame(performance.now(), true);
    if (animate && !document.hidden) this.start();
  }

  /** True when the first frame was drawn on a world (the CSS fade-in is skipped: the game just showed it). */
  get startedOnWorld(): boolean {
    return this.startedOn;
  }

  /** The world on screen, or on its way in. */
  get worldId(): string | null {
    return this.world?.id ?? null;
  }

  /**
   * Cross-dissolve toward a world's flat painting (null: back to the shader)
   * over WORLD_DISSOLVE_MS. A parked loop (low tier, hidden tab) runs for
   * the dissolve only; reduced motion snaps.
   */
  setWorld(id: string | null): void {
    if (this.destroyed) return;
    if ((this.world?.id ?? null) === id) {
      // The same world, on its way out: turn it around.
      if (this.world && this.world.to !== WORLD_ALPHA) this.retarget(this.world, WORLD_ALPHA);
      return;
    }
    if (this.world) {
      // The current layer leaves; a previous outgoing one is dropped outright.
      if (this.outgoing) this.dropLayer(this.outgoing);
      this.outgoing = this.world;
      this.retarget(this.outgoing, 0);
      this.world = null;
    }
    if (id) {
      this.world = { id, sprite: null, u: 0, from: 0, to: WORLD_ALPHA, alpha: 0 };
      void this.attach(this.world);
    }
    this.pinned = null;
    if (reducedMotion()) this.snapWorlds();
    this.pulse();
  }

  /** Debug: pin the dissolve at `ms` since it began (the capture harness's frames). */
  seekWorld(ms: number): void {
    this.pinned = Math.max(0, Math.min(1, ms / WORLD_DISSOLVE_MS));
    this.stop();
    this.transient = false;
    this.frame(performance.now(), true);
  }

  /** Switch animation on or off (settings change). */
  setAnimate(on: boolean): void {
    this.animate = on;
    if (on && !document.hidden) this.start();
    else this.stop();
  }

  private retarget(layer: WorldLayer, to: number): void {
    layer.from = layer.alpha;
    layer.to = to;
    layer.u = 0;
  }

  /** Run the loop for a dissolve when it is otherwise parked. */
  private pulse(): void {
    if (this.running || this.destroyed || !this.renderer || document.hidden) return;
    this.transient = !this.animate;
    this.start();
  }

  /** A world is still on its way in or out. */
  private dissolving(): boolean {
    return [this.world, this.outgoing].some((l) => l !== null && l.u < 1);
  }

  private snapWorlds(): void {
    for (const l of [this.world, this.outgoing]) if (l) l.u = 1;
  }

  /** Load the layer's painting and put it on the stage (the layer may have been dropped meanwhile). */
  private async attach(layer: WorldLayer): Promise<void> {
    const url = assetUrl(`worlds/${layer.id}/flat.${WORLD_FLAT_SIZE}.webp`);
    let tex: Texture;
    try {
      tex = await Assets.load<Texture>(url);
    } catch {
      return; // No painting: the shader stays; the game will say the same.
    }
    if (this.destroyed || (this.world !== layer && this.outgoing !== layer)) return;
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5);
    sprite.tint = WORLD_TINT;
    sprite.alpha = layer.alpha;
    layer.sprite = sprite;
    this.worlds.addChild(sprite);
    this.fit(sprite);
    if (!this.running) this.frame(performance.now(), true);
  }

  private dropLayer(layer: WorldLayer): void {
    layer.sprite?.destroy();
    layer.sprite = null;
    if (this.outgoing === layer) this.outgoing = null;
    if (this.world === layer) this.world = null;
  }

  /** Cover the viewport, centred (the flat is 16:9; a phone crops its sides). */
  private fit(sprite: Sprite): void {
    const tw = sprite.texture.width || 1;
    const th = sprite.texture.height || 1;
    const s = Math.max(this.width / tw, this.height / th);
    sprite.scale.set(s);
    sprite.position.set(this.width / 2, this.height / 2);
  }

  /** Advance the dissolves; returns true while one is still moving. */
  private updateWorlds(dt: number): boolean {
    let moving = false;
    for (const l of [this.world, this.outgoing]) {
      if (!l) continue;
      if (this.pinned !== null) l.u = this.pinned;
      else if (l.u < 1) {
        l.u = Math.min(1, l.u + (dt * 1000) / WORLD_DISSOLVE_MS);
        moving = true;
      }
      l.alpha = l.from + (l.to - l.from) * easeInOut(l.u);
      if (l.sprite) l.sprite.alpha = l.alpha;
    }
    // The motes ride above the world layer: they thin out as it comes in, so the painting is
    // the READY frame's painting and not the painting plus a glow the game does not have.
    const cover = Math.min(
      1,
      Math.max(this.world?.alpha ?? 0, this.outgoing?.alpha ?? 0) / WORLD_ALPHA,
    );
    if (this.motes) this.motes.container.alpha = 1 - MOTES_UNDER_WORLD * cover;
    // The shell reads the cover too (--world-cover): the hero's ambient glow yields to a painting.
    if (Math.abs(cover - this.coverShown) > 0.01 || (cover === 0) !== (this.coverShown === 0)) {
      this.coverShown = cover;
      document.documentElement.style.setProperty('--world-cover', cover.toFixed(2));
    }
    if (this.outgoing && this.outgoing.u >= 1 && this.outgoing.to === 0)
      this.dropLayer(this.outgoing);
    if (!moving && this.pinned === null) backdropWorld.report(this.world?.id ?? null);
    return moving;
  }

  start(): void {
    if (this.running || this.destroyed || !this.renderer) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  stats(): BackdropStats {
    return {
      frames: this.frames,
      cpuMs: this.cpuMs,
      cpuMaxMs: this.cpuMaxMs,
      gpuMs: this.gpuMs,
      gpuAvgMs: this.gpuAvgMs,
      running: this.running,
    };
  }

  destroy(): void {
    this.destroyed = true;
    // The next backdrop starts where this one was heading (the game shows that world).
    backdropWorld.report(this.world?.id ?? null);
    this.unsubscribeWorld?.();
    this.unsubscribeWorld = null;
    document.documentElement.style.removeProperty('--world-cover');
    this.stop();
    this.ro?.disconnect();
    this.ro = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.renderer) {
      this.renderer.canvas.remove();
      this.renderer.destroy();
      this.renderer = null;
    }
  }

  private layout(w: number, h: number): void {
    if (!this.renderer) return;
    w = Math.max(1, w);
    h = Math.max(1, h);
    this.width = w;
    this.height = h;
    this.renderer.resize(w, h);
    this.background?.resize(w, h, 0);
    for (const l of [this.world, this.outgoing]) if (l?.sprite) this.fit(l.sprite);
    const col = Math.min(CENTRE_COLUMN, w);
    this.motes?.layout(w, h, { x: (w - col) / 2, y: 0, w: col, h });
    if (!this.running) this.frame(performance.now(), true);
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.frame(now, false);
    // The frame may have parked a transient loop.
    if (this.running) this.raf = requestAnimationFrame(this.tick);
  };

  private frame(now: number, still: boolean): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const t0 = performance.now();
    const dt = still ? 0 : Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.timeSec += dt;
    this.background?.update(this.timeSec, dt);
    this.motes?.update(dt, this.width, this.height);
    const dissolving = this.updateWorlds(dt);
    // A parked loop ran only for the dissolve: park it again once it has landed.
    if (this.transient && !dissolving && !still) {
      this.transient = false;
      this.stop();
    }

    this.resolveTimer();
    this.beginTimer();
    renderer.render(this.stage);
    this.endTimer();

    const cpu = performance.now() - t0;
    this.frames++;
    // The first frames carry shader compilation; the averages start after them.
    if (this.frames <= 3) this.cpuMs = cpu;
    else {
      this.cpuMs += (cpu - this.cpuMs) / 60;
      if (cpu > this.cpuMaxMs) this.cpuMaxMs = cpu;
    }
  }

  // --- GPU timer (debug probe only; a no-op where the extension is missing) --

  private setupTimer(renderer: Renderer): void {
    const gl = (renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
    if (!gl || typeof gl.createQuery !== 'function') return;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
    if (!ext) return;
    this.gl = gl;
    this.timerExt = ext;
  }

  private beginTimer(): void {
    if (!this.gl || !this.timerExt || this.pendingQuery) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q);
    this.pendingQuery = q;
  }

  private endTimer(): void {
    if (!this.gl || !this.timerExt || !this.pendingQuery) return;
    this.gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
  }

  private resolveTimer(): void {
    const gl = this.gl;
    const q = this.pendingQuery;
    if (!gl || !this.timerExt || !q) return;
    const available = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) as boolean;
    const disjoint = gl.getParameter(this.timerExt.GPU_DISJOINT_EXT) as boolean;
    if (!available) return;
    if (!disjoint) {
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      const ms = ns / 1e6;
      this.gpuMs = ms;
      this.gpuAvgMs = this.gpuAvgMs === null ? ms : this.gpuAvgMs + (ms - this.gpuAvgMs) / 60;
    }
    gl.deleteQuery(q);
    this.pendingQuery = null;
  }
}

/** A 64 px soft radial glow, the mote sprite (the playfield bakes the same shape). */
function bakeGlow(renderer: Renderer): Texture {
  const size = 64;
  const g = new Graphics();
  for (let i = 10; i >= 1; i--) {
    const t = i / 10;
    g.circle(size / 2, size / 2, (size / 2) * t).fill({
      color: 0xffffff,
      alpha: 0.09 * (1 - t) * (1 - t) + 0.015,
    });
  }
  const tex = renderer.generateTexture(g);
  g.destroy();
  return tex;
}
