import { createCamera, frameToNode, nodeToFrame, pxPerUnit, type View } from './camera/camera.ts';
import { R_ENTER } from './camera/rebase.ts';
import { commonDepth, planFlight, positionInAncestor, stepFlight, type Flight } from './camera/flyto.ts';
import { ascend, updateFocus } from './camera/rebase.ts';
import { setSimTime, simTime } from './core/clock.ts';
import { climateAt, sunAt } from './culture/climate.ts';
import { biosphereOf, describeBiosphere } from './culture/biosphere.ts';
import { startLoop } from './core/loop.ts';
import { attachInput, createInput, flingBy, stepInput } from './input/pointer.ts';
import { drawHover, drawLock, render, setRecordAllHits, type HitEntry } from './render/renderer.ts';
import { nearestRimAt, pickAt, type PickResult } from './render/pick.ts';
import {
  childNear,
  childrenNear,
  groundHeightAt,
  isInhabited,
  makeChild,
  orbitalChildren,
  rimChild,
  rimChildren,
  seaHeightOf,
  type Cell,
} from './universe/node.ts';
import { HABITABLE_THRESHOLD } from './universe/gen/planet.ts';
import { LEVELS, ROOT_KIND } from './universe/schema.ts';
import { Tree } from './universe/tree.ts';
import { houseCount } from './render/draw/structures.ts';
import { createBookmarks } from './ui/bookmarks.ts';
import { createHud } from './ui/hud.ts';
import { DEFAULT_SEED, Router, stateOf, type CameraState } from './ui/router.ts';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;
const overlay = document.getElementById('overlay') as HTMLElement;

const ROOT_Z = 8 - LEVELS[ROOT_KIND].logSpan;

let view: View = { w: 0, h: 0 };
let flight: Flight | null = null;
/**
 * The thing the view is locked onto, if any. Double-click sets it; panning, rising and travelling clear it.
 *
 * This exists because of one specific complaint: "I should be able to zoom into anything, which is a
 * problem with movement." Everything below a galaxy is on an orbit, so a planet you are aiming at slides
 * out from under the cursor while you scroll toward it, and there are seventeen doublings of scrolling
 * between a system view and that planet. Locking on inverts the problem: the tracked thing is pinned to
 * the middle of the screen and the rest of the universe moves around it, so zooming toward it is just
 * zooming.
 */
let tracked: readonly Cell[] | null = null;
/** False while the view is still gliding onto `tracked`; true once it is holding it exactly. */
let acquired = false;

/**
 * True when the current flight was started by back/forward. Such a flight must NOT push a history
 * entry when it lands: the entry it is flying towards already exists, and pushing would clobber the
 * forward stack, so forward would silently stop working.
 */
let flightFromHistory = false;
let lastHits: readonly HitEntry[] = [];
let lastSignature = '';

/** Cheap change detector for the camera, at the precision the URL records. */
function cameraSignature(): string {
  return `${cam.node.path.map((c) => `${c.cx}.${c.cy}`).join('-')}|${cam.k}|${cam.cx}|${cam.cy}|` +
    `${cam.fx.toFixed(4)}|${cam.fy.toFixed(4)}|${cam.z.toFixed(3)}`;
}

const router = new Router((state) => {
  // Back and forward retrace the route rather than snapping, which costs almost nothing and feels
  // remarkable. If the seed changed we have no choice but to reload into the other universe.
  if (state.seed !== seed) {
    location.reload();
    return;
  }
  // Retraced, not snapped -- and from history, so landing must not push a fresh entry.
  if (state.path && startFlight(state.path, true)) return;
  applyState(state);
  lastSignature = cameraSignature();
  loop.wake();
});

const initial = router.initial();
const seed = initial.seed ?? DEFAULT_SEED;
const tree = new Tree(seed);
const cam = createCamera(tree.root, ROOT_Z);
const input = createInput(cam);
const hud = createHud(overlay, tree, (depth) => flyToDepth(depth));

/**
 * Places you kept, as pictures.
 *
 * The thumbnail is taken from the live canvas at the moment you keep the view, downscaled to a tile -- so the tile
 * IS the place as you saw it, which is a better name for it than the generator could write. This is what replaced
 * every word on the screen: the labels were doing two jobs, and this is the one of them a drawing cannot do.
 */
const bookmarks = createBookmarks(
  overlay,
  (state) => {
    cancelFlight();
    applyState(state);
    router.push(stateOf(cam, seed));
    loop.wake();
  },
  () => thumbnail(),
  () => stateOf(cam, seed),
);

/** The current view, small enough to keep in local storage: a few kilobytes of JPEG. */
function thumbnail(): string {
  const w = 116;
  const h = 80;
  const tile = document.createElement('canvas');
  tile.width = w;
  tile.height = h;
  const tctx = tile.getContext('2d');
  if (!tctx) return '';
  // Cover rather than stretch: a squashed thumbnail of a landscape is unrecognisable, which defeats the point.
  const scale = Math.max(w / canvas.width, h / canvas.height);
  const dw = canvas.width * scale;
  const dh = canvas.height * scale;
  tctx.drawImage(canvas, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return tile.toDataURL('image/jpeg', 0.72);
}

applyState(initial);

function applyState(state: Partial<CameraState>): void {
  // A pasted URL is untrusted: an unreachable path resolves to null, and we land at the nearest
  // reachable ancestor rather than showing an error.
  if (state.path) {
    let node = tree.resolve(state.path);
    let path = state.path;
    while (!node && path.length > 0) {
      path = path.slice(0, -1);
      node = tree.resolve(path);
    }
    cam.node = node ?? tree.root;
  }
  tracked = null;
  cam.k = state.k ?? 0;
  cam.cx = state.cx ?? 0;
  cam.cy = state.cy ?? 0;
  cam.fx = state.fx ?? 0;
  cam.fy = state.fy ?? 0;
  cam.z = state.z ?? ROOT_Z;
  updateFocus(cam, tree, view);
  // After the focus has settled, not before: a pasted z can be outside the reachable range, and the spring
  // must be aimed at where the camera actually ended up rather than at what the URL asked for.
  input.cancelZoom();
}

function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  view = { w: canvas.clientWidth, h: canvas.clientHeight };
  canvas.width = Math.round(view.w * dpr);
  canvas.height = Math.round(view.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  loop.wake();
}

/**
 * Ambient motion is driven by a wall clock rather than accumulated frame deltas, so a paused or
 * throttled tab resumes where the universe actually is instead of where it left off.
 */
const EPOCH = Date.now();
let motion = true;

/**
 * Put the tracked node back in the middle of the screen. Runs every frame, before `updateFocus`, so the
 * focus machinery then descends into whatever is under the camera -- which is the tracked node.
 *
 * Both positions are taken in the units of the lowest common ancestor, which is the only frame in which
 * they are simultaneously representable: the camera's own frame is normalised to radius 1 precisely so
 * that nothing ever has to hold a coordinate spanning the whole ladder.
 */
function followTracked(dt: number): void {
  if (!tracked) return;
  const target = tree.resolve(tracked);
  if (!target) {
    tracked = null;
    return;
  }
  const depth = commonDepth(cam.node.path, tracked);
  const to = positionInAncestor(tree, target, 0, 0, depth);
  const from = positionInAncestor(tree, cam.node, 0, 0, depth);
  if (!to || !from || from.scale === 0) {
    tracked = null;
    return;
  }
  const nx = (to.x - from.x) / from.scale;
  const ny = (to.y - from.y) / from.scale;
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    tracked = null;
    return;
  }
  const [fx, fy] = nodeToFrame(cam, nx, ny);

  /**
   * Eased on the way in, exact once there. A hard snap makes acquiring a lock a lurch of up to half a
   * screen, and the same lurch every time a scroll takes something over; easing makes it a glide. See
   * ACQUIRED_PX for why the glide then hands over to an exact hold rather than easing forever.
   */
  const dx = fx - cam.fx;
  const dy = fy - cam.fy;
  if (acquired) {
    cam.fx = fx;
    cam.fy = fy;
    return;
  }
  if (Math.hypot(dx, dy) * pxPerUnit(cam) < ACQUIRED_PX) {
    acquired = true;
    cam.fx = fx;
    cam.fy = fy;
    return;
  }
  const step = Math.min(1, ACQUIRE_RATE * dt);
  cam.fx += dx * step;
  cam.fy += dy * step;
}

/** How fast the view slides onto a thing it has just locked onto, per second. */
const ACQUIRE_RATE = 11;
/**
 * Gap at which the glide gives up and simply holds the thing, in pixels.
 *
 * Generous on purpose. An exponential ease never actually arrives at a MOVING target: it settles at a lag
 * of about one time constant's worth of the target's travel, which for a planet on a ninety-second orbit is
 * a couple of pixels -- so a threshold tight enough to look exact was never crossed and the lock trailed
 * the crosshair forever. Eight pixels is invisible as a final hop and comfortably wider than anything below
 * a galaxy travels in a frame.
 */
const ACQUIRED_PX = 8;

const loop = startLoop((dt) => {
  if (motion) setSimTime((Date.now() - EPOCH) / 1000);
  let moving = false;

  if (flight) {
    // A flight owns the camera; user input would fight it.
    if (stepFlight(flight, cam, tree, view, dt)) {
      const fromHistory = flightFromHistory;
      cancelFlight();
      lastSignature = cameraSignature();
      // Arriving from back/forward: update the URL in place, never push, or forward breaks.
      if (fromHistory) router.replace(stateOf(cam, seed));
      else router.push(stateOf(cam, seed));
    } else {
      moving = true;
    }
  } else {
    moving = stepInput(cam, input, view, dt);
    followTracked(dt);
    const zBefore = cam.z;
    updateFocus(cam, tree, view);
    /**
     * `updateFocus` clamps `z` in three places -- the bottom of the ladder, the root, and where the ground would
     * leave the picture -- and every one of them has to be told to the spring, or the spring spends the rest of
     * the session pulling against a wall. That is not just wasted work: the anchor keeps being applied, so a
     * camera held at a limit slides steadily toward whatever the pointer was last over, and the loop never
     * sleeps. Rebase itself never touches z, so a change here can only mean a clamp.
     */
    if (cam.z !== zBefore) input.cancelZoom();
    // Write the URL whenever the camera has actually moved, rather than only while input is active.
    // Keying off the input spring missed every programmatic move and left stale links behind.
    const signature = cameraSignature();
    if (signature !== lastSignature) {
      lastSignature = signature;
      router.replace(stateOf(cam, seed));
    }
  }

  tree.beginFrame();
  const stats = render(ctx, cam, tree, view);
  lastHits = stats.hits;

  // The lock, drawn first so a hover over the same thing sits on top of it.
  if (tracked) {
    const at = pick(view.w / 2, view.h / 2);
    const node = tree.resolve(tracked);
    if (at && node && samePath(at.path, tracked)) drawLock(ctx, at);
  }

  // Reticle under the cursor, so it is visible that things can be travelled to at all.
  if (!flight && !input.dragging) {
    const hovered = pick(input.hoverX, input.hoverY);
    if (hovered && hovered.path.length > cam.node.path.length) {
      drawHover(ctx, hovered, performance.now() / 1000);
      canvas.style.cursor = 'pointer';
    } else {
      canvas.style.cursor = 'crosshair';
    }
  }

  hud.update(cam, stats, loop.fps, loop.frameMs);
  (window as unknown as Record<string, unknown>).__lastDraws = stats.draws;
  (window as unknown as Record<string, unknown>).__lastStats = stats;
  /**
   * Ambient motion keeps the loop awake; without it the view would freeze mid-orbit when idle.
   *
   * A lock does too, and must: `followTracked` only runs inside this callback, so a sleeping loop leaves the
   * glide stranded part-way onto its target and stops following it once there. With ambient motion on that
   * never showed, because the clock kept the loop running -- it only surfaced with motion frozen, which is
   * how every automated check runs.
   */
  return moving || stats.spritesPending || motion || tracked !== null;
});

attachInput(canvas, cam, input, () => view, () => loop.wake());

// Dragging is the user saying "look somewhere else", which is the opposite of a lock.
input.onPan = () => {
  tracked = null;
};

input.onClick = (x, y) => {
  const hit = pick(x, y);
  if (!hit) return;
  travelTo(hit);
};

/**
 * Double click locks the view onto a thing. Double click on empty space lets go.
 *
 * Deliberately does not change the zoom: locking on is about WHERE the middle of the screen is, not how
 * close you are. Once locked, scrolling is a straight approach, because the thing cannot go anywhere.
 */
input.onDoubleClick = (x, y) => {
  const hit = pick(x, y);
  cancelFlight();
  tracked = hit ? hit.path : null;
  acquired = false;
  loop.wake();
};

/**
 * What is under a screen point, filtered to things worth going to.
 *
 * The lookup itself lives in render/pick.ts, which knows about all three ways a child can be placed --
 * including the rim slots that a planet's own disc is drawn instead of, and which therefore appear in no
 * hit list. What is left here is the one policy decision that belongs to navigation rather than geometry.
 */
function pick(x: number, y: number): PickResult | null {
  const hit = pickAt(cam, tree, view, lastHits, x, y);
  /**
   * The focus node and its ANCESTORS are not targets: they fill most of the screen, so they win almost every pick
   * made in the empty space between their children, and travelling to where you already are is a two-second flight
   * that lands exactly where it started -- which reads as the click having gone wrong. Backspace rises instead.
   *
   * SIBLINGS are targets, and testing depth alone excluded them. That was harmless while a focus node's own disc
   * was the picture, and wrong the moment the surface arrived: below a planet the ground either side of you is a
   * row of sibling plates, and being unable to double-click the next stretch of coast is being unable to walk.
   */
  if (hit && isSelfOrAncestor(hit.path)) return null;
  return hit;
}

/** Whether a path is the camera's own node or one of its ancestors -- that is, a prefix of the camera's path. */
function isSelfOrAncestor(path: readonly Cell[]): boolean {
  if (path.length > cam.node.path.length) return false;
  for (let i = 0; i < path.length; i++) {
    const a = path[i]!;
    const b = cam.node.path[i]!;
    if (a.cx !== b.cx || a.cy !== b.cy) return false;
  }
  return true;
}

/**
 * How far, in doublings, a thing is from being enterable at its true size.
 *
 * A planet in a system view is about 2^-17 of the system, so this is around 17 -- seventeen doublings of
 * scrolling through empty interplanetary space, during which the planet is pinned at its schematic floor
 * size and does not appear to get any closer. It also keeps orbiting, so it slides out from under the
 * cursor. Hand-zooming that gap is not a thing anyone can do, which is why scrolling toward a small
 * object becomes a flight instead.
 */
function doublingsAway(hit: HitEntry): number {
  return Math.log2(R_ENTER / Math.max(1e-12, hit.trueRPx));
}


/**
 * THE ONE WAY A FLIGHT BEGINS.
 *
 * Every caller goes through here, and that is the whole point of it existing. A flight, a lock and the zoom
 * spring are three different things all trying to drive the same camera, and they used to be set up
 * independently at half a dozen call sites: launching a flight while still tracking something meant
 * `followTracked` dragged the camera back towards the old node every frame of the trip, and leaving the
 * spring pointed at the zoom the gesture had been heading for meant the view lurched the moment the flight
 * ended. Clearing all three in one place is what makes those states impossible rather than merely unlikely.
 */
function startFlight(path: readonly Cell[], fromHistory = false): boolean {
  const planned = planFlight(cam, tree, path, view);
  if (!planned) return false;
  flight = planned;
  flightFromHistory = fromHistory;
  // A flight ends with the target as the focus node, which carries the camera by itself. Holding a lock
  // through one would fight it every frame.
  tracked = null;
  acquired = false;
  input.cancelZoom();
  loop.wake();
  return true;
}

/**
 * Abandon a flight where it stands, leaving the camera exactly where the tween had got to.
 *
 * Resyncing the spring is not optional: `zTarget` still holds whatever the zoom was doing before the flight
 * took over, so simply dropping the flight handed the camera to a spring aimed somewhere else entirely and
 * the view snapped. That was true of every place that cleared `flight` by hand, which is why they all come
 * through here now.
 */
function cancelFlight(): void {
  flight = null;
  flightFromHistory = false;
  input.cancelZoom();
}

function travelTo(hit: PickResult): boolean {
  return startFlight(hit.path);
}

/**
 * THE WHEEL ZOOMS, and it zooms at the middle of the screen. See the note in pointer.ts for why the cursor
 * is the wrong anchor over a range this big.
 *
 * What this hook does is decide what the middle of the screen IS. Scrolling in with the cursor squarely on
 * something takes that thing as the destination: the view eases until it is centred, and from then on the
 * zoom converges on it. The wheel used to instead hand the whole gesture to a two-second flight whenever
 * the cursor was near anything small -- measured, 13% of the screen at galaxy zoom, to one of 283 different
 * stars -- so about one scroll in eight teleported you somewhere you had not asked to go.
 *
 * "Squarely on" means within the thing's own drawn glyph, not the fifteen-pixel assist radius that makes
 * four-pixel dots clickable. Scroll over the gaps and nothing is taken over; the view zooms where it is
 * pointing already.
 *
 * A WORLD IS NOT A GAP. Its face is drawn as one disc and its rim slots are a pixel wide, so almost nowhere
 * on it passes "squarely on" and, once the disc is wider than the viewport, nothing on the screen does at
 * all -- which left a scroll at a planet with nothing to aim at, descending into the mantle until the ground
 * clamp stopped it. So a point that is inside a body rather than beside it falls through to the ground under
 * it: see `nearestRimAt`. Only the zoom does this; the reticle keeps the strict test, because a mark drawn a
 * third of a screen from the cursor would be claiming something untrue about where the cursor is.
 */
input.onZoomIntent = (x, y) => {
  if (flight) return;

  // Squarely on something, and not already holding it: take it as the destination.
  const under = pick(x, y);
  if (under && Math.hypot(under.xPx - x, under.yPx - y) <= Math.max(3, under.rPx)) {
    if (!tracked || !samePath(under.path, tracked)) {
      tracked = under.path;
      acquired = false;
      return;
    }
  }

  // Nothing squarely under the cursor, but the cursor is in rock: the ground on that bearing is where
  // zooming in from here goes, and it is a real child rather than a direction to fall in.
  if (!under) {
    const ground = nearestRimAt(cam, tree, view, x, y);
    if (ground && !isSelfOrAncestor(ground.path)) {
      if (!tracked || !samePath(ground.path, tracked)) {
        tracked = ground.path;
        acquired = false;
      }
      return;
    }
  }

  /**
   * Holding something, settled on it, and it is still further away than anyone could scroll: fly.
   *
   * The threshold is deliberately high. A galaxy and one of its stars are 29 doublings apart, which is
   * about fifty notches of wheel -- a gap the wheel cannot reasonably cross, and the one the flight exists
   * for. Anything nearer than eight doublings is left to the wheel, because a flight is not a zoom and
   * substituting one for the other is what made this feel unpredictable in the first place. Whatever
   * happens, it can only ever go to the thing already marked in the middle of the screen.
   */
  if (!tracked || !acquired) return;
  const at = pick(view.w / 2, view.h / 2);
  if (!at || !samePath(at.path, tracked)) return;
  if (doublingsAway(at) > LOCKED_FLY_DOUBLINGS) travelTo(at);
};

/** Gap, in doublings, past which scrolling toward a thing you are holding becomes a flight instead. */
const LOCKED_FLY_DOUBLINGS = 8;

function samePath(a: readonly Cell[], b: readonly Cell[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.cx !== b[i]!.cx || a[i]!.cy !== b[i]!.cy) return false;
  }
  return true;
}

/** Fly to the ancestor at a given path depth. Used by the breadcrumb. */
function flyToDepth(depth: number): void {
  if (depth >= cam.node.path.length) return;
  startFlight(cam.node.path.slice(0, depth));
}

/** Cycle through the children of the focus node, flying to each. Also the accessibility story. */
let tabIndex = 0;
function tabToChild(backwards: boolean): void {
  const [nx, ny] = frameToNode(cam, cam.fx, cam.fy);
  const found = childrenNear(cam.node, nx, ny);
  if (found.length === 0) return;
  tabIndex = (tabIndex + (backwards ? -1 : 1) + found.length) % found.length;
  startFlight([...cam.node.path, found[tabIndex]!.cell]);
}

window.addEventListener('keydown', (e) => {
  /**
   * How far one press moves the view, IN PIXELS.
   *
   * It used to be a per-frame velocity of 60, which decayed to a travel of about 190 px -- and when the
   * fling became frame-rate independent the same 60 was handed to `flingBy`, which reads it as the distance
   * itself. That quietly cut two-thirds off every arrow key: crossing a 1600 px viewport went from six
   * presses to thirteen. These are the distances the old nudge actually covered.
   */
  const panStep = e.shiftKey ? 750 : 190;
  switch (e.key) {
    case '+':
    case '=':
      zoomKey(1, view.w / 2, view.h / 2);
      break;
    case '-':
    case '_':
      zoomKey(-1, view.w / 2, view.h / 2);
      break;
    // Q and E used to zoom at the cursor. Everything zooms at the middle of the screen now -- see the note
    // in pointer.ts -- so they are a second pair of zoom keys for whichever hand is already there.
    case 'q':
      zoomKey(1, view.w / 2, view.h / 2);
      break;
    case 'e':
      zoomKey(-1, view.w / 2, view.h / 2);
      break;
    case 'Backspace':
    case 'u':
      cancelFlight();
      tracked = null;
      ascend(cam, tree);
      input.cancelZoom();
      router.push(stateOf(cam, seed));
      break;
    /**
     * Escape is the brake: whatever the view was doing of its own accord, it stops doing it, and it stops
     * where it is rather than snapping back or completing the move. A two-second flight you did not mean to
     * start was previously something you had to sit through.
     *
     * Including the flight that has not begun yet: a single click waits a third of a second to find out
     * whether it is half of a double click, so the brake has to reach into that window too or it stops the
     * view and the queued click immediately launches it again.
     */
    case 'Escape':
      cancelFlight();
      input.cancelPendingClick();
      tracked = null;
      acquired = false;
      flingBy(input, 0, 0);
      break;
    case 'Enter':
    case 'f': {
      const hit = pick(input.hoverX, input.hoverY);
      if (hit) travelTo(hit);
      break;
    }
    case 'Tab':
      tabToChild(e.shiftKey);
      break;
    case ' ':
      motion = !motion;
      break;
    case 'b':
      // Keep this view. The one keyboard verb the wordless chrome has, and the rail's plus tile does the same.
      bookmarks.add(stateOf(cam, seed), thumbnail());
      break;
    case '`':
      // The numbers, for whoever is working on the renderer rather than looking at the universe.
      hud.setDebug(!hud.debugVisible());
      loop.wake();
      break;
    case 'Home':
      cancelFlight();
      applyState({ path: [], k: 0, cx: 0, cy: 0, fx: 0, fy: 0, z: ROOT_Z });
      router.push(stateOf(cam, seed));
      break;
    case 'ArrowLeft':
    case 'a':
      nudge(panStep, 0);
      break;
    case 'ArrowRight':
    case 'd':
      nudge(-panStep, 0);
      break;
    case 'ArrowUp':
    case 'w':
      nudge(0, panStep);
      break;
    case 'ArrowDown':
    case 's':
      nudge(0, -panStep);
      break;
    default:
      return;
  }
  e.preventDefault();
  loop.wake();
});

function zoomKey(dz: number, ax: number, ay: number): void {
  cancelFlight();
  input.anchorX = ax;
  input.anchorY = ay;
  // Through `zoomBy`, so a key held down against the top or the bottom of the ladder cannot walk the target
  // off past where the camera is able to follow it.
  input.zoomBy(dz);
}

function nudge(dx: number, dy: number): void {
  cancelFlight();
  tracked = null;
  // Asked for as a distance in pixels: the arrow keys mean "move the view about this far", and how the
  // inertia gets it there is the input layer's business.
  flingBy(input, dx, dy);
}

// Respect a stated preference for less movement: orbits and clouds hold still.
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
if (reduceMotion?.matches) motion = false;
reduceMotion?.addEventListener?.('change', (e) => {
  motion = !e.matches;
  loop.wake();
});

window.addEventListener('resize', resize);
resize();
updateFocus(cam, tree, view);

/**
 * Debug and automation hooks. `diveStep` steers towards an occupied child before zooming, because
 * zooming into empty void is legitimate behaviour but never reaches the ground.
 */
function diveStep(dz = 0.5): void {
  aimStep();
  zoomStep(dz);
}

/**
 * Re-centre on the nearest child WITHOUT zooming.
 *
 * Split out from `diveStep` for the pop detector, which measures how much the picture changes between two
 * frames and compares that against the change the zoom alone accounts for. Zoom is anchored at the screen
 * centre, so a pure zoom step transforms the image by exactly a scale about the centre and the residual is
 * the pop. Re-aiming translates as well, which the model cannot subtract -- so the harness has to be able to
 * ask for the two separately and skip the frame after an aim.
 */
function aimStep(): void {
  cancelFlight();
  const [nx, ny] = frameToNode(cam, cam.fx, cam.fy);
  const ref = childNear(cam.node, nx, ny);
  if (!ref) return;
  const [fx, fy] = nodeToFrame(cam, ref.ox, ref.oy);
  cam.fx = fx;
  cam.fy = fy;
}

/** Zoom, and nothing else. Every rebase it triggers is invisible to the renderer by construction. */
function zoomStep(dz: number): void {
  cancelFlight();
  cam.z += dz;
  updateFocus(cam, tree, view);
  input.cancelZoom();
  loop.wake();
}

Object.assign(window as unknown as Record<string, unknown>, {
  __cam: cam,
  __tree: tree,
  __rimChildren: rimChildren,
  __houses: () => houseCount(),
  __isInhabited: isInhabited,
  __makeChild: makeChild,
  /**
   * Step to a sibling planet until one is habitable enough for anyone to live on.
   *
   * For the review harness. Only about one world in eight is habitable, and diving straight down picks a planet by
   * where its orbit happens to be, so the surface shots kept landing on five-hundred-kelvin cinders -- honest
   * places, and places with no buildings, no language and no name for themselves.
   */
  __seekHabitable: (): boolean => {
    loop.wake();
    const here = cam.node.ground?.traits;
    if (here && here.habitability >= HABITABLE_THRESHOLD) return true;
    const parent = tree.parentOf(cam.node);
    if (!parent || parent.kind !== 'system') return false;
    for (const ref of orbitalChildren(parent)) {
      const candidate = makeChild(parent, ref);
      if ((candidate.ground?.traits.habitability ?? 0) < HABITABLE_THRESHOLD) continue;
      cam.node = candidate;
      cam.k = 0;
      cam.cx = 0;
      cam.cy = 0;
      cam.fx = 0;
      cam.fy = 0;
      return true;
    }
    return false;
  },
  /** One line about the ground under the camera, for the review harnesses. */
  __describeHere: (): string => {
    const g = cam.node.ground;
    if (!g) return '';
    const c = climateAt(g.planetId, g.traits, g.theta);
    const sun = sunAt(g.planetId, g.traits, g.theta, simTime());
    return (
      `${g.traits.label} / ${c.biome} ${c.temp.toFixed(0)}K wet ${c.moisture.toFixed(2)} / ` +
      `sun ${sun.elevation.toFixed(2)} / ${describeBiosphere(biosphereOf(g.planetId))}`
    );
  },
  /**
   * Advance the frozen clock until the star is well up at the camera's own angle round the rim.
   *
   * For the review harness. Half of every world is in night at any instant and a night shot tells you nothing
   * about the colours, so this walks the clock in eighths of a day and stops at the brightest hour it finds.
   */
  __seekDaylight: (): number => {
    const g = cam.node.ground;
    if (!g) return 0;
    let best = 0;
    let bestElev = -2;
    const day = g.traits.dayLength * 3600;
    for (let i = 0; i < 24; i++) {
      const t = (i / 24) * day;
      const e = sunAt(g.planetId, g.traits, g.theta, t).elevation;
      if (e > bestElev) {
        bestElev = e;
        best = t;
      }
    }
    setSimTime(best);
    loop.wake();
    return bestElev;
  },
  /**
   * Step sideways along the rim, slot by slot, until the ground under the camera is somewhere people live.
   *
   * For the review harness. Diving straight down lands wherever the geometry puts it, and most of most worlds is
   * ocean, so every surface screenshot came back as sea bed under deep water -- an honest picture of a real place and
   * useless for looking at buildings. Nudging `fx` does not work: the camera can sit outside its own focus node
   * without `updateFocus` doing anything about it, so the focus never changes and the search never moves. This
   * rebases properly, one slot per step, landing at the neighbour's centre.
   */
  __seekInhabited: (limit = 800): boolean => {
    // Waking is not optional. Teleporting the camera without it leaves the render loop asleep, so the next
    // screenshot is the frame from BEFORE the jump -- which read as houses drawn in the wrong place.
    loop.wake();
    for (let i = 0; i < limit; i++) {
      if (isInhabited(cam.node)) return true;
      const parent = tree.parentOf(cam.node);
      const ref = tree.refOf(cam.node);
      if (!parent || !ref) return false;
      const next = rimChild(parent, ref.cell.cx + 1);
      if (!next) return false;
      cam.node = makeChild(parent, next);
      cam.k = 0;
      cam.cx = 0;
      cam.cy = 0;
      cam.fx = 0;
      cam.fy = 0;
    }
    return isInhabited(cam.node);
  },
  /** The focus node's ground line sampled across its own frame, plus its water line. Debug only. */
  __plate: () => {
    const g = cam.node.ground;
    if (!g) return null;
    const line: number[] = [];
    for (let i = 0; i <= 8; i++) line.push(groundHeightAt(g, -1 + i / 4, 16));
    return { theta: g.theta, span: g.span, baseRadius: g.baseRadius, sea: seaHeightOf(g), line };
  },
  __loop: loop,
  __input: input,
  __diveStep: diveStep,
  __aimStep: aimStep,
  __zoomStep: zoomStep,
  /** Freeze the clock at a fixed instant so screenshots and perf runs are reproducible. */
  __freezeTime: (seconds: number): void => {
    motion = false;
    setSimTime(seconds);
    loop.wake();
  },
  /**
   * Diagnostic for the navigation check: what a click at this point would resolve to, and the flight it
   * would launch. Through `pick` rather than `pickAt`, or it reports a target where a click does nothing:
   * standing on a region, every point that misses a settlement climbs to the planet and answers with the
   * region you are already in, which `pick` rejects and a click therefore ignores.
   */
  __probeClick: (x: number, y: number) => {
    const hit = pick(x, y);
    if (!hit) return { hit: null, flight: null };
    const planned = planFlight(cam, tree, hit.path, view);
    return {
      hit: { path: hit.path.map((c) => `${c.cx}.${c.cy}`).join('/'), kind: hit.kind },
      flight: planned
        ? { depth: planned.depth, az: planned.az, bz: planned.bz, zOut: planned.zOut, dur: planned.duration }
        : null,
    };
  },
  /** Show the renderer's numbers. The screenshot harness turns them on to assert the precision invariant. */
  __setDebug: (on: boolean): void => {
    hud.setDebug(on);
    loop.wake();
  },
  /** Double-click equivalent: lock the view onto whatever is at this point. */
  __lockOn: (x: number, y: number): void => {
    input.onDoubleClick?.(x, y);
  },
  /** The path the view is currently locked onto, or null. */
  __tracked: () => (tracked ? tracked.map((c) => `${c.cx}.${c.cy}`).join('/') : null),
  /** Make the renderer report every mark it draws, including scattered stars. See `setRecordAllHits`. */
  __recordAllHits: (on: boolean): void => {
    setRecordAllHits(on);
    loop.wake();
  },
  /** What a click at this point would resolve to. Used by the navigation checks. */
  __pick: (x: number, y: number) => {
    const hit = pick(x, y);
    if (!hit) return null;
    return {
      kind: hit.kind,
      path: hit.path.map((c) => `${c.cx}.${c.cy}`).join('/'),
      x: hit.xPx,
      y: hit.yPx,
      r: hit.rPx,
    };
  },
  /** What the last frame considered clickable, for the end-to-end navigation check. */
  __hits: () =>
    lastHits.map((h) => ({
      path: h.path.map((c) => `${c.cx}.${c.cy}`).join('/'),
      kind: h.kind,
      x: h.xPx,
      y: h.yPx,
      r: h.rPx,
      trueR: h.trueRPx,
    })),
  __renderOnce: (): number => {
    tree.beginFrame();
    const t0 = performance.now();
    const stats = render(ctx, cam, tree, view);
    const ms = performance.now() - t0;
    (window as unknown as Record<string, unknown>).__lastDraws = stats.draws;
    (window as unknown as Record<string, unknown>).__lastStats = stats;
    return ms;
  },
});
