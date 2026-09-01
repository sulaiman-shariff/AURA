/*
 * Label placement for the live overlay.
 *
 * Pure geometry, deliberately free of React and the DOM: the flicker patches
 * are immovable, so all of the freedom lives in where the labels go, and that
 * is exactly the part worth testing on its own with a crowded scene.
 */
import type { SceneObject } from "./types";

export interface OverlayItem {
  object: SceneObject;
  /** Flicker frequency, or null for a detected-but-unselectable object. */
  hz: number | null;
  state: "idle" | "winner" | "unsure";
  evidence: number | null;
}

export interface Size {
  w: number;
  h: number;
}

export type Box = { x: number; y: number; w: number; h: number };

export interface Placed extends OverlayItem {
  key: string;
  /** Patch centre, px within the overlay. */
  patchX: number;
  patchY: number;
  /** Chip rectangle, or null when there was nowhere to put it. */
  chip: Box | null;
  side: "right" | "left";
}

/**
 * Side of the flickering square, in px, at the windowed size. ~2-3 degrees at
 * a normal viewing distance.
 *
 * Presentation mode enlarges it in CSS, so this is only the fallback used
 * before the real one has been measured -- assuming it would put the layout
 * out by the difference, which is enough to slide a patch under the readout.
 */
export const PATCH = 54;

/** Gap between the patch and its label chip. */
const LEADER = 14;

/** Clear space required between two chips, in px. */
const GAP = 8;

/** Used only until the first measurement lands, to keep the first paint sane. */
const ESTIMATED_HEIGHT = 34;
const estimateWidth = (label: string) => label.length * 7.5 + 64;

function hits(a: Box, b: Box): boolean {
  return !(
    a.x + a.w + GAP <= b.x ||
    b.x + b.w + GAP <= a.x ||
    a.y + a.h + GAP <= b.y ||
    b.y + b.h + GAP <= a.y
  );
}

/**
 * Find a free slot for one chip on one side of its patch.
 *
 * Starts at the chip's natural height and slides downward past whatever it
 * runs into, then tries the same upward. Returns null if the column is full,
 * which lets the caller try the other side.
 */
function slot(
  patchX: number,
  patchY: number,
  size: Size,
  side: "right" | "left",
  taken: Box[],
  width: number,
  height: number,
  patch: number,
): Box | null {
  const x =
    side === "right"
      ? patchX + patch / 2 + LEADER
      : patchX - patch / 2 - LEADER - size.w;

  if (x < 0 || x + size.w > width) return null;

  const natural = Math.min(Math.max(patchY - size.h / 2, 0), height - size.h);

  for (const direction of [1, -1]) {
    let y = natural;

    for (let guard = 0; guard < 32; guard += 1) {
      const box = { x, y, w: size.w, h: size.h };
      const blocker = taken.find((other) => hits(box, other));
      if (!blocker) return box;

      y = direction === 1 ? blocker.y + blocker.h + GAP : blocker.y - size.h - GAP;
      if (y < 0 || y + size.h > height) break;
    }
  }

  return null;
}

/**
 * Nudge a patch clear of the fixed HUD.
 *
 * A label can be dropped if there is nowhere to put it; a patch cannot. It is
 * the stimulus, and a stimulus half-covered by the status readout is a
 * stimulus with the wrong luminance profile -- the decoder would be scoring a
 * flicker the eye never fully received. So when a patch lands under the HUD it
 * slides along the shortest axis until it is clear, staying within its own
 * object as long as the object is larger than the readout.
 */
function clearOfHud(box: Box, obstacles: Box[], height: number): number {
  let y = box.y;

  for (let guard = 0; guard < 8; guard += 1) {
    const current = { ...box, y };
    const blocker = obstacles.find((other) => hits(current, other));
    if (!blocker) break;

    const below = blocker.y + blocker.h + GAP;
    const above = blocker.y - box.h - GAP;

    if (below + box.h <= height) y = below;
    else if (above >= 0) y = above;
    else break;
  }

  return y + box.h / 2;
}

/**
 * Place every label so that no two collide.
 *
 * Objects are handled top-down, which keeps the result stable frame to frame:
 * a chip only moves when something above it moves. A chip that cannot be
 * placed on either side is dropped rather than stacked, because an unreadable
 * pile of labels is worse than one missing name.
 */
export function layout(
  items: OverlayItem[],
  width: number,
  height: number,
  sizes: Record<string, Size>,
  /**
   * Fixed furniture a label must not land on: the status readout, the HELP and
   * Cancel corners, the intent bar. These are positioned by CSS and cannot
   * move out of the way, so they enter the layout as obstacles.
   */
  obstacles: Box[] = [],
  /** Measured side of the flicker patch; CSS changes it between modes. */
  patch: number = PATCH,
): Placed[] {
  if (width <= 0 || height <= 0) return [];

  const anchored = items.map((item) => {
    const [x0, y0] = item.object.box;
    // The patch straddles the box's top-left corner: on the object, without
    // sitting over the middle of it.
    const patchX = Math.min(Math.max(x0 * width, patch / 2), width - patch / 2);
    const centred = Math.min(Math.max(y0 * height, patch / 2), height - patch / 2);

    return {
      item,
      key: item.object.label,
      patchX,
      patchY:
        item.hz === null
          ? centred
          : clearOfHud(
              { x: patchX - patch / 2, y: centred - patch / 2, w: patch, h: patch },
              obstacles,
              height,
            ),
    };
  });

  anchored.sort((a, b) => a.patchY - b.patchY || a.patchX - b.patchX);

  // Patches are immovable, so they are obstacles for labels, never candidates.
  const taken: Box[] = [...obstacles].concat(
    anchored
      .filter(({ item }) => item.hz !== null)
      .map(({ patchX, patchY }) => ({
        x: patchX - patch / 2,
        y: patchY - patch / 2,
        w: patch,
        h: patch,
      })),
  );

  return anchored.map(({ item, key, patchX, patchY }) => {
    const label = item.object.displayLabel || item.object.label;
    const size = sizes[key] ?? { w: estimateWidth(label), h: ESTIMATED_HEIGHT };

    // Prefer the side with more room, so a patch near the right edge sends its
    // label left instead of burning both attempts.
    const first: "right" | "left" = patchX > width * 0.62 ? "left" : "right";
    const second = first === "right" ? "left" : "right";

    let side = first;
    let chip = slot(patchX, patchY, size, first, taken, width, height, patch);
    if (!chip) {
      side = second;
      chip = slot(patchX, patchY, size, second, taken, width, height, patch);
    }

    if (chip) taken.push(chip);

    return { ...item, key, patchX, patchY, chip, side };
  });
}
