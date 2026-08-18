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
 */

const KEY = 'almanac.marks.v1';

/** More than a rail's worth is a filing cabinet, and the oldest quietly falls off the end. */
const LIMIT = 14;

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

function load(): Mark[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Anything malformed is discarded rather than trusted: this is user-editable storage.
    return parsed.filter(
      (m): m is Mark =>
        !!m && typeof m === 'object' && typeof (m as Mark).shot === 'string' && !!(m as Mark).state,
    );
  } catch {
    return [];
  }
}

function save(marks: readonly Mark[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(marks));
  } catch {
    // A full or blocked store is not worth interrupting anyone over; the rail simply does not persist.
  }
}

/**
 * The rail: a column of kept places down the right edge, plus one empty tile that keeps the current one.
 *
 * Deliberately not a list, not a menu and not a modal. It is a row of pictures, which is the wordless form of
 * "places you kept" -- and the only glyphs on it are a plus and a cross, which are signs rather than language.
 */
export function createBookmarks(
  root: HTMLElement,
  onGo: (state: CameraState) => void,
  capture: () => string,
  current: () => CameraState,
): Bookmarks {
  let marks = load();

  const rail = document.createElement('div');
  rail.className = 'rail';
  root.appendChild(rail);

  const render = (): void => {
    rail.replaceChildren();
    for (const mark of marks) {
      const tile = document.createElement('button');
      tile.className = 'mark';
      tile.style.backgroundImage = `url(${mark.shot})`;
      // A title is a tooltip rather than something on the screen, and it is the one accessible handle a
      // picture-only control has. Screen readers need SOMETHING; the view itself stays wordless.
      tile.title = 'Go';
      tile.addEventListener('click', () => onGo(mark.state));

      const drop = document.createElement('span');
      drop.className = 'drop';
      drop.title = 'Forget';
      drop.addEventListener('click', (e) => {
        e.stopPropagation();
        marks = marks.filter((m) => m !== mark);
        save(marks);
        render();
      });
      tile.appendChild(drop);
      rail.appendChild(tile);
    }

    const add = document.createElement('button');
    add.className = 'mark keep';
    add.title = 'Keep this view';
    add.addEventListener('click', () => api.add(current(), capture()));
    rail.appendChild(add);
  };

  const api: Bookmarks = {
    add(state, shot) {
      marks = [...marks, { at: Date.now(), state, shot }].slice(-LIMIT);
      save(marks);
      render();
    },
    count() {
      return marks.length;
    },
  };

  render();
  return api;
}
