/**
 * The one requestAnimationFrame loop that drives every flickering surface.
 *
 * It writes directly to DOM elements registered by the React components,
 * bypassing React state on purpose: the stimulus must update every frame
 * with as little jitter as possible, and a re-render per frame would add
 * work between the frame callback and the paint.
 */
import { getState } from "./store";
import { IDLE_GREY, greyCss, luminanceFor } from "./clock";

interface Tile {
  element: HTMLElement;
  hz: number;
  phase: number;
}

let stimulusElement: HTMLElement | null = null;

/*
 * Keyed by a caller-supplied string rather than a bare index, because more
 * than one panel renders tiles: a plain index would have the live session's
 * tile 0 silently overwrite the selection panel's tile 0.
 */
const tiles = new Map<string, Tile>();
let started = false;

export function attachStimulus(element: HTMLElement | null): void {
  stimulusElement = element;
  if (element) element.style.background = IDLE_GREY;
}

export function attachTile(
  key: string,
  element: HTMLElement,
  hz: number,
  phase = 0,
): () => void {
  element.style.background = IDLE_GREY;
  tiles.set(key, { element, hz, phase });
  return () => {
    if (tiles.get(key)?.element === element) tiles.delete(key);
  };
}

/*
 * Bring the surface that is about to flicker into view.
 *
 * The controls that start a trial can sit far down a long page while the
 * stimulus lives at the top, so the operator had to scroll up after
 * clicking -- and arrived several seconds into a recording window that had
 * already started. That is not just awkward: the analysis window then
 * contains the scroll rather than the response.
 *
 * Paired with the lead-in countdown in session.ts, which does not begin the
 * server trial until the scroll has had time to finish.
 */
function scrollElementIntoView(element: HTMLElement | null): void {
  if (!element) return;

  try {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch {
    // Older engines reject the options object; the plain form still works.
    element.scrollIntoView();
  }
}

export function scrollStimulusIntoView(): void {
  scrollElementIntoView(stimulusElement);
}

/** Scroll the first registered tile whose key starts with `prefix`. */
export function scrollTilesIntoView(prefix: string): void {
  for (const [key, tile] of tiles) {
    if (key.startsWith(prefix)) {
      scrollElementIntoView(tile.element);
      return;
    }
  }
}

export function resetStimulusSurface(): void {
  if (stimulusElement) stimulusElement.style.background = IDLE_GREY;
}

function frame(): void {
  const state = getState();
  const elapsedSeconds = performance.now() / 1000;

  if (stimulusElement) {
    if (state.flickerRunning && state.actualHz > 0) {
      stimulusElement.style.background = greyCss(
        luminanceFor(state.actualHz, elapsedSeconds),
      );
    } else {
      stimulusElement.style.background = IDLE_GREY;
    }
  }

  // All tiles share one clock, so their relative phase is well defined --
  // which is what a phase-coded scheme (JFPM) would later depend on.
  for (const tile of tiles.values()) {
    if (state.selectionRunning) {
      tile.element.style.background = greyCss(
        luminanceFor(tile.hz, elapsedSeconds, tile.phase),
      );
    } else {
      tile.element.style.background = IDLE_GREY;
    }
  }

  requestAnimationFrame(frame);
}

export function startAnimator(): void {
  if (started) return;
  started = true;
  requestAnimationFrame(frame);
}
