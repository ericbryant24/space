// The scale ladder. `logSpan` is log2(radius in metres); only monotonic decrease is required, so
// these are pacing knobs rather than physics. Total span is 2^76, which is the whole problem this
// project has to solve — see src/camera/rebase.ts for how that survives float64.

export type Kind =
  | 'field'
  | 'cluster'
  | 'galaxy'
  | 'system'
  | 'planet'
  | 'region'
  | 'settlement'
  | 'building';

/**
 * How a level's children are positioned.
 *
 * `cells` anchors one child per cell of a binary subdivision grid. That is what makes a galaxy of a
 * hundred billion stars navigable: "what is under the camera" becomes a floor division.
 *
 * `orbits` places a short, ordered list of children on circular orbits. A system has under ten
 * planets, so it needs neither the grid nor the bounded-fanout guarantee -- and planets belong on
 * orbits, which a grid cannot express.
 *
 * `scatter` places a bounded, ordered list at fixed positions drawn from the parent's own density
 * field. It exists because the grid, applied to a galaxy, put its systems on 10^16 cells each 4e-7 px
 * across at galaxy zoom -- so not one star you could see was a real place, and "zoom in on that star"
 * had no answer. A galaxy now carries a few thousand CATALOGUED systems: the stars you see are the
 * stars you can go to. The rest of its hundred billion remain unresolved glow, which is honest.
 */
export type Placement = 'cells' | 'orbits' | 'scatter';

export interface Level {
  readonly kind: Kind;
  readonly logSpan: number;
  readonly child: Kind | null;
  readonly placement: Placement;
  /** Fraction of anchor cells that hold a child. Below 1 the rest is honest void. */
  readonly density: number;
  /** Anchor cell half-size measured in child radii. Larger = sparser, more space between things. */
  readonly spacing: number;
  /** Children's logSpan varies by +/- this, so siblings are not all identical in size. */
  readonly sizeJitter: number;
  readonly label: string;
}

export const ROOT_KIND: Kind = 'field';

export const LEVELS: Readonly<Record<Kind, Level>> = {
  field: { kind: 'field', placement: 'cells', logSpan: 80, child: 'cluster', density: 0.62, spacing: 4, sizeJitter: 0.3, label: 'Field' },
  cluster: { kind: 'cluster', placement: 'cells', logSpan: 75, child: 'galaxy', density: 0.55, spacing: 4, sizeJitter: 0.45, label: 'Cluster' },
  galaxy: { kind: 'galaxy', placement: 'scatter', logSpan: 69, child: 'system', density: 0.5, spacing: 4, sizeJitter: 0.35, label: 'Galaxy' },
  system: { kind: 'system', placement: 'orbits', logSpan: 40, child: 'planet', density: 0.5, spacing: 4, sizeJitter: 0.5, label: 'System' },
  planet: { kind: 'planet', placement: 'cells', logSpan: 23, child: 'region', density: 0.7, spacing: 3, sizeJitter: 0.2, label: 'Planet' },
  region: { kind: 'region', placement: 'cells', logSpan: 15, child: 'settlement', density: 0.45, spacing: 4, sizeJitter: 0.3, label: 'Region' },
  settlement: { kind: 'settlement', placement: 'cells', logSpan: 10, child: 'building', density: 0.6, spacing: 3, sizeJitter: 0.35, label: 'Settlement' },
  building: { kind: 'building', placement: 'cells', logSpan: 4, child: null, density: 0, spacing: 1, sizeJitter: 0, label: 'Building' },
};

export const KIND_ORDER: readonly Kind[] = [
  'field',
  'cluster',
  'galaxy',
  'system',
  'planet',
  'region',
  'settlement',
  'building',
];

/**
 * Subdivision level at which a node's children are anchored, one per cell.
 *
 * This is the load-bearing trick for making a 2^76 ladder navigable. A galaxy does not hold a list
 * of systems (there would be 1e11 of them, and the gap from galaxy to system is 2^29, so randomly
 * placed children would be unfindable). Instead children are anchored to cells of a binary
 * subdivision grid whose cell size is a fixed multiple of the child's own radius. Wherever you zoom,
 * there is something nearby, and "what is in this cell" is O(1).
 */
export function anchorLevel(kind: Kind): number {
  const level = LEVELS[kind];
  if (!level.child) return 0;
  const gap = level.logSpan - LEVELS[level.child].logSpan;
  return Math.max(1, Math.round(gap - Math.log2(level.spacing)));
}

export function childKind(kind: Kind): Kind | null {
  return LEVELS[kind].child;
}

/** Human-readable metres/AU/ly for the scale readout. */
export function formatDistance(metres: number): string {
  const AU = 1.495978707e11;
  const LY = 9.4607e15;
  const PC = 3.0857e16;
  if (metres >= 1e3 * PC) return `${(metres / (1e6 * PC)).toPrecision(3)} Mpc`;
  if (metres >= PC) return `${(metres / (1e3 * PC)).toPrecision(3)} kpc`;
  if (metres >= 0.1 * LY) return `${(metres / LY).toPrecision(3)} ly`;
  if (metres >= 0.01 * AU) return `${(metres / AU).toPrecision(3)} AU`;
  if (metres >= 1e6) return `${(metres / 1e3).toPrecision(3)} km`;
  if (metres >= 1e3) return `${(metres / 1e3).toPrecision(3)} km`;
  if (metres >= 1) return `${metres.toPrecision(3)} m`;
  return `${(metres * 100).toPrecision(3)} cm`;
}
