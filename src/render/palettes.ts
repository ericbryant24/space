import { makePalette, voidBackground, type Palette } from '../culture/palette.ts';
import type { Node } from '../universe/node.ts';
import type { Tree } from '../universe/tree.ts';
import { css as cssColor, type Hsl } from './color.ts';

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
 * Space-mode background, taken from the nearest galaxy in the focus lineage so that different regions
 * of the universe are tinted differently rather than all sharing one flat near-black.
 *
 * The Two-Ends Rule: the background sits at one end of the palette's luminance ramp and everything is
 * drawn with the other end.
 */
export function voidBackgroundFor(node: Node, tree: Tree): Hsl {
  let current: Node | null = node;
  for (let i = 0; i < 10 && current; i++) {
    if (current.kind === 'galaxy') return voidBackground(cosmicPaletteOf(current.id));
    current = tree.parentOf(current);
  }
  return voidBackground(cosmicPaletteOf(node.id));
}
