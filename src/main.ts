import { createCamera, frameToNode, nodeToFrame, type View } from './camera/camera.ts';
import { planFlight, stepFlight, type Flight } from './camera/flyto.ts';
import { ascend, updateFocus } from './camera/rebase.ts';
import { startLoop } from './core/loop.ts';
import { attachInput, createInput, stepInput } from './input/pointer.ts';
import { hitTest, render, type HitEntry } from './render/renderer.ts';
import { anchorCellAt, childAt, type Cell } from './universe/node.ts';
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
const hud = createHud(overlay, (depth) => flyToDepth(depth));

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

const loop = startLoop((dt) => {
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
  hud.update(cam, stats, loop.fps, loop.frameMs);
  lastHits = stats.hits;
  (window as unknown as Record<string, unknown>).__lastDraws = stats.draws;
  // Keep running while sprites are still resolving, otherwise the view would sleep half-baked.
  return moving || stats.spritesPending;
});

attachInput(canvas, cam, input, () => view, () => loop.wake());

input.onClick = (x, y) => {
  const hit = hitTest(lastHits, x, y);
  if (!hit) return;
  const planned = planFlight(cam, tree, hit.path, view);
  if (planned) {
    flight = planned;
    flightFromHistory = false;
    loop.wake();
  }
};

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
  const level = LEVELS[cam.node.kind];
  if (!level.child) return;
  const [nx, ny] = frameToNode(cam, cam.fx, cam.fy);
  const here = anchorCellAt(cam.node, nx, ny);
  const found: Cell[] = [];
  for (let ring = 0; ring <= 4 && found.length < 24; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const cell = { cx: here.cx + dx, cy: here.cy + dy };
        if (childAt(cam.node, cell)) found.push(cell);
      }
    }
  }
  if (found.length === 0) return;
  tabIndex = (tabIndex + (backwards ? -1 : 1) + found.length) % found.length;
  const planned = planFlight(cam, tree, [...cam.node.path, found[tabIndex]!], view);
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
    case 'q':
      zoomKey(1, input.hoverX, input.hoverY);
      break;
    case 'e':
      zoomKey(-1, input.hoverX, input.hoverY);
      break;
    case 'Backspace':
    case 'u':
      flight = null;
      ascend(cam, tree);
      input.zTarget = cam.z;
      router.push(stateOf(cam, seed));
      break;
    case 'Enter':
    case 'f': {
      const hit = hitTest(lastHits, input.hoverX, input.hoverY);
      if (hit) {
        const planned = planFlight(cam, tree, hit.path, view);
        if (planned) {
          flight = planned;
          flightFromHistory = false;
        }
      }
      break;
    }
    case 'Tab':
      tabToChild(e.shiftKey);
      break;
    case 'Home':
      flight = null;
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
  flightFromHistory = false;
  input.velX = dx * 0.25;
  input.velY = dy * 0.25;
}

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
  let ref = childAt(cam.node, anchorCellAt(cam.node, nx, ny));
  if (!ref) {
    const here = anchorCellAt(cam.node, nx, ny);
    outer: for (let ring = 1; ring <= 6; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const cand = childAt(cam.node, { cx: here.cx + dx, cy: here.cy + dy });
          if (cand) {
            ref = cand;
            break outer;
          }
        }
      }
    }
  }
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
  __hits: () =>
    lastHits.map((h) => ({
      path: h.path.map((c) => `${c.cx}.${c.cy}`).join('/'),
      kind: h.kind,
      x: h.xPx,
      y: h.yPx,
      r: h.rPx,
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
