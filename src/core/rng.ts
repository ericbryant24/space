// Stateless integer hashing. Two rules govern everything in this file:
//
//  1. No sequential PRNG. A sequential stream would force us to generate every sibling in order to
//     reach the Nth child; every value here is a pure function of its inputs, so "the child in cell
//     (81723, 4402)" costs the same as "the first child".
//
//  2. Every roll draws from its own NAMED stream. With one shared stream, adding a trait later
//     reshuffles the whole universe and breaks every permalink anyone ever shared. With named
//     streams you can add "chimneyCount" and nothing else moves.

/** splitmix32 finalizer. Returns a uint32. */
export function sm32(x: number): number {
  x = (x + 0x9e3779b9) | 0;
  let z = x;
  z ^= z >>> 16;
  z = Math.imul(z, 0x21f0aaad);
  z ^= z >>> 15;
  z = Math.imul(z, 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

export function mix(h: number, v: number): number {
  return sm32((h ^ Math.imul(v | 0, 0x27d4eb2f)) | 0);
}

const SEED = 0x9e3779b9;

/**
 * Variadic hash. Convenient, but the rest parameter allocates an array on EVERY call, and these are
 * called tens of thousands of times per frame by the noise and placement code. Use the fixed-arity
 * forms below in any hot path; a periodic 213 ms garbage-collection pause traced back to exactly this.
 */
export function hash(...values: number[]): number {
  let h = SEED;
  for (let i = 0; i < values.length; i++) h = mix(h, values[i]!);
  return h;
}

// Allocation-free equivalents. These produce bit-identical results to hash() with the same arguments,
// so swapping one in never moves the universe.
export function hash1(a: number): number {
  return mix(SEED, a);
}
export function hash2(a: number, b: number): number {
  return mix(mix(SEED, a), b);
}
export function hash3(a: number, b: number, c: number): number {
  return mix(mix(mix(SEED, a), b), c);
}
export function hash4(a: number, b: number, c: number, d: number): number {
  return mix(mix(mix(mix(SEED, a), b), c), d);
}

/** uint32 -> [0, 1) using the top 24 bits. */
export function f01(h: number): number {
  return (h >>> 8) * (1 / 16777216);
}

/** uint32 -> [-1, 1). */
export function fSym(h: number): number {
  return f01(h) * 2 - 1;
}

export function pick<T>(h: number, arr: readonly T[]): T {
  return arr[(h >>> 8) % arr.length]!;
}

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Bump an entry here to deliberately revise ONE generator without disturbing any other trait.
// Never renumber an existing entry casually: it changes every place that stream touches.
export const STREAM_VERSION: Readonly<Record<string, number>> = {};

/** Seed for a named stream on a node. Stable across additions of unrelated streams. */
export function stream(nodeId: number, name: string): number {
  return hash3(nodeId, fnv1a(name), STREAM_VERSION[name] ?? 0);
}

/** One value from a named stream, indexed so a stream can yield a sequence without state. */
export function roll(nodeId: number, name: string, index = 0): number {
  return mix(stream(nodeId, name), index);
}
