import { Z_MAX, panByScreen, zoomAt, type Camera, type View } from '../camera/camera.ts';
import { R_ASCEND } from '../camera/rebase.ts';
import { LEVELS, ROOT_KIND } from '../universe/schema.ts';

export interface InputState {
  /**
   * Target zoom, approached by a critically damped spring so trackpad jitter does not show.
   *
   * ALWAYS INSIDE [Z_MIN, Z_MAX]. Never add to this directly -- use `zoomBy`, which clamps. See `clampZ`.
   */
  zTarget: number;
  anchorX: number;
  anchorY: number;
  hoverX: number;
  hoverY: number;
  dragging: boolean;
  /** Fling velocity in pixels per SECOND, so a fling travels the same distance at any frame rate. */
  velX: number;
  velY: number;
  onClick: ((x: number, y: number) => void) | null;
  onDoubleClick: ((x: number, y: number) => void) | null;
  /** Fired when the user drags the view sideways. Pinch-zoom does not count: zooming is not looking away. */
  onPan: (() => void) | null;
  /**
   * Called ONCE per zoom-in gesture, with the point the gesture was aimed at. Lets navigation decide
   * whether that point is over something worth travelling to, rather than zooming into the gap beside it.
   *
   * Once per gesture, not once per event: a wheel gesture is thirty events and a pinch is a hundred, and
   * taking over what the view is centred on is a decision, not a rate. Firing it per event meant a single
   * flick re-decided the destination thirty times, each one able to hand the whole gesture to a two-second
   * flight. A gesture ends when the events stop for GESTURE_IDLE_MS, or when the fingers lift.
   *
   * `anchored` says the gesture already knows where it is going in the plane, which a PINCH does and a wheel
   * does not. Two fingers name a point continuously and hold it under themselves; a wheel notch is a discrete
   * step with nothing to converge on, which is the whole reason this callback exists. So an anchored gesture
   * must not be allowed to take over what the view is centred on -- when it did, finishing a pinch dragged the
   * view sixteen pixels onto whatever star happened to be near the middle, which is the pinch complaint this
   * project has already answered once. What an anchored gesture still needs is the other half: over a planet's
   * rock nothing resolves under the fingers at all, and without a slot to aim at a pinch cannot reach the
   * ground. Naming that is not taking over; it is answering a question the fingers cannot.
   */
  onZoomIntent: ((x: number, y: number, dz: number, anchored: boolean) => void) | null;
  /** Move the zoom target by `dz` doublings, clamped to the reachable range. The only way it may grow. */
  zoomBy(dz: number): void;
  /** Set by navigation to cancel an in-flight spring, e.g. when a gesture becomes a flight. */
  cancelZoom(): void;
  /**
   * Throw away a click that is still waiting to find out whether it is half of a double click.
   *
   * A single click cannot fire until DOUBLE_MS has passed without a second one -- see `release` -- so for a
   * third of a second there is a flight pending that nothing outside this module could reach. Escape is the
   * brake: press it in that window and it stopped whatever was moving and then the timer started a flight
   * anyway, which is precisely the thing the brake had just been used to prevent.
   */
  cancelPendingClick(): void;
}

const ZOOM_STIFFNESS = 22;

/**
 * The top of the zoom, derived rather than declared.
 *
 * `updateFocus` stops zoom-out at the root by parking the root frame at exactly R_ASCEND pixels, so there
 * is no z below this that the camera can reach -- and Z_MAX is the same thing at the other end.
 *
 * THE SPRING MUST BE CLAMPED TO THE SAME RANGE THE CAMERA IS. It is not cosmetic: an unclamped target sits
 * somewhere the camera can never arrive at, so the gap never closes, so `stepInput` reports motion forever
 * and the rAF loop never sleeps. Scrolling into the floor left the tab pinned at 60 fps indefinitely.
 */
export const Z_MIN = Math.log2(R_ASCEND) - LEVELS[ROOT_KIND].logSpan;

export function clampZ(z: number): number {
  return z < Z_MIN ? Z_MIN : z > Z_MAX ? Z_MAX : z;
}

/**
 * A NOTCHED WHEEL AND A TRACKPAD ARE DIFFERENT INSTRUMENTS.
 *
 * A mouse wheel delivers one large, quantised delta per detent -- 100 px in most browsers, 120 in some,
 * three lines in others -- at whatever rate the hand can turn it. A trackpad delivers a dense stream of
 * small ones. Multiplying both by one gain gets exactly one of them right: a per-pixel gain that makes the
 * wheel feel decisive makes a trackpad bolt across the ladder, and one tuned for the trackpad makes the
 * wheel feel like winding a handle.
 *
 * So the wheel is quantised back into notches -- one event, one notch, whatever number the browser chose to
 * put in it -- and the trackpad keeps its per-pixel gain, at a smaller value than a single scale could
 * afford.
 */
const NOTCH_STEP = 0.55;
const SMOOTH_SCALE = 0.0032;
const MAX_WHEEL_STEP = 0.9;
/** Below this, in pixels, a delta is too small to have come from a detent. */
const NOTCH_MIN_PX = 40;
/** How far apart wheel magnitudes may be and still count as regular. A wheel repeats itself; a hand does not. */
const NOTCH_SPREAD = 0.25;

/**
 * A trackpad pinch arrives as wheel events with ctrlKey set, and the browser sends a very small delta for
 * it -- single pixels for a gesture that spans half the trackpad. Without this a pinch on a Mac barely
 * moved, which read as pinch-zoom simply not working.
 */
const PINCH_GAIN = 3.5;

/** Gap after which the next zoom event starts a fresh gesture. */
const GESTURE_IDLE_MS = 260;

/**
 * Fling decay per second, and the speed below which a fling has stopped.
 *
 * Per SECOND, because the decay used to be per frame: 0.92 a frame is a graceful glide at 60 Hz and a
 * dead stop at 120, and the fling travelled twice as far on the slower display. Both numbers are chosen to
 * match how the per-frame version felt at 60 Hz -- 0.92^60 is very nearly e^-5.
 */
const FLING_DECAY = 5;
const FLING_MIN_PX_PER_S = 6;
/** Time constant of the velocity average. Short enough to follow a flick, long enough to ignore jitter. */
const VELOCITY_TAU = 0.045;
/** A finger that has not moved for this long is not throwing anything, however fast it was moving before. */
const STILL_MS = 90;

export function createInput(cam: Camera): InputState {
  return {
    zTarget: clampZ(cam.z),
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
    zoomBy(dz: number): void {
      this.zTarget = clampZ(this.zTarget + dz);
    },
    cancelZoom(): void {
      this.zTarget = clampZ(cam.z);
    },
    cancelPendingClick(): void {
      // Nothing can be pending until `attachInput` installs the timer that owns it, and it replaces this.
    },
  };
}

/**
 * Throw the view by a given number of pixels, as if flung.
 *
 * The distance a fling covers is velocity / decay, so this is the inverse: it lets the keyboard nudge ask
 * for a distance in pixels without knowing what the decay constant is.
 */
export function flingBy(input: InputState, dxPx: number, dyPx: number): void {
  input.velX = dxPx * FLING_DECAY;
  input.velY = dyPx * FLING_DECAY;
}

export function attachInput(
  canvas: HTMLCanvasElement,
  cam: Camera,
  input: InputState,
  view: () => View,
  wake: () => void,
): void {
  /**
   * Where the panning finger was last seen, or null when there is no valid baseline to measure from.
   *
   * Nullable on purpose, and it is the fix for a bug that made finishing a pinch throw the view off
   * screen. A pinch takes the two-pointer branch of `pointermove`, which returns before touching this
   * baseline -- so it stayed frozen at wherever the FIRST finger was just before the second one landed.
   * Fingers never lift at the same instant, so the moment one left, the survivor's next move measured
   * itself against that stale point and panned by the whole finger separation plus everything the pinch
   * had travelled, in a single frame, and then set an inertial fling on top of it.
   *
   * Now the baseline is cleared whenever it cannot be trusted, and the next move re-establishes it
   * instead of panning by the gap.
   */
  let panFrom: { x: number; y: number } | null = null;
  let downX = 0;
  let downY = 0;
  let moved = 0;
  /** Whether this gesture ever had two fingers down. A pinch is not a tap, however little it moved. */
  let pinched = false;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  /** When the panning finger was last seen moving, so a finger held still cannot throw the view. */
  let lastMoveAt = -Infinity;

  /** Recent wheel magnitudes in pixels, newest last. Five is enough to see regularity without lagging. */
  const wheelMags: number[] = [];
  let lastZoomAt = -Infinity;
  let zoomIntentFired = false;

  const stopFling = (): void => {
    input.velX = 0;
    input.velY = 0;
  };

  const local = (e: PointerEvent | WheelEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /**
   * Note a zoom event, and report whether this gesture may still name a destination.
   *
   * Called for every zoom event, including zoom-out, because it is what decides where one gesture ends and
   * the next begins. The caller marks the intent as spent, so a gesture that opens by zooming out and then
   * reverses still gets its one chance. See InputState.onZoomIntent.
   */
  const beginZoom = (now: number): boolean => {
    if (now - lastZoomAt > GESTURE_IDLE_MS) {
      zoomIntentFired = false;
      // A fresh gesture may be a different instrument: the wheel classifier must not inherit the last one.
      wheelMags.length = 0;
    }
    lastZoomAt = now;
    return !zoomIntentFired;
  };

  /**
   * Whether this delta came from a detent rather than a finger.
   *
   * Line-mode deltas only ever come from a notched wheel, so those need no inference. Otherwise: detents
   * are both LARGE and REGULAR -- a wheel repeats the same number, a hand on glass never does -- and the
   * first event of a gesture has no history to be regular against, so size alone decides it and the next
   * event or two correct the guess.
   */
  const isNotched = (magPx: number, lines: boolean): boolean => {
    if (lines) return true;
    wheelMags.push(magPx);
    if (wheelMags.length > 5) wheelMags.shift();
    if (magPx < NOTCH_MIN_PX) return false;
    if (wheelMags.length < 3) return true;
    const sorted = [...wheelMags].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1]!;
    if (median < NOTCH_MIN_PX) return false;
    return sorted.every((m) => Math.abs(m - median) <= median * NOTCH_SPREAD);
  };

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // deltaMode differs wildly across browsers; normalise to pixels before doing anything.
      const lines = e.deltaMode === 1;
      let dy = e.deltaY;
      if (lines) dy *= 16;
      else if (e.deltaMode === 2) dy *= view().h;

      // Before the classifier, because this is what decides whether the deltas it has been collecting
      // belong to the gesture in front of it or to the one that ended a second ago.
      const mayName = beginZoom(e.timeStamp > 0 ? e.timeStamp : performance.now());

      // A pinch is not a scroll: it arrives here only because that is how browsers deliver it, and its
      // deltas are a different size entirely, so it neither uses nor teaches the wheel classifier.
      const dz = e.ctrlKey
        ? clampStep(-dy * SMOOTH_SCALE * PINCH_GAIN)
        : isNotched(Math.abs(dy), lines)
          ? clampStep(-Math.sign(dy) * NOTCH_STEP)
          : clampStep(-dy * SMOOTH_SCALE);

      const p = local(e);
      input.hoverX = p.x;
      input.hoverY = p.y;
      /**
       * ZOOM IS ANCHORED AT THE MIDDLE OF THE SCREEN, NOT AT THE CURSOR.
       *
       * Cursor-anchored zoom is the obvious choice and it is wrong here, for a reason that only shows up
       * over a range this large: the anchor is a screen pixel, so the world point it names is known to
       * about half a pixel -- and zooming AMPLIFIES that error by the zoom factor. Measured on the real
       * page, a stationary cursor over a star drifted 0.25 px after one notch, 12 px after eight, 61 px
       * after twelve, and 457 px after seventeen, doubling every 1.7 notches, exactly in proportion to the
       * scale. The maths was exact; the aim cannot be. Seventy-six doublings turns any sub-pixel error into
       * a screen, so the thing you were pointing at slides away and then leaves -- "it just shoots off in
       * random directions".
       *
       * The middle of the screen has no such error, so that is where the wheel goes. Choosing what is in
       * the middle is a separate, deliberate act: drag, or double-click a thing to hold it there.
       */
      input.anchorX = view().w / 2;
      input.anchorY = view().h / 2;
      // Scrolling with the cursor squarely on something means "closer to that", so it takes over the
      // middle of the screen and the zoom converges on it instead of diverging away from it.
      if (dz > 0 && mayName) {
        zoomIntentFired = true;
        input.onZoomIntent?.(p.x, p.y, dz, false);
      }
      input.zoomBy(dz);
      wake();
    },
    { passive: false },
  );

  canvas.addEventListener('pointerdown', (e) => {
    // Synthetic events have no active pointer to capture, and a throw here would abort the whole handler.
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable; the listeners below still see the events */
    }
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      input.dragging = true;
      panFrom = { x: p.x, y: p.y };
      downX = p.x;
      downY = p.y;
      moved = 0;
      pinched = false;
      lastMoveAt = -Infinity;
      stopFling();
    } else if (pointers.size === 2) {
      pinchDist = spread(pointers);
      pinched = true;
      // A pinch is one gesture, however many events it takes, so it gets one shot at naming a destination.
      zoomIntentFired = false;
      lastZoomAt = -Infinity;
      // No single-finger baseline is meaningful while two are down, and any leftover inertia from the
      // one-finger drag that preceded this would keep sliding the view through the whole pinch.
      panFrom = null;
      stopFling();
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
    const now = e.timeStamp > 0 ? e.timeStamp : performance.now();

    if (pointers.size >= 2) {
      const d = spread(pointers);
      if (pinchDist > 0 && d > 0) {
        // Centred, for the same reason the wheel is: see the note on the wheel handler. Two fingers name a
        // point no more precisely than one cursor does, and the amplification does not care which.
        const v = view();
        input.anchorX = v.w / 2;
        input.anchorY = v.h / 2;
        /**
         * A pinch drives the same spring and the same clamp as every other zoom source.
         *
         * It used to move `cam.z` directly, on the argument that fingers are already smooth. They are, but
         * the camera is not the only thing that has to agree about where the zoom is going: bypassing the
         * target left `zTarget` behind wherever the pinch started, so the frame after the fingers lifted
         * the spring hauled the view back to it. Everything zooms the same way now.
         */
        const dz = clampStep(Math.log2(d / pinchDist));
        const mayName = beginZoom(now);
        if (dz > 0 && mayName) {
          zoomIntentFired = true;
          const c = centroid(pointers);
          input.onZoomIntent?.(c.x, c.y, dz, true);
        }
        input.zoomBy(dz);
      }
      pinchDist = d;
      pinched = true;
      panFrom = null;
      stopFling();
      wake();
      return;
    }

    // No trusted baseline: this is the first move of a gesture, or the first after a pinch dropped to one
    // finger. Take the current position as the baseline and pan from the NEXT move, rather than panning by
    // however far the finger happens to be from a point that no longer means anything.
    if (!panFrom) {
      panFrom = { x: p.x, y: p.y };
      lastMoveAt = now;
      wake();
      return;
    }

    const dx = p.x - panFrom.x;
    const dy = p.y - panFrom.y;
    panFrom = { x: p.x, y: p.y };
    moved += Math.abs(dx) + Math.abs(dy);
    if (dx !== 0 || dy !== 0) input.onPan?.();
    panByScreen(cam, dx, dy);

    /**
     * The fling velocity is an exponential average in pixels per SECOND.
     *
     * It used to be the raw per-frame delta, which is a velocity only if every frame lasts the same length
     * of time. It does not: the same flick of the wrist produced twice the throw on a 120 Hz display as on
     * a 60 Hz one, and a stutter mid-drag produced a wild one. Dividing by the real elapsed time makes the
     * number mean something, and averaging it over a few tens of milliseconds keeps one jittery sample
     * from becoming the whole throw.
     */
    const dtSec = (now - lastMoveAt) / 1000;
    if (dtSec > 0 && dtSec < 0.25) {
      const w = 1 - Math.exp(-dtSec / VELOCITY_TAU);
      input.velX += (dx / dtSec - input.velX) * w;
      input.velY += (dy / dtSec - input.velY) * w;
    }
    lastMoveAt = now;
    wake();
  });

  /**
   * A single click travels to a thing; a double click locks the view onto it. So the single click has to
   * WAIT to find out which it is -- fire it immediately and every double click also launches a flight that
   * has to be cancelled a moment later, and the view lurches. A flight takes a couple of seconds anyway,
   * so a fraction of a second of held breath before it starts is not something you can feel.
   *
   * 350 ms because 210 was below the threshold real hands hit: a comfortable double click is around 250 ms
   * and a deliberate one on a trackpad is slower still, so the second click was being taken as a fresh
   * first click and locking on was something you had to be quick enough to earn.
   */
  const DOUBLE_MS = 350;
  const DOUBLE_SLOP_PX = 24;
  let pendingClick: ReturnType<typeof setTimeout> | null = null;
  let lastTapAt = -Infinity;
  let lastTapX = 0;
  let lastTapY = 0;

  input.cancelPendingClick = (): void => {
    if (pendingClick !== null) clearTimeout(pendingClick);
    pendingClick = null;
    // The tap is gone, so it must not be able to pair with the next one either: locking onto something is
    // two clicks that both counted, and half of this pair has just been thrown away.
    lastTapAt = -Infinity;
  };

  const release = (e: PointerEvent) => {
    // A pointer this gesture never owned -- one that went down on the chrome, or a stray from the OS --
    // must not reset drag state. Without this the window-level listeners below would end gestures they
    // were never part of.
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 1) {
      // A pinch is ending but one finger is still down. Re-baseline from where that finger actually is,
      // and drop any inertia, so lifting the other finger neither pans nor flings.
      const rest = pointers.values().next().value;
      panFrom = rest ? { x: rest.x, y: rest.y } : null;
      lastMoveAt = -Infinity;
      stopFling();
    }
    if (pointers.size === 0) {
      input.dragging = false;
      panFrom = null;
      // A finger that had come to rest before it lifted is not throwing anything. The velocity average
      // only updates on movement, so without this a slow drag that paused at the end flung at whatever
      // speed it was doing before the pause.
      const now = e.timeStamp > 0 ? e.timeStamp : performance.now();
      if (now - lastMoveAt > STILL_MS) stopFling();
      // Lifting the last finger of a pinch must not fling the view either.
      if (pinched) stopFling();
      // The gesture is over, so the next zoom is a new one however soon it arrives.
      zoomIntentFired = false;
      lastZoomAt = -Infinity;
      const p = local(e);
      const tapped = !pinched && moved < 6 && Math.abs(p.x - downX) < 6 && Math.abs(p.y - downY) < 6;
      if (tapped) {
        const tapNow = performance.now();
        const second =
          tapNow - lastTapAt < DOUBLE_MS &&
          Math.abs(p.x - lastTapX) < DOUBLE_SLOP_PX &&
          Math.abs(p.y - lastTapY) < DOUBLE_SLOP_PX;
        if (second) {
          if (pendingClick !== null) clearTimeout(pendingClick);
          pendingClick = null;
          lastTapAt = -Infinity;
          input.onDoubleClick?.(p.x, p.y);
        } else {
          lastTapAt = tapNow;
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

  /**
   * On the WINDOW, not the canvas.
   *
   * A pointer released over the HUD, off the edge of the page, or stolen outright by the OS never delivers
   * its `pointerup` to the canvas, so the entry stayed in the map forever: the next drag measured itself
   * against a phantom second finger and jumped, or a pinch that lost a finger out of the window never
   * ended. Canvas events bubble, so listening here covers both cases and `release` ignores anything this
   * gesture does not own.
   */
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);

  canvas.addEventListener('dblclick', (e) => e.preventDefault());
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

/** One zoom event may never be more than this, however violent the gesture that produced it. */
function clampStep(dz: number): number {
  return dz < -MAX_WHEEL_STEP ? -MAX_WHEEL_STEP : dz > MAX_WHEEL_STEP ? MAX_WHEEL_STEP : dz;
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

  if (!input.dragging) {
    if (Math.hypot(input.velX, input.velY) > FLING_MIN_PX_PER_S) {
      // Distance is velocity times time, and the decay is per second, so both survive a change of frame rate.
      panByScreen(cam, input.velX * dt, input.velY * dt);
      const decay = Math.exp(-FLING_DECAY * dt);
      input.velX *= decay;
      input.velY *= decay;
      moving = true;
    } else if (input.velX !== 0 || input.velY !== 0) {
      // Settle it exactly rather than leaving a residue, so the loop can go back to sleep.
      input.velX = 0;
      input.velY = 0;
    }
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
