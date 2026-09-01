/**
 * One decode window: flicker a frequency set, stop, and read back what the
 * headset decided.
 *
 * Extracted so the live session and the scene loop share it. This is the
 * piece where a subtle mistake is expensive -- a stale trial id, or acting
 * after the caller has stopped -- so there should be exactly one copy.
 */
import { RESULT_POLL_INTERVAL_MS, SELECTION_SECONDS, sleep } from "./clock";
import { fetchServerState, startTrial, stopTrial } from "./api";
import { setState } from "./store";
import type { TrialResult } from "./types";

export interface DecodeWindowOptions {
  /** Index 0 is the cued target; the firmware reports best_index across all. */
  frequencies: number[];
  refreshHz: number;
  seconds?: number;
  /** Checked every second; true abandons the window without acting on it. */
  isAborted: () => boolean;
  /** Called each second with the seconds remaining, for the countdown. */
  onTick?: (remaining: number) => void;
}

export type DecodeFailure = "start-failed" | "aborted" | "no-result";

export interface DecodeOutcome {
  result: TrialResult | null;
  failure: DecodeFailure | null;
  detail?: string;
}

export async function runDecodeWindow(
  options: DecodeWindowOptions,
): Promise<DecodeOutcome> {
  const { frequencies, refreshHz, isAborted, onTick } = options;
  const seconds = options.seconds ?? SELECTION_SECONDS;

  const response = await startTrial({
    requested_hz: frequencies[0],
    actual_hz: frequencies[0],
    competitors: frequencies.slice(1),
    refresh_hz: refreshHz,
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    return {
      result: null,
      failure: "start-failed",
      detail: detail.error ?? String(response.status),
    };
  }

  const trialId = ((await response.json()) as { trial_id: number }).trial_id;

  setState({ selectionRunning: true });

  /*
   * Poll for the result WHILE the stimulus is still running, and stop the
   * moment it arrives.
   *
   * Previously the flicker ran for a fixed duration and only then began
   * polling, so the user kept staring at a strobing target for seconds
   * after the headset had already decided. That is pure eye strain, and
   * with SSVEP adaptation it makes the next trial worse too.
   *
   * The deadline still bounds the wait: the firmware needs its warm-up plus
   * analysis window before it can post anything, so a few seconds of slack
   * past `seconds` covers polling latency without hanging forever.
   */
  const deadline = Date.now() + (seconds + 6) * 1000;
  let found: TrialResult | null = null;
  let lastTick = seconds;

  while (Date.now() < deadline) {
    if (isAborted()) {
      setState({ selectionRunning: false });
      await stopTrial();
      return { result: null, failure: "aborted" };
    }

    const serverState = await fetchServerState();
    const result = serverState?.last_result;

    // The trial id check matters: without it a result left over from a
    // previous window would be read as this one's answer.
    if (result && result.trial_id === trialId) {
      found = result;
      break;
    }

    const remaining = Math.ceil((deadline - Date.now()) / 1000) - 6;
    if (remaining !== lastTick && remaining > 0) {
      lastTick = remaining;
      onTick?.(remaining);
    }

    await sleep(RESULT_POLL_INTERVAL_MS);
  }

  setState({ selectionRunning: false });
  await stopTrial();

  if (found) return { result: found, failure: null };
  if (isAborted()) return { result: null, failure: "aborted" };

  return { result: null, failure: "no-result" };
}
