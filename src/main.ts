import { createCamera, frameToNode, nodeToFrame, zoomAt, type View } from './camera/camera.ts';
import { updateFocus } from './camera/rebase.ts';
import { startLoop } from './core/loop.ts';
import { attachInput, createInput, stepInput } from './input/pointer.ts';
import { hitTest, render } from './render/renderer.ts';
import { anchorCellAt, childAt } from './universe/node.ts';
import { LEVELS, ROOT_KIND } from './universe/schema.ts';
import { Tree } from './universe/tree.ts';
import { createHud } from './ui/hud.ts';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;
const overlay = document.getElementById('overlay') as HTMLElement;

const seed = readSeed();
const tree = new Tree(seed);
// Start with the root frame mid-window, so many clusters are on screen at once.
const cam = createCamera(tree.root, 8 - LEVELS[ROOT_KIND].logSpan);
const input = createInput(cam);
const hud = createHud(overlay);

let view: View = { w: 0, h: 0 };
let dpr = 1;

function resize(): void {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  view = { w: canvas.clientWidth, h: canvas.clientHeight };
  canvas.width = Math.round(view.w * dpr);
  canvas.height = Math.round(view.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  loop.wake();
}

const loop = startLoop((dt) => {
  const moving = stepInput(cam, input, view, dt);
  updateFocus(cam, tree, view);
  tree.beginFrame();
  const stats = render(ctx, cam, tree, view);
  hud.update(cam, stats, loop.fps, loop.frameMs);
  lastHits = stats.hits;
  (window as unknown as Record<string, unknown>).__lastDraws = stats.draws;
  return moving;
});

let lastHits: ReturnType<typeof render>['hits'] = [];

attachInput(canvas, cam, input, () => view, () => loop.wake());

input.onClick = (x, y) => {
  const hit = hitTest(lastHits, x, y);
  if (!hit) return;
  // M0: nudge the zoom towards whatever was clicked. The eased fly-to along the focus stack lands
  // with the navigation milestone.
  input.anchorX = hit.xPx;
  input.anchorY = hit.yPx;
  input.zTarget += 1.5;
  loop.wake();
};

window.addEventListener('keydown', (e) => {
  const panStep = e.shiftKey ? 240 : 60;
  switch (e.key) {
    case '+':
    case '=':
      input.anchorX = view.w / 2;
      input.anchorY = view.h / 2;
      input.zTarget += 1;
      break;
    case '-':
    case '_':
      input.anchorX = view.w / 2;
      input.anchorY = view.h / 2;
      input.zTarget -= 1;
      break;
    case 'q':
      input.anchorX = input.hoverX;
      input.anchorY = input.hoverY;
      input.zTarget += 1;
      break;
    case 'e':
      input.anchorX = input.hoverX;
      input.anchorY = input.hoverY;
      input.zTarget -= 1;
      break;
    case 'Home':
      cam.node = tree.root;
      cam.k = 0;
      cam.cx = 0;
      cam.cy = 0;
      cam.fx = 0;
      cam.fy = 0;
      cam.z = 8 - LEVELS[ROOT_KIND].logSpan;
      input.zTarget = cam.z;
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

function nudge(dx: number, dy: number): void {
  input.velX = dx * 0.25;
  input.velY = dy * 0.25;
}

function readSeed(): number {
  const m = /(?:^|[#&])s=([0-9a-z]+)/i.exec(location.hash);
  return m ? parseInt(m[1]!, 36) >>> 0 : 0x51ace;
}

window.addEventListener('resize', resize);
resize();

// Deliberate zoom-out clamp check on boot: the invariant must already hold before the first frame.
zoomAt(cam, view.w / 2, view.h / 2, 0, view);
updateFocus(cam, tree, view);

/**
 * Debug/automation hooks. `diveStep` is what the screenshot harness drives: it steers towards an
 * occupied child before zooming, because zooming into empty void is legitimate behaviour but never
 * reaches the ground. Note it moves BOTH cam.z and the spring target, otherwise the spring hauls the
 * camera straight back.
 */
function diveStep(dz = 0.5): void {
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
});
