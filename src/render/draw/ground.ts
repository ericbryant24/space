import { RELIEF, detailForScale, groundAt, seaRadiusOf } from '../../culture/terrain.ts';
import { climateAt } from '../../culture/climate.ts';
import { atLuminance, css, luminanceOf, shade, type Hsl } from '../color.ts';
import { outlineWidth, smoothstep } from '../bands.ts';
import { LEVELS } from '../../universe/schema.ts';
import { angleAtOffset, groundHeightAt, seaHeightOf, type Ground, type Node } from '../../universe/node.ts';
import { surfaceColours, type Surface } from './planet.ts';
import { drawStructures } from './structures.ts';
import { drawFlora, drawGroundcover } from './flora.ts';
import { daylight, type Sky } from './sky.ts';
import {
  beachDepth,
  classifySkin,
  materialTone,
  rockTone,
  skinDepth,
  strataFor,
  stratumTone,
} from './skin.ts';

/**
 * The ground, seen the way a two-dimensional creature would see it: edge on.
 *
 * A region is a stretch of its planet's circumference, so its frame straddles the surface -- rock below, sky above,
 * the ground line running across. That falls out of the geometry rather than being a chosen viewpoint, which is the
 * whole appeal: there is no projection anywhere in the project, and a building at the bottom of the ladder is a
 * front elevation because a front elevation is what a building IS from inside the plane.
 *
 * Two painters live here and they are deliberately the same painter. `drawSurfacePlate` draws one stretch of rim
 * edge on; `drawPlanetBody` draws the whole rim at once, as the edge of a disc. Everything they could disagree
 * about -- what the surface is made of, how deep the soil goes, where the beds of rock lie, how heavy the ink is --
 * they both ask `skin.ts`, in planet units, so the handover between them changes nothing you can see.
 */

/** Most joints the ground line ever has. Scaled down with the plate, so a small plate costs little. */
const LINE_SAMPLES = 220;

/** Width of the ground line, in screen pixels, at every level. The one hero line of a surface view. */
const GROUND_INK_PX = 2.4;

/**
 * How far past its own frame a plate draws, in frame radii.
 *
 * A plate's slot is exactly one frame wide, so this small excess is only there to make sure neighbours overlap
 * rather than leave a hairline of bare parent between them wherever floating point rounds the wrong way.
 */
const OVERDRAW = 1.05;

/**
 * How thick a planet's living rind is: soil and water above, rock below, as a fraction of its radius.
 *
 * Shared with the renderer, and it has to be, because it is one half of a handover. A planet draws its own body
 * until it is 1 / PLATE_RIND screens across, and past that its regions draw the ground instead -- so the rind the
 * disc paints has to be exactly as deep as the rock a plate paints, or a dark band of interior appears or vanishes
 * at the moment the handover happens. See PLANET_MAX_DIAGONALS in renderer.ts for the other half.
 */
export const PLATE_RIND = 0.16;

/** Concentric steps down through a planet's interior. Three, because three flat steps read as depth. */
const INTERIOR_BANDS = 3;

/**
 * Where the disc stops drawing and its regions take over, in screen diagonals.
 *
 * The reciprocal of PLATE_RIND, and the renderer's PLANET_MAX_DIAGONALS is the same number -- it lives there
 * because that is where the decision is made, and here because the disc has to know how long it has left in
 * order to fade its interior out before it goes.
 */
const PLANET_MAX_DIAGONALS_LOCAL = 1 / PLATE_RIND;

/** One planet radius, in metres. Fixed by the ladder, so the disc painter can ask for real depths without a node. */
const PLANET_METRES = 2 ** LEVELS.planet.logSpan;

/**
 * The sky the current frame is under, or null out in space.
 *
 * Frame state rather than an argument, and reluctantly. A plate is handed its sky directly, because the renderer
 * calls it directly. The disc is not: it is reached through `drawPlanet` in planet.ts, which is space-mode art and
 * has no business knowing what time of day it is anywhere. Threading a sky through it would put a surface concern
 * into every planet icon in a system view for the sake of the one moment near the end of the descent where the two
 * pictures overlap -- and they do overlap, for about a factor of three in zoom, with the daylight backdrop already
 * fully painted behind a disc that still fills several screens. Without this the world visibly changed colour at
 * the handover. Set once per frame by the renderer, exactly like `beginStructureFrame`.
 */
let frameSky: Sky | null = null;
/** The viewport, for the same reason: the disc painter has no view argument and most of a big disc is off screen. */
let frameView = { w: 0, h: 0, diagonal: 1, cosUp: 1, sinUp: 0 };
/** The enclosing galaxy's chemistry, which is what the bedrock is made of. See `rockTone`. */
let frameOre = { hue: 30, metallicity: 0.4 };

/**
 * `up` is the scene rotation, and the disc painter needs it to know where the window is.
 *
 * The canvas is turned about the disc's own centre before the body is painted, so inside the painter the viewport
 * is a rotated rectangle. Turning the direction to its centre back by the same angle is all that takes -- the
 * DISTANCE to it is unaffected by a rotation about the centre, which is why only one angle is needed here and not
 * a transform. Frame state rather than an argument because it is a frame-level fact: the only rotation a planet's
 * disc is ever drawn under is the scene's own, since a planet turned by anything else is one seen from inside a
 * region, and by then it is far past the size at which it stops drawing itself. See PLANET_MAX_DIAGONALS.
 */
export function beginGroundFrame(
  sky: Sky | null,
  w: number,
  h: number,
  up: number,
  ore: { hue: number; metallicity: number },
): void {
  frameSky = sky;
  frameView = { w, h, diagonal: Math.hypot(w, h), cosUp: Math.cos(up), sinUp: Math.sin(up) };
  frameOre = ore;
}

/**
 * The stretch of a planet's rim that could possibly be on screen, as an angle either side of the viewport.
 *
 * By the time the disc hands over to its regions it is six screens across, so five sixths of every curve it
 * traces is outside the window -- and the ground line, the material runs and the beds of rock were all spread
 * evenly over the whole of it. What you could actually see got a sixth of the detail it was paying for, and the
 * frame paid thirteen octaves a sample for the rest. This is the same clamp a plate applies to its own span,
 * in polar form: the law of cosines on the triangle made by the planet's centre, the middle of the viewport and
 * a point on the surface. Null means the whole circle is in play, which is the common case and the cheap one.
 */
function visibleArc(cx: number, cy: number, r: number): { from: number; to: number } | null {
  const { w, h, diagonal, cosUp, sinUp } = frameView;
  if (r < diagonal) return null;
  const sx = w / 2 - cx;
  const sy = h / 2 - cy;
  // The middle of the window, turned back into the frame the disc is painted in.
  const vx = cosUp * sx + sinUp * sy;
  const vy = cosUp * sy - sinUp * sx;
  const d = Math.hypot(vx, vy);
  const reach = diagonal / 2 + r * PLATE_RIND;
  if (d <= reach) return null;
  const cosHalf = (r * r + d * d - reach * reach) / (2 * r * d);
  if (!(cosHalf > -1) || cosHalf > 1) return cosHalf > 1 ? { from: 0, to: 0 } : null;
  // A margin of a couple of degrees, so a fill's chord never cuts a visible corner.
  const half = Math.acos(cosHalf) + 0.04;
  const mid = Math.atan2(vy, vx);
  if (half >= Math.PI) return null;
  return { from: mid - half, to: mid + half };
}

/** Trace the ground line across the plate, in local units, left to right. */
function groundLine(g: Ground, detail: number, samples: number, from: number, to: number): Float64Array {
  const out = new Float64Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const u = from + ((to - from) * i) / (samples - 1);
    out[i * 2] = u;
    out[i * 2 + 1] = groundHeightAt(g, u, detail);
  }
  return out;
}

/**
 * A region, settlement or building plate: the surface seen edge on.
 *
 * `reachPx` is how far above and below the ground the plate paints, in SCREEN PIXELS -- the frame's diagonal, so one
 * plate covers the screen if it has to. Pixels rather than frame radii because a plate has to cover the whole height
 * of the column it owns whatever its own width: measured in radii, a settlement eight pixels across painted a
 * hundred-pixel sliver of its own sky into the middle of its region's ground, and a region came out a comb of
 * vertical spikes.
 *
 * NOTHING HERE IS BOUNDED BY A RECTANGLE, and that is the whole trick to tiling these without seams.
 *
 * Plates meet edge to edge, hundreds of them across a screen, and three earlier schemes each left a faint vertical
 * rule at every boundary -- one pixel wide, about seven percent contrast, easy to look straight past in a screenshot
 * and impossible to unsee afterwards. Clipping to a strip puts a column of half-covered fill at every shared edge.
 * Overlapping with no clip is worse: a plate paints its layers in order, so its soil polygon's vertical side edge
 * was antialiased against its OWN rock beneath, and since a later plate paints over an earlier one, every plate
 * stamped that hairline into its neighbour's finished ground. An integer-aligned clip cures the antialiasing but
 * only for an axis-aligned rectangle, and these plates are ROTATED -- a plate's "up" is the direction away from the
 * planet's centre, which differs from its neighbour's.
 *
 * What works is to bound every fill by the GROUND LINE rather than by a rectangle. Then a fill's side edges only
 * ever fall where the neighbouring plate painted the same colour -- sky beside sky, rock beside rock -- because both
 * plates read the same terrain field at the angle where they meet. Antialiasing between two identical colours is
 * invisible, so there is nothing left to see and no clip is needed at all. `tools/seam-check.ts` guards it.
 */
export function drawSurfacePlate(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  node: Node,
  reachPx: number,
  sky: Sky,
  ore: { hue: number; metallicity: number },
  window: { readonly from: number; readonly to: number },
): void {
  const g = node.ground;
  if (!g) return;
  const s = surfaceColours(g.traits);
  const detail = Math.round(detailForScale((r / g.span) * 2));
  /**
   * The climate at this plate's own centre.
   *
   * One query per plate, not per sample: the biome is a fact about a stretch of country and it is evaluated at a
   * fixed coarse detail, so it does not shimmer as you approach. What DOES vary within a plate -- snow above a
   * height, sand at the waterline, bare rock on a steep slope -- is computed per sample from the ground line the
   * plate already has, which costs nothing extra.
   */
  const climate = climateAt(g.planetId, g.traits, g.theta);
  const shadowHue = g.traits.starLight.shadowHue;
  /**
   * This plate's own radius in metres -- 2^logSpan, straight off the node.
   *
   * The number that turns real depths and real heights into local units, and the reason a forest is the same
   * forest at every zoom rather than being redrawn at a new size each time you descend.
   */
  const metresPerUnit = 2 ** node.logSpan;

  // Screen y runs down; local y runs OUTWARD from the planet, so up on screen is away from its centre.
  const toX = (u: number) => cx + u * r;
  const toY = (v: number) => cy - v * r;
  const reach = reachPx / Math.max(1e-9, r);

  /**
   * SAMPLE ONLY THE STRETCH THAT IS ON SCREEN.
   *
   * A plate keeps drawing until it is two and a half screen diagonals in radius, so at the coarse end of every rung
   * six sevenths of it is off the edge of the window -- and the ground line, the tree lattice, the ground cover and
   * the material runs were all spread evenly over the whole of it. What you could actually see got a seventh of the
   * detail it was paying for. Clamping to the visible span costs ten flops and buys up to six times the resolution
   * exactly where you are looking.
   */
  const from = Math.max(-OVERDRAW, window.from);
  const to = Math.min(OVERDRAW, window.to);
  if (to <= from) return;
  const span = to - from;
  const samples = Math.max(16, Math.min(LINE_SAMPLES, Math.round((r * span) / 2)));
  const line = groundLine(g, detail, samples, from, to);

  /**
   * The water line, clamped to what the plate can paint.
   *
   * Unclamped it is unbounded: the sea's depth in LOCAL units grows by the frame's own scale factor at every rung,
   * so at building zoom an ocean floor is tens of thousands of frame radii below the surface. A true number, and not
   * one to hand to a path.
   */
  const seaR = seaRadiusOf(g.planetId, g.traits);
  const sea = Math.min(reach, seaHeightOf(g));
  let lowest = Infinity;
  for (let i = 0; i < samples; i++) lowest = Math.min(lowest, line[i * 2 + 1]!);
  const wet = sea > lowest;

  /** A path bounded above by the ground line and below by the plate's reach: everything solid. */
  const rockPath = (): void => {
    ctx.beginPath();
    ctx.moveTo(toX(from), toY(-reach));
    for (let i = 0; i < samples; i++) ctx.lineTo(toX(line[i * 2]!), toY(line[i * 2 + 1]!));
    ctx.lineTo(toX(to), toY(-reach));
    ctx.closePath();
  };

  /**
   * NO SKY FILL HERE. The sky is painted once per frame, before any plate, by `drawGround` in renderer.ts.
   *
   * A plate used to paint its own sky, on the argument that its parent had painted the same ground at a coarser
   * detail level and left rock standing in mid-air wherever the fine ground came out lower. That argument stopped
   * being true when the handover went in: a rim parent paints its own body OR its children's plates and never
   * both, so a plate's parent is not on screen at the same time and there is nothing of its to erase.
   *
   * Dropping it is what lets the star, the moons and the clouds be drawn ONCE, in unrotated screen space, before
   * the plates -- so the horizon and the rooftops occlude them for nothing, and no two overlapping plates can
   * disagree about where the sun is.
   */
  // 1. Rock: the deep body of the world, under everything the surface does.
  const rock = daylight(rockTone(s.land, ore), sky, shadowHue);
  rockPath();
  ctx.fillStyle = css(rock);
  ctx.fill();

  /**
   * 2. The beds of rock, as LINES parallel to the surface rather than filled bands.
   *
   * Which beds those are is a fact about the PLANET, not about this plate -- see `strataFor` -- so a bed stays
   * where it is as you descend past it and the finer beds resolve between the ones already on screen. Lines rather
   * than fills for the seam reason above: a stroke has no vertical side edges to antialias. Each plate repaints
   * its rock first, so a child's finer layering replaces its parent's coarser layering cleanly rather than the two
   * showing at once.
   */
  const beds = strataFor(r / g.span, Math.min(PLATE_RIND, reach * g.span));
  for (const bed of beds) {
    const top = bed.depth / g.span;
    // A bed lies between its own depth and the next one down, which is twice as deep -- so the beds thicken
    // downwards, exactly as a geometric family must, and the picture reads as layers rather than as ruled lines.
    const bottom = Math.min(reach + 1, top * 2);
    ctx.beginPath();
    for (let i = 0; i < samples; i++) ctx.lineTo(toX(line[i * 2]!), toY(line[i * 2 + 1]! - top));
    for (let i = samples - 1; i >= 0; i--) ctx.lineTo(toX(line[i * 2]!), toY(line[i * 2 + 1]! - bottom));
    ctx.closePath();
    ctx.fillStyle = css(stratumTone(rock, g.planetId, bed.index), bed.alpha);
    ctx.fill();
  }

  /**
   * 3. THE SKIN: what the surface is actually made of, in runs along the ground.
   *
   * The rock beneath is one tone and always has been; what varies is the few metres at the top, and it varies for
   * reasons you can see. Snow lies above a height, because it is colder up there. Sand collects at the waterline.
   * Bare rock shows where the slope is too steep for anything to hold. Everywhere else is soil in the biome's own
   * colour -- so a world's deserts, forests and tundra are visibly different stretches of the same coast rather
   * than one flat green.
   *
   * Drawn as a run per material rather than as a gradient or a blend. The vertical edge where one run meets the
   * next is a REAL edge -- a snow line, the top of a beach -- and the only kind of edge in this painter that is
   * allowed to be visible.
   */
  const depth = skinDepth(r, metresPerUnit);
  const runs = classifySkin(
    g.planetId,
    g.traits,
    seaR,
    samples,
    (i) => angleAtOffset(g, line[i * 2]!),
    (i) => g.baseRadius + line[i * 2 + 1]! * g.span,
    beachDepth(g.traits, r, metresPerUnit) * g.span,
  );
  for (const run of runs) {
    ctx.beginPath();
    for (let i = run.from; i <= run.to; i++) ctx.lineTo(toX(line[i * 2]!), toY(line[i * 2 + 1]!));
    for (let i = run.to; i >= run.from; i--) ctx.lineTo(toX(line[i * 2]!), toY(line[i * 2 + 1]! - depth));
    ctx.closePath();
    ctx.fillStyle = css(daylight(materialTone(run.material, run.biome, s, g.traits, ore), sky, shadowHue));
    ctx.fill();
  }

  /**
   * 4. Water: the gap ABOVE the ground and below the water line, plus a shallow band along the shore.
   *
   * Bounded below by `min(sea, ground)`, which is the ground where the ground is submerged and the water line itself
   * where it is not -- so the polygon collapses to nothing over dry land. A dry world needs no special case, and a
   * coast is simply where the shape runs out. Flat and opaque, like every fill in the project.
   *
   * The shallows are the same shape drawn twice: once for the whole sea in its deep colour, once for the sliver
   * above the sea bed where the bed is close to the surface. That is what makes a shore read as a shore from
   * orbit-adjacent zooms, and it costs one extra path.
   */
  if (wet) {
    const seaTone = daylight(s.sea, sky, shadowHue);
    ctx.beginPath();
    ctx.moveTo(toX(from), toY(sea));
    ctx.lineTo(toX(to), toY(sea));
    for (let i = samples - 1; i >= 0; i--) {
      ctx.lineTo(toX(line[i * 2]!), toY(Math.min(sea, line[i * 2 + 1]!)));
    }
    ctx.closePath();
    ctx.fillStyle = css(seaTone);
    ctx.fill();

    const shallow = Math.max(2 / r, depth * 2.2);
    ctx.beginPath();
    for (let i = 0; i < samples; i++) {
      const v = Math.min(sea, line[i * 2 + 1]!);
      ctx.lineTo(toX(line[i * 2]!), toY(v));
    }
    for (let i = samples - 1; i >= 0; i--) {
      const v = Math.min(sea, line[i * 2 + 1]! + shallow);
      ctx.lineTo(toX(line[i * 2]!), toY(v));
    }
    ctx.closePath();
    ctx.fillStyle = css(atLuminance(seaTone, Math.min(0.72, luminanceOf(seaTone) + 0.16)));
    ctx.fill();
  }

  // 5. What grows here.
  if (climate.land) {
    drawGroundcover(ctx, g, climate, sky, cx, cy, r, detail, metresPerUnit, sea, from, to);
    drawFlora(ctx, g, climate, sky, cx, cy, r, detail, metresPerUnit, sea, from, to);
  }

  /**
   * 6. The surface in ink, at a FIXED screen width.
   *
   * Not `outlineWidth(r, ...)`. That helper fades an object's outline out as the object gets small and returns zero
   * under about six pixels, which is right for a moon and wrong here, because a plate is not an object, it is a
   * window onto the ground. Sized from the plate, the ink vanished the moment settlements took over the painting,
   * and the coastline disappeared from the world. The disc does use the ramp, and the two agree, because at the
   * moment the disc hands over it is several screens across and the ramp has long since saturated.
   */
  ctx.beginPath();
  for (let i = 0; i < samples; i++) {
    const px = toX(line[i * 2]!);
    const py = toY(line[i * 2 + 1]!);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.lineWidth = GROUND_INK_PX;
  ctx.strokeStyle = css(daylight(s.coast, sky, shadowHue));
  ctx.stroke();

  // 7. What is built here, standing out of the ground.
  drawStructures(ctx, cx, cy, r, node, detail, sky, climate, ore, from, to);

  // And the top of the water, lighter, in the runs where there IS water. A line drawn straight across would be the
  // sea LEVEL, which is a fact about the planet rather than something you can see from the beach.
  if (wet) {
    ctx.beginPath();
    let open = false;
    for (let i = 0; i < samples; i++) {
      const under = line[i * 2 + 1]! < sea;
      if (under && !open) {
        ctx.moveTo(toX(line[i * 2]!), toY(sea));
        open = true;
      } else if (under) {
        ctx.lineTo(toX(line[i * 2]!), toY(sea));
      } else {
        open = false;
      }
    }
    ctx.lineWidth = GROUND_INK_PX * 0.7;
    ctx.strokeStyle = css(daylight(atLuminance(s.sea, Math.min(0.9, luminanceOf(s.sea) + 0.26)), sky, shadowHue));
    ctx.stroke();
  }
}

/**
 * A planet: a disc of rock with everything that matters happening on its edge.
 *
 * A thin bright rind of soil and water at the circumference, a dark interior in concentric steps, and the surface
 * itself as a wiggly closed curve at `groundAt(theta)` with water filling every dip below the sea radius. What used
 * to be here was a world map -- continents laid across the face of the disc, which is a flattened picture of a round
 * planet rather than a genuinely flat one.
 *
 * The value ramp is the point. Life happens in the rind, and the eye goes to the brightest thing on screen, so a
 * mid-toned interior with rings in it turns a planet into a target painted on a wall -- which is exactly what the
 * first version of this looked like. At a quarter of the land's luminance the coast is the one bright edge in the
 * picture, and depth still reads, because flat steps read as depth at any contrast at all.
 *
 * THE RIND IS PAINTED BY THE SAME CODE THE PLATES USE. It was not, for a while, and the cost was the worst seam in
 * the project: the disc filled one flat green rind and ruled a cyan circle of sea level straight across the dry
 * land, then handed over to a coast with snow on its tops, sand at its waterline and a different colour for every
 * biome. Everything below now comes out of `skin.ts` in planet units, which is the one frame a disc and a doorstep
 * can both speak.
 */
export function drawPlanetBody(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  id: number,
  traits: Parameters<typeof surfaceColours>[0],
): void {
  const s = surfaceColours(traits);
  const seaR = seaRadiusOf(id, traits);
  const detail = Math.round(detailForScale(r));
  const shadowHue = traits.starLight.shadowHue;
  /**
   * Daylight, weighted by how far the arrival has got.
   *
   * Out in space this is the identity and a planet is simply lit. By the time the disc hands over to its regions
   * the daylight backdrop behind it is already fully painted, so the disc has to be under the same sky the plates
   * are -- and it has to get there continuously, over the same range the backdrop fades in, or the world changes
   * colour in one frame. `frameSky.groundAlpha` is exactly that range.
   */
  const lit = (c: Hsl): Hsl => (frameSky ? daylight(c, frameSky, shadowHue, frameSky.groundAlpha) : c);

  /**
   * Two resolutions: a fine curve for the silhouette, a coarse grid for the surface material.
   *
   * The outline needs a joint every few pixels or a planet several screens across comes out visibly faceted. The
   * material does not: a run of desert is hundreds of kilometres long, and asking the climate field for it once
   * per curve joint would be a thousand terrain evaluations a frame for boundaries that land in the same place
   * either way. So the runs are classified on a grid `step` times coarser and their indices scaled back up, which
   * keeps the fine curve for the shapes and pays for the climate once per visible feature.
   */
  const arc = visibleArc(cx, cy, r);
  const span = arc ? arc.to - arc.from : Math.PI * 2;
  if (span <= 0) return;
  const start = arc ? arc.from : 0;
  const curve = Math.max(96, Math.min(1400, Math.round(((r * span) / Math.PI) * 0.8)));
  const grid = Math.max(72, Math.min(360, Math.round(((r * span) / Math.PI) * 0.22)));
  const step = Math.max(1, Math.round(curve / grid));
  const cells = Math.max(24, Math.round(curve / step));
  const samples = cells * step;

  const thetaOf = (i: number) => start + (span * i) / samples;
  const rad = new Float64Array(samples + 1);
  for (let i = 0; i <= samples; i++) rad[i] = groundAt(id, traits, thetaOf(i), detail);

  const px = (i: number, radius: number) => cx + Math.cos(thetaOf(i)) * radius * r;
  const py = (i: number, radius: number) => cy + Math.sin(thetaOf(i)) * radius * r;

  /**
   * The surface itself. On a two-dimensional world this IS the coastline.
   *
   * Closed round the whole rim when the whole rim is in play, and closed THROUGH THE PLANET'S CENTRE when only
   * an arc of it is -- a wedge rather than a ring. A partial arc filled on its own closes with a chord across
   * the front of the disc, which would leave the rock cut off in a straight line down the screen; the wedge
   * covers everything beneath the visible surface and nothing that is on screen falls outside it.
   */
  const surfacePath = (wedge: boolean): void => {
    ctx.beginPath();
    if (wedge) ctx.moveTo(cx, cy);
    for (let i = 0; i <= samples; i++) {
      if (i === 0 && !wedge) ctx.moveTo(px(i, rad[i]!), py(i, rad[i]!));
      else ctx.lineTo(px(i, rad[i]!), py(i, rad[i]!));
    }
    ctx.closePath();
  };
  const surfaceCurve = () => surfacePath(arc !== null);

  // Deep enough that the deepest sea bed still has rock under it, and set to match what a region plate paints, so
  // the handover from disc to plates changes nothing about how thick the living world is. See PLATE_RIND.
  const crust = Math.min(1 - RELIEF * 0.7, 1 - PLATE_RIND);

  // 1. The ocean, as a disc out to the water line. Land stands out of it where the ground is higher.
  ctx.fillStyle = css(lit(s.sea));
  ctx.beginPath();
  ctx.arc(cx, cy, r * seaR, 0, Math.PI * 2);
  ctx.fill();

  /**
   * 2. The body of the world, in rock.
   *
   * Rock, not land: the green belongs to the skin, which is painted over this in step 5. Filling the whole disc
   * with the land colour and calling the result a planet is what made the rind read as one flat thing with a
   * circle drawn on it.
   */
  const rock = lit(rockTone(s.land, frameOre));
  surfaceCurve();
  ctx.fillStyle = css(rock);
  ctx.fill();

  /**
   * 3. The interior, drawn OVER the body so the rind stays a rind rather than the whole disc being one colour.
   *
   * Faded out as the disc grows past a couple of screens, and that is the last thing that differed across the
   * handover. A plate paints uniform rock beneath its ground line, because from down there the core of the world
   * is thousands of kilometres away and out of the picture; the disc painted its concentric steps right up to the
   * moment it stopped drawing, so a band of interior blinked out of existence as the regions took over. By the
   * switch at PLANET_MAX_DIAGONALS the disc is uniform rock below the rind, which is exactly what a plate paints.
   */
  const interior = 1 - smoothstep(2.5 * frameView.diagonal, PLANET_MAX_DIAGONALS_LOCAL * frameView.diagonal, r);
  for (let b = 0; interior > 0.004 && b < INTERIOR_BANDS; b++) {
    const t = b / (INTERIOR_BANDS - 1);
    ctx.beginPath();
    ctx.arc(cx, cy, r * crust * (1 - (b / INTERIOR_BANDS) * 0.78), 0, Math.PI * 2);
    ctx.fillStyle = css(
      lit(
        atLuminance(
          { ...s.land, s: s.land.s * (0.7 - t * 0.32) },
          Math.max(0.035, luminanceOf(s.land) * (0.3 - t * 0.2)),
        ),
      ),
      interior,
    );
    ctx.fill();
  }
  // A core, in the star's own shadow hue: the one warm thing in a cold interior, and the only thing the middle of a
  // two-dimensional world has to say for itself.
  if (interior > 0.004) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * crust * 0.13, 0, Math.PI * 2);
    ctx.fillStyle = css(lit(atLuminance(shade(s.land, shadowHue, 1.4), 0.15)), interior);
    ctx.fill();
  }

  /**
   * 4. The beds of rock in the rind, from the same geometric family the plates draw.
   *
   * Only two or three of them are separable at the sizes a whole disc is usually seen at, and that is the point:
   * the finer beds are still there, waiting between them, and they resolve as you descend rather than a new set
   * snapping in at each rung.
   */
  const beds = strataFor(r, 1 - crust);
  for (const bed of beds) {
    const bottom = Math.min(1 - crust, bed.depth * 2);
    ctx.beginPath();
    for (let i = 0; i <= samples; i++) ctx.lineTo(px(i, rad[i]! - bed.depth), py(i, rad[i]! - bed.depth));
    for (let i = samples; i >= 0; i--) ctx.lineTo(px(i, rad[i]! - bottom), py(i, rad[i]! - bottom));
    ctx.closePath();
    ctx.fillStyle = css(stratumTone(rock, id, bed.index), bed.alpha);
    ctx.fill();
  }

  /**
   * 5. THE SKIN, in runs round the rim: snow on the tops, sand at the waterline, rock on the steeps, biome soil
   * everywhere else. The same classification, from the same file, at the same depths as a region plate's.
   */
  const depth = skinDepth(r, PLANET_METRES);
  const runs = classifySkin(
    id,
    traits,
    seaR,
    cells + 1,
    (i) => thetaOf(i * step),
    (i) => rad[i * step]!,
    beachDepth(traits, r, PLANET_METRES),
  );
  for (const run of runs) {
    const a = run.from * step;
    const b = run.to * step;
    ctx.beginPath();
    for (let i = a; i <= b; i++) ctx.lineTo(px(i, rad[i]!), py(i, rad[i]!));
    for (let i = b; i >= a; i--) ctx.lineTo(px(i, rad[i]! - depth), py(i, rad[i]! - depth));
    ctx.closePath();
    ctx.fillStyle = css(lit(materialTone(run.material, run.biome, s, traits, frameOre)));
    ctx.fill();
  }

  /**
   * 6. The shallows: a band of lighter water over the sea bed wherever the bed is close to the surface.
   *
   * The same trick a plate uses, and the reason a shore reads as a shore from orbit -- without it the sea is one
   * flat disc and every coast is a hard step from land to deep water, which no coast is.
   */
  const shallow = Math.max(2 / r, depth * 2.2);
  {
    // One subpath per submerged stretch: out along the sea bed, back along the top of the shallow water. A single
    // path that zig-zagged between the two would fill as a comb of triangles rather than as a band.
    ctx.beginPath();
    let i = 0;
    while (i <= samples) {
      if (rad[i]! >= seaR) {
        i++;
        continue;
      }
      const a = i;
      while (i <= samples && rad[i]! < seaR) i++;
      const b = i - 1;
      ctx.moveTo(px(a, rad[a]!), py(a, rad[a]!));
      for (let j = a + 1; j <= b; j++) ctx.lineTo(px(j, rad[j]!), py(j, rad[j]!));
      for (let j = b; j >= a; j--) {
        const top = Math.min(seaR, rad[j]! + shallow);
        ctx.lineTo(px(j, top), py(j, top));
      }
      ctx.closePath();
    }
    ctx.fillStyle = css(lit(atLuminance(s.sea, Math.min(0.72, luminanceOf(s.sea) + 0.16))));
    ctx.fill();
  }

  // 7. The surface in ink, over everything, because it is the edge of the world. Never the wedge: a stroked
  // wedge would draw two spokes out to the centre of the planet.
  const w = outlineWidth(r, GROUND_INK_PX);
  if (w > 0) {
    surfacePath(false);
    ctx.lineWidth = w;
    ctx.strokeStyle = css(lit(s.coast));
    ctx.stroke();

    /**
     * And the water line, lighter, ONLY WHERE THERE IS WATER.
     *
     * A full circle at the sea radius is the sea LEVEL, which is a fact about the planet rather than something
     * anyone can see -- and drawn as a ring it ruled a bright cyan line straight across every continent. Stroked
     * in the arcs where the ground actually lies below it, the same line becomes the far shore of each ocean,
     * which is what a plate draws too.
     */
    ctx.beginPath();
    let open = false;
    for (let i = 0; i <= samples; i++) {
      if (rad[i]! < seaR) {
        if (!open) {
          ctx.moveTo(px(i, seaR), py(i, seaR));
          open = true;
        } else {
          ctx.lineTo(px(i, seaR), py(i, seaR));
        }
      } else {
        open = false;
      }
    }
    ctx.lineWidth = w * 0.5;
    ctx.strokeStyle = css(lit(atLuminance(s.sea, Math.min(0.9, luminanceOf(s.sea) + 0.26))));
    ctx.stroke();
  }
}

export type { Surface };
