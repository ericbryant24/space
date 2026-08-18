import { Z_MAX } from '../camera/camera.ts';
import type { Cell } from '../universe/node.ts';
import type { CameraState } from './router.ts';

/**
 * BOOKMARKS: the thing that replaced every word on the screen.
 *
 * Names were doing two jobs. One was telling you what you were looking at, which is a job the drawing has to do --
 * a place that needs a caption has not been drawn well enough. The other was letting you keep hold of a place you
 * had found, which no drawing can do, and which a label never really did either: the name of a building four
 * levels down a procedural universe is not something anyone remembers or types back in.
 *
 * A bookmark does that job properly and does it without a word: a thumbnail of the view, and the exact camera
 * state behind it. The picture IS the name, and it is a better name than the generator could write, because it is
 * the place as you saw it.
 *
 * Which makes durability the whole point. A bookmark you lose is not a bookmark, and there is nowhere else to
 * write the place down -- so everything below is about the three ways this store used to lose one.
 */

/** Per universe. A path means nothing in a universe that did not grow it -- see `keyFor`. */
const STORE = 'almanac.marks.v2';

/** The single un-namespaced store this replaced. Read once, redistributed by seed, then dropped. */
const LEGACY = 'almanac.marks.v1';

/** More than a rail's worth is a filing cabinet, and the oldest quietly falls off the end. */
const LIMIT = 14;

/**
 * A thumbnail is a data URL and it goes straight into a CSS `url(...)`, so its charset is a security
 * question, not a tidiness one: anything outside base64 could close the url and carry a declaration
 * of its own into the page. localStorage is editable by anyone who can reach the console, and by any
 * script that ever ran on this origin, so what comes back out of it is untrusted input.
 */
const SHOT = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** The tiles this app writes are a few kilobytes. Anything near this is not one of ours. */
const SHOT_MAX_CHARS = 64 * 1024;

export interface Mark {
  /** Milliseconds since the epoch. Ordering only -- never shown. */
  readonly at: number;
  readonly state: CameraState;
  /** A data URL of the view when it was kept. Small: a JPEG a few kilobytes wide. */
  readonly shot: string;
}

export interface Bookmarks {
  /** Keep the current view. `shot` comes from the live canvas, so the tile is what you were looking at. */
  add(state: CameraState, shot: string): void;
  count(): number;
}

/** One universe's shelf. Two seeds are two different universes and share nothing. */
function keyFor(seed: number): string {
  return `${STORE}.${(seed >>> 0).toString(36)}`;
}

const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const inRange = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * Rebuild a camera state from stored JSON, or refuse it.
 *
 * Every field is checked against what the camera can actually hold, because a bookmark is applied by
 * `applyState` without further question and a nonsense one would drive the focus somewhere the
 * precision invariant does not describe. The bounds are the system's own: the ladder is eight rungs,
 * `z` runs from about -72 at the root to Z_MAX at the bottom, cell indices are non-negative integers
 * below 2^k, and the frame offset is kept small by rebase.
 */
function readState(v: unknown): CameraState | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;

  if (!isIndex(s.seed)) return null;
  if (!Array.isArray(s.path) || s.path.length > 16) return null;
  const path: Cell[] = [];
  for (const raw of s.path) {
    if (!raw || typeof raw !== 'object') return null;
    const { cx, cy } = raw as Record<string, unknown>;
    if (!isIndex(cx) || !isIndex(cy)) return null;
    path.push({ cx, cy });
  }

  // k counts binary subdivisions inside one node; rebase pops out long before it reaches three figures.
  if (!isIndex(s.k) || s.k > 256) return null;
  const bound = 2 ** Math.min(s.k, 53);
  if (!isIndex(s.cx) || !isIndex(s.cy) || s.cx >= bound || s.cy >= bound) return null;
  // The frame has radius 1 and the camera sits inside it; anything past a few frame widths is junk.
  if (!inRange(s.fx, -64, 64) || !inRange(s.fy, -64, 64)) return null;
  if (!inRange(s.z, -128, Z_MAX)) return null;

  return { seed: s.seed, path, k: s.k, cx: s.cx, cy: s.cy, fx: s.fx, fy: s.fy, z: s.z };
}

function readMark(v: unknown): Mark | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  if (typeof m.shot !== 'string' || m.shot.length > SHOT_MAX_CHARS || !SHOT.test(m.shot)) return null;
  const state = readState(m.state);
  if (!state) return null;
  // `at` only orders the rail, and the array is already in order -- a bad timestamp is not worth
  // losing the place over.
  const at = inRange(m.at, 0, Number.MAX_SAFE_INTEGER) ? m.at : 0;
  return { at, state, shot: m.shot };
}

/** Everything at `key` that survives inspection. One bad entry costs one entry, never the shelf. */
function readShelf(key: string): Mark[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    // Storage can be blocked outright (private windows, hardened settings). Then there is no shelf.
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Mark[] = [];
  for (const entry of parsed) {
    const mark = readMark(entry);
    if (mark) out.push(mark);
  }
  return out.slice(-LIMIT);
}

/**
 * Write a shelf, giving ground rather than throwing.
 *
 * Thumbnails are data URLs, so a full rail is tens of kilobytes and `setItem` throwing
 * QuotaExceededError is a matter of when rather than if -- and it throws from inside a click
 * handler, where an escaping error takes the frame loop's callback with it. Each failure evicts the
 * oldest place and tries again, a few times; if even an empty shelf will not write, storage is
 * blocked and there is nothing useful to say about it. Returns what actually got stored, so the rail
 * can show exactly that -- INCLUDING when nothing got stored, which is the whole point. Handing back
 * the list it was asked to write would draw tiles for places that do not exist anywhere, and they
 * would disappear on the next load: a rail that silently forgets, which is the one failure this file
 * is here to prevent.
 */
function writeShelf(key: string, marks: readonly Mark[]): readonly Mark[] {
  let keep = marks;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      localStorage.setItem(key, JSON.stringify(keep));
      return keep;
    } catch {
      if (keep.length === 0) break;
      keep = keep.slice(1);
    }
  }
  // Re-read rather than remember: nothing here wrote, so the shelf is whatever it was, and that is
  // the only list that is true.
  return readShelf(key);
}

let migrated = false;

/**
 * Move the one old un-namespaced shelf onto the per-universe ones.
 *
 * The old store held every seed's places in a single list, so switching universes showed you tiles
 * that flew to coordinates that meant something else entirely. Each kept place records the seed it
 * came from, though, so the old shelf can be dealt out onto the right ones rather than binned.
 */
function migrateLegacy(): void {
  if (migrated) return;
  migrated = true;
  const old = readShelf(LEGACY);
  if (old.length === 0) {
    try {
      localStorage.removeItem(LEGACY);
    } catch {
      // Nothing to clean up if the store will not talk to us.
    }
    return;
  }
  const bySeed = new Map<number, Mark[]>();
  for (const mark of old) {
    const list = bySeed.get(mark.state.seed);
    if (list) list.push(mark);
    else bySeed.set(mark.state.seed, [mark]);
  }
  for (const [seed, list] of bySeed) {
    const key = keyFor(seed);
    // Never over a shelf that already exists: those places were kept more recently than these.
    if (readShelf(key).length === 0) writeShelf(key, list.slice(-LIMIT));
  }
  try {
    localStorage.removeItem(LEGACY);
  } catch {
    // It stays where it is and gets redistributed again next time. Harmless, and idempotent.
  }
}

/**
 * The rail: a column of kept places down the right edge, plus one tile at the foot of it that keeps the current one.
 *
 * Deliberately not a list, not a menu and not a modal. It is a row of pictures, which is the wordless form of
 * "places you kept" -- and the only glyphs on it are a plus and a cross, which are signs rather than language.
 *
 * The keep tile sits outside the scrolling part, so it stays where it is however many places are on the shelf.
 * When it scrolled with them, filling the rail pushed the only way of adding to it off the bottom of the screen.
 */
export function createBookmarks(
  root: HTMLElement,
  onGo: (state: CameraState) => void,
  capture: () => string,
  current: () => CameraState,
): Bookmarks {
  migrateLegacy();

  // The running universe. Its places are the only ones whose coordinates mean anything here.
  const seed = current().seed >>> 0;
  const key = keyFor(seed);
  let marks: readonly Mark[] = readShelf(key).filter((m) => m.state.seed === seed);

  const rail = document.createElement('nav');
  rail.className = 'rail';
  // Attributes are not on the screen, and eight identical picture buttons are unusable without them.
  rail.setAttribute('aria-label', 'Kept views');

  const scroller = document.createElement('div');
  scroller.className = 'marks';
  rail.appendChild(scroller);

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'mark keep';
  add.setAttribute('aria-label', 'Keep this view');
  add.addEventListener('click', () => api.add(current(), capture()));
  rail.appendChild(add);

  root.appendChild(rail);

  const render = (): void => {
    scroller.replaceChildren();
    marks.forEach((mark, i) => {
      const tile = document.createElement('div');
      tile.className = 'mark';

      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'go';
      go.style.backgroundImage = `url("${mark.shot}")`;
      go.setAttribute('aria-label', `Kept view ${i + 1}`);
      go.addEventListener('click', () => onGo(mark.state));

      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'drop';
      drop.setAttribute('aria-label', `Forget kept view ${i + 1}`);
      // The disc is a separate box from the button so the target can be bigger than the sign it draws,
      // and so the two can be sized apart where the tile shrinks -- see the breakpoint in index.html.
      const disc = document.createElement('span');
      disc.className = 'disc';
      drop.appendChild(disc);
      drop.addEventListener('click', (e) => {
        e.stopPropagation();
        // `render` replaces every tile, so the button that was just pressed stops existing and focus
        // falls to the document body -- a keyboard user is dropped out of the rail after every
        // forget and has to tab back in. Where it should land is the tile that moved up into this
        // slot, so a run of deletions is a run of presses in one place, and the keep tile when the
        // shelf empties. Only when this button HAD the focus: a mouse click must not pull it here.
        const slot = marks.indexOf(mark);
        const held = document.activeElement === drop;
        marks = writeShelf(key, marks.filter((m) => m !== mark));
        render();
        if (!held) return;
        const drops = scroller.querySelectorAll<HTMLButtonElement>('.drop');
        (drops[Math.min(slot, drops.length - 1)] ?? add).focus();
      });

      tile.append(go, drop);
      scroller.appendChild(tile);
    });
  };

  const api: Bookmarks = {
    add(state, shot) {
      // The picture is the name. A tile with nothing on it names nothing, so it is not kept at all --
      // and a shot that fails inspection here would be dropped on the next load anyway, which would
      // look like the rail forgetting things at random.
      if (shot.length > SHOT_MAX_CHARS || !SHOT.test(shot)) return;
      marks = writeShelf(key, [...marks, { at: Date.now(), state, shot }].slice(-LIMIT));
      render();
      // The new tile goes on the end, and the end is below the fold on any window shorter than about
      // 770px -- so on a laptop, pressing the keep key looked exactly like nothing happening. The
      // only evidence that a place was kept is the picture of it, so the rail has to be showing it.
      scroller.scrollTop = scroller.scrollHeight;
    },
    count() {
      return marks.length;
    },
  };

  render();
  return api;
}
