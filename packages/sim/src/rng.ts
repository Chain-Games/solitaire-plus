/**
 * Deterministic PRNG for the sim.
 *
 * Nothing in this package may call Math.random() or Date.now(). Every source of
 * randomness flows through an Rng constructed from a seed string, so any game is
 * reproducible from (seed, moves) alone — on the client, on the server, in tests.
 *
 * Algorithm: FNV-1a to hash the seed string to 32 bits, then mulberry32.
 * mulberry32 is small, fast, and passes the tests that matter for shuffling a
 * 52-card deck. It is not cryptographic; the server picks seeds with crypto.
 */

export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: string | number) {
    this.state = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
    // Burn a few outputs so nearby seeds diverge quickly.
    for (let i = 0; i < 4; i++) this.nextU32();
  }

  /** Uniform 32-bit unsigned integer. */
  nextU32(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    if (!Number.isInteger(n) || n <= 0)
      throw new RangeError(`Rng.int: n must be a positive integer, got ${n}`);
    return Math.floor(this.next() * n);
  }
}
