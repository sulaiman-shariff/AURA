/**
 * Trial, selection and calibration workflows.
 *
 * This is a straight port of the original static/app.js control flow: the
 * same sequencing, timings, retry limits and server calls, with DOM writes
 * replaced by store updates. Anything that changes what the headset sees
 * or when belongs here or in clock.ts, not in the components.
 */
import {
  beginCalibration,
  cancelCalibrationRequest,
  fetchAllocation,
  fetchCalibrationStatus,
  fetchConfig,
  fetchProfile,
  fetchServerState,
  startTrial,
  stopTrial,
  type StartTrialBody,
} from "./api";
import {
  resetStimulusSurface,
  scrollStimulusIntoView,
  scrollTilesIntoView,
  startAnimator,
} from "./animator";
import {
  ACTIVE_SECONDS,
  BASELINE_WINDOWS,
  CALIBRATION_VALIDATION_TRIALS_PER_FREQUENCY,
  FALLBACK_COMMAND_FREQUENCIES,
  CALIBRATION_TRIALS_PER_FREQUENCY,
  MAX_STIMULUS_HZ,
  MAX_TRIAL_ATTEMPTS,
  MIN_STIMULUS_HZ,
  READY_SECONDS,
  REST_SECONDS,
  RESULT_POLL_ATTEMPTS,
  RESULT_POLL_INTERVAL_MS,
  SELECTION_SECONDS,
  calculateActualFrequency,
  measureRefreshRate,
  sleep,
} from "./clock";
import {
  getState,
  initialSelection,
  notify,
  patchSelection,
  setState,
  type MatchTone,
} from "./store";
import { preload as preloadDetector } from "./detector";
import type { Band, CalibrationStatus, TrialResult } from "./types";

// -----------------------------------------------------------------
// Result polling
// -----------------------------------------------------------------

export function toneFor(result: TrialResult | null): MatchTone {
  if (!result) return "idle";
  if (!result.confident) return "uncertain";
  return result.match ? "match" : "no-match";
}

async function pollServerState(): Promise<void> {
  const serverState = await fetchServerState();

  if (!serverState) {
    setState({ serverOnline: false });
    return;
  }

  setState((current) => ({
    serverOnline: true,
    history: serverState.history ?? [],
    // /api/start clears last_result, so a non-null value is always the
    // result of the most recent trial and overrides "recording".
    lastResult: serverState.last_result ?? current.lastResult,
    matchTone: serverState.last_result
      ? toneFor(serverState.last_result)
      : current.matchTone,
  }));
}

async function refreshCalibrationStatus(): Promise<CalibrationStatus | null> {
  const status = await fetchCalibrationStatus();
  if (status) setState({ calibration: status });
  return status;
}

/** The command set, from the server once known. */
function commandFrequencies(): number[] {
  return getState().config?.frequencies ?? FALLBACK_COMMAND_FREQUENCIES;
}

function commandKeys(): string[] {
  const config = getState().config;
  if (config) return config.keys;
  return FALLBACK_COMMAND_FREQUENCIES.map((hz) => String(hz));
}

async function refreshConfig(): Promise<void> {
  const config = await fetchConfig();
  if (config) setState({ config });
}

async function refreshProfile(): Promise<void> {
  const profile = await fetchProfile();
  if (profile) setState({ profile });
}

// -----------------------------------------------------------------
// Single stimulus
// -----------------------------------------------------------------

async function startFlicker(
  frequency: number,
  extraFields: Partial<StartTrialBody> = {},
): Promise<number | null> {
  const { refreshReady, refreshHz, trialStarting, flickerRunning } = getState();

  // Re-entry guard. The lead-in is several seconds long, so without this a
  // second click launches an overlapping trial and both are lost.
  if (trialStarting || flickerRunning) return null;

  if (!refreshReady) {
    notify("The display refresh-rate measurement is not finished yet.");
    return null;
  }

  if (
    !Number.isFinite(frequency) ||
    frequency < MIN_STIMULUS_HZ ||
    frequency > MAX_STIMULUS_HZ
  ) {
    notify(`Enter a frequency between ${MIN_STIMULUS_HZ} Hz and ${MAX_STIMULUS_HZ} Hz.`);
    return null;
  }

  const calculated = calculateActualFrequency(frequency, refreshHz);

  setState({
    trialStarting: true,
    requestedHz: frequency,
    actualHz: calculated.frequency,
    framesPerCycle: calculated.framesPerCycle,
    clamped: calculated.clamped,
    matchTone: "recording",
  });

  /*
   * Lead-in: scroll the stimulus into view, then count down before anything
   * starts recording.
   *
   * The button that starts a trial may be far down the page from the disc,
   * so without this the operator spends the first seconds of the window
   * scrolling -- and those seconds are inside the analysis window. Nothing
   * flickers and no server trial exists until the countdown finishes.
   */
  scrollStimulusIntoView();

  for (let remaining = READY_SECONDS; remaining > 0; remaining--) {
    setState({ status: `Get ready — starting in ${remaining}…` });
    await sleep(1000);
  }

  setState({
    trialStarting: false,
    flickerRunning: true,
    status: `Flickering at ${calculated.frequency.toFixed(3)} Hz.`,
  });

  const response = await startTrial({
    requested_hz: frequency,
    actual_hz: calculated.frequency,
    ...extraFields,
  });

  if (!response.ok) {
    setState({ trialStarting: false, flickerRunning: false, matchTone: "idle" });
    notify("Could not start the trial on the server.");
    return null;
  }

  return ((await response.json()) as { trial_id: number }).trial_id;
}

/**
 * Wait for this trial's result, then stop the stimulus.
 *
 * The flicker used to run to a fixed timeout regardless, leaving the user
 * staring at a strobing disc for seconds after the headset had already
 * decided -- eye strain for no information, and worse for the next trial
 * because the SSVEP adapts under prolonged stimulation.
 */
async function stopWhenResultArrives(trialId: number, seconds: number): Promise<void> {
  const deadline = Date.now() + (seconds + 6) * 1000;

  while (Date.now() < deadline) {
    if (!getState().flickerRunning) return;

    const serverState = await fetchServerState();

    if (serverState?.last_result?.trial_id === trialId) break;

    await sleep(RESULT_POLL_INTERVAL_MS);
  }

  await stopFlicker();
}

/**
 * Start a server trial with NOTHING flickering.
 *
 * Used for the resting baseline: the firmware records and reports evidence
 * at every command frequency while the disc stays a static grey, so what
 * comes back is each frequency's pedestal with no stimulus behind it.
 */
async function startSilentTrial(
  extraFields: Partial<StartTrialBody> = {},
): Promise<number | null> {
  const { trialStarting, flickerRunning } = getState();
  if (trialStarting || flickerRunning) return null;

  const frequencies = commandFrequencies();
  setState({ trialStarting: true, matchTone: "recording" });

  const response = await startTrial({
    requested_hz: frequencies[0],
    actual_hz: frequencies[0],
    competitors: frequencies.slice(1),
    refresh_hz: getState().refreshHz,
    ...extraFields,
  });

  setState({ trialStarting: false });

  if (!response.ok) {
    setState({ matchTone: "idle" });
    notify("Could not start the baseline window on the server.");
    return null;
  }

  return ((await response.json()) as { trial_id: number }).trial_id;
}

export async function manualStart(frequency: number): Promise<void> {
  if (getState().calibrationRunning) return;

  const trialId = await startFlicker(frequency);
  if (trialId === null) return;

  await stopWhenResultArrives(trialId, ACTIVE_SECONDS);
}

export async function stopFlicker(): Promise<void> {
  setState({ trialStarting: false, flickerRunning: false });
  resetStimulusSurface();
  await stopTrial();
}

// -----------------------------------------------------------------
// Automatic 10 / 15 Hz sweep
// -----------------------------------------------------------------

export async function runAutomaticTest(): Promise<void> {
  const state = getState();

  if (state.automaticRunning || state.calibrationRunning) return;

  if (!state.refreshReady) {
    notify("The display refresh-rate measurement is not finished yet.");
    return;
  }

  setState({ automaticRunning: true });

  const frequencies = [...commandFrequencies()];

  for (let index = 0; index < frequencies.length; index++) {
    if (!getState().automaticRunning) break;

    const frequency = frequencies[index];
    setState({
      status: `Starting sweep trial ${index + 1} of ${frequencies.length}…`,
    });

    const started = await startFlicker(frequency);

    if (started === null) {
      setState({ automaticRunning: false });
      break;
    }

    for (let remaining = ACTIVE_SECONDS; remaining > 0; remaining--) {
      if (!getState().automaticRunning) break;
      setState({
        status:
          `Trial ${index + 1}/${frequencies.length}: ` +
          `${getState().actualHz.toFixed(3)} Hz — ${remaining} s remaining.`,
      });
      await sleep(1000);
    }

    await stopFlicker();

    if (!getState().automaticRunning) break;

    for (let remaining = REST_SECONDS; remaining > 0; remaining--) {
      if (!getState().automaticRunning) break;
      setState({ status: `Rest — next trial in ${remaining} s.` });
      await sleep(1000);
    }
  }

  setState({ automaticRunning: false });
  await stopFlicker();
  setState({ status: "Sweep complete." });
}

export async function cancelAutomaticTest(): Promise<void> {
  setState({ automaticRunning: false });
  await stopFlicker();
  setState({ status: "Sweep cancelled." });
}

// -----------------------------------------------------------------
// Multi-target selection
// -----------------------------------------------------------------

export async function runSelection(requestedCount: number, band: Band): Promise<void> {
  const state = getState();

  if (state.calibrationRunning || state.automaticRunning || state.selection.busy) {
    return;
  }

  if (!state.refreshReady) {
    notify("The display refresh-rate measurement is not finished yet.");
    return;
  }

  const allocation = await fetchAllocation(state.refreshHz, band);

  if (!allocation) {
    notify("Could not fetch the frequency allocation from the server.");
    return;
  }

  const frequencies = allocation.allocated.slice(0, requestedCount || 4);

  if (frequencies.length < 2) {
    notify("Not enough usable frequencies in this band for a selection.");
    return;
  }

  const labels = frequencies.map((_, i) => `Option ${i + 1}`);

  setState({
    selection: {
      ...initialSelection,
      frequencies,
      labels,
      band: allocation.band,
      busy: true,
      status: `Look at one tile and hold your gaze.`,
      detail: `${frequencies.length} targets, ${allocation.band} band.`,
    },
  });

  /*
   * Same lead-in as a single trial: the tiles have only just been rendered,
   * so give the page a moment to scroll them into view before any of them
   * starts flickering and the recording window opens.
   */
  scrollTilesIntoView("selection-");

  for (let remaining = READY_SECONDS; remaining > 0; remaining--) {
    patchSelection({ status: `Get ready — starting in ${remaining}…` });
    await sleep(1000);
  }

  patchSelection({ status: "Look at one tile and hold your gaze." });

  // The cued frequency is index 0 only so the firmware has something to
  // report as "target"; for a real selection we read best_index instead.
  const response = await startTrial({
    requested_hz: frequencies[0],
    actual_hz: frequencies[0],
    competitors: frequencies.slice(1),
    refresh_hz: state.refreshHz,
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    notify("Could not start the selection: " + (detail.error || response.status));
    setState({ selection: initialSelection, selectionRunning: false });
    return;
  }

  const trialId = ((await response.json()) as { trial_id: number }).trial_id;
  setState({ selectionRunning: true });

  for (let remaining = SELECTION_SECONDS; remaining > 0; remaining--) {
    patchSelection({ status: `Hold your gaze on one tile… ${remaining} s` });
    await sleep(1000);
  }

  setState({ selectionRunning: false });
  await stopTrial();

  patchSelection({ status: "Decoding…", detail: "" });

  for (let attempt = 0; attempt < RESULT_POLL_ATTEMPTS; attempt++) {
    const serverState = await fetchServerState();
    const result = serverState?.last_result;

    if (result && result.trial_id === trialId) {
      renderSelectionResult(result, frequencies, labels);
      patchSelection({ busy: false });
      return;
    }

    await sleep(RESULT_POLL_INTERVAL_MS);
  }

  patchSelection({
    status: "No result from the headset.",
    detail: "Is the ESP32 powered and connected?",
    busy: false,
  });
}

function renderSelectionResult(
  result: TrialResult,
  frequencies: number[],
  labels: string[],
): void {
  const index = typeof result.best_index === "number" ? result.best_index : -1;
  const confident = Boolean(result.confident);

  if (!result.accepted) {
    patchSelection({
      winner: -1,
      confident: false,
      status: `Rejected: ${result.reason || "signal quality"}.`,
      detail: "Check the electrodes and try again.",
    });
    return;
  }

  if (index < 0 || index >= frequencies.length) {
    patchSelection({
      winner: -1,
      status: "No usable selection in this window.",
      detail: "",
    });
    return;
  }

  const rawEvidence = Array.isArray(result.evidence_db) ? result.evidence_db : [];
  const evidence = frequencies.map((_, i) =>
    typeof rawEvidence[i] === "number" ? rawEvidence[i] : null,
  );

  const marginDb =
    typeof result.best_margin_db === "number" ? result.best_margin_db : null;

  patchSelection({
    winner: index,
    confident,
    evidence,
    marginDb,
    status: confident
      ? `Selected ${labels[index]} · ${frequencies[index].toFixed(2)} Hz`
      : `Best guess ${labels[index]} · below threshold, not committed`,
    detail:
      marginDb === null
        ? ""
        : `Margin over runner-up: ${marginDb.toFixed(2)} dB`,
  });
}

// -----------------------------------------------------------------
// Guided calibration
// -----------------------------------------------------------------

/**
 * Waits for a calibration counter (contact_attempts, a cal_data length,
 * or validation_results length) to increase beyond previousCount. This
 * is how we detect whether the trial that just finished was accepted
 * (counted) or rejected (server discarded it silently).
 */
async function waitForCalibrationProgress(
  getCount: (status: CalibrationStatus) => number,
  previousCount: number,
): Promise<{ advanced: boolean; status: CalibrationStatus | null }> {
  let lastStatus: CalibrationStatus | null = null;

  for (let i = 0; i < RESULT_POLL_ATTEMPTS; i++) {
    await sleep(RESULT_POLL_INTERVAL_MS);

    const status = await refreshCalibrationStatus();
    if (!status) continue;

    lastStatus = status;

    if (getCount(status) > previousCount) {
      return { advanced: true, status };
    }
  }

  return { advanced: false, status: lastStatus };
}

async function runContactCheck(): Promise<boolean> {
  /*
   * Resting baseline. Several accepted windows with the disc static; the
   * server medians the evidence at each command frequency and the firmware
   * subtracts it from then on. Doubles as the contact check, since a window
   * only counts if both channels pass the quality gates.
   */
  const needed = getState().config?.baseline_windows ?? BASELINE_WINDOWS;
  const maxAttempts = needed + MAX_TRIAL_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!getState().calibrationRunning) return false;

    const statusBefore = await fetchCalibrationStatus();
    const attemptsBefore = statusBefore ? statusBefore.contact_attempts : 0;
    const collected = statusBefore ? statusBefore.baseline_windows : 0;

    if (collected >= needed) return true;

    const trialId = await startSilentTrial({ phase: "contact_check" });
    if (trialId === null) return false;

    for (
      let remaining = ACTIVE_SECONDS;
      remaining > 0 && getState().calibrationRunning;
      remaining--
    ) {
      setState({
        status:
          `Resting baseline ${collected + 1}/${needed} — sit still, eyes open, ` +
          `look at the grey disc — ${remaining} s.`,
      });
      await sleep(1000);
    }

    await stopFlicker();

    const result = await waitForCalibrationProgress(
      (s) => s.contact_attempts,
      attemptsBefore,
    );

    if (result.advanced && result.status && result.status.baseline_windows >= needed) {
      return true;
    }

    if (result.advanced && result.status && !result.status.contact_ok) {
      setState({ status: "Window rejected — check electrode placement. Retrying…" });
      await sleep(1500);
    }
  }

  return false;
}

async function runCalibrationTrial(
  requestedFrequency: number,
  phase: string,
  commandKey: string,
  isValidation: boolean,
  getCount: (status: CalibrationStatus) => number,
): Promise<boolean> {
  const statusBefore = await fetchCalibrationStatus();
  const previousCount = statusBefore ? getCount(statusBefore) : 0;

  const phaseLabel =
    phase === "validation" ? "Validation" : `Calibrating ${commandKey} Hz`;

  for (let attempt = 0; attempt < MAX_TRIAL_ATTEMPTS; attempt++) {
    if (!getState().calibrationRunning) return false;

    const started = await startFlicker(requestedFrequency, {
      phase,
      command_key: commandKey,
      is_validation: isValidation,
    });

    if (started === null) return false;

    for (
      let remaining = ACTIVE_SECONDS;
      remaining > 0 && getState().calibrationRunning;
      remaining--
    ) {
      setState({
        status:
          `${phaseLabel} · target ${commandKey} Hz ` +
          `(actual ${getState().actualHz.toFixed(3)} Hz) — ` +
          `${remaining} s remaining, attempt ${attempt + 1}/${MAX_TRIAL_ATTEMPTS}.`,
      });
      await sleep(1000);
    }

    await stopFlicker();

    if (!getState().calibrationRunning) return false;

    const result = await waitForCalibrationProgress(getCount, previousCount);

    if (result.advanced) {
      for (
        let remaining = REST_SECONDS;
        remaining > 0 && getState().calibrationRunning;
        remaining--
      ) {
        setState({ status: `Rest — next trial in ${remaining} s.` });
        await sleep(1000);
      }
      return true;
    }

    setState({
      status: "Trial rejected (bad contact or artifact burst) — repeating.",
    });
    await sleep(1500);
  }

  setState({
    status: "Too many rejected trials in a row — aborting calibration.",
  });
  return false;
}

async function runCalibrationBlock(commandKey: string, hz: number): Promise<boolean> {
  const perFrequency =
    getState().config?.calibration_trials_per_frequency ?? CALIBRATION_TRIALS_PER_FREQUENCY;

  for (let i = 0; i < perFrequency; i++) {
    if (!getState().calibrationRunning) return false;

    const ok = await runCalibrationTrial(
      hz,
      "calibrate",
      commandKey,
      false,
      (s) => (s.cal_data && s.cal_data[commandKey] ? s.cal_data[commandKey].length : 0),
    );

    if (!ok) return false;
  }

  return true;
}

function buildValidationOrder(): { key: string; hz: number }[] {
  const perFrequency =
    getState().config?.validation_trials_per_frequency ??
    CALIBRATION_VALIDATION_TRIALS_PER_FREQUENCY;

  const keys = commandKeys();
  const frequencies = commandFrequencies();
  const items: { key: string; hz: number }[] = [];

  keys.forEach((key, index) => {
    for (let i = 0; i < perFrequency; i++) items.push({ key, hz: frequencies[index] });
  });

  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }

  return items;
}

async function runValidationBlock(): Promise<boolean> {
  const order = buildValidationOrder();

  for (const item of order) {
    if (!getState().calibrationRunning) return false;

    const ok = await runCalibrationTrial(
      item.hz,
      "validation",
      item.key,
      true,
      (s) => (s.validation_results ? s.validation_results.length : 0),
    );

    if (!ok) return false;
  }

  return true;
}

async function finishCalibrationAborted(message: string): Promise<void> {
  setState({ calibrationRunning: false });
  await stopFlicker();
  setState({ status: message || "Calibration aborted." });
}

export async function startCalibration(): Promise<void> {
  const state = getState();

  if (state.calibrationRunning || state.automaticRunning) return;

  if (!state.refreshReady) {
    notify("The display refresh-rate measurement is not finished yet.");
    return;
  }

  setState({ calibrationRunning: true });

  const beginResponse = await beginCalibration();

  if (!beginResponse.ok) {
    await finishCalibrationAborted("Could not start calibration.");
    return;
  }

  setState({ calibration: (await beginResponse.json()) as CalibrationStatus });

  await refreshConfig();

  const contactOk = await runContactCheck();

  if (!contactOk) {
    await finishCalibrationAborted(
      "Calibration aborted: could not collect a clean resting baseline.",
    );
    return;
  }

  const keys = commandKeys();
  const frequencies = commandFrequencies();

  for (let index = 0; index < keys.length; index++) {
    if (!(await runCalibrationBlock(keys[index], frequencies[index]))) {
      await finishCalibrationAborted(`Calibration aborted during the ${keys[index]} Hz block.`);
      return;
    }
  }

  if (!(await runValidationBlock())) {
    await finishCalibrationAborted("Calibration aborted during validation.");
    return;
  }

  await refreshCalibrationStatus();
  await refreshProfile();

  setState({ status: "Calibration complete.", calibrationRunning: false });
}

export async function cancelCalibration(): Promise<void> {
  setState({ calibrationRunning: false });
  await cancelCalibrationRequest();
  await stopFlicker();
  await refreshCalibrationStatus();
  setState({ status: "Calibration cancelled." });
}

// -----------------------------------------------------------------
// Global wiring
// -----------------------------------------------------------------

export function enterFullscreen(): void {
  if (document.documentElement.requestFullscreen) {
    void document.documentElement.requestFullscreen();
  }
}

/** Hard stop: aborts every running workflow and blanks the stimulus. */
export function emergencyStop(): void {
  setState({ automaticRunning: false, calibrationRunning: false });
  void stopFlicker();
}

let initialised = false;

export function initialise(): void {
  if (initialised) return;
  initialised = true;

  startAnimator();

  // ~5 MB of model weights, fetched once and then cached. Warming it here
  // means the first live session does not stall on the download.
  void preloadDetector().catch(() => {
    /* falls back to Gemini; surfaced in the panel, not fatal */
  });

  window.setInterval(pollServerState, 750);
  void pollServerState();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && getState().flickerRunning) {
      emergencyStop();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.code === "Escape" || event.key === " " || event.code === "Space") {
      event.preventDefault();
      emergencyStop();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/stop");
    }
  });

  void (async () => {
    const refreshHz = await measureRefreshRate();

    setState({
      refreshHz,
      refreshReady: true,
      status: `Ready. Measured display refresh: ${refreshHz.toFixed(2)} Hz.`,
    });

    await refreshConfig();
    await refreshCalibrationStatus();
    await refreshProfile();
  })();
}
