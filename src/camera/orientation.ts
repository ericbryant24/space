import { frameToNode, type Camera } from './camera.ts';

/**
 * WHICH WAY IS UP.
 *
 * On a two-dimensional world the surface is the planet's circumference, so "up" is the direction away from the
 * planet's centre -- and that points somewhere different at every point on the rim. Every frame below the planet
 * already knows this: a region carries a `spin` of `theta + pi/2` (see ChildRef.spin), and the renderer's climb
 * un-turns whichever frame the camera is focused on, so a region in focus is drawn with its ground horizontal
 * whether it sits at the top of its world or a third of the way round it.
 *
 * That leaves one gap, and it is a wide one. A planet stops drawing its own disc once it is about six screens
 * across, and its regions do not take focus until one of them is 220 pixels wide -- which is another two and a
 * bit doublings further in. Through that whole stretch the camera is focused on the PLANET, whose own frame is
 * drawn unturned, while the plates hanging off its rim are each turned by their own angle. Stand over the right
 * hand side of a world and the ground ran vertically down the middle of the screen; stand under it and the sky
 * was at the bottom. The picture was not wrong -- it was a correct picture of a disc, drawn from a camera that
 * had not been told it was standing on something.
 *
 * So: while the camera's focus IS the planet, turn the whole scene so that the outward direction at the camera's
 * own angle points up the screen. Below the planet the frame chain has already done it and this returns zero, so
 * there is no double correction and no seam at the moment a region takes focus -- the rotation the chain starts
 * applying is exactly the rotation this stops applying.
 */

/**
 * How close to the centre of a planet the outward direction stops meaning anything, in planet radii.
 *
 * Below this there is no "up" to find: the camera is inside the rock, every direction is outward, and atan2 of a
 * point near the origin is noise that would spin the world. In practice the camera is only ever down there while
 * flying through, and the weight below has faded the rotation out long before.
 */
const CENTRE_DEAD = 0.25;

/** Where the camera stands on its world, as an angle round the rim, or null if that question has no answer. */
export function outwardAngle(cam: Camera): number | null {
  if (cam.node.kind !== 'planet') return null;
  // The planet's own units, where its centre is the origin and its nominal surface is at radius one.
  const [x, y] = frameToNode(cam, cam.fx, cam.fy);
  if (Math.hypot(x, y) < CENTRE_DEAD) return null;
  // Node space has y pointing down, the same way the screen does, and `theta` is measured in that space
  // throughout -- see rimChild.
  return Math.atan2(y, x);
}

/**
 * The last UNWEIGHTED angle chosen, so the next one can be unwrapped against it.
 *
 * Angles are only defined up to a whole turn, and a whole turn is invisible -- until the rotation is being ramped
 * in, when `weight * angle` and `weight * (angle + 2pi)` are two different pictures. Panning past the far side of
 * a world crosses that branch cut, and without unwrapping the scene would spin once round in a single frame at
 * one particular longitude. One number of state, carried between frames, because continuity between frames is
 * exactly the property being asked for.
 *
 * Unweighted, and that matters: unwrapping against the weighted angle compares a half-applied rotation with a
 * whole one, so the correction is wrong by half a turn and the error compounds every frame until the scene is
 * spinning on its own.
 */
let previous = 0;

/**
 * The rotation to apply to the whole scene, in radians, or 0 to leave it alone.
 *
 * Positive angles turn clockwise, because screen y points down -- the same convention `ChildRef.spin` uses, which
 * is what lets this be added straight to it.
 *
 * `weight` is how far the world has come upright, and the caller passes the sky's own `groundAlpha` so that the
 * scene turns over exactly the range the daylight backdrop fades in. Turning while the planet is still a body in
 * space would spin its siblings and its star for no reason; turning once you are inside the atmosphere is simply
 * what standing on the ground means. Sharing one ramp makes the two read as one event rather than two.
 */
export function upAngleFor(cam: Camera, weight: number): number {
  const theta = outwardAngle(cam);
  if (theta === null) {
    previous = 0;
    return 0;
  }
  const raw = -Math.PI / 2 - theta;
  // Nearest branch to where the rotation already was, so a continuous pan gives a continuous turn.
  const turns = Math.round((previous - raw) / (Math.PI * 2));
  const unwrapped = raw + turns * Math.PI * 2;
  previous = unwrapped;
  return unwrapped * Math.min(1, Math.max(0, weight));
}

/** Undo the scene rotation for a screen point, so a pointer can be compared with unrotated geometry. */
export function unrotatePoint(
  x: number,
  y: number,
  up: number,
  viewW: number,
  viewH: number,
): { x: number; y: number } {
  if (up === 0) return { x, y };
  const dx = x - viewW / 2;
  const dy = y - viewH / 2;
  const c = Math.cos(-up);
  const s = Math.sin(-up);
  return { x: viewW / 2 + dx * c - dy * s, y: viewH / 2 + dy * c + dx * s };
}
