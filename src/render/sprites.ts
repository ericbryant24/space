/**
 * Byte-budgeted offscreen sprite cache.
 *
 * Budgeting by COUNT rather than bytes is a classic way to leak hundreds of megabytes: 1024 cached
 * canvases at 512x512 is half a gigabyte. So the budget here is in bytes, estimated as w*h*4.
 */
type Surface = HTMLCanvasElement | OffscreenCanvas;

export interface Sprite {
  readonly canvas: Surface;
  readonly size: number;
  readonly bytes: number;
}

const BUDGET_BYTES = 48 * 1024 * 1024;
/**
 * Per-frame baking budget. Baking every sprite a wide view asks for in one frame is a multi-second
 * stall: a field of 110 galaxies took 2.4s before this existed. Instead each frame spends a couple of
 * milliseconds and the renderer draws a cheap stand-in for whatever has not been baked yet, so the
 * view resolves over a handful of frames rather than freezing once.
 */
const BAKE_MS_PER_FRAME = 2.5;

const cache = new Map<string, Sprite>();
let usedBytes = 0;
let bakeSpent = 0;
let bakesThisFrame = 0;
let pending = 0;

export function spriteStats(): { entries: number; megabytes: number; pending: number; bakes: number } {
  return { entries: cache.size, megabytes: usedBytes / (1024 * 1024), pending, bakes: bakesThisFrame };
}

/** Reset the frame's bake budget. Call once per rendered frame. */
export function beginSpriteFrame(): void {
  bakeSpent = 0;
  bakesThisFrame = 0;
  pending = 0;
}

/** True while sprites are still waiting to be baked, so the loop knows to keep drawing. */
export function spritesPending(): boolean {
  return pending > 0;
}

export function makeSurface(size: number): { surface: Surface; ctx: CanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const surface = new OffscreenCanvas(size, size);
    const ctx = surface.getContext('2d') as unknown as CanvasRenderingContext2D;
    return { surface, ctx };
  }
  const surface = document.createElement('canvas');
  surface.width = size;
  surface.height = size;
  return { surface, ctx: surface.getContext('2d')! };
}

/**
 * Fetch or bake a sprite. `size` is quantised by the caller into a power-of-two bucket so a sprite
 * stays valid across a full doubling of zoom rather than being rebaked every frame.
 */
export function getSprite(
  key: string,
  size: number,
  bake: (ctx: CanvasRenderingContext2D, size: number) => void,
): Sprite {
  const found = cache.get(key);
  if (found) {
    // Refresh recency: Map preserves insertion order, so re-inserting moves it to the back.
    cache.delete(key);
    cache.set(key, found);
    return found;
  }
  return bakeNow(key, size, bake);
}

/**
 * Budgeted variant. Returns a cached sprite, else bakes if this frame has budget left, else returns
 * null so the caller can draw a cheap stand-in this frame and get the real thing shortly.
 */
export function getSpriteBudgeted(
  key: string,
  size: number,
  bake: (ctx: CanvasRenderingContext2D, size: number) => void,
): Sprite | null {
  const found = cache.get(key);
  if (found) {
    cache.delete(key);
    cache.set(key, found);
    return found;
  }
  if (bakeSpent >= BAKE_MS_PER_FRAME) {
    pending++;
    return null;
  }
  const t0 = performance.now();
  const sprite = bakeNow(key, size, bake);
  bakeSpent += performance.now() - t0;
  bakesThisFrame++;
  return sprite;
}

function bakeNow(
  key: string,
  size: number,
  bake: (ctx: CanvasRenderingContext2D, size: number) => void,
): Sprite {
  const { surface, ctx } = makeSurface(size);
  ctx.clearRect(0, 0, size, size);
  bake(ctx, size);

  const sprite: Sprite = { canvas: surface, size, bytes: size * size * 4 };
  cache.set(key, sprite);
  usedBytes += sprite.bytes;

  while (usedBytes > BUDGET_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    const victim = cache.get(oldest)!;
    cache.delete(oldest);
    usedBytes -= victim.bytes;
  }
  return sprite;
}

/** Power-of-two bucket for a requested pixel size, so rebakes happen once per doubling. */
export function sizeBucket(px: number, min = 32, max = 1024): number {
  const p = 2 ** Math.ceil(Math.log2(Math.max(1, px)));
  return Math.min(max, Math.max(min, p));
}

export function clearSprites(): void {
  cache.clear();
  usedBytes = 0;
  pending = 0;
}
