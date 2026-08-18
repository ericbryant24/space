import type { Camera } from '../camera/camera.ts';
import type { Cell } from '../universe/node.ts';

/**
 * The URL *is* the zoom address. Sharing a location is the whole growth loop of a thing like this, so
 * the complete camera state round-trips through the fragment: seed, semantic path, subdivision cell,
 * local offset, and zoom.
 *
 * Offsets are quantised to four decimals, which is sub-pixel by the precision invariant -- the frame
 * is radius 1.0 and at most 1024 px across, so 1e-4 of a frame unit is at most a tenth of a pixel.
 */
export interface CameraState {
  seed: number;
  path: Cell[];
  k: number;
  cx: number;
  cy: number;
  fx: number;
  fy: number;
  z: number;
}

const b36 = (n: number): string => Math.round(n).toString(36);
const parseB36 = (s: string): number => parseInt(s, 36);

export function encodeState(state: CameraState): string {
  const parts = [
    `s=${b36(state.seed)}`,
    `p=${state.path.map((c) => `${b36(c.cx)}.${b36(c.cy)}`).join('-')}`,
    `k=${state.k}`,
    `c=${b36(state.cx)}.${b36(state.cy)}`,
    `o=${state.fx.toFixed(4)},${state.fy.toFixed(4)}`,
    `z=${state.z.toFixed(3)}`,
  ];
  return parts.join('&');
}

export function decodeState(hash: string): Partial<CameraState> & { seed: number } {
  const raw = hash.replace(/^#/, '');
  const params = new Map<string, string>();
  for (const pair of raw.split('&')) {
    const eq = pair.indexOf('=');
    if (eq > 0) params.set(pair.slice(0, eq), pair.slice(eq + 1));
  }

  const seedRaw = params.get('s');
  const seed = seedRaw !== undefined && /^[0-9a-z]+$/i.test(seedRaw) ? parseB36(seedRaw) >>> 0 : DEFAULT_SEED;

  const out: Partial<CameraState> & { seed: number } = { seed };

  const pathRaw = params.get('p');
  if (pathRaw !== undefined) {
    if (pathRaw === '') out.path = [];
    else {
      const cells: Cell[] = [];
      let ok = true;
      for (const seg of pathRaw.split('-')) {
        const [a, b] = seg.split('.');
        const cx = a !== undefined ? parseB36(a) : NaN;
        const cy = b !== undefined ? parseB36(b) : NaN;
        if (!Number.isInteger(cx) || !Number.isInteger(cy) || cx < 0 || cy < 0) {
          ok = false;
          break;
        }
        cells.push({ cx, cy });
      }
      if (ok) out.path = cells;
    }
  }

  const k = params.get('k');
  if (k !== undefined && /^\d+$/.test(k)) out.k = Number(k);

  const c = params.get('c');
  if (c !== undefined) {
    const [a, b] = c.split('.');
    const cx = a !== undefined ? parseB36(a) : NaN;
    const cy = b !== undefined ? parseB36(b) : NaN;
    if (Number.isInteger(cx) && Number.isInteger(cy)) {
      out.cx = cx;
      out.cy = cy;
    }
  }

  const o = params.get('o');
  if (o !== undefined) {
    const [a, b] = o.split(',');
    const fx = Number(a);
    const fy = Number(b);
    if (Number.isFinite(fx) && Number.isFinite(fy)) {
      out.fx = fx;
      out.fy = fy;
    }
  }

  const z = params.get('z');
  if (z !== undefined && Number.isFinite(Number(z))) out.z = Number(z);

  return out;
}

export const DEFAULT_SEED = 0x51ace;

export function stateOf(cam: Camera, seed: number): CameraState {
  return {
    seed,
    path: cam.node.path.map((c) => ({ cx: c.cx, cy: c.cy })),
    k: cam.k,
    cx: cam.cx,
    cy: cam.cy,
    fx: cam.fx,
    fy: cam.fy,
    z: cam.z,
  };
}

/**
 * Safari throttles history writes to roughly 100 per 30 seconds and then throws, so continuous
 * interaction has to coalesce. Discrete navigations push a real entry; dragging only replaces.
 */
const REPLACE_INTERVAL_MS = 350;

export class Router {
  private lastWrite = 0;
  private pendingReplace: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private suppress = false;
  private readonly onPop: (state: Partial<CameraState> & { seed: number }) => void;

  constructor(onPop: (state: Partial<CameraState> & { seed: number }) => void) {
    this.onPop = onPop;
    window.addEventListener('popstate', () => {
      if (this.suppress) return;
      this.onPop(decodeState(location.hash));
    });
  }

  initial(): Partial<CameraState> & { seed: number } {
    return decodeState(location.hash);
  }

  /** Continuous update while interacting. Coalesced, never pushes history. */
  replace(state: CameraState): void {
    const hash = `#${encodeState(state)}`;
    if (hash === location.hash) return;
    this.pendingReplace = hash;
    const now = performance.now();
    const wait = Math.max(0, REPLACE_INTERVAL_MS - (now - this.lastWrite));
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pendingReplace === null) return;
      this.lastWrite = performance.now();
      this.write(this.pendingReplace, false);
      this.pendingReplace = null;
    }, wait);
  }

  /** Discrete navigation: a completed flight, a breadcrumb click, a level jump. */
  push(state: CameraState): void {
    const hash = `#${encodeState(state)}`;
    if (hash === location.hash) return;
    this.pendingReplace = null;
    this.lastWrite = performance.now();
    this.write(hash, true);
  }

  private write(hash: string, push: boolean): void {
    this.suppress = true;
    try {
      if (push) history.pushState(null, '', hash);
      else history.replaceState(null, '', hash);
    } catch {
      // Throttled by the browser. Dropping a coalesced write is harmless; the next one carries the
      // latest state anyway.
    }
    this.suppress = false;
  }
}
