import { makeWorld, nameOf } from './world.js';
import { rimLens, fisheyeLens, ladderRing } from './lens.js';
import { TAU, wrap } from './util.js';
import { drawWorld, drawVoid, drawPlate } from './render.js';
import { P } from './paint.js';

const state = { seed: 11, focus: 0, world: makeWorld(11), spin: false };

// Land on the shore of the biggest town, a couple of hundred metres inland: at every zoom in every
// lens that one longitude has water, a coastline, buildings and trees within reach.
function defaultFocus(world) {
  const s = world.sites[0];
  if (!s) return 0;
  const coast = world.coastNear(s.theta);
  const inland = Math.sign(s.theta - coast) || 1;
  return coast + inland * 260 / 6.05e6;
}
state.focus = defaultFocus(state.world);
const panels = [];

export function setSeed(seed) {
  state.seed = seed; state.world = makeWorld(seed);
  // Land on something worth looking at: the biggest town on the new world.
  state.focus = defaultFocus(state.world);
  for (const p of panels) p.hud();
}
export function setSpin(on) { state.spin = on; }
export const getState = () => state;

// What the world is, for the middle of the plate.
function plate(w) {
  const lat = Math.abs(Math.sin(state.focus)) * 0.94;
  const deg = (Math.asin(Math.min(1, lat)) * 180 / Math.PI).toFixed(0);
  const hemi = Math.sin(state.focus) >= 0 ? 'N' : 'S';
  const lines = [
    ['CROSS-SECTION', 'small'],
    [nameOf(state.world.seed * 7919), 'title'],
    ['radius 6 050 km · inclined section', 'body'],
  ];
  if (w > 300) lines.push([`focus ${deg}° ${hemi}`, 'body']);
  return lines;
}

function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  const w = Math.max(120, Math.round(r.width)), h = Math.max(120, Math.round(r.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// --- the three prototypes --------------------------------------------------------------------------

const RENDER = {
  rim(ctx, w, h, k) {
    const S = Math.min(w, h) / 2;
    const lens = rimLens({
      cx: w / 2, cy: h / 2, diskR: S * 0.94, focus: state.focus, relief: k.relief, scale: k.zoom,
    });
    // Zooming a true circle means the circle leaves the frame. Once it does, pin the focus near the
    // top of the panel so what you were looking at stays where you put it.
    const pin = Math.max(0, Math.min(1, (k.zoom - 1) / 1.6));
    lens.cy = h / 2 + (h * 0.20 + lens.seaPx - h / 2) * pin;
    drawWorld(ctx, state.world, lens, { time: k.time, labels: true });
    if (k.zoom < 1.3) drawPlate(ctx, lens, plate(w));
    return lens;
  },
  fisheye(ctx, w, h, k) {
    const S = Math.min(w, h) / 2;
    const lens = fisheyeLens({
      cx: w / 2, cy: h / 2, diskR: S * 0.94,
      focus: state.focus, relief: k.relief, zoom: k.zoom,
    });
    drawWorld(ctx, state.world, lens, { time: k.time, labels: true });
    // The focus window, marked. Without it you cannot tell how much world the middle is showing.
    ctx.save();
    ctx.strokeStyle = P.hudDim; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
    for (const sgn of [-1, 1]) {
      const A = lens.angleOf(state.focus + sgn * lens.w * 0.999);
      ctx.beginPath();
      ctx.moveTo(lens.cx + Math.cos(A) * lens.seaPx * 0.74, lens.cy + Math.sin(A) * lens.seaPx * 0.74);
      ctx.lineTo(lens.cx + Math.cos(A) * S * 1.02, lens.cy + Math.sin(A) * S * 1.02);
      ctx.stroke();
    }
    ctx.restore();
    drawPlate(ctx, lens, plate(w));
    return lens;
  },
  ladder(ctx, w, h, k) {
    const S = Math.min(w, h) / 2;
    const rP = S * 0.30;
    // Three rings, each one slice of the ring inside it, unrolled. The step is the knob: at 10x you
    // get a shallow ladder that stops at a coastline, at 40x you reach a street in three rungs.
    const step = k.zoom;
    // The planet keeps clear air above it -- its own mountains reach 18 px past the sea circle, and a
    // ring starting any closer sheared them off.
    const bounds = [[0.375, 0.56], [0.58, 0.765], [0.785, 0.99]].map(([a, b]) => [a * S, b * S]);
    const planet = rimLens({ cx: w / 2, cy: h / 2, diskR: rP / 0.64, focus: state.focus, relief: k.relief });
    drawWorld(ctx, state.world, planet, { time: k.time, orbit: false, air: 'thin', labels: false });

    let arc = Math.PI / step;
    const lenses = [];
    for (const [rIn, rOut] of bounds) {
      const lens = ladderRing({ cx: w / 2, cy: h / 2, rIn, rOut, focus: state.focus, arc, relief: k.relief });
      ctx.save();
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, rOut, 0, TAU);
      ctx.arc(w / 2, h / 2, rIn, 0, TAU, true);
      ctx.clip();
      ctx.fillStyle = P.void; ctx.fill();
      drawWorld(ctx, state.world, lens, { time: k.time, orbit: false, air: 'thin', labels: rOut > S * 0.78 });
      ctx.restore();
      // Where the unrolled arc wraps. Left unmarked it reads as a crack in the picture; marked, with
      // the rung's span written next to it, it reads as the join it is -- and the ladder stops being
      // ornament and starts being an instrument.
      ctx.save();
      ctx.strokeStyle = P.hudDim; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w / 2, h / 2 + lens.r0); ctx.lineTo(w / 2, h / 2 + rOut);
      ctx.stroke();
      ctx.font = '500 9.5px ui-sans-serif, system-ui, sans-serif';
      ctx.letterSpacing = '0.08em';
      ctx.fillStyle = P.hud; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(`×${Math.round(lens.mag).toLocaleString('en')}  ${span(arc * 2 * 6.05e6)} across`,
        w / 2 + 6, h / 2 + (lens.r0 + rOut) / 2);
      ctx.restore();

      lenses.push(lens);
      arc /= step;
    }

    // The chain, drawn: on the planet and on every ring but the last, the slice that the ring outside
    // it magnifies. It is always the same fraction of whatever it sits on -- one part in `step`.
    ctx.save();
    ctx.strokeStyle = P.hud; ctx.lineWidth = 1.4;
    const marks = [[rP * 1.14, rP * 1.24], ...bounds.slice(0, 2).map(([, rOut], i) => [rOut, bounds[i + 1][0]])];
    const halfSpan = Math.PI / step;
    for (let i = 0; i < marks.length; i++) {
      const [r1, r2] = marks[i];
      for (const sgn of [-1, 1]) {
        const A = -Math.PI / 2 + sgn * halfSpan;
        ctx.beginPath();
        ctx.moveTo(w / 2 + Math.cos(A) * r1, h / 2 + Math.sin(A) * r1);
        ctx.lineTo(w / 2 + Math.cos(A) * r2, h / 2 + Math.sin(A) * r2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, (r1 + r2) / 2, -Math.PI / 2 - halfSpan, -Math.PI / 2 + halfSpan);
      ctx.stroke();
    }
    ctx.setLineDash([2, 5]); ctx.strokeStyle = P.hudDim;
    ctx.beginPath(); ctx.moveTo(w / 2, h / 2 - rP * 0.4); ctx.lineTo(w / 2, h / 2 - S * 0.995); ctx.stroke();
    ctx.restore();
    return lenses[2];
  },
};

// --- mounting --------------------------------------------------------------------------------------

export function mount(root) {
  const kind = root.dataset.lens;
  const canvas = root.querySelector('canvas');
  const readout = root.querySelector('.readout');
  const sliders = [...root.querySelectorAll('input[type=range]')];
  const k = { relief: 1, zoom: kind === 'ladder' ? 14 : (kind === 'rim' ? 1 : 4.4), time: 0 };
  for (const s of sliders) {
    k[s.dataset.knob] = +s.value;
    s.addEventListener('input', () => { k[s.dataset.knob] = +s.value; hud(); });
  }
  let last = null;

  function hud() {
    if (!readout) return;
    const { w } = fit(canvas);
    const S = w;
    void S;
    const l = last;
    if (!l) return;
    const along = l.along(state.focus);
    const win = kind === 'fisheye' ? l.w * 2 * 6.05e6 : (kind === 'ladder' ? l.arc * 2 * 6.05e6 : null);
    const bits = [];
    bits.push(`<b>${fmt(along)}</b> px per metre of ground`);
    if (win != null) bits.push(`window <b>${dist(win)}</b>`);
    bits.push(`whole planet in frame: <b>${kind === 'rim' && k.zoom > 1.02 ? 'no' : 'yes'}</b>`);
    const site = state.world.sites.reduce((a, b) =>
      Math.abs(wrap(b.theta - state.focus)) < Math.abs(wrap(a.theta - state.focus)) ? b : a, state.world.sites[0]);
    if (site) bits.push(`nearest town <b>${nameOf(site.seed)}</b>`);
    readout.innerHTML = bits.join(' · ');
  }

  // drag to travel round the world; the drag maps to real ground, so the same gesture moves a
  // continent at planet scale and a few metres when you are on a street.
  let dragging = false, px = 0;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; px = e.clientX; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || !last) return;
    const along = Math.max(1e-9, last.along(state.focus));
    state.focus -= (e.clientX - px) / (along * 6.05e6);
    px = e.clientX;
    for (const p of panels) p.hud();
  });
  canvas.addEventListener('wheel', (e) => {
    const s = sliders.find((q) => q.dataset.knob === 'zoom');
    if (!s) return;
    e.preventDefault();
    const lo = +s.min, hi = +s.max, span = hi - lo;
    s.value = String(Math.max(lo, Math.min(hi, +s.value - Math.sign(e.deltaY) * span * 0.03)));
    k.zoom = +s.value; hud();
  }, { passive: false });

  function frame(ts) {
    const { ctx, w, h } = fit(canvas);
    k.time = ts / 1000;
    if (state.spin) state.focus += 0.0004;
    drawVoid(ctx, w, h, state.seed);
    last = RENDER[kind](ctx, w, h, k);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  panels.push({ hud });
  setTimeout(hud, 60);
}

const span = (m) => (m > 2e5 ? Math.round(m / 1000).toLocaleString('en') + ' km' : m > 2000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m');
const fmt = (v) => (v >= 1 ? v.toFixed(1) : v >= 0.01 ? v.toFixed(3) : v.toExponential(1));
const dist = (m) => (m > 2e5 ? (m / 1000).toFixed(0) + ' km' : m > 2000 ? (m / 1000).toFixed(1) + ' km' : m.toFixed(0) + ' m');
