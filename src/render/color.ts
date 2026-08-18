/**
 * Colour utilities. The important one is `solveL`.
 *
 * HSL lightness is not perceptual: yellow at L=50% is far brighter than blue at L=50%. Picking
 * palette roles by L is exactly why naive procedural palettes clash and go muddy. So instead we
 * choose a target RELATIVE LUMINANCE per role and solve for the L that hits it.
 */
export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360 / 360;
  if (s <= 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const chan = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [
    Math.round(chan(hh + 1 / 3) * 255),
    Math.round(chan(hh) * 255),
    Math.round(chan(hh - 1 / 3) * 255),
  ];
}

const channel = (c: number): number => {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function luminanceOf(c: Hsl): number {
  const [r, g, b] = hslToRgb(c.h, c.s, c.l);
  return luminance(r, g, b);
}

/** Luminance rises monotonically with L at fixed H and S, so bisection converges every time. */
export function solveL(h: number, s: number, targetY: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    const [r, g, b] = hslToRgb(h, s, mid);
    if (luminance(r, g, b) < targetY) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function contrastRatio(a: Hsl, b: Hsl): number {
  const ya = luminanceOf(a);
  const yb = luminanceOf(b);
  const hi = Math.max(ya, yb);
  const lo = Math.min(ya, yb);
  return (hi + 0.05) / (lo + 0.05);
}

export function css(c: Hsl, alpha = 1): string {
  const h = ((c.h % 360) + 360) % 360;
  return alpha >= 1
    ? `hsl(${h.toFixed(1)} ${(c.s * 100).toFixed(1)}% ${(c.l * 100).toFixed(1)}%)`
    : `hsl(${h.toFixed(1)} ${(c.s * 100).toFixed(1)}% ${(c.l * 100).toFixed(1)}% / ${alpha.toFixed(3)})`;
}

/** Shortest signed angular distance from a to b, in degrees. */
export function hueDelta(a: number, b: number): number {
  let d = (((b - a) % 360) + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

export function hueGap(a: number, b: number): number {
  return Math.abs(hueDelta(a, b));
}

/**
 * Derived shade, never a black overlay. Dropping luminance while nudging saturation up and rotating
 * the hue towards the palette's shadow direction is what keeps flat art from going muddy.
 */
export function shade(c: Hsl, shadowHue: number, strength = 1): Hsl {
  const h = c.h + hueDelta(c.h, shadowHue) * 0.18 * strength;
  const s = Math.min(0.95, c.s + 0.06 * strength);
  return { h, s, l: solveL(h, s, luminanceOf(c) * (1 - 0.38 * strength)) };
}

/** Push a colour to a specific luminance, keeping hue and saturation. */
export function atLuminance(c: Hsl, y: number): Hsl {
  return { h: c.h, s: c.s, l: solveL(c.h, c.s, y) };
}
