/**
 * Seeded mulberry32 RNG. The generator state lives in `state.rng` (uint32) so it is saved with the game
 * and the same seed + same commands always produce the same run, regardless of how ticks are batched.
 */

export interface RngHolder {
  rng: number;
}

/** Uniform float in [0, 1). Advances `holder.rng`. */
export function random(holder: RngHolder): number {
  holder.rng = (holder.rng + 0x6d2b79f5) >>> 0;
  let t = holder.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Uniform integer in [lo, hi] (inclusive). */
export function randInt(holder: RngHolder, lo: number, hi: number): number {
  if (hi <= lo) return lo;
  return lo + Math.floor(random(holder) * (hi - lo + 1));
}

/** Uniform float in [lo, hi). */
export function randRange(holder: RngHolder, lo: number, hi: number): number {
  return lo + random(holder) * (hi - lo);
}

/** True with probability p. Always consumes exactly one random number. */
export function chance(holder: RngHolder, p: number): boolean {
  return random(holder) < p;
}

/** Pick a uniformly random element. */
export function pick<T>(holder: RngHolder, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(random(holder) * items.length))];
}

/** Normalise any number into a valid uint32 seed. */
export function normaliseSeed(seed: number): number {
  const s = Math.floor(Math.abs(Number.isFinite(seed) ? seed : 0)) >>> 0;
  return s;
}
