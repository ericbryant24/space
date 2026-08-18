/**
 * Render loop that sleeps when idle. There are no dirty rects in this project -- a zoom changes every
 * pixel, so partial redraws would pay complexity for a case that never happens. The saving instead
 * comes from not running at all while the camera is at rest.
 */
export interface LoopHandle {
  /** Ask for another frame. Safe to call repeatedly; coalesces. */
  wake(): void;
  stop(): void;
  readonly fps: number;
  readonly frameMs: number;
}

export function startLoop(step: (dtSeconds: number) => boolean): LoopHandle {
  let running = true;
  let queued = false;
  let last = performance.now();
  let emaMs = 16;
  let fps = 60;

  const handle: LoopHandle = {
    wake() {
      if (!running || queued) return;
      queued = true;
      requestAnimationFrame(tick);
    },
    stop() {
      running = false;
    },
    get fps() {
      return fps;
    },
    get frameMs() {
      return emaMs;
    },
  };

  function tick(now: number): void {
    queued = false;
    if (!running) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    const t0 = performance.now();
    const wantsMore = step(dt);
    const spent = performance.now() - t0;

    emaMs = emaMs * 0.9 + spent * 0.1;
    if (dt > 0) fps = fps * 0.9 + (1 / dt) * 0.1;

    if (wantsMore) handle.wake();
  }

  handle.wake();
  return handle;
}
