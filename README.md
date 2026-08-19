# The Almanac

A browser-based, procedurally generated universe you can zoom through continuously — from a field of
galaxy clusters down to a single building — with nothing in between missing.

**Live:** https://ericbryant24.github.io/space/

```
scroll to zoom · drag to pan · click to fly · Tab to tour · Backspace to rise · Home to reset
```

The URL is the address. Every camera position round-trips through the fragment, so any place you find
can be shared as a link, and back/forward retrace the route rather than snapping.

## How the zoom works

The ladder spans **2⁷⁶** — about 10²³ metres down to 16 metres. Multiplying world coordinates by a zoom
factor that large destroys float64 long before you reach the ground, so there is **no global coordinate
system**. Instead:

- one global scalar `z` (log₂ pixels per metre), and
- a **focus frame** whose radius is normalised to 1.0, held between **64 and 1024 screen pixels**.

Because the frame's radius is 1.0 in local units, its pixel radius *is* pixels-per-unit. Pinning that to
a 4-bit window means the finest relative precision ever needed at the focus is 2⁻¹⁰, leaving ~42 bits of
mantissa spare — permanently, at any depth.

Descending happens by *halving the frame*: multiply by two, add ±1. That is **bit-exact in float64**, so
the ~76 halvings across the full range introduce exactly zero error. Which is why there is never
anything to pop. A round trip through the entire range returns to within 0.01 px.

## How the content works

Generation is stateless hashing over **named streams** rather than a sequential PRNG. The Nth child
costs the same as the first, and adding a trait later cannot reshuffle the universe and break links
people have already shared.

Two things are placed two different ways. A galaxy's stars are **cell-anchored** — one per cell of a
subdivision grid whose pitch is a fixed multiple of the child's radius — so "what is under the camera"
is a floor division rather than a search. A system's planets sit on **orbits**, because there are under
ten of them and a grid cannot express an orbit.

**Culture belongs to the planet, not the galaxy.** A galaxy is a hundred billion stars; nothing about
language, architecture or life is uniform at that scale. What legitimately spans a galaxy is physics:
its shape, its star population, and a metallicity gradient that reaches all the way down to the colour
of a wall. So naming has two tiers — cosmic objects carry the Almanac Office's catalogue names, and an
inhabited planet and everything below it is named in that world's own language:

> Hearth 6533 IV, called **Wobai** by the people who live there.

Each world's language is generated behind two guards: a 14-bit signature rejected if it lands within
Hamming distance 2 of any of eight Earth clichés, and a forced oddity so every language has at least one
genuinely strange feature. Names within a world measure 6.5× more similar to each other than to names
from another world.

## Running it

```sh
npm install
npm run dev        # http://localhost:5173/space/
npm test           # unit tests (no browser needed)
npm run typecheck
npm run build
```

Nine harnesses drive the real page in Chromium, and every one of them earned its keep by finding
something that reading the code would not have:

```sh
npm run shots      # dives the full ladder, one PNG per rung
npm run worlds     # eight DIFFERENT planets, because one planet says nothing about a generator
npm run perf       # steady-state frame times, sampled between rungs as well as at them
npm run nav        # deep links, back/forward, click-to-fly, pinch, malformed URLs
npm run marks      # bookmarks survive a reload; and that no words appear on screen
npm run seams      # vertical anomalies in the ground that no landscape can account for
npm run pops       # every frame of the whole descent, against how much the zoom accounts for
npm run relief     # how steep the ground actually gets, rung by rung
npm run ruins      # finds a town that stands empty and photographs it at three sizes
```

`src/core`, `src/camera`, `src/universe` and `src/culture` are pure — no DOM — so the hard maths is
covered without a browser harness.

## The rim is the surface

A planet here is a **disc seen edge on**, and its surface is its circumference. Nothing lives in the
middle; a region is an arc of the rim, and zooming into one turns the frame so that arc is horizontal and
gives you a side-on cross-section of the ground — soil over beds of rock, the sea at its own level, and
the sky above it at whatever time of day it is where you are standing.

Everything on that ground is an address. The row of roofs on a settlement's horizon is not a decoration
standing in for houses: they are the settlement's real building slots, drawn at the size and place they
will be when you arrive, and zooming in resolves them rather than replacing them.

## Rare places

Rarity is a **pure function of address**, which is what makes a rare place worth finding — it is in the
same place forever, in the same place for everybody, and a link to it stays true. One settlement in a
hundred and twenty stands empty: no lit windows after dark, no smoke over the roofs, part of the roof
down and the wall head broken with it, the colour weathered out of the walls, and the world growing back
in through the doorways.

Nothing marks it. A rare place is not ringed, pinned or sparkled — it looks different because it *is*
different, and the difference reads from a region away, so it draws the eye without anything being drawn
that is not the place itself.

## Status

Working, end to end: the continuous zoom across all eight rungs, ten galaxy morphologies, systems with
ticking orbits, planets as discs and as ground, climate and biosphere per world, generated languages and
writing systems, architectural grammar filtered by local climate, settlements and building elevations,
bookmarks and permalinks, and empty towns.

Measured: 42 bits of mantissa headroom at the worst point of the descent, no seams across the sampled
shots, no pops across the whole dive, and every rung inside a 16 ms p99 frame budget.

## Licence

MIT.
