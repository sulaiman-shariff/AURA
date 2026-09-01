/**
 * The live session loop: continuous decode windows over a persistent tile
 * set, with HELP and CANCEL always present.
 *
 * This is the first piece of AURA that behaves like the actual product
 * rather than an experiment. `runSelection` in session.ts fires one window
 * and stops; here windows run back to back until the operator stops the
 * session, which is what an assistive device has to do.
 *
 * WHY HELP NEEDS TWO WINDOWS
 * --------------------------
 * The design calls for HELP to fire on a single deliberate act, with an
 * audible countdown the user can abort by looking away. A countdown is only
 * meaningful if something can actually observe the user looking away, and
 * the only observation available is the next decode window. So HELP
 * requires two consecutive windows: the first starts the countdown and
 * speaks a warning, and the second either confirms it or -- if the user has
 * looked at anything else, or at nothing -- aborts it.
 *
 * That makes HELP slower than the ~6 s in the design document (two windows
 * is roughly 10 s with the current 1 s warm-up plus 4 s analysis). The
 * honest fix is a shorter analysis window, which needs the multi-channel
 * decoder; padding the number here would only make the countdown a lie.
 *
 * WHAT "LOCAL" MEANS TODAY
 * ------------------------
 * The audible alarm and the on-screen alert are produced in the browser
 * with no network call, so they survive losing the internet. The EEG still
 * arrives via the server, so HELP is not yet end-to-end local -- see the
 * offline discussion in README section 8.4. This narrows the gap; it does
 * not close it.
 */
import { READY_SECONDS, SELECTION_SECONDS, sleep } from "./clock";
import { fetchAllocation, raiseHelpAlert, stopTrial } from "./api";
import { runDecodeWindow } from "./decode";
import { scrollTilesIntoView } from "./animator";
import { getState, notify, patchLive, setState } from "./store";
import { alarmTone, speak, stopSpeaking } from "./speech";
import type { Band, LiveTile, TrialResult } from "./types";

/** Consecutive HELP windows required before the alarm fires. */
const HELP_WINDOWS_REQUIRED = 2;

/** Rest between windows, so the user can move their gaze without it counting. */
const INTER_WINDOW_MS = 900;

/**
 * Incremented on every stop. A loop iteration compares against this before
 * acting, so a session that is stopped mid-window cannot fire HELP or post
 * a stale selection afterwards.
 */
let generation = 0;

export function stopLiveSession(): void {
  generation += 1;
  stopSpeaking();
  setState({ selectionRunning: false });
  patchLive({
    running: false,
    helpStreak: 0,
    helpCountdown: null,
    status: "Session stopped.",
    detail: "",
  });
  void stopTrial();
}

export function acknowledgeHelp(): void {
  patchLive({ helpFired: false, status: "Help acknowledged.", detail: "" });
}

/**
 * Build the tile set. HELP takes the lowest allocated frequency because the
 * 8-15 Hz band has the best SSVEP SNR and this is the one tile that must
 * work; CANCEL takes the next. Whatever is left becomes options.
 */
export function buildLiveTiles(
  allocated: number[],
  optionLabels: string[],
): LiveTile[] {
  if (allocated.length < 3) return [];

  const tiles: LiveTile[] = [
    { hz: allocated[0], label: "HELP", kind: "help" },
    { hz: allocated[1], label: "Cancel", kind: "cancel" },
  ];

  const optionFrequencies = allocated.slice(2);

  optionFrequencies.forEach((hz, index) => {
    tiles.push({
      hz,
      label: optionLabels[index] ?? `Option ${index + 1}`,
      kind: "option",
    });
  });

  return tiles;
}

/** Run one decode window over the tile set. Returns null if it was aborted. */
async function runWindow(
  tiles: LiveTile[],
  refreshHz: number,
  myGeneration: number,
): Promise<TrialResult | null> {
  const outcome = await runDecodeWindow({
    frequencies: tiles.map((tile) => tile.hz),
    refreshHz,
    isAborted: () => generation !== myGeneration,
    onTick: (remaining) =>
      patchLive((current) => ({
        detail:
          current.helpCountdown !== null
            ? `Calling for help in ${remaining} s — look away to cancel.`
            : `Look at a tile… ${remaining} s`,
      })),
  });

  if (outcome.failure === "start-failed") {
    notify("Could not start a decode window: " + (outcome.detail ?? "unknown error"));
  }

  return outcome.result;
}

function fireHelp(trialId?: number): void {
  /*
   * Order matters. The local alarm comes first and depends on nothing
   * outside this browser, so it still happens if the network is down. Only
   * then do we try to tell anyone else.
   */
  stopSpeaking();
  alarmTone();

  // Spoken after the tone so it is not talked over.
  window.setTimeout(() => speak("Calling for help now."), 700);

  patchLive((current) => ({
    running: false,
    helpFired: true,
    helpStreak: 0,
    helpCountdown: null,
    status: "HELP TRIGGERED",
    detail: "Alarm sounded locally. Contacting a caregiver…",
    alertDetail: null,
    alertForwarded: null,
    transcript: [...current.transcript, "HELP triggered"],
  }));

  setState({ selectionRunning: false });
  void stopTrial();

  void raiseHelpAlert(
    "Help requested via the AURA headset.",
    trialId,
    "Decoded from two consecutive SSVEP windows on the HELP target.",
  ).then((outcome) => {
    patchLive({
      alertForwarded: outcome.forwarded,
      alertDetail: outcome.detail,
      detail: outcome.forwarded
        ? "Alarm sounded locally and a caregiver was notified."
        : "Alarm sounded locally. Nobody was notified remotely.",
    });
  });
}

export async function startLiveSession(
  band: Band,
  optionLabels: string[],
): Promise<void> {
  const state = getState();

  if (state.live.running || state.calibrationRunning || state.selection.busy) {
    return;
  }

  if (!state.refreshReady) {
    notify("The display refresh-rate measurement is not finished yet.");
    return;
  }

  const allocation = await fetchAllocation(state.refreshHz, band);

  /*
   * Prefer the calibrated command set over the band allocation once a
   * profile exists: those are the frequencies that have thresholds and
   * resting baselines. The band allocation is the bench tool for exploring;
   * the product should run on what was calibrated.
   */
  const profile = getState().profile;
  if (
    allocation &&
    profile?.calibrated_at &&
    Array.isArray(profile.frequencies) &&
    profile.frequencies.length >= 3
  ) {
    allocation.allocated = [...profile.frequencies];
    allocation.band = "calibrated";
  }

  if (!allocation) {
    notify("Could not fetch the frequency allocation from the server.");
    return;
  }

  const tiles = buildLiveTiles(allocation.allocated, optionLabels);

  if (tiles.length < 3) {
    notify(
      "This band does not allocate enough frequencies for HELP, Cancel and an option.",
    );
    return;
  }

  generation += 1;
  const myGeneration = generation;

  patchLive({
    running: true,
    tiles,
    winner: -1,
    confident: false,
    evidence: [],
    helpStreak: 0,
    helpCountdown: null,
    helpFired: false,
    windowsRun: 0,
    transcript: [],
    status: "Session running.",
    detail: `${tiles.length} tiles, ${allocation.band} band. HELP at ${tiles[0].hz.toFixed(2)} Hz.`,
  });

  // The Start button sits above the tiles, which only exist from now on.
  scrollTilesIntoView("live-");

  speak("Session started. Look at a tile to choose it.");

  for (let remaining = READY_SECONDS; remaining > 0; remaining--) {
    patchLive({ detail: `Get ready — starting in ${remaining}…` });
    await sleep(1000);
  }

  while (generation === myGeneration) {
    const result = await runWindow(tiles, state.refreshHz, myGeneration);

    if (generation !== myGeneration) return;

    if (!result) {
      patchLive({
        status: "No result from the headset.",
        detail: "Is the ESP32 powered and connected? Retrying…",
        helpStreak: 0,
        helpCountdown: null,
      });
      await sleep(INTER_WINDOW_MS);
      continue;
    }

    handleWindowResult(result, tiles);

    if (generation !== myGeneration) return;

    await sleep(INTER_WINDOW_MS);
  }
}

function handleWindowResult(result: TrialResult, tiles: LiveTile[]): void {
  const evidence = Array.isArray(result.evidence_db) ? result.evidence_db : [];
  const index = typeof result.best_index === "number" ? result.best_index : -1;
  const confident = Boolean(result.confident);

  patchLive((current) => ({
    windowsRun: current.windowsRun + 1,
    evidence: tiles.map((_, i) => (typeof evidence[i] === "number" ? evidence[i] : null)),
  }));

  // Signal quality gates come first: a rejected window says nothing about
  // where the user was looking, so it must not advance or abort anything.
  if (!result.accepted) {
    patchLive({
      winner: -1,
      confident: false,
      status: `Window rejected: ${result.reason ?? "signal quality"}.`,
      detail: "Check the electrodes.",
      helpStreak: 0,
      helpCountdown: null,
    });
    return;
  }

  if (!confident || index < 0 || index >= tiles.length) {
    patchLive({
      winner: -1,
      confident: false,
      status: "No confident selection.",
      detail: "Keep your gaze steady on one tile.",
      helpStreak: 0,
      helpCountdown: null,
    });
    return;
  }

  const tile = tiles[index];

  patchLive({ winner: index, confident: true });

  if (tile.kind === "help") {
    patchLive((current) => {
      const streak = current.helpStreak + 1;

      if (streak >= HELP_WINDOWS_REQUIRED) return { helpStreak: streak };

      return {
        helpStreak: streak,
        helpCountdown: SELECTION_SECONDS,
        status: "HELP selected — confirming.",
        detail: "Look away now to cancel.",
      };
    });

    if (getState().live.helpStreak >= HELP_WINDOWS_REQUIRED) {
      fireHelp(result.trial_id);
    } else {
      speak("Help selected. Look away to cancel.");
    }

    return;
  }

  // Anything that is not HELP clears a countdown in progress. This is the
  // abort path: the user looked somewhere else.
  const wasCountingDown = getState().live.helpCountdown !== null;

  if (tile.kind === "cancel") {
    patchLive((current) => ({
      helpStreak: 0,
      helpCountdown: null,
      status: wasCountingDown ? "Help cancelled." : "Cancelled.",
      detail: "Returned to the tile set.",
      winner: index,
      transcript: [...current.transcript, wasCountingDown ? "Help cancelled" : "Cancel"],
    }));

    speak(wasCountingDown ? "Help cancelled." : "Cancelled.");
    return;
  }

  patchLive((current) => ({
    helpStreak: 0,
    helpCountdown: null,
    status: `Selected: ${tile.label}`,
    detail: `${tile.hz.toFixed(2)} Hz · margin ${
      typeof result.best_margin_db === "number"
        ? result.best_margin_db.toFixed(2)
        : "--"
    } dB`,
    transcript: [...current.transcript, tile.label],
  }));

  speak(tile.label);
}
