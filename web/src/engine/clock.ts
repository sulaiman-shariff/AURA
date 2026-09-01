/**
 * Stimulus timing. Ported unchanged from the original app.js -- the numbers
 * here are the experiment, not the UI, so do not tune them for looks.
 */

/*
 * Stimulus modulation depth.
 *
 * Was 138 +/- 28 -- about 22% of full scale, which is BELOW the entire
 * range tested by Sci. Rep. (2022) on SSVEP amplitude depth (they went
 * 100% down to 30% and recommended ~60%, scoring 94.6% vs 91.7% against
 * full depth while also rating more comfortable).
 *
 * A first calibration at 22% returned 25% accuracy on a 2-target task --
 * below chance -- with 15 Hz scoring LOWER when cued than when not, i.e.
 * no stimulus-locked response at all. An under-driven stimulus is the
 * simplest explanation, so this moves to ~60% depth: 128 +/- 76 spans
 * 52-204, still short of full black-white flicker.
 */
export const LUMINANCE_MIDDLE = 128;
export const LUMINANCE_AMPLITUDE = 76;
// Upper bound on a trial, not its length: the flicker now stops as soon as
// the result arrives. Must still exceed the firmware's 1 s warm-up + 4 s
// analysis window plus polling latency.
export const ACTIVE_SECONDS = 8;
export const REST_SECONDS = 10;

/*
 * Fallback command set, used only until /api/config has answered. The real
 * set lives in the server's COMMAND_HZ; nothing here should be treated as
 * the source of truth.
 */
export const FALLBACK_COMMAND_FREQUENCIES = [15, 17, 19];

// Widest stimulus range the server accepts; the upper bound allows the
// high-frequency band, which is far safer for photosensitive users.
export const MIN_STIMULUS_HZ = 5;
export const MAX_STIMULUS_HZ = 60;

// How long a selection window runs before the result is read back. Must
// exceed the firmware's 1 s warm-up plus 4 s analysis window.
export const SELECTION_SECONDS = 8;

/*
 * Quiet lead-in before a trial's flicker begins, so the page can scroll the
 * stimulus into view and the operator can settle their gaze. Nothing is
 * recorded during it -- the server trial starts only once it has elapsed.
 */
export const READY_SECONDS = 3;

// Fallbacks; the server's /api/config is authoritative.
export const CALIBRATION_TRIALS_PER_FREQUENCY = 8;
export const CALIBRATION_VALIDATION_TRIALS_PER_FREQUENCY = 3;
export const BASELINE_WINDOWS = 3;
export const MAX_TRIAL_ATTEMPTS = 6;
export const RESULT_POLL_ATTEMPTS = 10;
export const RESULT_POLL_INTERVAL_MS = 500;

/*
 * Sampled sinusoidal stimulation (Manyakov et al. 2013): the luminance is a
 * sinusoid sampled at frame times rather than an on/off square wave, so the
 * frequency does NOT have to divide the refresh rate. The only real limit is
 * having enough frames per cycle for the sampled sinusoid to be faithful;
 * Chen et al. (2015) ran 15.8 Hz on a 60 Hz display, so refresh/4 is a
 * defensible ceiling.
 */
export const MAX_REFRESH_FRACTION = 0.25;

/** Idle colour of every stimulus surface. */
export const IDLE_GREY = "#333333";

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

export function measureRefreshRate(): Promise<number> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    let previousTimestamp: number | null = null;

    function measure(timestamp: number) {
      if (previousTimestamp !== null) {
        const interval = timestamp - previousTimestamp;
        if (interval > 1 && interval < 100) {
          intervals.push(interval);
        }
      }
      previousTimestamp = timestamp;

      if (intervals.length < 120) {
        requestAnimationFrame(measure);
        return;
      }

      resolve(1000.0 / median(intervals));
    }

    requestAnimationFrame(measure);
  });
}

export interface ActualFrequency {
  frequency: number;
  framesPerCycle: number;
  clamped: boolean;
}

export function calculateActualFrequency(
  requested: number,
  refreshHz: number,
): ActualFrequency {
  const ceiling = refreshHz * MAX_REFRESH_FRACTION;
  const frequency = Math.min(requested, ceiling);
  return {
    frequency,
    framesPerCycle: refreshHz / frequency,
    clamped: frequency < requested,
  };
}

export function luminanceFor(frequency: number, seconds: number, phase = 0): number {
  const normalized = Math.sin(2 * Math.PI * frequency * seconds + phase);
  const luminance = LUMINANCE_MIDDLE + LUMINANCE_AMPLITUDE * normalized;
  return Math.round(Math.max(0, Math.min(255, luminance)));
}

export function greyCss(value: number): string {
  return `rgb(${value}, ${value}, ${value})`;
}
