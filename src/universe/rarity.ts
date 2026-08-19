import { f01, roll } from '../core/rng.ts';

/**
 * RARE PLACES.
 *
 * The one thing the ladder could not do until now was reward looking. Every stretch of coast is real and every
 * house is an address, but a world where all of it is equally ordinary gives you no reason to pick a direction --
 * and "a reason to keep zooming" was one of the three qualities this project is for.
 *
 * Rarity here is a PURE FUNCTION OF ADDRESS and nothing else. That is what makes a rare place worth finding: it
 * is in the same place forever, it is in the same place for everybody, and a bookmark of it stays true. There is
 * no register of special objects anywhere, no seeding pass, and no state -- ask the question of an address and
 * the answer comes back the same every time, on any machine, in any order.
 *
 * NOTHING HERE IS A MARKER. A rare place is not flagged, ringed, pinned or sparkled; it is a place that LOOKS
 * different because it IS different, and that difference is visible at the zoom where you are choosing where to
 * go next. An empty town reads as empty from a region away -- no lit windows after dark, no smoke over the roofs,
 * the colour gone out of the walls -- so it draws the eye without anything being drawn that is not the town.
 *
 * Every roll draws from its own named stream, so this file could not move an existing place even if it wanted to.
 */

/**
 * One settlement in this many stood empty.
 *
 * Rare enough that finding one is an event, common enough that a few minutes of looking along one world's coast
 * will turn one up. A planet carries a few hundred settled slots, so most inhabited worlds have one or two.
 */
export const RUIN_ONE_IN = 120;

/**
 * Whether the people who built this place have gone.
 *
 * Asked of a SETTLEMENT's id. Its buildings are still there and are still addresses you can zoom into -- what
 * changed is that nobody is in them, which is a fact about the town rather than about whether the town exists.
 * Placement is untouched: an empty town occupies the slot a lived-in one would have.
 */
export function isRuin(settlementId: number): boolean {
  return f01(roll(settlementId, 'abandoned')) * RUIN_ONE_IN < 1;
}

/**
 * How far gone, 0 for a lived-in town and 0.35 to 1 for an empty one.
 *
 * Zero is never returned for a ruin, because a town that has only just emptied looks exactly like a town, and a
 * rare place that is indistinguishable from a common one is not worth having found. The upper end takes the roof
 * off and leaves the walls.
 */
export function ruinDecay(settlementId: number): number {
  if (!isRuin(settlementId)) return 0;
  return 0.35 + f01(roll(settlementId, 'decay')) * 0.65;
}

/** Years since the last of them left. For the readout; the number is as real as anything else here. */
export function ruinYears(settlementId: number): number {
  if (!isRuin(settlementId)) return 0;
  return 30 + Math.round(f01(roll(settlementId, 'emptied')) ** 2 * 870);
}
