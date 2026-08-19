// The palette. Flat fills only -- no gradients anywhere. A soft edge is the fastest way to make flat
// art look like a 3D render that did not come off, and this whole idea lives or dies on the edge
// reading crisply.

export const P = {
  void: '#141726',
  star: '#8e97b8',
  // The interior is SHADOW. Concentric bands of rock were the whole problem with the old planet: the
  // eye went to the middle, where nothing happens, and the rim -- where everything happens -- was a
  // hairline. So the body is one value barely above the void, and the rim is the only lit thing here.
  crust: '#1f2333',
  crustDeep: '#1a1e2c',
  mantle: '#262a3c',
  core: '#2b2733',
  coreHot: '#332f42',
  ink: '#151f27',

  abyss: '#1c4459',
  shelf: '#2f6d87',
  seaIce: '#dfe9ee',
  sheen: '#4e93a8',

  ice: '#e8eff3',
  tundra: '#7f8d80',
  grass: '#7e9a4e',
  forest: '#3f7040',
  jungle: '#2c6740',
  desert: '#c0a165',

  canopy: '#2f5c37',
  canopyLit: '#3d7343',
  jungleCanopy: '#245036',

  wall: '#cfc0aa',
  wallShade: '#a3927c',
  roof: '#8d6f60',
  window: '#f6e3ae',
  tower: '#ded2bf',

  cloud: '#eef3f7',
  cloudShade: '#cfdae4',
  air: '#6fa6d0',
  orbit: '#5d6b8c',
  hud: '#8fa0c4',
  hudDim: '#5b6684',
};

export const BIOME_FILL = {
  abyss: P.abyss, shelf: P.shelf, seaIce: P.seaIce,
  ice: P.ice, tundra: P.tundra, grass: P.grass,
  desert: P.desert, forest: P.forest, jungle: P.jungle,
};
