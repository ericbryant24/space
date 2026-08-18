/**
 * The single time source for ambient motion.
 *
 * Everything that moves is a pure function of (time, node hash) with no simulation state, so motion
 * survives navigation and reload exactly, and nothing has to be stepped or saved.
 *
 * It is a module-level value rather than a Date.now() call at each use site for two reasons: the unit
 * tests need a frozen clock to assert determinism, and a single value per frame guarantees that every
 * object in a frame is drawn at the same instant.
 */
let now = 0;

export function setSimTime(seconds: number): void {
  now = seconds;
}

export function simTime(): number {
  return now;
}

/** Fraction through a cycle of the given period, 0-1. */
export function phase(period: number, offset = 0): number {
  if (period <= 0) return 0;
  return ((now / period + offset) % 1 + 1) % 1;
}
