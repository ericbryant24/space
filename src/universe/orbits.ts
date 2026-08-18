/**
 * Orbital radii, in the parent system's units.
 *
 * Its own module for one reason: `gen/planet.ts` needs it to work out a planet's insolation, and `node.ts`
 * needs `gen/planet.ts` in order to place settlements on land -- so the two cannot import each other. Pulling
 * the one shared function out is cheaper than tolerating a cycle. `node.ts` re-exports it, so nothing else had
 * to change.
 */

/** A Titius-Bode-like progression: crowded inside, spread outside. */
export function orbitRadius(index: number, count: number): number {
  const frac = (index + 1) / (count + 0.6);
  return 0.13 + 0.79 * frac ** 1.35;
}
