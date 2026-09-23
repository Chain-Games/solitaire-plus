import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The haptics map, the Settings gate and the tick rate limit. `navigator`
 * is stubbed so the module sees a platform with `vibrate`.
 */
const calls: (number | number[])[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('navigator', {
    vibrate: (p: number | number[]) => {
      calls.push(p);
      return true;
    },
    maxTouchPoints: 5,
  });
  vi.stubGlobal('document', { hidden: false });
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('haptics', () => {
  it('plays the mapped pattern for each kind when the toggle is on', async () => {
    const { haptic, HAPTIC_PATTERNS, hapticsSupported } = await import('./haptics.js');
    const { useSettings } = await import('../state/settings.js');
    expect(hapticsSupported()).toBe(true);
    expect(useSettings.getState().haptics).toBe(true); // default on where supported
    haptic('thump');
    haptic('clear');
    haptic('big');
    haptic('toast');
    expect(calls).toEqual([
      HAPTIC_PATTERNS.thump,
      [...(HAPTIC_PATTERNS.clear as readonly number[])],
      HAPTIC_PATTERNS.big,
      HAPTIC_PATTERNS.toast,
    ]);
  });

  it('is silent when the Settings toggle is off', async () => {
    const { haptic } = await import('./haptics.js');
    const { useSettings } = await import('../state/settings.js');
    useSettings.getState().setHaptics(false);
    haptic('thump');
    expect(calls).toEqual([]);
    useSettings.getState().setHaptics(true);
    haptic('thump');
    expect(calls).toEqual([20]);
  });

  it('rate-limits ticks to 20 a second', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const { haptic } = await import('./haptics.js');
      haptic('tick');
      haptic('tick'); // same instant: dropped
      vi.advanceTimersByTime(30);
      haptic('tick'); // 30 ms later: dropped (limit is 50 ms)
      vi.advanceTimersByTime(30);
      haptic('tick'); // 60 ms after the first: plays
      expect(calls).toEqual([8, 8]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not supported on a desktop that merely has vibrate()', async () => {
    vi.stubGlobal('navigator', { vibrate: () => true, maxTouchPoints: 0 });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const { haptic, hapticsSupported } = await import('./haptics.js');
    const { useSettings } = await import('../state/settings.js');
    expect(hapticsSupported()).toBe(false);
    expect(useSettings.getState().haptics).toBe(false);
    haptic('tick');
    expect(calls).toEqual([]);
  });

  it('is silent while the page is hidden', async () => {
    vi.stubGlobal('document', { hidden: true });
    const { haptic } = await import('./haptics.js');
    haptic('big');
    expect(calls).toEqual([]);
  });
});
