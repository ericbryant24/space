import { makePalette, voidBackground, type Palette } from '../culture/palette.ts';
import type { Node } from '../universe/node.ts';
import type { Tree } from '../universe/tree.ts';
import { css as cssColor, hueDelta, luminanceOf, solveL, type Hsl } from './color.ts';
import { smoothstep } from './bands.ts';

export const css = cssColor;

const cache = new Map<number, Palette>();

export function cosmicPaletteOf(id: number): Palette {
  let p = cache.get(id);
  if (!p) {
    p = makePalette(id, 'cosmicPalette', 'sober');
    if (cache.size > 512) cache.clear();
    cache.set(id, p);
  }
  return p;
}

/**
 * The void a node sits in: the diffuse light of whatever encloses it.
 *
 * Inside a galaxy that is the galaxy, at any depth below it -- interstellar space does not stop belonging to a
 * galaxy because you have descended into one of its systems. Between galaxies it is the cluster, and between
 * clusters the field. Nothing below a galaxy has a void of its own.
 */
function containerVoid(node: Node, tree: Tree): Hsl {
  let current: Node | null = node;
  for (let i = 0; i < 10 && current; i++) {
    if (current.kind === 'galaxy' || current.kind === 'cluster' || current.kind === 'field') {
      return voidBackground(cosmicPaletteOf(current.id));
    }
    current = tree.parentOf(current);
  }
  return voidBackground(cosmicPaletteOf(node.id));
}

/** Shortest way round the hue circle, holding luminance rather than lightness, like everything else here. */
function mix(a: Hsl, b: Hsl, t: number): Hsl {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const h = a.h + hueDelta(a.h, b.h) * t;
  const s = a.s + (b.s - a.s) * t;
  const y = luminanceOf(a) + (luminanceOf(b) - luminanceOf(a)) * t;
  return { h, s, l: solveL(h, s, y) };
}

/**
 * Space-mode background, so that different regions of the universe are tinted differently rather than all
 * sharing one flat near-black.
 *
 * The Two-Ends Rule: the background sits at one end of the palette's luminance ramp and everything is drawn
 * with the other end.
 *
 * BLENDED BETWEEN THE FOCUS AND ITS PARENT, and it has to be. Taking the focus lineage's colour outright meant
 * the whole screen changed hue in one frame the moment the camera crossed a semantic boundary -- ascend out of a
 * galaxy and the void flipped from that galaxy's tint to its cluster's, which the pop detector caught as the
 * largest single-frame change anywhere in the project. Weighting by how much of the screen the focus node covers
 * removes it exactly: at the instant of entering, the child is 220 px across and contributes nothing, which is
 * what the parent was contributing a frame earlier, so the two readings agree across the switch.
 */
export function voidBackgroundFor(node: Node, tree: Tree, nodePx: number, diagonal: number): Hsl {
  const inner = containerVoid(node, tree);
  const parent = tree.parentOf(node);
  if (!parent) return inner;
  return mix(containerVoid(parent, tree), inner, smoothstep(0.5 * diagonal, 2 * diagonal, nodePx));
}
