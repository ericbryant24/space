import { f01, hash2, hash3 } from '../../core/rng.ts';
import { isInhabited, makeChild, rimChildren, type Node } from '../../universe/node.ts';
import { groundHeightAt } from '../../universe/node.ts';
import type { PlanetTraits } from '../../universe/gen/planet.ts';
import { atLuminance, css, luminanceOf, shade, type Hsl } from '../color.ts';
import { surfaceColours } from './planet.ts';

/**
 * Buildings, standing OUT of the ground line.
 *
 * A front elevation is what a building is from inside a two-dimensional world -- not a chosen viewpoint, and not a
 * projection of anything. The plate has already turned the frame edge on, so a house is simply a shape sitting on the
 * ground with the sky behind it.
 *
 * NOTHING HERE IS DECORATIVE. Every house drawn is a rim slot you can zoom into, taken from the same `rimChildren`
 * the camera navigates by and gated by the same `isInhabited` that decides whether anyone lives there -- so the row
 * of roofs on a settlement's horizon is the row of addresses, at the size and place they will be when you arrive.
 */

/**
 * Below this a house is dust rather than a shape, and is skipped. Its slot is still a place you can zoom into.
 *
 * At 1.6 px a village came out as a scatter of pale specks along a ridge, which says nothing and reads as dirt on
 * the lens -- and a mark you cannot identify is the same failure as a mark that stands for nothing.
 */
const MIN_HOUSE_PX = 3.5;

/** Tallest a house gets, as a multiple of its own width. Above this a village reads as a row of towers. */
const MAX_ASPECT = 1.7;

interface Plate {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly detail: number;
}

/**
 * One house: a body, a pitched roof, and -- if there is room for them to read -- a door and a window.
 *
 * The roof's pitch is the planet's climate, which is the cue the whole project exists to make legible: a snowy world
 * builds steep and a dry one builds flat, everywhere on that world, because `snowIndex` and `aridity` are the
 * planet's and not the building's. See THE TELL in the plan.
 */
function house(
  ctx: CanvasRenderingContext2D,
  plate: Plate,
  u: number,
  halfWidth: number,
  base: number,
  id: number,
  traits: PlanetTraits,
  wall: Hsl,
  ink: Hsl,
): void {
  const { cx, cy, r } = plate;
  const toX = (v: number) => cx + v * r;
  const toY = (v: number) => cy - v * r;
  const widthPx = halfWidth * 2 * r;

  // Height and pitch: the planet decides the pitch, the address decides the storey count.
  const storeys = 1 + Math.floor(f01(hash2(id, 0x71)) * 2.6);
  const height = Math.min(MAX_ASPECT * halfWidth * 2, halfWidth * 2 * (0.55 + storeys * 0.3));
  const pitch = Math.max(0.06, Math.min(0.95, 0.18 + 0.9 * traits.snowIndex - 0.28 * traits.aridity));
  const eaveOver = halfWidth * (0.12 + 0.12 * Math.min(1, traits.cloudCover));

  const left = u - halfWidth;
  const right = u + halfWidth;
  const eave = base + height;
  const ridge = eave + halfWidth * pitch;

  // Body.
  ctx.beginPath();
  ctx.moveTo(toX(left), toY(base));
  ctx.lineTo(toX(left), toY(eave));
  ctx.lineTo(toX(right), toY(eave));
  ctx.lineTo(toX(right), toY(base));
  ctx.closePath();
  ctx.fillStyle = css(wall);
  ctx.fill();

  // Roof: one flat triangle with an overhang. A gable end is the only roof a flat world can have.
  ctx.beginPath();
  ctx.moveTo(toX(left - eaveOver), toY(eave));
  ctx.lineTo(toX(u), toY(ridge));
  ctx.lineTo(toX(right + eaveOver), toY(eave));
  ctx.closePath();
  ctx.fillStyle = css(shade(wall, traits.starLight.shadowHue, 1.1));
  ctx.fill();

  if (widthPx >= 14) {
    // A door on one side or the other, and windows in a row -- the only free rolls a house gets.
    const doorW = halfWidth * 0.3;
    const doorH = Math.min(height * 0.55, halfWidth * 0.7);
    const doorAt = u + (f01(hash2(id, 0x72)) < 0.5 ? -1 : 1) * halfWidth * 0.42;
    ctx.fillStyle = css(atLuminance(wall, Math.max(0.04, luminanceOf(wall) - 0.24)));
    ctx.fillRect(toX(doorAt - doorW / 2), toY(base + doorH), doorW * r, doorH * r);

    const cols = 1 + Math.floor(f01(hash2(id, 0x73)) * 3);
    const winW = halfWidth * 0.26;
    const winH = winW * 1.15;
    for (let s = 0; s < storeys; s++) {
      for (let c = 0; c < cols; c++) {
        const wx = u + ((c + 0.5) / cols - 0.5) * halfWidth * 1.5;
        const wy = base + height * ((s + 0.62) / storeys);
        if (wy + winH > eave) continue;
        // Lit or dark, on a schedule of its own. The one thing on a plate that is allowed to be a coin toss.
        const lit = f01(hash3(id, 0x74, s * 8 + c)) < 0.42;
        ctx.fillStyle = css(lit ? atLuminance({ h: traits.atmHue + 40, s: 0.7, l: 0.6 }, 0.72) : atLuminance(wall, 0.08));
        ctx.fillRect(toX(wx - winW / 2), toY(wy + winH), winW * r, winH * r);
      }
    }
  }

  // Ink, over everything: the silhouette is the read.
  if (widthPx >= 6) {
    ctx.lineWidth = Math.min(2.6, Math.max(0.9, widthPx * 0.045));
    ctx.strokeStyle = css(ink);
    ctx.beginPath();
    ctx.moveTo(toX(left), toY(base));
    ctx.lineTo(toX(left), toY(eave));
    ctx.lineTo(toX(left - eaveOver), toY(eave));
    ctx.lineTo(toX(u), toY(ridge));
    ctx.lineTo(toX(right + eaveOver), toY(eave));
    ctx.lineTo(toX(right), toY(eave));
    ctx.lineTo(toX(right), toY(base));
    ctx.stroke();
  }
}

/**
 * Everything built on this plate.
 *
 * A building draws itself. Anything above a building draws its inhabited children as the houses they are -- so a
 * settlement's horizon is a row of roofs and a region's is a scatter of villages, at whatever size they come out.
 * That is the cheap representation of a level being a pre-baked view of the expensive one, which is the rule that
 * makes the crossfades in this project invisible: the marks do not stand in for the buildings, they ARE them.
 */
/**
 * Houses painted in the last frame.
 *
 * Worth counting, and not only for debugging: a structure pass that silently draws nothing looks exactly like a
 * world where nobody happens to live, and the first version of this went two rounds of screenshots before it turned
 * out the descent was landing on the sea bed every time.
 */
let drawn = 0;
export function beginStructureFrame(): void {
  drawn = 0;
}
export function houseCount(): number {
  return drawn;
}

export function drawStructures(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  node: Node,
  detail: number,
): void {
  const g = node.ground;
  if (!g) return;
  const s = surfaceColours(g.traits);
  const plate: Plate = { cx, cy, r, detail };
  const wall = atLuminance(
    { h: g.traits.atmHue * 0.3 + g.traits.starLight.colour.h * 0.7, s: 0.24, l: 0.5 },
    Math.min(0.72, luminanceOf(s.land) + 0.24),
  );

  if (node.kind === 'building') {
    if (!isInhabited(node)) return;
    drawn++;
    house(ctx, plate, 0, 0.42, groundHeightAt(g, 0, detail), node.id, g.traits, wall, s.coast);
    return;
  }

  for (const ref of rimChildren(node)) {
    if (ref.rel * 2 * r < MIN_HOUSE_PX) return;
    const child = makeChild(node, ref);
    if (!isInhabited(child)) continue;

    if (ref.kind === 'building') {
      // One house, filling most of its own slot -- which is the width it will fill when you arrive in it.
      house(ctx, plate, ref.ox, ref.rel * 0.72, groundHeightAt(g, ref.ox, detail), child.id, g.traits, wall, s.coast);
      drawn++;
      continue;
    }

    /**
     * A child that is itself a place full of places -- a settlement seen from its region -- reads as a CLUSTER.
     *
     * Drawing it as one large house would say "one building" about a town of forty. A short row says "town" at a
     * glance, and it is still nothing invented: the row's width is the settlement's own slot, and zooming in
     * resolves it into that settlement's actual buildings in that same stretch of ground.
     */
    const count = 3 + Math.floor(f01(hash2(child.id, 0x7a)) * 4);
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const u = ref.ox + (t - 0.5) * ref.rel * 1.7;
      const w = (ref.rel / count) * (0.5 + f01(hash3(child.id, 0x7b, i)) * 0.5);
      house(ctx, plate, u, w, groundHeightAt(g, u, detail), child.id ^ (i * 0x9e37), g.traits, wall, s.coast);
      drawn++;
    }
  }
}
