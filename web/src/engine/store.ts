import { useSyncExternalStore } from "react";
import type {
  CalibrationStatus,
  LiveState,
  SceneState,
  SelectionState,
  ServerConfig,
  ThresholdProfile,
  TrialResult,
} from "./types";

export type MatchTone = "idle" | "recording" | "match" | "no-match" | "uncertain";

export interface UIState {
  refreshHz: number;
  refreshReady: boolean;

  flickerRunning: boolean;
  /**
   * True from the moment a trial is requested until it is actually running
   * or has failed -- i.e. across the "Get ready" lead-in, during which
   * nothing flickers yet. Without it the start controls stay enabled for
   * those seconds and a second click starts an overlapping trial, which the
   * firmware then discards as "trial changed during recording".
   */
  trialStarting: boolean;
  automaticRunning: boolean;
  calibrationRunning: boolean;
  /** True only while the selection tiles are actually flickering. */
  selectionRunning: boolean;

  requestedHz: number;
  actualHz: number;
  framesPerCycle: number;
  clamped: boolean;

  /** The main status line under the stage. */
  status: string;
  /** Transient notice that replaces the old alert() calls. */
  notice: string | null;

  serverOnline: boolean;
  lastResult: TrialResult | null;
  history: TrialResult[];
  /** Set to "recording" while a trial is live, otherwise derived from lastResult. */
  matchTone: MatchTone;

  calibration: CalibrationStatus | null;
  profile: ThresholdProfile | null;
  /** Command set and trial counts, fetched once at startup. */
  config: ServerConfig | null;

  selection: SelectionState;
  live: LiveState;
  scene: SceneState;
}

export const initialScene: SceneState = {
  running: false,
  stage: "idle",
  notice: null,
  cameraReady: false,
  cameraDetail: "",
  cameras: [],
  cameraId: "",
  frame: null,
  objects: [],
  objectFrequencies: [],
  lastDetectionAt: null,
  intents: [],
  selectedObject: null,
  tiles: [],
  winner: -1,
  confident: false,
  evidence: [],
  source: "",
  sourceDetail: "",
  detectorSource: null,
  viewStill: false,
  lastEnrichedAt: null,
  enrichedCount: 0,
  band: null,
  status: "",
  detail: "",
  helpStreak: 0,
  helpFired: false,
  alertForwarded: null,
  alertDetail: null,
  transcript: [],
};

export const initialLive: LiveState = {
  running: false,
  tiles: [],
  winner: -1,
  confident: false,
  evidence: [],
  status: "",
  detail: "",
  helpStreak: 0,
  helpCountdown: null,
  helpFired: false,
  alertForwarded: null,
  alertDetail: null,
  windowsRun: 0,
  transcript: [],
};

export const initialSelection: SelectionState = {
  frequencies: [],
  labels: [],
  band: null,
  winner: -1,
  confident: false,
  evidence: [],
  marginDb: null,
  status: "",
  detail: "",
  busy: false,
};

let state: UIState = {
  refreshHz: 60.0,
  refreshReady: false,
  flickerRunning: false,
  trialStarting: false,
  automaticRunning: false,
  calibrationRunning: false,
  selectionRunning: false,
  requestedHz: 10.0,
  actualHz: 10.0,
  framesPerCycle: 6,
  clamped: false,
  status: "Measuring display refresh rate…",
  notice: null,
  serverOnline: false,
  lastResult: null,
  history: [],
  matchTone: "idle",
  calibration: null,
  profile: null,
  config: null,
  selection: initialSelection,
  live: initialLive,
  scene: initialScene,
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function getState(): UIState {
  return state;
}

export function setState(
  patch: Partial<UIState> | ((current: UIState) => Partial<UIState>),
): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

export function patchSelection(patch: Partial<SelectionState>): void {
  setState((current) => ({ selection: { ...current.selection, ...patch } }));
}

/**
 * The functional form matters for both of these: the live and scene loops
 * derive several fields from the previous ones (the HELP streak, the
 * transcript), and reading them separately would race against an in-flight
 * update.
 */
export function patchScene(
  patch: Partial<SceneState> | ((current: SceneState) => Partial<SceneState>),
): void {
  setState((current) => {
    const next = typeof patch === "function" ? patch(current.scene) : patch;
    return { scene: { ...current.scene, ...next } };
  });
}

export function patchLive(
  patch: Partial<LiveState> | ((current: LiveState) => Partial<LiveState>),
): void {
  setState((current) => {
    const next = typeof patch === "function" ? patch(current.live) : patch;
    return { live: { ...current.live, ...next } };
  });
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Select a slice of the UI state. Selectors must return a stable value for
 * an unchanged state (a primitive or a stored sub-object), never a fresh
 * object literal, or React will re-render forever.
 */
export function useStore<T>(selector: (current: UIState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

let noticeTimer: number | undefined;

/** Show a transient message in place of a blocking alert(). */
export function notify(message: string, ms = 6000): void {
  window.clearTimeout(noticeTimer);
  setState({ notice: message });
  noticeTimer = window.setTimeout(() => setState({ notice: null }), ms);
}

export function dismissNotice(): void {
  window.clearTimeout(noticeTimer);
  setState({ notice: null });
}
