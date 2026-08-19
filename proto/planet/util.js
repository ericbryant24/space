// Shared scalars. Separate module so the four drawing modules can be concatenated into one file for
// publishing without two of them declaring TAU.

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const mod = (n, m) => ((n % m) + m) % m;
/** Shortest signed distance between two angles, in (-pi, pi]. */
export const wrap = (d) => { d = (d + Math.PI) % TAU; return (d < 0 ? d + TAU : d) - Math.PI; };
export function smooth(x, a, b) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
