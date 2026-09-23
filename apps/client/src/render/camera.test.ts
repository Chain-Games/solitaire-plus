import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import { Camera } from './camera.js';

const CX = 960;
const CY = 484;

function rig(parallax = 6) {
  const cam = new Camera();
  const back = new Container();
  const plate = new Container();
  const tiles = new Container();
  const hud = new Container();
  cam.add(back, -1);
  cam.add(plate, -0.2);
  cam.add(tiles, 0);
  cam.add(hud, 0.4, true);
  cam.configure(parallax);
  cam.layout(CX, CY);
  return { cam, back, plate, tiles, hud };
}

function offset(c: Container): { x: number; y: number } {
  return { x: c.x - CX, y: c.y - CY };
}

describe('Camera planes', () => {
  it('is the identity at rest: every plane at its pivot, scale 1', () => {
    const r = rig();
    r.cam.update(1 / 60);
    for (const c of [r.back, r.plate, r.tiles, r.hud]) {
      expect(offset(c)).toEqual({ x: 0, y: 0 });
      expect(c.scale.x).toBe(1);
      expect(c.pivot.x).toBe(CX);
    }
  });

  it('never moves the reference (tile) plane for the pointer, and stays within the tier reach', () => {
    const r = rig(6);
    r.cam.pointer(1920, 1080, 1920, 1080);
    for (let i = 0; i < 240; i++) r.cam.update(1 / 60);
    expect(offset(r.tiles)).toEqual({ x: 0, y: 0 });
    // Far planes slide with the look, near planes against it.
    const b = offset(r.back);
    expect(b.x).toBeCloseTo(6, 3);
    expect(b.y).toBeCloseTo(6, 3);
    const h = offset(r.hud);
    expect(h.x).toBe(-2);
    expect(h.y).toBe(-2);
    expect(Math.abs(offset(r.plate).x)).toBeLessThanOrEqual(6 * 0.2 + 1e-9);
  });

  it('keeps the HUD on whole pixels and never scales any plane', () => {
    const r = rig(6);
    r.cam.pointer(1300, 700, 1920, 1080);
    for (let i = 0; i < 30; i++) {
      r.cam.update(1 / 60);
      expect(Number.isInteger(r.hud.x - CX)).toBe(true);
      expect(Number.isInteger(r.hud.y - CY)).toBe(true);
      for (const c of [r.back, r.plate, r.tiles, r.hud]) expect(c.scale.x).toBe(1);
    }
  });

  it('has no motion of its own: nothing moves without a look input', () => {
    const r = rig();
    for (let i = 0; i < 400; i++) {
      r.cam.update(1 / 60);
      for (const c of [r.back, r.plate, r.tiles, r.hud]) {
        expect(offset(c)).toEqual({ x: 0, y: 0 });
        expect(c.scale.x).toBe(1);
      }
    }
  });

  it('is fully off on the low tier and when motion is 0', () => {
    const low = rig(0);
    const off = rig(6);
    off.cam.motion = 0;
    for (const r of [low, off]) {
      r.cam.pointer(0, 0, 1920, 1080);
      for (let i = 0; i < 60; i++) r.cam.update(1 / 60);
      for (const c of [r.back, r.plate, r.tiles, r.hud]) {
        expect(offset(c)).toEqual({ x: 0, y: 0 });
        expect(c.scale.x).toBe(1);
      }
    }
  });

  it('re-centres a held tilt so only changes of tilt look', () => {
    const r = rig();
    r.cam.tilt(20, 45);
    for (let i = 0; i < 600; i++) r.cam.update(1 / 60);
    expect(Math.abs(offset(r.back).x)).toBeLessThan(0.05);
    r.cam.tilt(40, 45);
    for (let i = 0; i < 20; i++) r.cam.update(1 / 60);
    expect(offset(r.back).x).toBeGreaterThan(2);
  });
});
