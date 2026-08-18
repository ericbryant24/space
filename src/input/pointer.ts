import { panByScreen, zoomAt, type Camera, type View } from '../camera/camera.ts';

export interface InputState {
  /** Target zoom, approached by a critically damped spring so trackpad jitter does not show. */
  zTarget: number;
  anchorX: number;
  anchorY: number;
  hoverX: number;
  hoverY: number;
  dragging: boolean;
  velX: number;
  velY: number;
  onClick: ((x: number, y: number) => void) | null;
  onDoubleClick: ((x: number, y: number) => void) | null;
  /** Fired when the user drags the view sideways. Pinch-zoom does not count: zooming is not looking away. */
  onPan: (() => void) | null;
  /**
   * Called on every zoom-in gesture. Lets navigation decide whether the cursor is over something worth
   * travelling to, rather than zooming into the gap beside it.
   */
  onZoomIntent: ((x: number, y: number, dz: number) => boolean) | null;
  /** Set by navigation to cancel an in-flight spring, e.g. when a gesture becomes a flight. */
  cancelZoom(): void;
}

const ZOOM_STIFFNESS = 22;
/**
 * Doublings per pixel of wheel delta. At 0.0022 a notch was 0.22 doublings, so crossing the ladder took
 * roughly 350 notches of scrolling -- which is most of why the zoom felt like hard work.
 */
const WHEEL_SCALE = 0.0048;
const MAX_WHEEL_STEP = 0.9;
const DRAG_DECAY = 0.92;

export function createInput(cam: Camera): InputState {
  return {
    zTarget: cam.z,
    anchorX: 0,
    anchorY: 0,
    hoverX: 0,
    hoverY: 0,
    dragging: false,
    velX: 0,
    velY: 0,
    onClick: null,
    onDoubleClick: null,
    onPan: null,
    onZoomIntent: null,
    cancelZoom(): void {
      this.zTarget = cam.z;
    },
  };
}

export function attachInput(
  canvas: HTMLCanvasElement,
  cam: Camera,
  input: InputState,
  view: () => View,
  wake: () => void,
): void {
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;
  let moved = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;

  const local = (e: PointerEvent | WheelEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // deltaMode differs wildly across browsers; normalise to pixels before doing anything.
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= view().h;
      const dz = Math.max(-MAX_WHEEL_STEP, Math.min(MAX_WHEEL_STEP, -dy * WHEEL_SCALE));
      const p = local(e);
      // Latch the anchor for the whole gesture including its inertial tail, so the spring does not
      // slide off the point the user aimed at.
      input.anchorX = p.x;
      input.anchorY = p.y;
      // Navigation gets first refusal: if the cursor is over something far too small to zoom into by
      // hand, it takes the gesture and flies there instead.
      if (dz > 0 && input.onZoomIntent?.(p.x, p.y, dz)) {
        wake();
        return;
      }
      input.zTarget += dz;
      wake();
    },
    { passive: false },
  );

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      input.dragging = true;
      lastX = p.x;
      lastY = p.y;
      downX = p.x;
      downY = p.y;
      moved = 0;
      input.velX = 0;
      input.velY = 0;
    } else if (pointers.size === 2) {
      pinchDist = spread(pointers);
    }
    wake();
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    input.hoverX = p.x;
    input.hoverY = p.y;
    if (!pointers.has(e.pointerId)) {
      wake();
      return;
    }
    pointers.set(e.pointerId, p);

    if (pointers.size >= 2) {
      const d = spread(pointers);
      if (pinchDist > 0 && d > 0) {
        const c = centroid(pointers);
        input.anchorX = c.x;
        input.anchorY = c.y;
        // Fingers already smooth the motion, so pinch bypasses the spring and applies directly.
        zoomAt(cam, c.x, c.y, Math.log2(d / pinchDist), view());
        input.zTarget = cam.z;
      }
      pinchDist = d;
      wake();
      return;
    }

    const dx = p.x - lastX;
    const dy = p.y - lastY;
    lastX = p.x;
    lastY = p.y;
    moved += Math.abs(dx) + Math.abs(dy);
    if (dx !== 0 || dy !== 0) input.onPan?.();
    panByScreen(cam, dx, dy);
    input.velX = dx;
    input.velY = dy;
    wake();
  });

  /**
   * A single click travels to a thing; a double click locks the view onto it. So the single click has to
   * WAIT to find out which it is -- fire it immediately and every double click also launches a flight that
   * has to be cancelled a moment later, and the view lurches. A flight takes a couple of seconds anyway,
   * so a fifth of a second of held breath before it starts is not something you can feel.
   */
  const DOUBLE_MS = 210;
  const DOUBLE_SLOP_PX = 24;
  let pendingClick: ReturnType<typeof setTimeout> | null = null;
  let lastTapAt = -Infinity;
  let lastTapX = 0;
  let lastTapY = 0;

  const release = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) {
      input.dragging = false;
      const p = local(e);
      const tapped = moved < 6 && Math.abs(p.x - downX) < 6 && Math.abs(p.y - downY) < 6;
      if (tapped) {
        const now = performance.now();
        const second =
          now - lastTapAt < DOUBLE_MS &&
          Math.abs(p.x - lastTapX) < DOUBLE_SLOP_PX &&
          Math.abs(p.y - lastTapY) < DOUBLE_SLOP_PX;
        if (second) {
          if (pendingClick !== null) clearTimeout(pendingClick);
          pendingClick = null;
          lastTapAt = -Infinity;
          input.onDoubleClick?.(p.x, p.y);
        } else {
          lastTapAt = now;
          lastTapX = p.x;
          lastTapY = p.y;
          if (pendingClick !== null) clearTimeout(pendingClick);
          pendingClick = setTimeout(() => {
            pendingClick = null;
            input.onClick?.(p.x, p.y);
            wake();
          }, DOUBLE_MS);
        }
      }
    }
    wake();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('dblclick', (e) => e.preventDefault());
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

/**
 * Advance the zoom spring and drag inertia. Returns true while still in motion, which is what keeps
 * the loop awake.
 */
export function stepInput(cam: Camera, input: InputState, view: View, dt: number): boolean {
  let moving = false;

  const gap = input.zTarget - cam.z;
  if (Math.abs(gap) > 1e-6) {
    const dz = gap * Math.min(1, ZOOM_STIFFNESS * dt);
    zoomAt(cam, input.anchorX, input.anchorY, dz, view);
    moving = true;
  } else if (cam.z !== input.zTarget) {
    zoomAt(cam, input.anchorX, input.anchorY, gap, view);
  }

  if (!input.dragging && (Math.abs(input.velX) > 0.05 || Math.abs(input.velY) > 0.05)) {
    panByScreen(cam, input.velX, input.velY);
    input.velX *= DRAG_DECAY;
    input.velY *= DRAG_DECAY;
    moving = true;
  }

  return moving;
}

function spread(pointers: Map<number, { x: number; y: number }>): number {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function centroid(pointers: Map<number, { x: number; y: number }>): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const p of pointers.values()) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pointers.size, y: y / pointers.size };
}
