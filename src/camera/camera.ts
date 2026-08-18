import type { Node } from '../universe/node.ts';

/**
 * There is NO global world coordinate system. Multiplying world coordinates by a zoom factor
 * spanning 2^76 would destroy float64 long before you reached the ground.
 *
 * Instead: one global scalar `z` (log2 pixels-per-metre), plus a FOCUS FRAME. The frame is cell
 * (cx, cy) of a binary subdivision at level k inside a semantic node, and its radius is normalised
 * to 1.0 in frame units. All render maths happens in that frame.
 *
 *   PRECISION INVARIANT: the frame's radius in screen pixels, R = 2^(z + node.logSpan - k), is kept
 *   inside [64, 1024] by rebase.ts.
 *
 * Because the frame radius is 1.0 in local units, R *is* pixels-per-frame-unit. Holding R in a 4-bit
 * window means the finest relative precision ever required at the focus is 2^-10, leaving ~42 bits
 * of float64 mantissa spare -- permanently, at any depth. Precision stops being a scale problem and
 * becomes bookkeeping.
 */
export interface Camera {
  node: Node;
  /** Subdivision level within `node`. */
  k: number;
  /** Cell indices at level k. Integers, exact in float64 far past any depth we reach. */
  cx: number;
  cy: number;
  /** Camera centre offset within the frame, in frame units. Kept small (|f| <~ 8). */
  fx: number;
  fy: number;
  /** log2(pixels per metre). The only global number in the system. */
  z: number;
}

export interface View {
  w: number;
  h: number;
}

export function createCamera(node: Node, z: number): Camera {
  return { node, k: 0, cx: 0, cy: 0, fx: 0, fy: 0, z };
}

/** Pixels per frame unit == the frame's on-screen radius in pixels. */
export function pxPerUnit(cam: Camera): number {
  return 2 ** (cam.z + cam.node.logSpan - cam.k);
}

/** Pixels per unit of the focus NODE's own coordinate space. */
export function pxPerNodeUnit(cam: Camera): number {
  return 2 ** (cam.z + cam.node.logSpan);
}

/** Frame units -> node units. Exact: only powers of two and small integers. */
export function frameToNode(cam: Camera, fx: number, fy: number): [number, number] {
  const s = 2 ** -cam.k;
  return [s * (2 * cam.cx + 1 + fx) - 1, s * (2 * cam.cy + 1 + fy) - 1];
}

/** Node units -> frame units. */
export function nodeToFrame(cam: Camera, nx: number, ny: number): [number, number] {
  const inv = 2 ** cam.k;
  return [(nx + 1) * inv - 2 * cam.cx - 1, (ny + 1) * inv - 2 * cam.cy - 1];
}

export function screenToFrame(cam: Camera, sx: number, sy: number, view: View): { x: number; y: number } {
  const r = pxPerUnit(cam);
  return { x: cam.fx + (sx - view.w / 2) / r, y: cam.fy + (sy - view.h / 2) / r };
}

export function frameToScreen(cam: Camera, fx: number, fy: number, view: View): { x: number; y: number } {
  const r = pxPerUnit(cam);
  return { x: view.w / 2 + (fx - cam.fx) * r, y: view.h / 2 + (fy - cam.fy) * r };
}

/**
 * Zoom by `dz` doublings keeping the point under (sx, sy) fixed.
 *
 * From screen = centre + (p - f) * S, holding p fixed gives f' = p - (p - f) * S/S'. Note this only
 * ever touches `z` and bounded local offsets -- never a global scale -- so zoom-to-cursor stays
 * exact at every depth. Cursor drift when deeply zoomed is the classic failure of the naive
 * approach.
 */
export function zoomAt(cam: Camera, sx: number, sy: number, dz: number, view: View): void {
  const p = screenToFrame(cam, sx, sy, view);
  const ratio = 2 ** -dz;
  cam.fx = p.x + (cam.fx - p.x) * ratio;
  cam.fy = p.y + (cam.fy - p.y) * ratio;
  cam.z += dz;
}

export function panByScreen(cam: Camera, dxPx: number, dyPx: number): void {
  const r = pxPerUnit(cam);
  cam.fx -= dxPx / r;
  cam.fy -= dyPx / r;
}

/** Metres per pixel at the current zoom -- for the scale readout. */
export function metresPerPixel(cam: Camera): number {
  return 2 ** -cam.z;
}

/**
 * Place the camera at a point given in the CURRENT node's units, choosing k/cx/cy so that R lands
 * in the middle of the invariant window. Used when crossing a semantic boundary, where the frame
 * has to be rebuilt rather than halved.
 */
export function setNodeCoords(cam: Camera, nx: number, ny: number): void {
  const target = Math.round(cam.z + cam.node.logSpan - 8); // 2^8 = 256, centre of [64, 1024]
  const k = Math.max(0, target);
  const n = 2 ** k;
  const span = 2 ** (1 - k);
  cam.k = k;
  cam.cx = Math.min(n - 1, Math.max(0, Math.floor((nx + 1) / span)));
  cam.cy = Math.min(n - 1, Math.max(0, Math.floor((ny + 1) / span)));
  const [fx, fy] = nodeToFrame(cam, nx, ny);
  cam.fx = fx;
  cam.fy = fy;
}

/** Remaining float64 mantissa bits at the focus. Displayed in the debug HUD; asserted in tests. */
export function mantissaHeadroom(cam: Camera): number {
  const r = pxPerUnit(cam);
  const off = Math.max(1, Math.abs(cam.fx), Math.abs(cam.fy));
  return 52 - Math.log2(r) - Math.log2(off);
}
