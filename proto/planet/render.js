// One drawing pass, shared by every prototype.
//
// It knows the world and the paint and nothing at all about which lens it is looking through. Every
// decision about what is worth drawing comes from one number the lens reports -- pixels per metre of
// ground, right here -- so detail appears and dissolves in the same place in all three prototypes.

import { R, ATM, ORBIT, nameOf } from './world.js';
import { P, BIOME_FILL } from './paint.js';
import { TAU, clamp, wrap } from './util.js';
const WET = { abyss: 1, shelf: 1, seaIce: 1 };

// --- sampling --------------------------------------------------------------------------------------

export function sampleRim(world, lens, budget = 5200) {
  const [t0, t1] = lens.window();
  const full = t1 - t0 >= TAU - 1e-9;
  const pts = [];
  let t = t0, guard = 0;
  while (t <= t1 && guard++ < budget) {
    const A = lens.angleOf(t), rho = lens.rho(world.elevation(t), t);
    pts.push({
      t, e: world.elevation(t), b: world.biome(t), A,
      ca: Math.cos(A), sa: Math.sin(A),
      x: lens.cx + Math.cos(A) * rho, y: lens.cy + Math.sin(A) * rho,
    });
    // Two pixels of ground per sample, wherever the lens happens to be looking closely.
    const along = Math.max(1e-12, lens.along(t));
    t += clamp(2 / (along * R), 1e-11, (t1 - t0) / 90);
  }
  if (full && pts.length) pts.push({ ...pts[0], t: pts[0].t + TAU });
  return { pts, full };
}

const at = (lens, s, alt) => {
  const rho = lens.rho(alt, s.t);
  return [lens.cx + s.ca * rho, lens.cy + s.sa * rho];
};
const atPx = (lens, s, alt, dpx) => {
  const rho = lens.rho(alt, s.t) + dpx;
  return [lens.cx + s.ca * rho, lens.cy + s.sa * rho];
};

/**
 * Fill bands hugging the rim, batched by colour.
 *
 * Batching is not an optimisation, it is a correctness fix: drawn one quad per sample, every pair of
 * neighbouring quads of the SAME colour left a faint antialiased seam, and 700 of them round the rim
 * read as a dotted line. Consecutive samples that agree become one polygon and the seams go away.
 */
function fillRuns(ctx, lens, pts, keyOf, colourOf, topOf, botOf) {
  let i = 0;
  while (i < pts.length - 1) {
    const k = keyOf(pts[i]);
    if (k == null) { i++; continue; }
    let j = i;
    while (j < pts.length - 1 && keyOf(pts[j + 1]) === k) j++;
    if (j === i) j = Math.min(i + 1, pts.length - 1);
    ctx.beginPath();
    for (let n = i; n <= j; n++) { const [x, y] = topOf(pts[n]); n === i ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    for (let n = j; n >= i; n--) { const [x, y] = botOf(pts[n]); ctx.lineTo(x, y); }
    ctx.closePath();
    ctx.fillStyle = colourOf(k, pts[i]);
    ctx.fill();
    i = j;
  }
}

// --- the pass --------------------------------------------------------------------------------------

export function drawWorld(ctx, world, lens, o = {}) {
  placed.length = 0;
  const { pts, full } = sampleRim(world, lens);
  if (pts.length < 2) return;
  const time = o.time || 0;
  const alongFocus = lens.along(lens.focus);
  const ring = !!lens.ringGround;

  // Atmosphere: three flat translucent shells rather than one gradient. Stepped air is a choice, not
  // a limitation -- the same reason nothing else here is feathered.
  if (o.air !== false) {
    const shells = o.air === 'thin'
      ? [[0, ATM, 0.09]]
      : [[0, 9e3, 0.26], [9e3, 3.4e4, 0.11], [3.4e4, ATM, 0.05]];
    for (const [lo, hi, alpha] of shells) {
      ctx.globalAlpha = alpha;
      fillRuns(ctx, lens, pts, () => 'air', () => P.air, (s) => at(lens, s, hi), (s) => at(lens, s, lo));
    }
    ctx.globalAlpha = 1;
  }

  // Solid body. One polygon, closed through the middle when the lens shows the whole rim.
  ctx.beginPath();
  for (let n = 0; n < pts.length; n++) { const [x, y] = at(lens, pts[n], pts[n].e); n ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  if (!full) for (let n = pts.length - 1; n >= 0; n--) { const [x, y] = atPx(lens, pts[n], 0, -(lens.seaPx * 0.42)); ctx.lineTo(x, y); }
  ctx.closePath();
  ctx.fillStyle = P.crust;
  ctx.fill();

  // Interior, only while the whole body is in frame. Two quiet discs: the point of this idea is that
  // the interior is NOT where you look, so it gets two values and no rings.
  if (full && !ring && lens.mag < 4) {
    // Two values, not five. Enough to say "this is a body with an inside", not enough to look at.
    ctx.beginPath();
    ctx.arc(lens.cx, lens.cy, lens.rho(-4.2e5, lens.focus), 0, TAU);
    ctx.fillStyle = P.mantle; ctx.fill();
    ctx.beginPath();
    ctx.arc(lens.cx, lens.cy, lens.rho(-2.6e6, lens.focus), 0, TAU);
    ctx.fillStyle = P.coreHot; ctx.fill();
  }

  // Water. Two passes, not two colours in one: keyed by depth in a single pass, the boundary between
  // shelf and abyss ran from the sea SURFACE down, so every change of depth class cut a vertical step
  // in the sea like torn paper. Filling the shelf everywhere and then laying the abyss under a fixed
  // depth contour puts the boundary where it belongs -- along the water, not across it.
  fillRuns(ctx, lens, pts, (s) => (s.e < 0 ? 'sea' : null), () => P.shelf,
    (s) => at(lens, s, 0), (s) => at(lens, s, s.e));
  fillRuns(ctx, lens, pts, (s) => (s.e < -2600 ? 'deep' : null), () => P.abyss,
    (s) => at(lens, s, -2600), (s) => at(lens, s, s.e));

  // The coloured rind: the top few pixels of the crust, which is all of a planet anyone ever sees.
  // The rind carries every colour in the picture, so it gets real weight -- 4% of the disc, not 2%.
  const rindPx = ring ? 6 : Math.max(5, Math.min(18, lens.seaPx * 0.04));
  fillRuns(ctx, lens, pts,
    (s) => s.b,
    (k) => BIOME_FILL[k],
    (s) => at(lens, s, WET[s.b] ? 0 : s.e),
    (s) => atPx(lens, s, WET[s.b] ? 0 : s.e, -rindPx));

  // Ink on the ground line. Sea and land take different weights so a coast still reads as a coast
  // when the whole planet is 500 px across.
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  for (let n = 0; n < pts.length; n++) {
    const [x, y] = at(lens, pts[n], WET[pts[n].b] ? 0 : pts[n].e);
    n ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = P.ink; ctx.lineWidth = 1.1; ctx.stroke();

  drawFlora(ctx, world, lens, pts);
  drawTowns(ctx, world, lens, o);
  if (o.air !== false) drawClouds(ctx, world, lens, time, full);
  if (full && !ring && o.orbit !== false) drawOrbit(ctx, world, lens, time);
  void alongFocus;
}

// --- flora -----------------------------------------------------------------------------------------

const SPACING = { forest: 52, jungle: 30 };

function drawFlora(ctx, world, lens, pts) {
  // Wherever a single tree would be under two pixels wide, the forest is a fringe on the rind instead
  // of a crowd of dots -- same silhouette, and it does not shimmer when the planet turns.
  const runs = [];
  let i = 0;
  while (i < pts.length - 1) {
    const b = pts[i].b;
    if (b !== 'forest' && b !== 'jungle') { i++; continue; }
    let j = i;
    while (j < pts.length - 1 && pts[j + 1].b === b) j++;
    runs.push([i, Math.max(j, i + 1), b]);
    i = j + 1;
  }
  for (const [i, j, b] of runs) {
    const t0 = pts[i].t, t1 = pts[j].t;
    const sp = SPACING[b];
    const wpx = sp * lens.along((t0 + t1) / 2);
    const col = b === 'jungle' ? P.jungleCanopy : P.canopy;
    if (wpx < 2.2) {
      // fringe: a saw-toothed band on top of the rind
      ctx.beginPath();
      for (let n = i; n <= j; n++) {
        const s = pts[n];
        const h = (n % 2 ? 3.4 : 5.6) + (b === 'jungle' ? 1.6 : 0);
        const [x, y] = atPx(lens, s, s.e, h);
        n === i ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      for (let n = j; n >= i; n--) { const [x, y] = atPx(lens, pts[n], pts[n].e, -1); ctx.lineTo(x, y); }
      ctx.closePath(); ctx.fillStyle = col; ctx.fill();
      continue;
    }
    for (const tr of world.trees(t0, t1, sp, 2600)) {
      const e = world.elevation(tr.theta);
      if (e <= 0) continue;
      const h = 16 + 22 * ((tr.seed * 2654435761 >>> 8) % 997) / 997 + (b === 'jungle' ? 12 : 0);
      const A = lens.angleOf(tr.theta), ca = Math.cos(A), sa = Math.sin(A);
      const r0 = lens.rho(e, tr.theta);
      const hpx = lens.height(e, h, tr.theta);
      if (hpx < 1.5) continue;
      const rad = Math.max(1.1, hpx * 0.42);
      const mx = lens.cx + ca * (r0 + hpx * 0.62), my = lens.cy + sa * (r0 + hpx * 0.62);
      ctx.beginPath(); ctx.ellipse(mx, my, rad * 0.9, hpx * 0.5, A, 0, TAU);
      ctx.fillStyle = (tr.seed & 3) ? col : P.canopyLit; ctx.fill();
      if (hpx > 14) {
        ctx.beginPath();
        ctx.moveTo(lens.cx + ca * r0, lens.cy + sa * r0);
        ctx.lineTo(mx, my);
        ctx.strokeStyle = P.ink; ctx.lineWidth = Math.max(1, hpx * 0.09); ctx.stroke();
      }
    }
  }
}

// --- towns -----------------------------------------------------------------------------------------

function drawTowns(ctx, world, lens, o) {
  const [w0, w1] = lens.window();
  for (const site of world.sites) {
    let th = site.theta;
    // bring the site into the window's branch
    const d = wrap(th - (w0 + w1) / 2);
    th = (w0 + w1) / 2 + d;
    if (th < w0 - 0.02 || th > w1 + 0.02) continue;
    const along = lens.along(th);
    const spanPx = site.half * 2 * along;
    const e = world.elevation(th);
    if (e <= 0) continue;
    const A = lens.angleOf(th), ca = Math.cos(A), sa = Math.sin(A);

    if (spanPx < 3.2) {
      // A town too small to draw is still a town: a mark, at a minimum readable size. Symbology, not
      // geometry -- the alternative is a world that looks uninhabited from orbit.
      const r0 = lens.rho(e, th);
      const hp = 4 + 5 * site.weight * 3;
      ctx.save(); ctx.translate(lens.cx + ca * r0, lens.cy + sa * r0); ctx.rotate(A + Math.PI / 2);
      ctx.fillStyle = P.wall; ctx.fillRect(-1.4, -hp, 2.8, hp);
      ctx.fillStyle = P.window; ctx.fillRect(-0.6, -hp + 1.2, 1.2, 1.2);
      ctx.restore();
      if (o.labels && site.weight > 0.22) label(ctx, lens, th, e, hp + 6, nameOf(site.seed), A);
      continue;
    }

    const plots = world.plots(site);
    for (const b of plots) {
      const bt = th + b.x / R;
      const be = world.elevation(bt);
      if (be <= 0) continue;
      const bA = lens.angleOf(bt);
      const wpx = b.w * lens.along(bt);
      const r0 = lens.rho(be, bt), hpx = lens.height(be, b.h, bt);
      if (hpx < 0.7) continue;
      ctx.save();
      ctx.translate(lens.cx + Math.cos(bA) * r0, lens.cy + Math.sin(bA) * r0);
      ctx.rotate(bA + Math.PI / 2);
      const ww = Math.max(0.9, wpx);
      ctx.fillStyle = b.kind === 'tower' ? P.tower : P.wall;
      ctx.fillRect(-ww / 2, -hpx, ww, hpx);
      if (ww > 3) { ctx.fillStyle = P.wallShade; ctx.fillRect(ww / 2 - ww * 0.28, -hpx, ww * 0.28, hpx); }
      if (ww > 3.5 && hpx > 5) {
        ctx.fillStyle = P.roof;
        ctx.fillRect(-ww / 2 - 0.6, -hpx - Math.max(1, hpx * 0.05), ww + 1.2, Math.max(1, hpx * 0.05));
      }
      if (ww > 7 && hpx > 12) {
        ctx.fillStyle = P.window;
        const rows = Math.floor(hpx / 7), cols = Math.max(1, Math.floor(ww / 6));
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          if (((b.seed + r * 7 + c * 13) % 5) === 0) continue;
          ctx.fillRect(-ww / 2 + 2 + c * 6, -hpx + 3 + r * 7, 2.4, 3.0);
        }
      }
      ctx.restore();
    }
    if (o.labels) label(ctx, lens, th, e, 14 + spanPx * 0.02, nameOf(site.seed), A);
  }
}

const placed = [];

function label(ctx, lens, th, e, lift, text, A) {
  const r = lens.rho(e, th) + lift;
  const x = lens.cx + Math.cos(A) * r, y = lens.cy + Math.sin(A) * r;
  // Two names on top of each other are worse than one name: a rim that compresses will always want to
  // stack them, so the second one loses.
  for (const [px, py] of placed) if (Math.abs(px - x) < 46 && Math.abs(py - y) < 13) return;
  placed.push([x, y]);
  ctx.save();
  ctx.translate(x, y); ctx.rotate(A + Math.PI / 2);
  const up = Math.abs(wrap(A + Math.PI / 2)) > Math.PI / 2;
  if (up) ctx.rotate(Math.PI);
  ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = up ? 'top' : 'bottom';
  ctx.fillStyle = P.hud;
  ctx.fillText(text, 0, up ? 11 : -3);
  ctx.restore();
}

// --- sky -------------------------------------------------------------------------------------------

function drawClouds(ctx, world, lens, time, full) {
  const [w0, w1] = lens.window();
  for (const c of world.clouds) {
    let t0 = c.theta + c.drift * time * 60;
    const mid = (w0 + w1) / 2;
    t0 = mid + wrap(t0 - mid);
    if (t0 < w0 || t0 > w1) continue;
    const hp = lens.height(c.alt, c.thick, t0);
    if (hp < 2.4) continue;
    const lenPx = c.len * R * lens.along(t0);
    if (lenPx < 6) continue;
    const n = Math.min(14, Math.max(3, Math.round(lenPx / Math.max(2, hp * 0.8))));
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = P.cloud;
    for (let k = 0; k < n; k++) {
      const f = k / (n - 1);
      const t = t0 + c.len * f * (full ? 1 : 1);
      const A = lens.angleOf(t);
      const rad = hp * (0.5 + 0.42 * Math.sin(Math.PI * f) + 0.12 * (((c.seed + k) % 3) / 3));
      const r = lens.rho(c.alt + c.thick * 0.5, t);
      ctx.beginPath();
      ctx.ellipse(lens.cx + Math.cos(A) * r, lens.cy + Math.sin(A) * r, rad * 0.95, rad * 0.78, A, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function drawOrbit(ctx, world, lens, time) {
  ctx.save();
  ctx.setLineDash([2, 7]);
  ctx.beginPath(); ctx.arc(lens.cx, lens.cy, lens.rho(ORBIT, lens.focus), 0, TAU);
  ctx.strokeStyle = P.orbit; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
  for (const st of world.stations) {
    const t = st.theta + st.drift * time * 60;
    const A = lens.angleOf(t), r = lens.rho(st.alt, t);
    const x = lens.cx + Math.cos(A) * r, y = lens.cy + Math.sin(A) * r;
    ctx.save(); ctx.translate(x, y); ctx.rotate(A);
    ctx.fillStyle = P.hud; ctx.fillRect(-2.5, -1.2, 5, 2.4);
    ctx.fillStyle = P.window; ctx.fillRect(-0.7, -0.6, 1.4, 1.2);
    ctx.restore();
  }
}

// --- backdrop --------------------------------------------------------------------------------------

export function drawVoid(ctx, w, h, seed = 3) {
  ctx.fillStyle = P.void; ctx.fillRect(0, 0, w, h);
  let s = seed * 2654435761 >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  ctx.fillStyle = P.star;
  for (let i = 0; i < 260; i++) {
    const x = rnd() * w, y = rnd() * h, r = rnd() * rnd() * 1.5 + 0.2;
    ctx.globalAlpha = 0.25 + rnd() * 0.6;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * The plate's caption, in the middle.
 *
 * Not decoration: a cross-section leaves 60% of the picture empty by construction, and an empty
 * middle full of nothing reads as a mistake. Filling it with what the world IS turns the hole into
 * the reason the drawing is shaped this way -- an almanac plate, not a doughnut.
 */
export function drawPlate(ctx, lens, lines) {
  ctx.save();
  ctx.textAlign = 'center';
  let y = lens.cy - (lines.length - 1) * 11;
  for (const [text, weight] of lines) {
    ctx.font = weight === 'title'
      ? '600 17px ui-serif, Georgia, serif'
      : (weight === 'small' ? '500 10px ui-sans-serif, system-ui, sans-serif' : '400 12px ui-sans-serif, system-ui, sans-serif');
    if (weight === 'small') { ctx.letterSpacing = '0.14em'; } else { ctx.letterSpacing = '0em'; }
    ctx.fillStyle = weight === 'title' ? P.hud : P.hudDim;
    ctx.fillText(text, lens.cx, y);
    y += weight === 'title' ? 24 : 17;
  }
  ctx.restore();
}
