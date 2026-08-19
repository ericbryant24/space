import { f01, hash2 } from '../../core/rng.ts';
import { archOf, lookOf } from '../../culture/arch.ts';
import type { LocalClimate } from '../../culture/climate.ts';
import { motifOf } from '../../culture/motif.ts';
import { scriptOf } from '../../culture/script.ts';
import { languageOf } from '../../culture/language.ts';
import { buildingName, cultureOf } from '../../universe/gen/culture.ts';
import { ruinDecay } from '../../universe/rarity.ts';
import {
  groundHeightAt,
  isInhabited,
  makeChild,
  rimCells,
  rimChildren,
  rimSlotId,
  slotIsSettled,
  type Node,
} from '../../universe/node.ts';
import { smoothstep } from '../bands.ts';
import { atLuminance, css, luminanceOf, shade, solveL } from '../color.ts';
import { drawFacade, FACADE_MIN_PX, ruinOpenRight, wallPath, type Facade } from './facade.ts';
import { daylight, type Sky } from './sky.ts';
import { surfaceColours } from './planet.ts';

/**
 * WHAT IS BUILT ON A STRETCH OF GROUND.
 *
 * NOTHING HERE IS DECORATIVE. Every building drawn is a rim slot you can zoom into, taken from the same
 * `rimChildren` the camera navigates by and gated by the same `isInhabited` that decides whether anyone lives
 * there -- so the row of roofs on a settlement's horizon is the row of addresses, at the size and place they will
 * be when you arrive. The cheap representation is not a stand-in for the expensive one; it IS the expensive one,
 * drawn smaller.
 *
 * Three sizes, and the handover between them is a matter of what can be seen rather than of taste:
 *
 *   under 4 px    a mark, because a shape that small is grit
 *   under 26 px   a silhouette: mass, roof and one window band, which is all that reads
 *   above that    the full elevation, where the planet's own grammar and writing become visible
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

/**
 * Below this a building is dust rather than a shape, and is skipped. Its slot is still a place you can zoom into.
 *
 * At 1.6 px a village came out as a scatter of pale specks along a ridge, which says nothing and reads as dirt on
 * the lens -- and a mark you cannot identify is the same failure as a mark that stands for nothing.
 */
const MIN_HOUSE_PX = 3.5;

/**
 * Where a building starts to appear, and where it is fully there, in screen pixels of width.
 *
 * A hard cut at MIN_HOUSE_PX meant a whole village blinked into existence in one frame as you approached, which is
 * the loudest pop the surface had. Ramping the alpha over a doubling of size costs one multiply and is invisible.
 */
const HOUSE_FADE_IN = 1.9;
const HOUSE_FADE_FULL = 4.6;

/** Tallest a building gets, as a multiple of its own width, whatever its world's grammar says. */
const MAX_ASPECT = 2.4;

/**
 * And however tall that comes out, nothing stands more than this many frame radii above the ground.
 *
 * A building's frame is sized by its FOOTPRINT -- its slot along the rim -- so a world whose grammar builds
 * tall produced buildings two and a half frames high, and at the size the camera settles on them that is a
 * plain wall from the bottom of the screen to the top with no roof, no eave and no sky. Which is worse than
 * losing the drama, because the roof is where a world states its climate: pitch, overhang, chimney, snow. This
 * only ever binds on the ones that were unreadable -- anything under about one and a third frames is left
 * exactly as its grammar built it.
 */
const BUILDING_TOP = 1.35;

/** Clear space a mark needs before the next one, as a multiple of its own width, to read as separate. */
const MARK_SPACING = 1.7;

/** Everything a building inherits from its world, worked out once per plate rather than once per building. */
interface World {
  readonly arch: ReturnType<typeof archOf>;
  readonly motif: ReturnType<typeof motifOf>;
  readonly script: ReturnType<typeof scriptOf>;
  readonly culture: ReturnType<typeof cultureOf>;
}

export function drawStructures(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  node: Node,
  detail: number,
  sky: Sky,
  climate: LocalClimate,
  ore: { hue: number; metallicity: number },
  from: number,
  to: number,
): void {
  const g = node.ground;
  if (!g || !climate.land) return;

  /**
   * Everything that belongs to the WORLD is worked out once for the whole plate.
   *
   * All five of these are per-planet and cached, but a cache lookup in a loop that runs sixty times a frame is
   * still sixty lookups, and `languageOf` had no cache at all -- eighty microseconds of phoneme generation per
   * building per frame, for a language that cannot change. This is the shape the rest of the file should be read
   * in: the planet decides, and a building only chooses how many storeys it has.
   */
  const language = languageOf(g.planetId);
  const world: World = {
    arch: archOf(g.planetId, g.traits, motifOf(g.planetId)),
    motif: motifOf(g.planetId),
    script: scriptOf(g.planetId, language),
    culture: cultureOf(g.planetId, g.traits),
  };

  /**
   * WHETHER ANYONE STILL LIVES HERE, asked of the TOWN and not of the house.
   *
   * One settlement in a hundred and twenty stands empty (see universe/rarity.ts), and when the people left they
   * all left -- so the answer belongs to the settlement and every building on the plate is handed the same one.
   * That is what makes an empty town read as one abandonment from a region away rather than as a scatter of
   * derelicts, and it is why the last rung needs `parentId`: a single building filling the screen has to ask its
   * settlement, or it would light its windows again at the moment you arrived.
   */
  if (node.kind === 'building') {
    if (!isInhabited(node)) return;
    building(ctx, cx, cy, r, node, node, 0, 0.72, detail, sky, climate, ore, world, ruinDecay(node.parentId), 1);
    return;
  }
  const hostRuin = node.kind === 'settlement' ? ruinDecay(node.id) : 0;

  for (const ref of rimChildren(node)) {
    // Off the edge of the window is off the edge of the work: a plate can be six screens wide.
    if (ref.ox + ref.rel < from || ref.ox - ref.rel > to) continue;
    const child = makeChild(node, ref);
    if (!isInhabited(child)) continue;

    if (ref.kind === 'building') {
      building(ctx, cx, cy, r, node, child, ref.ox, ref.rel * 0.72, detail, sky, climate, ore, world, hostRuin, 1);
      continue;
    }

    town(ctx, cx, cy, r, node, child, ref, detail, sky, climate, ore, world, ruinDecay(child.id));
  }
}

/**
 * A SETTLEMENT SEEN FROM ITS REGION: its own buildings, at their own addresses, as many of them as will fit.
 *
 * What used to be here was a row of three to seven invented houses, which said "town" and nothing else -- the same
 * row whether the place held eight people or four hundred. These are the settlement's REAL building slots: the
 * index into the slot decides the address, the address decides the hash, and the hash decides whether anyone lives
 * there, exactly as `rimChild` and `isInhabited` will decide it when you arrive. Zooming in does not replace this
 * drawing, it resolves it -- the roofs you were looking at stay where they were and the ones between them fill in.
 *
 * The one thing not asked here is whether a slot is under water, because that costs a terrain sample at placement
 * detail and there are thousands of slots on a region plate. A settlement stands on dry ground by construction, so
 * the answer is almost always yes; where it is not, a house at the waterline fades out as you approach rather than
 * vanishing, which is the same behaviour as any other detail resolving.
 *
 * THE STRIDE IS A POWER OF TWO, and that is what makes the approach monotonic. Halving it keeps every building
 * already drawn and adds the ones between them, so nothing ever moves or swaps; and the newcomers are ramped in
 * over the whole doubling before they are needed, so no house appears at full strength.
 */
function town(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  host: Node,
  child: Node,
  ref: { readonly ox: number; readonly rel: number },
  detail: number,
  sky: Sky,
  climate: LocalClimate,
  ore: { hue: number; metallicity: number },
  world: World,
  ruin: number,
): void {
  const slots = rimCells(child);
  if (slots === 0) return;
  const slotPx = (ref.rel * 2 * r) / slots;
  // Slots per mark, so that marks land at least a mark's width apart and a town does not read as a smear.
  const need = Math.max(1, (MIN_HOUSE_PX * MARK_SPACING) / Math.max(1e-9, slotPx));
  const lv = Math.log2(need);
  const coarse = 2 ** Math.ceil(lv);
  const step = Math.max(1, coarse / 2);
  // Zero at the top of a doubling, one at the bottom: the newcomers are fully there just as the stride halves.
  const newcomer = Math.ceil(lv) - lv;
  const half = (ref.rel / slots) * 0.72;

  for (let i = 0; i < slots; i += step) {
    const id = rimSlotId(child, i);
    if (!slotIsSettled(id, child.kind)) continue;
    const u = ref.ox + (-1 + ((i + 0.5) * 2) / slots) * ref.rel;
    if (u < -1.1 || u > 1.1) continue;
    const alpha = i % coarse === 0 ? 1 : newcomer;
    if (alpha < 0.02) continue;
    building(ctx, cx, cy, r, host, child, u, half, detail, sky, climate, ore, world, ruin, alpha, id);
  }
}

/**
 * One building, at whichever of the three levels of detail its size affords.
 *
 * `host` is the plate being drawn on and `addr` the node whose address the building has -- and `addrId` overrides
 * that address when a settlement is drawing its own building slots from a level up, because at that point the
 * building is not a node yet. It has to be the id the slot WILL have, which is `hash3(settlement.id, 0x21b0, i)`,
 * the same expression `rimChild` uses: the roof shape, the storey count and the lit windows all hang off it, so an
 * id invented for the stand-in would mean every house changed as you arrived.
 */
function building(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  host: Node,
  addr: Node,
  u: number,
  halfUnits: number,
  detail: number,
  sky: Sky,
  climate: LocalClimate,
  ore: { hue: number; metallicity: number },
  world: World,
  ruin: number,
  crowdAlpha = 1,
  addrId = addr.id,
): void {
  const g = host.ground!;
  const trueHalf = halfUnits * r;
  /**
   * An icon floor, and a fade under it.
   *
   * A building narrower than a few pixels cannot be drawn at its true size and be anything but grit, so below the
   * floor it is drawn AT the floor -- the same trick a planet gets in a system view, and honest for the same
   * reason: the mark stands at the address, at the smallest size a mark can stand at. Under that it ramps away
   * rather than being cut, because a village blinking into existence in one frame was the loudest pop the surface
   * had. `max` of a constant and a growing quantity is continuous, so nothing changes size abruptly either.
   */
  const alpha = crowdAlpha * smoothstep(HOUSE_FADE_IN, HOUSE_FADE_FULL, trueHalf * 2);
  if (alpha < 0.02) return;
  const half = Math.max(trueHalf, MIN_HOUSE_PX / 2);
  const x = cx + u * r;
  const id = addrId;
  drawn++;

  /**
   * THREE POINTS OF CONTACT, not one.
   *
   * A building sampled at its centre alone floats over a dip and buries its downhill corner in a rise, which on
   * sloping ground is most of them. Its floor is level -- floors are -- so it sits at the HIGHEST of its three
   * contact points, and the gap under the rest of it is filled with a plinth, which is exactly what a real
   * building on a slope does and what `arch.plinth` already says these worlds build.
   */
  const gL = groundHeightAt(g, u - halfUnits, detail);
  const gC = groundHeightAt(g, u, detail);
  const gR = groundHeightAt(g, u + halfUnits, detail);
  const groundY = cy - Math.max(gL, gC, gR) * r;
  const footY = cy - Math.min(gL, gC, gR) * r;

  const traits = g.traits;
  const arch = world.arch;
  const look = lookOf(arch, id, f01(hash2(id, 0xc1)) < 0.16);

  const prevAlpha = ctx.globalAlpha;
  if (alpha < 1) ctx.globalAlpha = prevAlpha * alpha;

  if (footY > groundY + 0.75) {
    // Masonry, in the galaxy's own ore: a foundation is the one part of a building made of the ground it stands on.
    const dark = Math.min(1, Math.max(0, (ore.metallicity - 0.1) / 0.9));
    const sat = 0.12 + dark * 0.2;
    ctx.fillStyle = css(
      daylight(
        { h: ore.hue, s: sat, l: solveL(ore.hue, sat, Math.max(0.06, 0.34 - dark * 0.2)) },
        sky,
        traits.starLight.shadowHue,
      ),
    );
    ctx.fillRect(x - half, groundY, half * 2, footY - groundY);
  }

  /**
   * THE SILHOUETTE AND THE ELEVATION ARE CROSSFADED, not switched.
   *
   * They are built from the same grammar -- the same roof shape at the same pitch, the same storey count, the same
   * wall in the same ore -- so at the threshold they are the same mass in the same colour. But the elevation also
   * has windows, a door, an eave, a sign in the world's own writing, and swapping one drawing for the other in a
   * single frame put all of that on the wall at once. The silhouette is drawn first and the elevation ramped in
   * over it, which reads as the detail resolving because that is exactly what it is; and because the elevation
   * covers the same footprint, at full strength there is nothing of the silhouette left to see.
   */
  const detailed = smoothstep(FACADE_MIN_PX * 0.85, FACADE_MIN_PX * 1.35, half * 2);

  // The silhouette. Mass, roof and one band of windows: everything that survives under twenty-six pixels.
  if (detailed < 0.999) {
    const s = surfaceColours(traits);
    const shadowHue = traits.starLight.shadowHue;
    const dark = Math.min(1, Math.max(0, (ore.metallicity - 0.1) / 0.9));
    const y = Math.min(0.82, Math.max(0.12, 0.62 - dark * 0.34));
    const sat = 0.1 + dark * 0.26;
    const wall = daylight({ h: ore.hue, s: sat, l: solveL(ore.hue, sat, y) }, sky, shadowHue);
    const storeyH = half * 2 * arch.verticality * 0.42;
    const height = Math.min(half * 2 * MAX_ASPECT, r * BUILDING_TOP, storeyH * look.storeys);
    const rise = half * arch.pitch;

    /**
     * THE BLOCK AND THE ELEVATION ARE THE SAME MASS, ruin included.
     *
     * `wallPath` is the elevation's own silhouette, imported rather than reproduced, because the two drawings are
     * crossfaded over a third of a doubling -- so a rectangle here against a broken head there would have a ruin
     * grow its roofline back as you approached and lose it again as you arrived. The roof is cut to the same
     * fraction, off the same end, from the same `ruinOpenRight`.
     */
    const worn = ruin > 0 ? { h: wall.h, s: wall.s * (1 - 0.62 * ruin), l: wall.l * (1 - 0.1 * ruin) } : wall;
    ctx.fillStyle = css(worn);
    ctx.beginPath();
    wallPath(ctx, x, groundY, groundY - height, half, ruin, id);
    ctx.fill();
    const kept = 1 - 0.55 * ruin;
    const openRight = ruinOpenRight(id);
    const eaveL = x - half - half * arch.eave;
    const eaveR = x + half + half * arch.eave;
    const stop = openRight ? eaveL + (eaveR - eaveL) * kept : eaveR - (eaveR - eaveL) * kept;
    ctx.fillStyle = css(shade(worn, shadowHue, 1.1));
    ctx.beginPath();
    ctx.moveTo(openRight ? eaveL : eaveR, groundY - height);
    ctx.lineTo(x, groundY - height - rise);
    // Past the ridge the covering has gone, so the far slope stops where the roof stops.
    if ((openRight && stop > x) || (!openRight && stop < x)) ctx.lineTo(stop, groundY - height);
    ctx.closePath();
    ctx.fill();

    if (half * 2 > 9) {
      // One window band, lit after dark. At this size a lit window is the only thing that says "someone is in".
      const lit = ruin <= 0 && sky.night > 0.3 && f01(hash2(id, 0x74)) < 0.6 * sky.night;
      const w = Math.max(1, half * 0.3);
      ctx.fillStyle = css(
        lit
          ? atLuminance({ h: (traits.starLight.colour.h + 42) % 360, s: 0.62, l: 0.7 }, 0.78)
          : daylight({ h: traits.atmHue, s: 0.3, l: solveL(traits.atmHue, 0.3, 0.14) }, sky, shadowHue),
      );
      ctx.fillRect(x - w / 2, groundY - height * 0.62, w, Math.max(1, height * 0.2));
    }
    if (half * 2 > 6) {
      ctx.strokeStyle = css(daylight(atLuminance(s.coast, Math.max(0.04, luminanceOf(s.coast))), sky, shadowHue));
      ctx.lineWidth = Math.min(2.2, Math.max(0.8, half * 0.09));
      ctx.beginPath();
      wallPath(ctx, x, groundY, groundY - height, half, ruin, id);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(openRight ? x - half : x + half, groundY - height);
      ctx.lineTo(x, groundY - height - rise);
      if ((openRight && stop > x) || (!openRight && stop < x)) ctx.lineTo(Math.max(x - half, Math.min(x + half, stop)), groundY - height);
      ctx.stroke();
    }
  }

  // The full elevation, over the top of it, ramping in.
  if (detailed > 0.001) {
    ctx.globalAlpha = prevAlpha * alpha * detailed;
    const facade: Facade = {
      arch,
      look,
      motif: world.motif,
      script: world.script,
      sign: buildingName(world.culture, id).local,
      climate,
      sky,
      traits,
      oreHue: ore.hue,
      metallicity: ore.metallicity,
      civic: look.roof === arch.roofCivic && arch.roofCivic !== arch.roof,
      ruin,
      maxHeight: Math.min(half * 2 * MAX_ASPECT, r * BUILDING_TOP),
      id,
      planetId: g.planetId,
    };
    drawFacade(ctx, x, groundY, half, facade);
  }

  ctx.globalAlpha = prevAlpha;
}
