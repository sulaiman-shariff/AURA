/** A decoded trial as posted by the ESP32 firmware and stored by the server. */
export interface TrialResult {
  trial_id: number;
  target_hz: number;
  detected_hz: number;
  score: number;
  margin: number;
  p2p: number;
  confident: boolean;
  match: boolean;
  accepted: boolean;
  received_at: number;
  main_fundamental_snr_db?: number | null;
  main_harmonic_snr_db?: number | null;
  artifact_fundamental_snr_db?: number | null;
  artifact_harmonic_snr_db?: number | null;
  main_p2p?: number | null;
  artifact_p2p?: number | null;
  main_rms?: number | null;
  artifact_rms?: number | null;
  competitor_hz?: number | null;
  competitor_evidence_db?: number | null;
  source?: string | null;
  reason?: string | null;
  best_index?: number;
  best_margin_db?: number | null;
  evidence_db?: number[];
  target_set_hz?: number[];
  /** Resting baselines the firmware subtracted, aligned with target_set_hz. */
  baseline_db?: number[];
  main_contact_good?: boolean;
  artifact_contact_good?: boolean;
}

export interface ServerState {
  trial_id: number;
  active: boolean;
  requested_hz: number;
  target_hz: number;
  frequencies: number[];
  refresh_hz: number;
  started_at: number | null;
  last_result: TrialResult | null;
  history: TrialResult[];
}

export type CalibrationPhase =
  | "idle"
  | "contact_check"
  | "calibrate"
  | "validation_ready"
  | "validation"
  | "done";

export interface Thresholds {
  evidence_threshold: number;
  margin_threshold: number;
}

export interface CalibrationSummary {
  quality: "GOOD" | "FAIR" | "POOR";
  overall_accuracy_pct: number;
  overall_correct: number;
  overall_total: number;
  /** Accuracy a random guess would score, so POOR can be read against it. */
  chance_pct: number;
  per_frequency: Record<
    string,
    Thresholds & {
      baseline_db: number;
      validation_correct: number;
      validation_total: number;
      /** winner key -> count, for the trials cued at this frequency. */
      confusion: Record<string, number>;
    }
  >;
}

export interface CalibrationStatus {
  running: boolean;
  phase: CalibrationPhase;
  /** Key of the frequency currently being calibrated or validated. */
  current_key: string | null;
  message: string;
  contact_attempts: number;
  contact_ok: boolean;
  /** Accepted resting windows collected so far for the baseline. */
  baseline_windows: number;
  baseline_db: Record<string, number>;
  cal_data: Record<string, unknown[]>;
  validation_results: unknown[];
  thresholds: Record<string, Thresholds | null>;
  summary: CalibrationSummary | null;
}

/** The persisted calibration profile, keyed by command frequency. */
export interface ThresholdProfile {
  frequencies: number[];
  keys: string[];
  thresholds: Record<string, Thresholds>;
  baseline_db: Record<string, number>;
  calibrated_at: number | null;
}

/** What the server knows about the command set; nothing here is hardcoded client-side. */
export interface ServerConfig {
  frequencies: number[];
  keys: string[];
  calibration_trials_per_frequency: number;
  validation_trials_per_frequency: number;
  baseline_windows: number;
  max_targets: number;
  bands: Record<string, [number, number]>;
  default_band: Band;
}

export type Band = "clear" | "standard" | "comfort" | "high" | "calibrated";

export interface FrequencyAllocation {
  refresh_hz: number;
  band: Band;
  band_hz: [number, number];
  max_renderable_hz: number;
  separation_hz: number;
  allocated: number[];
  max_targets: number;
  firmware_limit: number;
  one_octave: boolean;
  method: string;
}

/**
 * What a live tile does when it wins a decode window. HELP and CANCEL are
 * always present; everything else is an ordinary option (later, a
 * camera-detected object or an LLM-proposed intent).
 */
export type TileKind = "help" | "cancel" | "option";

export interface LiveTile {
  hz: number;
  label: string;
  kind: TileKind;
}

export interface LiveState {
  /** True from "Start session" until it is stopped or HELP fires. */
  running: boolean;
  tiles: LiveTile[];
  /** Index of the tile the last window chose, -1 for none. */
  winner: number;
  confident: boolean;
  evidence: (number | null)[];
  status: string;
  detail: string;
  /**
   * Consecutive decode windows that chose HELP. HELP needs two in a row,
   * so that looking away during the countdown aborts it.
   */
  helpStreak: number;
  /** Seconds left on the abortable countdown, null when not counting. */
  helpCountdown: number | null;
  /** Latched once HELP has actually fired; cleared on acknowledgement. */
  helpFired: boolean;
  /**
   * Whether the alert actually reached anyone. null while the request is in
   * flight. The UI must not imply help is coming until this is true.
   */
  alertForwarded: boolean | null;
  /** What the server said about the forwarding attempt. */
  alertDetail: string | null;
  /** Completed decode windows this session, for the operator's benefit. */
  windowsRun: number;
  /** Last committed selection, shown as a running transcript. */
  transcript: string[];
}

/** An object found in the camera frame, by either detector. */
export interface SceneObject {
  /**
   * Stable identity. Frequencies are pinned to this across frames, so it
   * must NOT change when a better name arrives -- otherwise a tag would
   * jump to a different frequency mid-session.
   */
  label: string;
  /** What the tag shows. Gemini's name when it has one, else `label`. */
  displayLabel?: string;
  /** Which detector produced the box currently being drawn. */
  origin?: "local" | "gemini";
  /** [x0, y0, x1, y1] as fractions of the frame, x first. */
  box: [number, number, number, number] | number[];
  actionable: boolean;
}

export interface SceneIntent {
  label: string;
  action: "speak" | "call" | "device" | "note";
  params: string;
}

export type SceneStage = "idle" | "scanning" | "objects" | "intents" | "acted";

export interface SceneState {
  running: boolean;
  stage: SceneStage;
  cameraReady: boolean;
  cameraDetail: string;
  /** Cameras offered in the picker. */
  cameras: { deviceId: string; label: string }[];
  /** Chosen camera, or "" for the browser's default. */
  cameraId: string;
  /** Last captured frame, kept only for debugging; the view shows live video. */
  frame: string | null;
  objects: SceneObject[];
  /** Frequency pinned to each object, aligned with `objects`; null when the
   *  object was detected but the frequency budget was already spent. */
  objectFrequencies: (number | null)[];
  /** When the vision loop last returned, for a staleness indicator. */
  lastDetectionAt: number | null;
  intents: SceneIntent[];
  selectedObject: string | null;
  /** [HELP, Cancel, ...items] — aligned with the decoded best_index. */
  tiles: LiveTile[];
  winner: number;
  confident: boolean;
  evidence: (number | null)[];
  /** "gemini"/"local" when real, "stub" when placeholders. */
  source: string;
  /** Which detector the vision loop is actually using. */
  detectorSource: "local" | "cloud" | "hybrid" | null;
  /** True while the view is settled enough for a cloud call to be worth it. */
  viewStill: boolean;
  /**
   * A short message that must be impossible to miss -- shown large over the
   * view, not in the corner readout. A cancel used to be announced only in
   * the readout, which in a full-screen headset view is indistinguishable
   * from the session having silently done nothing.
   */
  notice: string | null;
  /** When Gemini last enriched the scene. */
  lastEnrichedAt: number | null;
  /** How many objects Gemini contributed that the local detector missed. */
  enrichedCount: number;
  sourceDetail: string;
  band: Band | null;
  status: string;
  detail: string;
  helpStreak: number;
  helpFired: boolean;
  alertForwarded: boolean | null;
  alertDetail: string | null;
  transcript: string[];
}

export interface SelectionState {
  frequencies: number[];
  labels: string[];
  band: Band | null;
  /** Index of the decoded tile, -1 when none. */
  winner: number;
  confident: boolean;
  /** Per-tile evidence in dB, aligned with `frequencies`. */
  evidence: (number | null)[];
  marginDb: number | null;
  /** Headline message for the selection block. */
  status: string;
  /** Secondary line, e.g. the rejection reason. */
  detail: string;
  /** True from "Run selection" until the result is rendered. */
  busy: boolean;
}
