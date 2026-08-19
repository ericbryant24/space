# Planet scale — prototypes

Three answers to one question: how do you draw a planet as a 2D circle where everything happens on the
edge, skewed so the whole world and its surface details are legible at the same time?

```sh
npm run dev            # then open /space/proto/
node proto/bundle.mjs  # flatten to proto/dist/lenses.html, one self-contained file
```

## What is shared, and what is not

Everything except the lens is shared, deliberately — it is the only way to compare the three fairly.

| file | what it holds |
| --- | --- |
| `planet/world.js` | the world as a ring: elevation, biomes, towns, trees, clouds. Pure, deterministic. |
| `planet/paint.js` | the palette. Flat fills only. |
| `planet/render.js` | one drawing pass. Knows nothing about which lens it is looking through. |
| `planet/lens.js` | **the three lenses**, and the radial scale they share. |
| `planet/app.js` | mounting, pointer handling, the plate caption. |

The renderer's every level-of-detail decision comes from one number the lens reports — pixels per metre
of ground, right here — so detail appears and dissolves in the same place in all three.

## The three

- **Rim** — one true circle; longitude honest, altitude exaggerated. The forty metres above sea level
  get as much screen as the five hundred kilometres below. Towns under three pixels become marks.
- **Fisheye** — the disc never moves; longitude is redistributed. A window of ground is spread over a
  fixed arc and the rest of the planet is compressed logarithmically into what is left. The falloff is
  solved for derivative continuity, not tuned.
- **Ladder** — the planet stays undistorted and each ring outside it is one slice of the ring within,
  unrolled. Every scale on screen at once; each rung a thin band.

## Three things the building settled

1. **Heights measure from their own ground.** Absolute altitude through a locally true scale put a town
   at 400 m elevation 180 px outside the disc. Terrain keeps the art-directed ramp; an object's own
   height takes whichever is larger, the ramp or a locally true scale.
2. **Magnification is a ground-level effect.** Applied at every altitude it pushed the 130 km shell past
   1.5× the disc wherever the lens magnified, and the atmosphere came out as a lobe. Full strength under
   600 m, gone by 6 km.
3. **The interior is shadow.** Concentric bands of rock were the whole problem with the old planet — the
   eye went to the middle, where nothing happens. The body is now one value barely above the void.

Nothing here uses the main renderer's focus-frame machinery; a prototype only needs about 10⁶ of range,
which float64 gives away for free. Anything taken further has to move onto the real ladder.
