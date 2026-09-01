/**
 * How much the camera view is changing, right now.
 *
 * The scene layer uses this to decide when a slow, accurate detector is
 * worth running. A cloud call takes 1-2 s; if the view is moving, its answer
 * describes a frame that no longer exists by the time it arrives. If the
 * view is still, that same answer is as valid when it lands as when it was
 * asked, so the latency stops mattering and only the accuracy counts.
 *
 * Deliberately crude: a 32x24 greyscale difference is a few hundred
 * microseconds and runs between detections without being noticeable. It
 * measures *change*, not motion in any structured sense -- a hand waving
 * through frame, the camera being nudged, and the lights being switched all
 * register, which is exactly right, because all three invalidate a stale
 * detection.
 */

const SAMPLE_WIDTH = 32;
const SAMPLE_HEIGHT = 24;

let canvas: HTMLCanvasElement | null = null;
let previous: Uint8ClampedArray | null = null;

function ensureCanvas(): CanvasRenderingContext2D | null {
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = SAMPLE_WIDTH;
    canvas.height = SAMPLE_HEIGHT;
  }
  // willReadFrequently: this is read back every frame.
  return canvas.getContext("2d", { willReadFrequently: true });
}

export function resetMotion(): void {
  previous = null;
}

/**
 * Mean absolute luma change since the previous call, normalised to 0..1.
 *
 * Returns 1 on the first call (nothing to compare against yet), so a caller
 * treats a fresh session as "moving" until it has seen two frames.
 */
export function frameChange(video: HTMLVideoElement): number {
  if (!video.videoWidth || !video.videoHeight) return 1;

  const context = ensureCanvas();
  if (!context) return 1;

  context.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);

  let current: Uint8ClampedArray;
  try {
    current = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data;
  } catch {
    return 1;
  }

  if (!previous || previous.length !== current.length) {
    previous = new Uint8ClampedArray(current);
    return 1;
  }

  let total = 0;
  for (let i = 0; i < current.length; i += 4) {
    // Rec. 601 luma, cheaply.
    const a = (current[i] * 299 + current[i + 1] * 587 + current[i + 2] * 114) / 1000;
    const b = (previous[i] * 299 + previous[i + 1] * 587 + previous[i + 2] * 114) / 1000;
    total += Math.abs(a - b);
  }

  previous = new Uint8ClampedArray(current);

  return total / (SAMPLE_WIDTH * SAMPLE_HEIGHT) / 255;
}
