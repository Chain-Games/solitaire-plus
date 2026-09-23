import { describe, expect, it } from 'vitest';
import { QUALITY, RESOLUTION_BUDGET_PX, effectiveResolution } from './quality.js';

describe('effectiveResolution', () => {
  it('supersamples a DPR-1 monitor on the desktop tiers and leaves medium and low native', () => {
    expect(effectiveResolution(QUALITY.ultra, 1, false, 1808, 1050)).toBe(2);
    expect(effectiveResolution(QUALITY.high, 1, false, 1920, 1080)).toBe(2);
    expect(effectiveResolution(QUALITY.medium, 1, false, 1920, 1080)).toBe(1);
    expect(effectiveResolution(QUALITY.low, 1, false, 1920, 1080)).toBe(1);
  });

  it('keeps a coarse-pointer device at native, capped by the tier', () => {
    expect(effectiveResolution(QUALITY.ultra, 3, true, 390, 844)).toBe(3);
    expect(effectiveResolution(QUALITY.ultra, 1, true, 1024, 768)).toBe(1);
    expect(effectiveResolution(QUALITY.low, 3, true, 390, 844)).toBe(2);
  });

  it('never drops below native on a fine pointer and never above maxResolution', () => {
    expect(effectiveResolution(QUALITY.ultra, 2, false, 1440, 900)).toBe(2);
    expect(effectiveResolution(QUALITY.ultra, 1.25, false, 1536, 864)).toBe(2);
    expect(effectiveResolution(QUALITY.low, 1, false, 1920, 1080)).toBe(1);
  });

  it('holds the supersampling under the pixel budget, fractionally', () => {
    const r = effectiveResolution(QUALITY.ultra, 1, false, 2560, 1440);
    expect(r).toBeGreaterThan(1.5);
    expect(r).toBeLessThan(2);
    expect(2560 * 1440 * r * r).toBeLessThanOrEqual(RESOLUTION_BUDGET_PX);
    // A 4K monitor at DPR 1 has no room for a worthwhile factor: native.
    expect(effectiveResolution(QUALITY.ultra, 1, false, 3840, 2160)).toBe(1);
    // Native is never held under the budget (the phone rule).
    expect(effectiveResolution(QUALITY.ultra, 2, false, 2560, 1440)).toBe(2);
  });

  it('honours the session cap from the governor', () => {
    expect(effectiveResolution(QUALITY.ultra, 1, false, 1920, 1080, 1.5)).toBe(1.5);
    expect(effectiveResolution(QUALITY.ultra, 1, false, 1920, 1080, 1)).toBe(1);
    expect(effectiveResolution(QUALITY.ultra, 1.25, false, 1920, 1080, 1)).toBe(1.25);
  });
});
