import type { Container } from 'pixi.js';

/**
 * 2.5D camera: the scene is a stack of planes at different depths — the
 * backdrop farthest, then the motes, the table light, the plate, the tiles
 * (the reference plane, which never moves relative to the pointer so
 * hit-testing is untouched), and the HUD nearest — and the camera drifts a
 * few pixels toward the pointer (desktop) or the phone's tilt (mobile), so
 * the planes slide against each other.
 *
 * That is the camera's only motion. There is deliberately no dolly, punch-in
 * or landing settle: every whole-scene scale or shake re-samples every tile
 * off its pixel grid and reads as a blur, and the owner asked for none of it.
 * Nothing here allocates per frame or reads wall time.
 *
 * Depth d per plane: 0 is the reference; negative is farther (moves WITH the
 * look), positive is nearer (moves against it). Offsets are
 * `-d * parallaxPx * look`; the HUD's are rounded to whole pixels, and no
 * plane is ever scaled, so everything stays crisp.
 */

/** Look smoothing rate (1/s): ~0.3 s to settle on the pointer. */
const LOOK_LERP = 4;
/** Device tilt (degrees) for a full look, and how fast the resting tilt is re-centred (1/s). */
const TILT_FULL_DEG = 22;
const TILT_RECENTRE = 0.5;

export interface Plane {
  container: Container;
  depth: number;
  /** Whole-pixel offsets, no scale (text). */
  crisp?: boolean;
}

export class Camera {
  private readonly planes: Plane[] = [];
  private cx = 0;
  private cy = 0;
  /** Look target and smoothed look, -1..1. */
  private targetX = 0;
  private targetY = 0;
  private lookX = 0;
  private lookY = 0;
  /** Device tilt: raw and the slowly re-centring rest pose. */
  private tiltX = 0;
  private tiltY = 0;
  private restX = 0;
  private restY = 0;
  private tiltSeen = false;
  /** Tier number. */
  private parallaxPx = 0;
  /** Player / tooling switch, 0..1. */
  motion = 1;
  /** Everything eases to rest while this is set (results cinematic). */
  rest = false;

  add(container: Container, depth: number, crisp = false): void {
    this.planes.push({ container, depth, crisp });
  }

  configure(parallaxPx: number): void {
    this.parallaxPx = parallaxPx;
  }

  /** Pivot: the board centre. */
  layout(cx: number, cy: number): void {
    this.cx = cx;
    this.cy = cy;
    for (const p of this.planes) p.container.pivot.set(cx, cy);
  }

  /** Pointer in canvas px over a w×h canvas; null when it left. */
  pointer(x: number, y: number, w: number, h: number): void {
    this.targetX = clamp((x / w - 0.5) * 2);
    this.targetY = clamp((y / h - 0.5) * 2);
  }

  pointerLeft(): void {
    this.targetX = 0;
    this.targetY = 0;
  }

  /** Device orientation in degrees: gamma (left/right), beta (front/back). */
  tilt(gamma: number, beta: number): void {
    if (!this.tiltSeen) {
      this.tiltSeen = true;
      this.restX = gamma;
      this.restY = beta;
    }
    this.tiltX = gamma;
    this.tiltY = beta;
  }

  /** Per frame. `dt` is presentation time for the look ease. */
  update(dt: number): void {
    const k = this.rest ? 0 : this.motion;
    // Tilt: the rest pose drifts toward the current tilt so a phone held at an
    // angle centres itself and only changes of tilt move the camera.
    if (this.tiltSeen) {
      const a = Math.min(1, dt * TILT_RECENTRE);
      this.restX += (this.tiltX - this.restX) * a;
      this.restY += (this.tiltY - this.restY) * a;
      this.targetX = clamp((this.tiltX - this.restX) / TILT_FULL_DEG);
      this.targetY = clamp((this.tiltY - this.restY) / TILT_FULL_DEG);
    }
    const lerp = Math.min(1, dt * LOOK_LERP);
    this.lookX += (this.targetX * k - this.lookX) * lerp;
    this.lookY += (this.targetY * k - this.lookY) * lerp;

    const px = this.parallaxPx * k;
    for (const p of this.planes) {
      const d = p.depth;
      let ox = -d * px * this.lookX;
      let oy = -d * px * this.lookY;
      const c = p.container;
      if (p.crisp) {
        ox = Math.round(ox);
        oy = Math.round(oy);
      }
      c.scale.set(1);
      c.position.set(this.cx + ox, this.cy + oy);
    }
  }
}

function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}
