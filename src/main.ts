import { createCamera, frameToNode, nodeToFrame, pxPerUnit, type View } from './camera/camera.ts';
import { R_ENTER } from './camera/rebase.ts';
import { commonDepth, planFlight, positionInAncestor, stepFlight, type Flight } from './camera/flyto.ts';
import { ascend, updateFocus } from './camera/rebase.ts';
import { setSimTime } from './core/clock.ts';
import { startLoop } from './core/loop.ts';
import { attachInput, createInput, stepInput } from './input/pointer.ts';
import {
  displayName,
  drawHover,
  drawLock,
  hitTest,
  hoverLabel,
  render,
  scatterHitAt,
  setRecordAllHits,
  type HitEntry,
} from './render/renderer.ts';
import { childNear, childrenNear, type Cell } from './universe/node.ts';
import { LEVELS, ROOT_KIND } from './universe/schema.ts';
import { Tree } from './universe/tree.ts';
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
  if (state.path) {
    const planned = planFlight(cam, tree, state.path, view);
    if (planned) {
      flight = planned;
      flightFromHistory = true;
      loop.wake();
      return;
    }
  }
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
  input.zTarget = cam.z;
  updateFocus(cam, tree, view);
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
      flight = null;
      flightFromHistory = false;
      input.zTarget = cam.z;
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
    updateFocus(cam, tree, view);
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
    if (at && node && samePath(at.path, tracked)) drawLock(ctx, at, displayName(node, tree));
  }

  // Reticle under the cursor, so it is visible that things can be travelled to at all.
  if (!flight && !input.dragging) {
    const hovered = pick(input.hoverX, input.hoverY);
    if (hovered && hovered.path.length > cam.node.path.length) {
      const node = tree.resolve(hovered.path);
      if (node) drawHover(ctx, hovered, hoverLabel(node, tree), performance.now() / 1000);
      canvas.style.cursor = 'pointer';
    } else {
      canvas.style.cursor = 'crosshair';
    }
  }

  hud.update(cam, stats, loop.fps, loop.frameMs);
  (window as unknown as Record<string, unknown>).__lastDraws = stats.draws;
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
  flight = null;
  tracked = hit ? hit.path : null;
  acquired = false;
  input.cancelZoom();
  input.zTarget = cam.z;
  loop.wake();
};

/**
 * What is under a screen point.
 *
 * The frame's hit list covers everything drawn at true scale, and the analytic lookup covers a galaxy's
 * few thousand catalogued stars, which are too numerous to record. The star wins when both match,
 * because it is the deeper, more specific thing.
 */
function pick(x: number, y: number): HitEntry | null {
  const hit = scatterHitAt(cam, view, x, y) ?? hitTest(lastHits, x, y);
  // The focus node and its ancestors fill most of the screen, so they win almost every pick made in the
  // empty space between their children. Travelling to where you already are is a two-second flight that
  // lands exactly where it started, which reads as the click having gone wrong. Backspace rises instead.
  if (hit && hit.path.length <= cam.node.path.length) return null;
  return hit;
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


function travelTo(hit: HitEntry): boolean {
  const planned = planFlight(cam, tree, hit.path, view);
  if (!planned) return false;
  // A flight is a different way of saying "put me there", and it ends with the target as the focus node --
  // which carries the camera by itself. Holding a lock through one would fight it every frame.
  tracked = null;
  flight = planned;
  flightFromHistory = false;
  input.cancelZoom();
  loop.wake();
  return true;
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
  const planned = planFlight(cam, tree, cam.node.path.slice(0, depth), view);
  if (planned) {
    flight = planned;
    flightFromHistory = false;
    loop.wake();
  }
}

/** Cycle through the children of the focus node, flying to each. Also the accessibility story. */
let tabIndex = 0;
function tabToChild(backwards: boolean): void {
  const [nx, ny] = frameToNode(cam, cam.fx, cam.fy);
  const found = childrenNear(cam.node, nx, ny);
  if (found.length === 0) return;
  tabIndex = (tabIndex + (backwards ? -1 : 1) + found.length) % found.length;
  const planned = planFlight(cam, tree, [...cam.node.path, found[tabIndex]!.cell], view);
  if (planned) {
    flight = planned;
    flightFromHistory = false;
    loop.wake();
  }
}

window.addEventListener('keydown', (e) => {
  const panStep = e.shiftKey ? 240 : 60;
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
      flight = null;
      tracked = null;
      ascend(cam, tree);
      input.zTarget = cam.z;
      router.push(stateOf(cam, seed));
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
    case '`':
      // The numbers, for whoever is working on the renderer rather than looking at the universe.
      hud.setDebug(!hud.debugVisible());
      loop.wake();
      break;
    case 'Home':
      flight = null;
      tracked = null;
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
  flight = null;
  flightFromHistory = false;
  input.anchorX = ax;
  input.anchorY = ay;
  input.zTarget += dz;
}

function nudge(dx: number, dy: number): void {
  flight = null;
  tracked = null;
  flightFromHistory = false;
  input.velX = dx * 0.25;
  input.velY = dy * 0.25;
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
  flight = null;
  const [nx, ny] = frameToNode(cam, cam.fx, cam.fy);
  const ref = childNear(cam.node, nx, ny);
  if (ref) {
    const [fx, fy] = nodeToFrame(cam, ref.ox, ref.oy);
    cam.fx = fx;
    cam.fy = fy;
  }
  cam.z += dz;
  input.zTarget = cam.z;
  updateFocus(cam, tree, view);
  loop.wake();
}

Object.assign(window as unknown as Record<string, unknown>, {
  __cam: cam,
  __tree: tree,
  __loop: loop,
  __input: input,
  __diveStep: diveStep,
  /** Freeze the clock at a fixed instant so screenshots and perf runs are reproducible. */
  __freezeTime: (seconds: number): void => {
    motion = false;
    setSimTime(seconds);
    loop.wake();
  },
  /** What the last frame considered clickable, for the end-to-end navigation check. */
  /** Diagnostic for the navigation check: what a click at this point would resolve to. */
  __probeClick: (x: number, y: number) => {
    const hit = hitTest(lastHits, x, y);
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
    return ms;
  },
});
