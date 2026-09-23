import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';
import { MoteField } from './motes.js';

/** Small deterministic LCG so layouts are reproducible across runs. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const W = 1920;
const H = 1080;
const BOARD = { x: 620, y: 150, w: 680, h: 680 };

function field(count = 30, seed = 7): MoteField {
  const f = new MoteField({ glow: Texture.EMPTY }, count, seeded(seed));
  f.layout(W, H, BOARD);
  return f;
}

function speed(v: { vx: number; vy: number }): number {
  return Math.hypot(v.vx, v.vy);
}

describe('MoteField layout', () => {
  it('allocates every sprite once, in an additive container', () => {
    const f = field(30);
    expect(f.container.children.length).toBe(30);
    expect(f.size).toBe(30);
    for (const c of f.container.children) expect(c.blendMode).toBe('add');
  });

  it('keeps the last dozen motes in the outer thirds on wide screens', () => {
    const f = field(30);
    for (let i = 18; i < 30; i++) {
      const { x } = f.positionOf(i);
      const outside = x <= BOARD.x - 40 || x >= BOARD.x + BOARD.w + 40;
      expect(outside, `mote ${i} at x=${x}`).toBe(true);
    }
  });

  it('lets the big motes roam anywhere on narrow screens', () => {
    const f = new MoteField({ glow: Texture.EMPTY }, 30, seeded(3));
    f.layout(800, 1200, { x: 60, y: 200, w: 680, h: 680 });
    let inside = 0;
    for (let i = 18; i < 30; i++) {
      const { x } = f.positionOf(i);
      if (x > 20 && x < 780) inside++;
    }
    expect(inside).toBeGreaterThan(0);
  });

  it('gives front-layer motes more drift than back-layer motes (parallax by size)', () => {
    const f = field(30);
    let back = 0;
    let backN = 0;
    let front = 0;
    let frontN = 0;
    for (let i = 0; i < 30; i++) {
      const s = speed(f.velocityOf(i));
      if (f.depthOf(i) === 0) {
        back += s;
        backN++;
      } else {
        front += s;
        frontN++;
      }
    }
    expect(backN).toBeGreaterThan(0);
    expect(frontN).toBeGreaterThan(0);
    expect(front / frontN).toBeGreaterThan(back / backN);
  });
});

describe('MoteField impulse', () => {
  it('kicks motes radially away from the source, scaled by falloff and depth', () => {
    const f = field(30);
    const cx = BOARD.x + BOARD.w / 2;
    const cy = BOARD.y + 100;
    const radius = 600;
    const strength = 120;
    f.impulse(cx, cy, strength, radius);
    let kicked = 0;
    for (let i = 0; i < 30; i++) {
      const { x, y } = f.positionOf(i);
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      const k = f.impulseOf(i);
      if (d >= radius) {
        expect(k.vx).toBe(0);
        expect(k.vy).toBe(0);
        continue;
      }
      kicked++;
      // Direction: parallel to (dx, dy), pointing away.
      const dot = k.vx * dx + k.vy * dy;
      expect(dot).toBeGreaterThan(0);
      const cross = Math.abs(k.vx * dy - k.vy * dx) / (d * speed(k));
      expect(cross).toBeLessThan(1e-4);
      // Magnitude: strength * smoothstep falloff * (0.33 back / 1.0 front).
      const t = 1 - d / radius;
      const falloff = t * t * (3 - 2 * t);
      const parallax = 0.33 + 0.67 * f.depthOf(i);
      expect(speed(k)).toBeCloseTo(strength * falloff * parallax, 6);
    }
    expect(kicked).toBeGreaterThan(0);
  });

  it('ignores motes outside the radius and degenerate calls', () => {
    const f = field(30);
    f.impulse(-5000, -5000, 200, 100);
    f.impulse(W / 2, H / 2, 0, 500);
    f.impulse(W / 2, H / 2, 200, 0);
    for (let i = 0; i < 30; i++) expect(speed(f.impulseOf(i))).toBe(0);
  });

  it('stacks two impulses additively', () => {
    const a = field(30);
    const b = field(30);
    a.impulse(W / 2, H / 2, 100, 900);
    b.impulse(W / 2, H / 2, 50, 900);
    b.impulse(W / 2, H / 2, 50, 900);
    for (let i = 0; i < 30; i++) {
      expect(b.impulseOf(i).vx).toBeCloseTo(a.impulseOf(i).vx, 6);
      expect(b.impulseOf(i).vy).toBeCloseTo(a.impulseOf(i).vy, 6);
    }
  });

  it('pushes a mote sitting exactly on the source straight up', () => {
    const f = field(30);
    const { x, y } = f.positionOf(0);
    f.impulse(x, y, 80, 300);
    const k = f.impulseOf(0);
    expect(k.vx).toBe(0);
    expect(k.vy).toBeCloseTo(-80 * (0.33 + 0.67 * f.depthOf(0)), 6);
  });
});

describe('MoteField decay', () => {
  it('decays the kick exponentially and is back to drift within ~1.5 s', () => {
    const f = field(30);
    f.impulse(W / 2, H / 2, 200, 2000);
    const k0 = f.impulseOf(5);
    expect(speed(k0)).toBeGreaterThan(0);
    // Half a second at 60 Hz: exp(-3 * 0.5) = 0.223.
    for (let n = 0; n < 30; n++) f.update(1 / 60, W, H);
    const k1 = f.impulseOf(5);
    expect(speed(k1) / speed(k0)).toBeCloseTo(Math.exp(-1.5), 3);
    // Direction is preserved while it decays.
    expect(k1.vx / k1.vy).toBeCloseTo(k0.vx / k0.vy, 6);
    // 1.5 s total: exp(-4.5) ~ 1.1% of the original kick, i.e. drift again.
    for (let n = 0; n < 60; n++) f.update(1 / 60, W, H);
    expect(speed(f.impulseOf(5)) / speed(k0)).toBeLessThan(0.012);
  });

  it('is frame-rate independent', () => {
    const a = field(30, 11);
    const b = field(30, 11);
    a.impulse(W / 2, H / 2, 150, 2000);
    b.impulse(W / 2, H / 2, 150, 2000);
    for (let n = 0; n < 60; n++) a.update(1 / 60, W, H);
    for (let n = 0; n < 6; n++) b.update(1 / 6, W, H);
    for (let i = 0; i < 30; i++) {
      expect(a.impulseOf(i).vx).toBeCloseTo(b.impulseOf(i).vx, 4);
      expect(a.impulseOf(i).vy).toBeCloseTo(b.impulseOf(i).vy, 4);
    }
  });

  it('moves the motes by drift plus kick and never leaves the wrap margin', () => {
    const f = field(30);
    f.impulse(W / 2, H / 2, 400, 3000);
    const before = f.positionOf(3);
    f.update(1 / 60, W, H);
    const after = f.positionOf(3);
    // The kick decays first, then the frame integrates drift + decayed kick,
    // which is what velocityOf() reports after the update.
    const v = f.velocityOf(3);
    // Either it moved by v * dt, or it wrapped to the far side.
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const wrappedX = Math.abs(dx) > W / 2;
    const wrappedY = Math.abs(dy) > H / 2;
    if (!wrappedX) expect(dx).toBeCloseTo(v.vx / 60, 3);
    if (!wrappedY) expect(dy).toBeCloseTo(v.vy / 60, 3);
    for (let n = 0; n < 600; n++) f.update(1 / 60, W, H);
    for (let i = 0; i < 30; i++) {
      const p = f.positionOf(i);
      expect(p.x).toBeGreaterThanOrEqual(-40);
      expect(p.x).toBeLessThanOrEqual(W + 40);
      expect(p.y).toBeGreaterThanOrEqual(-40);
      expect(p.y).toBeLessThanOrEqual(H + 40);
    }
  });
});

describe('MoteField heat', () => {
  it('speeds the drift by up to 50% and warms the tint', () => {
    const f = field(30);
    const cold = speed(f.velocityOf(2));
    const coldTint = f.container.children[1]?.tint;
    f.setHeat(1);
    expect(speed(f.velocityOf(2)) / cold).toBeCloseTo(1.5, 6);
    const hotTint = f.container.children[1]?.tint;
    expect(hotTint).not.toBe(coldTint);
    // Warmer: more red than blue.
    const r = ((hotTint ?? 0) >> 16) & 0xff;
    const b = (hotTint ?? 0) & 0xff;
    expect(r).toBeGreaterThan(b);
    f.setHeat(0);
    expect(f.container.children[1]?.tint).toBe(coldTint);
  });

  it('clamps heat to 0..1', () => {
    const f = field(30);
    const cold = speed(f.velocityOf(2));
    f.setHeat(5);
    expect(speed(f.velocityOf(2)) / cold).toBeCloseTo(1.5, 6);
    f.setHeat(-3);
    expect(speed(f.velocityOf(2)) / cold).toBeCloseTo(1, 6);
  });
});
