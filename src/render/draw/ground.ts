import { RELIEF, detailForScale, groundAt, seaRadiusOf } from '../../culture/terrain.ts';
import { atLuminance, css, luminanceOf, shade, type Hsl } from '../color.ts';
import { outlineWidth } from '../bands.ts';
import { groundHeightAt, seaHeightOf, type Ground, type Node } from '../../universe/node.ts';
import { skyTone, surfaceColours, type Surface } from './planet.ts';
import { drawStructures } from './houses.ts';

/**
 * The ground, seen the way a two-dimensional creature would see it: edge on.
 *
 * A region is a stretch of its planet's circumference, so its frame straddles the surface -- rock below, sky above,
 * the ground line running across. That falls out of the geometry rather than being a chosen viewpoint, which is the
 * whole appeal: there is no projection anywhere in the project, and a building at the bottom of the ladder is a
 * front elevation because a front elevation is what a building IS from inside the plane.
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
 * Depths of the stratum lines, in FRAME RADII, at every level of the ladder.
 *
 * A fixed depth in local units, not a fixed thickness of planet -- and that is not a fudge, it is what the terrain
 * field being self-similar means. The relief across a frame is the same fraction of that frame at every zoom (see
 * PERSISTENCE in terrain.ts), so a fixed fraction of the frame IS a fixed multiple of the local relief. Measured in
 * planet units instead, the strata sat two frame-radii below the ground at region zoom and a million below it at
 * building zoom, which is why the rock came out one flat colour.
 */
const STRATA = [0.22, 0.55] as const;

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

/** Trace the ground line across the plate, in local units, left to right. */
function groundLine(g: Ground, detail: number, samples: number): Float64Array {
  const out = new Float64Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const u = -OVERDRAW + (2 * OVERDRAW * i) / (samples - 1);
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
): void {
  const g = node.ground;
  if (!g) return;
  const s = surfaceColours(g.traits);
  const detail = Math.round(detailForScale((r / g.span) * 2));

  // Screen y runs down; local y runs OUTWARD from the planet, so up on screen is away from its centre.
  const toX = (u: number) => cx + u * r;
  const toY = (v: number) => cy - v * r;
  const reach = reachPx / Math.max(1e-9, r);

  const samples = Math.max(16, Math.min(LINE_SAMPLES, Math.round(r)));
  const line = groundLine(g, detail, samples);

  /**
   * The water line, clamped to what the plate can paint.
   *
   * Unclamped it is unbounded: the sea's depth in LOCAL units grows by the frame's own scale factor at every rung,
   * so at building zoom an ocean floor is tens of thousands of frame radii below the surface. A true number, and not
   * one to hand to a path.
   */
  const sea = Math.min(reach, seaHeightOf(g));
  let lowest = Infinity;
  for (let i = 0; i < samples; i++) lowest = Math.min(lowest, line[i * 2 + 1]!);
  const wet = sea > lowest;

  /** A path bounded above by the ground line and below by the plate's reach: everything solid. */
  const rockPath = (): void => {
    ctx.beginPath();
    ctx.moveTo(toX(-OVERDRAW), toY(-reach));
    for (let i = 0; i < samples; i++) ctx.lineTo(toX(line[i * 2]!), toY(line[i * 2 + 1]!));
    ctx.lineTo(toX(OVERDRAW), toY(-reach));
    ctx.closePath();
  };

  /**
   * 1. Sky, down to the top of whatever is solid or liquid.
   *
   * A plate paints sky rather than leaving it, and has to: its parent painted the same ground at a coarser detail
   * level, and wherever the fine ground is lower than the coarse ground the parent's rock is standing in mid-air.
   * This is what erases it. Bounding it by the surface rather than filling a rectangle is what keeps its edges
   * invisible.
   */
  ctx.beginPath();
  ctx.moveTo(toX(-OVERDRAW), toY(reach));
  for (let i = 0; i < samples; i++) {
    ctx.lineTo(toX(line[i * 2]!), toY(Math.max(line[i * 2 + 1]!, wet ? sea : -reach)));
  }
  ctx.lineTo(toX(OVERDRAW), toY(reach));
  ctx.closePath();
  ctx.fillStyle = css(skyTone(g.traits));
  ctx.fill();

  // 2. Rock, below the ground.
  rockPath();
  ctx.fillStyle = css(s.land);
  ctx.fill();

  /**
   * 3. Strata, as LINES parallel to the surface rather than filled bands.
   *
   * Depth is the one thing the inside of a two-dimensional world has to say, and layers say it instantly. Lines
   * rather than fills for the seam reason above -- a stroke has no vertical side edges to antialias -- and each
   * plate repaints its rock before drawing them, so a child's finer layering replaces its parent's coarser layering
   * cleanly instead of the two showing at once.
   */
  ctx.lineWidth = GROUND_INK_PX * 0.8;
  for (let b = 0; b < STRATA.length; b++) {
    const drop = STRATA[b]!;
    ctx.beginPath();
    for (let i = 0; i < samples; i++) {
      const px = toX(line[i * 2]!);
      const py = toY(line[i * 2 + 1]! - drop);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    const t = (b + 1) / STRATA.length;
    ctx.strokeStyle = css(
      atLuminance({ ...s.land, s: s.land.s * (1 - t * 0.3) }, Math.max(0.05, luminanceOf(s.land) * (1 - t * 0.45))),
    );
    ctx.stroke();
  }

  /**
   * 4. Water: the gap ABOVE the ground and below the water line.
   *
   * Bounded below by `min(sea, ground)`, which is the ground where the ground is submerged and the water line itself
   * where it is not -- so the polygon collapses to nothing over dry land. A dry world needs no special case, and a
   * coast is simply where the shape runs out. Flat and opaque, like every fill in the project.
   */
  if (wet) {
    ctx.beginPath();
    ctx.moveTo(toX(-OVERDRAW), toY(sea));
    ctx.lineTo(toX(OVERDRAW), toY(sea));
    for (let i = samples - 1; i >= 0; i--) {
      ctx.lineTo(toX(line[i * 2]!), toY(Math.min(sea, line[i * 2 + 1]!)));
    }
    ctx.closePath();
    ctx.fillStyle = css(s.sea);
    ctx.fill();
  }

  /**
   * 5. The surface in ink, at a FIXED screen width.
   *
   * Not `outlineWidth(r, ...)`. That helper fades an object's outline out as the object gets small and returns zero
   * under about six pixels, which is right for a moon and wrong here, because a plate is not an object, it is a
   * window onto the ground. Sized from the plate, the ink vanished the moment settlements took over the painting,
   * and the coastline disappeared from the world.
   */
  ctx.beginPath();
  for (let i = 0; i < samples; i++) {
    const px = toX(line[i * 2]!);
    const py = toY(line[i * 2 + 1]!);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.lineWidth = GROUND_INK_PX;
  ctx.strokeStyle = css(s.coast);
  ctx.stroke();

  // 6. What is built here, standing out of the ground. Drawn before the water line, so a jetty's shore still reads.
  drawStructures(ctx, cx, cy, r, node, detail);

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
    ctx.strokeStyle = css(atLuminance(s.sea, Math.min(0.9, luminanceOf(s.sea) + 0.22)));
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
  const samples = Math.max(96, Math.min(1400, Math.round(r * 1.6)));
  // Deep enough that the deepest sea bed still has rock under it, and set to match what a region plate paints, so
  // the handover from disc to plates changes nothing about how thick the living world is. See PLATE_RIND.
  const crust = Math.min(1 - RELIEF * 0.7, 1 - PLATE_RIND);

  const surfaceCurve = (): void => {
    ctx.beginPath();
    for (let i = 0; i <= samples; i++) {
      const theta = (i / samples) * Math.PI * 2;
      const rad = groundAt(id, traits, theta, detail) * r;
      const px = cx + Math.cos(theta) * rad;
      const py = cy + Math.sin(theta) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  };

  // 1. The ocean, as a disc out to the water line. Land stands out of it where the ground is higher.
  ctx.fillStyle = css(s.sea);
  ctx.beginPath();
  ctx.arc(cx, cy, r * seaR, 0, Math.PI * 2);
  ctx.fill();

  // 2. The land: one closed curve at the ground radius.
  surfaceCurve();
  ctx.fillStyle = css(s.land);
  ctx.fill();

  // 3. The interior, drawn OVER the land so the coast stays a thin rind rather than the whole disc being one colour.
  for (let b = 0; b < INTERIOR_BANDS; b++) {
    const t = b / (INTERIOR_BANDS - 1);
    ctx.beginPath();
    ctx.arc(cx, cy, r * crust * (1 - (b / INTERIOR_BANDS) * 0.78), 0, Math.PI * 2);
    ctx.fillStyle = css(
      atLuminance(
        { ...s.land, s: s.land.s * (0.7 - t * 0.32) },
        Math.max(0.035, luminanceOf(s.land) * (0.3 - t * 0.2)),
      ),
    );
    ctx.fill();
  }
  // A core, in the star's own shadow hue: the one warm thing in a cold interior, and the only thing the middle of a
  // two-dimensional world has to say for itself.
  ctx.beginPath();
  ctx.arc(cx, cy, r * crust * 0.13, 0, Math.PI * 2);
  ctx.fillStyle = css(atLuminance(shade(s.land, traits.starLight.shadowHue, 1.4), 0.15));
  ctx.fill();

  // 4. The surface in ink, over everything, because it is the edge of the world.
  const w = outlineWidth(r, 3);
  if (w > 0) {
    surfaceCurve();
    ctx.lineWidth = w;
    ctx.strokeStyle = css(s.coast);
    ctx.stroke();

    // And the water line, lighter, so a shore reads as a shore.
    ctx.beginPath();
    ctx.arc(cx, cy, r * seaR, 0, Math.PI * 2);
    ctx.lineWidth = w * 0.5;
    ctx.strokeStyle = css(atLuminance(s.sea, Math.min(0.9, luminanceOf(s.sea) + 0.2)));
    ctx.stroke();
  }
}

export type { Surface };
