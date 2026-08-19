import { SPECTRAL, spectralIndexOf, starLightOf, type SpectralClass } from '../../cosmic/spectral.ts';
import { galaxyShape } from '../../universe/gen/galaxyShape.ts';
import { childAt, type Node } from '../../universe/node.ts';
import { LEVELS, anchorLevel } from '../../universe/schema.ts';
import { atLuminance, css, luminanceOf, shade, type Hsl } from '../color.ts';
import { BANDS, outlineWidth, smoothstep } from '../bands.ts';
import { getSprite, sizeBucket } from '../sprites.ts';

/**
 * Some levels of the ladder are OBJECTS with a surface (a planet, a building) and some are REGIONS OF
 * SPACE that merely contain things (a field, a cluster, a star system). Drawing the second kind as an
 * opaque disc is a visible lie: it hides its own contents and implies a substance that is not there.
 *
 * So containers get a soft interior wash and a faint boundary, and their children are the content.
 */

/**
 * Where a container's wash arrives from nothing.
 *
 * These are the `generic` band's fade-in endpoints in bands.ts, and the lower one is also the renderer's
 * own MIN_DRAW_PX: the wash therefore reaches zero exactly at the size where the renderer stops drawing
 * the node at all, so there is no residue left to snap away. Before this the wash was drawn at full
 * strength from its first visible frame, which is the most common kind of pop there is -- a whole
 * population of cluster smudges blinking on together as a field came into range.
 */
export const CONTAINER_FADE_PX: readonly [number, number] = [0.45, 1.2];

/**
 * Concentric flat steps in a container's wash.
 *
 * Flat fills, not a radial gradient. The gradient this replaces was the third one in a project that
 * allows exactly two, and stepping it costs nothing: seven discs whose accumulated alpha follows the
 * same profile the gradient had, so the wash has the same weight and the same falloff and now reads as
 * drawn rather than as a soft render. Seven is where the steps stop being separable at the sizes a
 * container is actually looked at.
 */
const WASH_STEPS = 7;

/**
 * The alpha the old gradient reached at radius fraction `f`. Kept as the target profile so the stepped
 * wash weighs the same as the gradient did and nothing about the cosmic view changed brightness.
 */
function washProfile(f: number): number {
  if (f >= 1) return 0;
  if (f >= 0.62) return (0.26 * (1 - f)) / 0.38;
  return 0.5 + (0.26 - 0.5) * (f / 0.62);
}

export function drawContainer(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  colour: Hsl,
  strength = 1,
  /**
   * The contents of a cluster, if this container is one. Absent for a field or a system, which then get
   * the plain wash. See `clusterCensus`.
   */
  census: ClusterCensus | null = null,
): void {
  const appear = smoothstep(CONTAINER_FADE_PX[0], CONTAINER_FADE_PX[1], r);
  if (appear <= 0) return;

  /**
   * How much of this cluster's population is drawn as individual galaxies rather than as wash, and the
   * wash's share is the complement: the smudge IS the unresolved galaxies, so it has to give up exactly
   * what the swarm takes. `resolved` is 0 for anything that is not a cluster.
   */
  const resolved = census ? swarmAlpha(r) : 0;
  const tone = census ? censusTone(colour, census) : colour;
  // A container is a place as well as a population, so a floor of presence survives even when every one
  // of its galaxies is drawn individually. Without it a cluster loses its extent the moment it resolves.
  const washK = census ? censusStrength(census) * (1 - 0.62 * resolved) : 1;
  /**
   * THE SAME LIGHT IN LESS AREA.
   *
   * A container too small for its contents to be picked out is all of them at once, and all of them at once
   * is brighter than any one of them: the light is the same and the area it arrives in is smaller. Without
   * this the opening view of the whole field -- which is nothing but clusters at eight pixels each -- was
   * thirty faint smudges on a dark ground, the emptiest picture in the project and the first one anybody sees.
   *
   * It rises exactly over the range where the swarm has not yet started, so it is spent by the time the
   * individual galaxies begin to arrive and the wash begins to give itself up to them.
   */
  const compact = census ? 1 + 1.2 * (1 - smoothstep(CLUSTER_SWARM_FADE_PX[0], CLUSTER_SWARM_FADE_PX[1], r)) : 1;
  const k = strength * appear * washK;

  if (k > 1 / 512) {
    let covered = 0;
    for (let i = 0; i < WASH_STEPS; i++) {
      // Midpoints of the steps, so the outermost disc sits just inside the rim -- a step exactly at the
      // rim would carry zero alpha and be wasted, and one exactly at the centre would have no radius.
      const f = (WASH_STEPS - i - 0.5) / WASH_STEPS;
      const target = Math.min(0.95, washProfile(f) * k * compact);
      // Discs composite, so each step only has to add what the one outside it did not.
      const add = covered >= 1 ? 0 : (target - covered) / (1 - covered);
      if (add > 1 / 512) {
        ctx.fillStyle = css(tone, add);
        ctx.beginPath();
        ctx.arc(cx, cy, r * f, 0, Math.PI * 2);
        ctx.fill();
      }
      covered = target;
    }
  }

  if (census && resolved > 1 / 255) paintSwarm(ctx, cx, cy, r, colour, census, resolved * appear);

  // A boundary faint enough to read as a survey annotation rather than a wall.
  const w = outlineWidth(r, 1);
  if (w > 0) {
    ctx.lineWidth = w;
    ctx.strokeStyle = css(colour, 0.22 * strength * appear);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// --- What a cluster is actually made of -----------------------------------------------------------
//
// A cluster below the size where its galaxies can be drawn used to be a generic smudge: one wash, one
// strength, and a hue drift taken from the low bits of its id -- which is to say nothing about the
// cluster at all. It has a real population, its cells are O(1) to enumerate, and the answer never
// changes, so the smudge can be made out of the census instead.

/**
 * Every galaxy of a cluster, reduced to what a stamp can carry.
 *
 * `marks` holds four numbers per galaxy: centre x and y in cluster units, radius in cluster units, and
 * 1 for a star-forming morphology or 0 for a quiescent one. Flat, because a cluster holds a hundred and
 * fifty of these and they are walked twice a frame.
 */
export interface ClusterCensus {
  readonly marks: Float32Array;
  readonly count: number;
  /** Fraction of the population still forming stars: spirals, irregulars and rings. */
  readonly starForming: number;
  /**
   * Population relative to the anchor grid's nominal occupancy. The geometry filters -- children must lie
   * wholly inside the parent disc, and the population thins towards the rim -- take about a third, so a
   * typical cluster lands near 0.7 rather than 1.
   */
  readonly richness: number;
}

/** Morphologies whose light is dominated by young, hot, blue populations rather than by old red ones. */
const STAR_FORMING = new Set(['spiral', 'barredSpiral', 'flocculent', 'irregular', 'ring', 'cartwheel', 'interacting']);

const censusCache = new Map<number, ClusterCensus>();

/**
 * The galaxies of one cluster. Pure in the cluster's address, so it is cached by id and by generous
 * margin: 256 cells, each a hash, and a shape roll for every one that is occupied comes to about a
 * millisecond -- trivial once and ruinous sixty times a second. A field puts around forty clusters on
 * screen, so the cache holds well over a field's worth; sized so that panning across one cannot start
 * evicting censuses it is about to want back.
 */
export function clusterCensus(node: Node): ClusterCensus {
  const hit = censusCache.get(node.id);
  if (hit) return hit;

  const k = anchorLevel(node.kind);
  const n = 2 ** k;
  const marks: number[] = [];
  let young = 0;
  const cell = { cx: 0, cy: 0 };
  for (let cx = 0; cx < n; cx++) {
    for (let cy = 0; cy < n; cy++) {
      cell.cx = cx;
      cell.cy = cy;
      const ref = childAt(node, cell);
      if (!ref) continue;
      const forming = STAR_FORMING.has(galaxyShape(ref.id).morphology) ? 1 : 0;
      young += forming;
      marks.push(ref.ox, ref.oy, ref.rel, forming);
    }
  }
  const count = marks.length / 4;
  const census: ClusterCensus = {
    marks: Float32Array.from(marks),
    count,
    starForming: count > 0 ? young / count : 0,
    richness: count / Math.max(1, n * n * LEVELS[node.kind].density),
  };
  if (censusCache.size > 128) censusCache.clear();
  censusCache.set(node.id, census);
  return census;
}

/**
 * The wash's strength, from the population it stands for. A cluster with half the galaxies of its
 * neighbour should be half as bright, and before this every cluster in the universe was equally bright.
 * Floored well above zero because an empty cluster is still a place, and capped because richness has a
 * long tail and one lucky cluster must not white out its field.
 */
function censusStrength(c: ClusterCensus): number {
  return 0.45 + 0.85 * Math.min(1.4, c.richness);
}

/**
 * The wash's tone. Hue stays the container's, because that is the only hue this drawing is entitled to;
 * what the mix changes is luminance, and it is entitled to change that -- a cluster of star-forming
 * discs really is brighter per galaxy than a cluster of quiescent ellipticals.
 */
function censusTone(colour: Hsl, c: ClusterCensus): Hsl {
  return atLuminance(colour, Math.min(0.7, luminanceOf(colour) * (0.78 + 0.55 * c.starForming)));
}

/**
 * How many cluster radii there are to a galaxy radius: the two levels are six doublings apart, so a
 * size in galaxy pixels becomes the same size in cluster pixels by multiplying by this. Read off the
 * ladder rather than written as 64, because it is the ladder that decides it.
 */
const CLUSTER_PER_GALAXY = 2 ** (LEVELS.cluster.logSpan - LEVELS.galaxy.logSpan);

/**
 * Where the swarm hands over to the galaxies themselves.
 *
 * This is the galaxy `blob` band's own fade-in, measured on the cluster instead of on the galaxy -- and
 * it is READ from that table rather than transcribed, because the entire value of the handover is that
 * the two ramps cannot drift apart. It is ramped in DOUBLINGS for the same reason: `weight` in bands.ts
 * is parameterised in log2, and log2 of a cluster's radius is log2 of its galaxies' plus a constant six,
 * so the swarm's fade-out is the galaxies' fade-in reflected exactly. The two therefore sum to one
 * galaxy's worth of ink at every size, which is the only thing "hands over" can honestly mean. Keyed at
 * 70 px it did nothing of the sort: the first galaxies arrived at 98% of their own weight with the swarm
 * still at full strength, and a swarm dot is floored several times larger than the galaxy it stands for,
 * so the pair drew half as much ink again as the cluster has, in the wrong shapes.
 *
 * THE RENDERER HAS TO AGREE: it must iterate a cluster's grid from the same 0.45 px, which is
 * MIN_CHILD_PX_BY_KIND.galaxy = 0.45 rather than the global 1.1 px floor. At 1.1 px the first real
 * galaxy does not appear until its cluster is 70 px across, by which point the swarm has already given
 * up four fifths of itself and there is nothing standing in for it.
 */
const GALAXY_BLOB_IN = BANDS.galaxy![0]!.in;
export const CLUSTER_SWARM_OUT_PX: readonly [number, number] = [
  CLUSTER_PER_GALAXY * GALAXY_BLOB_IN[0],
  CLUSTER_PER_GALAXY * GALAXY_BLOB_IN[1],
];

/**
 * Where the swarm of individual galaxies fades in.
 *
 * Below 11 px a cluster is smaller than the gaps between the dots would be and the swarm reads as
 * noise; by the time it is 29 px across each dot has a pixel of its own and the arrangement -- which is
 * the cluster's real arrangement -- is what you are looking at. The top of this ramp is the bottom of
 * the handover above, so the swarm reaches full strength exactly as it starts giving itself up and the
 * two ramps never run at once.
 */
export const CLUSTER_SWARM_FADE_PX: readonly [number, number] = [11, CLUSTER_SWARM_OUT_PX[0]];

function swarmAlpha(r: number): number {
  const lr = Math.log2(Math.max(1e-12, r));
  return (
    smoothstep(CLUSTER_SWARM_FADE_PX[0], CLUSTER_SWARM_FADE_PX[1], r) *
    (1 - smoothstep(Math.log2(CLUSTER_SWARM_OUT_PX[0]), Math.log2(CLUSTER_SWARM_OUT_PX[1]), lr))
  );
}

/**
 * The most of its own area a swarm may cover, as a fraction.
 *
 * A galaxy is a fortieth of a pixel across at the sizes where the swarm lives, so its dot has to be a
 * chart symbol -- the same bargain `systemStarRadius` strikes for stars. Unbounded, a hundred and fifty
 * floored dots cover more than the cluster does and the swarm reads as a solid plate; this caps the
 * floor so the ink can never exceed a quarter of the disc, whatever the population.
 */
export const CLUSTER_SWARM_COVER = 0.25;

function paintSwarm(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  colour: Hsl,
  c: ClusterCensus,
  alpha: number,
): void {
  if (c.count === 0) return;
  // Solve `count * (2d)^2 = cover * pi * r^2` for the dot half-width, so the cap is a statement about
  // ink rather than a tuned pixel size.
  const floor = r * Math.sqrt((CLUSTER_SWARM_COVER * Math.PI) / c.count) * 0.5;
  const y = luminanceOf(colour);
  // Two ends of one luminance ramp on the container's hue: young discs at the bright end, old red
  // populations at the dim one. Nothing here invents a hue.
  const tones: readonly Hsl[] = [
    atLuminance(colour, Math.max(0.02, y * 0.85)),
    atLuminance(colour, Math.min(0.72, y * 2.1)),
  ];

  for (let t = 0; t < 2; t++) {
    let drawn = 0;
    ctx.beginPath();
    for (let i = 0; i < c.count; i++) {
      if (c.marks[i * 4 + 3] !== t) continue;
      const d = Math.max(floor, c.marks[i * 4 + 2]! * r);
      // Rects, not arcs: at one pixel the difference is antialiasing and the cost is halved.
      ctx.rect(cx + c.marks[i * 4]! * r - d, cy + c.marks[i * 4 + 1]! * r - d, d * 2, d * 2);
      drawn++;
    }
    if (drawn === 0) continue;
    ctx.fillStyle = css(tones[t]!, alpha * 0.85);
    ctx.fill();
  }
}

/**
 * A star system is ~10 AU across but its star is a few million km, so the system's own extent is
 * almost entirely empty. Draw the star, not the extent -- and draw it in its spectral colour, which is
 * the cue that carries the star's identity all the way down to the shading of a single wall.
 */
export function starCoreRadius(id: number, systemRadiusPx: number): number {
  return Math.max(0.8, systemRadiusPx * 0.055 * starLightOf(id).cls.discScale);
}

export function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, systemRadiusPx: number, id: number): void {
  const light = starLightOf(id);
  const ci = spectralIndexOf(id);
  const r = starCoreRadius(id, systemRadiusPx);

  // The second and last sanctioned gradient in the project: a star's bloom. It is BAKED rather than
  // built per call -- a fresh radial gradient is a canvas object each frame, and the same twelve blooms
  // are wanted over and over. See `bloomSprite` for the shape, which is unchanged.
  const bloom = r * bloomScale(light.cls);
  const sprite = bloomSprite(ci, bloom);
  ctx.drawImage(sprite.canvas as CanvasImageSource, cx - bloom, cy - bloom, bloom * 2, bloom * 2);

  ctx.fillStyle = css({ ...light.colour, l: Math.min(0.97, light.colour.l + 0.2) });
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  if (light.cls.key === 'RG' || light.cls.key === 'C') {
    // Swollen stars get a cooler rim so they read as bloated rather than merely large.
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.strokeStyle = css(shade(light.colour, light.shadowHue, 0.5), 0.7);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * A tighter bloom. An expansive one turns interplanetary space into warm haze and hides the galaxy that
 * should be visible right through it.
 */
function bloomScale(cls: SpectralClass): number {
  return 2.2 + cls.rel * 1.4;
}

/**
 * The bloom, baked once per class per size bucket.
 *
 * The sprite is a pure function of the spectral class, because every length in it is a multiple of the
 * star's own radius -- so one bake serves every star of that class at that bucket, and a bucket lasts a
 * full doubling of zoom.
 */
function bloomSprite(ci: number, bloomPx: number) {
  const size = sizeBucket(bloomPx * 2, 32, 512);
  return getSprite(`starbloom:${ci}:${size}`, size, (bctx, s) => {
    const cls = SPECTRAL[ci]!;
    const colour = { h: cls.hue, s: cls.sat, l: 0.5 + cls.rel * 0.28 };
    const half = s / 2;
    // The core sits at 0.5 / bloomScale of the sprite's radius, which is where it sat when this was
    // built at draw time against the star's own radius.
    const inner = half * (0.5 / bloomScale(cls));
    const g = bctx.createRadialGradient(half, half, inner, half, half, half);
    g.addColorStop(0, css(colour, 0.34 * cls.rel));
    g.addColorStop(1, css(colour, 0));
    bctx.fillStyle = g;
    bctx.beginPath();
    bctx.arc(half, half, half, 0, Math.PI * 2);
    bctx.fill();
  });
}

/**
 * A catalogued system drawn as a star, sized so it is visible and clickable from galaxy level.
 *
 * This is the thing that makes a galaxy read as a 2D map. Before it, every star on screen was decorative
 * and none corresponded to a place, so pointing at one and zooming did nothing -- the reported symptom
 * was "it's like they are not 2D and it is confusing", which is exactly right: a field of unreachable
 * points behaves like a 3D fly-through, not like a map you can zoom.
 */

/**
 * Radius a catalogued star is drawn at, as a fraction of its galaxy's on-screen radius.
 *
 * A star sits 29 doublings below its galaxy, so at its true size it is a 4e-7 px point at galaxy zoom
 * and still under two pixels four doublings later. Drawn that way it never grows: the arms around it
 * inflate, the star does not, and zooming toward one gives no sense of approach at all -- which is the
 * second half of "it's like they are not 2D". So a star is a CHART SYMBOL until its real disc catches
 * up: proportional to the galaxy that holds it, and therefore growing as you descend into it, capped so
 * that a handful of stars can never swallow the screen.
 *
 * Hit-testing calls this same function, so what you can click is exactly what you can see. The two
 * drifting apart is how you get a target that looks pickable and is not.
 */
/**
 * Growth is deliberately SUB-linear in the galaxy's size, at roughly the two-thirds power.
 *
 * Linear looks like the obvious choice -- hold each star at a fixed angular size and total ink stays
 * constant, since the number on screen falls as the square of the zoom. It does not, because a galaxy's
 * stars are not spread evenly: descending into one lands you in the arms and the bulge, where the local
 * density is several times the average, so the count falls far slower than the area does. Linear growth
 * turned two doublings past galaxy focus into overlapping confetti at forty percent screen coverage.
 * The exponent trades a little of the approach cue for a field that still reads as stars.
 */
const SYMBOL_EXP = 0.62;
const SYMBOL_K = 0.0873; // chosen so a mid-class star is ~2.5 px when its galaxy fills the viewport
const SYMBOL_MIN = 1.5;

/**
 * The cap is PER CLASS, not global. A single ceiling makes every star identical the moment the brightest
 * reach it, and a field of same-sized dots stops reading as a sky -- magnitude is most of what makes a
 * star chart legible.
 *
 * The ceiling is what actually governs how crowded the busiest view gets, because a few doublings past
 * galaxy focus every star has reached it while several hundred are still on screen. At 13 px that view
 * was overlapping confetti covering nearly forty percent of the screen; at 8 px it reads as a dense
 * cluster, which is what it is.
 */
function symbolCap(rel: number): number {
  return 2.6 + 5.4 * rel;
}

/**
 * How far a drawn star reaches, counting its halo and its sparkle -- the extent hit-testing has to cover,
 * because clicking a part of a star you can plainly see has to hit that star. Both flourishes grow out of
 * the core rather than switching on, so this grows with them.
 */
export function starGlyphRadius(coreRadiusPx: number): number {
  const halo = 1 + (HALO_SCALE - 1) * haloRamp(coreRadiusPx);
  const spark = 1 + (SPARKLE_SCALE - 1) * sparkleRamp(coreRadiusPx);
  return coreRadiusPx * Math.max(halo, spark);
}

// One-entry memo: every star in a frame shares its parent's radius, and so does every hit test against
// them, so the power is computed once per frame rather than a few thousand times.
let lastParentPx = -1;
let lastParentBase = 0;

export function systemStarRadius(id: number, truePx: number, parentPx: number): number {
  if (parentPx !== lastParentPx) {
    lastParentPx = parentPx;
    lastParentBase = SYMBOL_K * parentPx ** SYMBOL_EXP;
  }
  // Brighter classes read larger, which is how a star chart shows magnitude.
  const rel = SPECTRAL[spectralIndexOf(id)]!.rel;
  const symbol = lastParentBase * (0.55 + 0.9 * rel);
  /**
   * THE FLOOR IS THE STAR, NOT THE SYSTEM.
   *
   * This used to bottom out at the SYSTEM's own radius on screen, and a system is ten astronomical units of
   * almost entirely empty space -- so a few doublings inside a galaxy every catalogued star swelled into a
   * white disc the size of its whole system, until the camera entered one and it collapsed to a dot with two
   * orbit rings round it. The pop detector called it the largest single-frame change in the descent, and it
   * was: a four-hundred-pixel sun turning into a twenty-pixel one.
   *
   * `starCoreRadius` is the expression `drawStar` uses for the real thing, so the chart symbol and the star it
   * stands for are the same size at the moment one hands over to the other, and neither ever draws the empty
   * space around it.
   */
  return Math.max(Math.min(symbolCap(rel), Math.max(SYMBOL_MIN, symbol)), starCoreRadius(id, truePx));
}

// --- Batched stars ------------------------------------------------------------------------------
//
// A galaxy puts a couple of thousand catalogued stars on screen at once. Drawn one at a time each needs
// its own `fillStyle` assignment and its own path, and that state churn costs far more than the fills
// themselves -- the identical pattern in the since-deleted decorative starfield produced a 210 ms stall.
// Stars are therefore queued by spectral class and emitted as ONE PATH PER CLASS: a dozen fills instead
// of two thousand, for a result that is pixel-for-pixel the same.

const CLASS_COUNT = SPECTRAL.length;
const BATCH_CAP = 4096;
/**
 * Below this a star is a square: cheaper than an arc, and at a couple of pixels sharper, which reads as
 * "resolved". Its side is the AREA MATCH for the circle it replaces -- d = r * sqrt(pi) -- so the two
 * shapes deposit exactly the same ink at the crossover and the switch costs no brightness. It used to be
 * `round(r * 1.4)`, which both weighed a quarter less than the circle and quantised the size, so a whole
 * sky of stars stepped between one and two pixels as you zoomed. Rounding a size is a pop by definition.
 */
export const SQUARE_MAX_PX = 2.6;
/** Half-side of the area-matched square, as a multiple of the core radius: sqrt(pi) / 2. */
const SQUARE_HALF_SIDE = Math.sqrt(Math.PI) / 2;
/**
 * Where a star's flat halo starts to emerge from behind its core, and where it has reached full extent.
 *
 * Both flourishes are FLAT fills batched into the same paths as the cores, because the alternative -- a
 * radial gradient each -- is a per-star canvas object and the reason to batch in the first place. It is
 * also the house style: a big flat circle with no halo reads as confetti.
 *
 * The halo is an ANNULUS whose inner edge is the core, so at the bottom of the band it has zero area and
 * contributes exactly nothing. That is what makes the arrival continuous: there is no threshold at which
 * a disc of glow appears under a core that may itself be semi-transparent. It is full by 5.2 px, where
 * the ring is about two pixels wide and reads as glow rather than as a fringe.
 */
export const HALO_MIN_PX = 2.9;
export const HALO_FULL_PX = 5.2;
/** Halo radius, as a multiple of the core radius. */
const HALO_SCALE = 1.75;
/** Sparkle spike length, as a multiple of the core radius. */
const SPARKLE_SCALE = 2.7;
/**
 * Where the four-point sparkle grows out of the core, and where it is fully drawn.
 *
 * The spike's half-width ramps from zero over the same band as its length, so at the bottom the rhombus
 * is degenerate and fills nothing at all -- again no threshold, no appearing mark. 7.4 px is where the
 * spikes are long enough to read as rays rather than as a lumpy outline.
 */
export const SPARKLE_MIN_PX = 4.6;
export const SPARKLE_FULL_PX = 7.4;
/** Sparkles are four extra path segments each, so they are rationed to the brightest on screen. */
const SPARKLE_CAP = 220;

function haloRamp(r: number): number {
  return smoothstep(HALO_MIN_PX, HALO_FULL_PX, r);
}

function sparkleRamp(r: number): number {
  return smoothstep(SPARKLE_MIN_PX, SPARKLE_FULL_PX, r);
}

/**
 * How far outside the viewport a scattered star survives before the renderer culls it.
 *
 * The renderer draws a scattered system at a schematic floor of PLANET_ICON_MIN_PX and culls it once its
 * CENTRE is that far outside the window -- but the star drawn there reaches up to 2.7 core radii, twenty
 * pixels, so a bright star sitting five pixels off the edge had a visible chunk of halo on screen and
 * lost all of it in one frame. Every star therefore ramps to nothing across this last strip, in size and
 * in alpha together, and is already gone by the time the cull fires. Keep equal to the renderer's
 * schematic floor.
 */
export const STAR_EDGE_FADE_PX = 4.2;

/**
 * THE EDGE FADE IS IN SIZE ONLY, AND HAS TO BE.
 *
 * Alpha is a canvas-wide setting, so a per-star alpha would mean a fill per star and the end of the
 * batching this whole section exists for. Quantising it into four buckets is worse than not doing it:
 * a star crossing a bucket boundary jumps a third of its brightness in one frame, and a bright one is
 * an eight-pixel core with a twenty-pixel sparkle, so a pan turned the window's border into a row of
 * blinking marks -- the exact artefact the fade was added to remove. Nothing is lost by dropping it,
 * because the radius already carries the fade and ink goes as its square: a star at half fade is
 * already down to a quarter of its ink, continuously, with one path per class per pass.
 */

const batchX: Float32Array[] = [];
const batchY: Float32Array[] = [];
const batchR: Float32Array[] = [];
const batchN: number[] = [];
for (let i = 0; i < CLASS_COUNT; i++) {
  batchX.push(new Float32Array(BATCH_CAP));
  batchY.push(new Float32Array(BATCH_CAP));
  batchR.push(new Float32Array(BATCH_CAP));
  batchN.push(0);
}
/** Per-star edge fade, recomputed per class at flush. Reused: a flush allocates nothing. */
const batchFade = new Float32Array(BATCH_CAP);
let sparkleBudget = 0;

export function beginStarBatch(): void {
  for (let i = 0; i < CLASS_COUNT; i++) batchN[i] = 0;
  sparkleBudget = SPARKLE_CAP;
}

/**
 * Queue one catalogued star. Returns the radius it will be drawn at, which the caller needs before the
 * batch is flushed in order to size its hit record and decide whether it earns a label.
 */
export function queueSystemStar(
  cx: number,
  cy: number,
  truePx: number,
  parentPx: number,
  id: number,
): number {
  const ci = spectralIndexOf(id);
  const r = systemStarRadius(id, truePx, parentPx);
  const n = batchN[ci]!;
  if (n < BATCH_CAP) {
    batchX[ci]![n] = cx;
    batchY[ci]![n] = cy;
    batchR[ci]![n] = r;
    batchN[ci] = n + 1;
  }
  return r;
}

/**
 * The window, in the same units the queued positions are in.
 *
 * Read off the canvas and its own transform rather than threaded through every call site: the batch has
 * no view object and does not want one, the renderer sets a pure device-pixel-ratio scale, and this runs
 * once per flush.
 */
function viewportOf(ctx: CanvasRenderingContext2D): { w: number; h: number } {
  const canvas = ctx.canvas as { width?: number; height?: number } | undefined;
  if (!canvas || !canvas.width || !canvas.height) return { w: Infinity, h: Infinity };
  let scale = 1;
  if (typeof ctx.getTransform === 'function') {
    const m = ctx.getTransform();
    if (m && m.a > 0) scale = m.a;
  }
  return { w: canvas.width / scale, h: canvas.height / scale };
}

/** Emit every queued star. Returns the number of draw calls issued, for the frame budget. */
export function flushStarBatch(ctx: CanvasRenderingContext2D, alpha: number): number {
  let draws = 0;
  const view = viewportOf(ctx);

  for (let ci = 0; ci < CLASS_COUNT; ci++) {
    const n = batchN[ci]!;
    if (n === 0) continue;
    const cls = SPECTRAL[ci]!;
    const colour = colourOf(cls);
    const xs = batchX[ci]!;
    const ys = batchY[ci]!;
    const rs = batchR[ci]!;

    // How near each star is to being culled, as a factor on its size -- and so on its ink, which
    // follows as the square of it.
    for (let i = 0; i < n; i++) {
      const x = xs[i]!;
      const y = ys[i]!;
      const edge = Math.min(x, y, view.w - x, view.h - y);
      batchFade[i] = smoothstep(-STAR_EDGE_FADE_PX, 0, edge);
    }

    // Pass 1: haloes, as annuli, so a core always lands on its own glow rather than inside it.
    ctx.globalAlpha = alpha * 0.16;
    ctx.fillStyle = css(colour, 1);
    let haloes = 0;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const core = rs[i]! * batchFade[i]!;
      const ramp = haloRamp(rs[i]!);
      if (ramp <= 0) continue;
      const outer = core * (1 + (HALO_SCALE - 1) * ramp);
      if (outer - core < 0.02) continue;
      ctx.moveTo(xs[i]! + outer, ys[i]!);
      ctx.arc(xs[i]!, ys[i]!, outer, 0, Math.PI * 2);
      // Traced the other way, so the winding rule leaves a ring rather than a filled disc.
      ctx.moveTo(xs[i]! + core, ys[i]!);
      ctx.arc(xs[i]!, ys[i]!, core, 0, Math.PI * 2, true);
      haloes++;
    }
    if (haloes > 0) {
      ctx.fill();
      draws++;
    }

    // Pass 2: four-point sparkles on the brightest, the one flourish that makes a star read as a star
    // rather than as a dot. Drawn under the core so the core caps the spikes cleanly.
    ctx.globalAlpha = alpha * 0.75;
    let spikes = 0;
    ctx.beginPath();
    for (let i = 0; i < n && sparkleBudget > 0; i++) {
      const ramp = sparkleRamp(rs[i]!);
      // Below a sixty-fourth the rhombus is thinner than a screen pixel and would spend budget on
      // nothing at all. Neither would a star that has already faded to nothing at the window's edge.
      if (ramp < 1 / 64) continue;
      const core = rs[i]! * batchFade[i]!;
      if (core <= 0) continue;
      const x = xs[i]!;
      const y = ys[i]!;
      const long = core * (1 + (SPARKLE_SCALE - 1) * ramp);
      const wide = core * 0.42 * ramp;
      ctx.moveTo(x - long, y);
      ctx.lineTo(x, y - wide);
      ctx.lineTo(x + long, y);
      ctx.lineTo(x, y + wide);
      ctx.closePath();
      ctx.moveTo(x, y - long);
      ctx.lineTo(x + wide, y);
      ctx.lineTo(x, y + long);
      ctx.lineTo(x - wide, y);
      ctx.closePath();
      sparkleBudget--;
      spikes++;
    }
    if (spikes > 0) {
      ctx.fill();
      draws++;
    }

    // Pass 3: the cores.
    ctx.globalAlpha = alpha;
    ctx.fillStyle = css({ ...colour, l: Math.min(0.97, colour.l + 0.18) });
    let cores = 0;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const r = rs[i]! * batchFade[i]!;
      if (r <= 0) continue;
      if (r <= SQUARE_MAX_PX) {
        const h = r * SQUARE_HALF_SIDE;
        ctx.rect(xs[i]! - h, ys[i]! - h, h * 2, h * 2);
      } else {
        ctx.moveTo(xs[i]! + r, ys[i]!);
        ctx.arc(xs[i]!, ys[i]!, r, 0, Math.PI * 2);
      }
      cores++;
    }
    if (cores > 0) {
      ctx.fill();
      draws++;
    }
  }

  ctx.globalAlpha = 1;
  return draws;
}

function colourOf(cls: SpectralClass): Hsl {
  return { h: cls.hue, s: cls.sat, l: 0.5 + cls.rel * 0.28 };
}
