import type {
  Band,
  CalibrationStatus,
  FrequencyAllocation,
  ServerConfig,
  ServerState,
  ThresholdProfile,
} from "./types";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch (error) {
    console.error(error);
    return null;
  }
}

export function fetchServerState(): Promise<ServerState | null> {
  return getJson<ServerState>("/api/state");
}

export function fetchCalibrationStatus(): Promise<CalibrationStatus | null> {
  return getJson<CalibrationStatus>("/api/calibration/status");
}

export function fetchConfig(): Promise<ServerConfig | null> {
  return getJson<ServerConfig>("/api/config");
}

export function fetchProfile(): Promise<ThresholdProfile | null> {
  return getJson<ThresholdProfile>("/api/calibration/profile");
}

export function fetchAllocation(
  refreshHz: number,
  band: Band,
): Promise<FrequencyAllocation | null> {
  return getJson<FrequencyAllocation>(
    `/api/frequencies?refresh_hz=${refreshHz}&band=${encodeURIComponent(band)}`,
  );
}

export interface StartTrialBody {
  requested_hz: number;
  actual_hz: number;
  competitors?: number[];
  refresh_hz?: number;
  phase?: string;
  /** Which command frequency this calibration trial belongs to. */
  command_key?: string;
  logical_hz?: number;
  is_validation?: boolean;
}

export function startTrial(body: StartTrialBody): Promise<Response> {
  return fetch("/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function stopTrial(): Promise<void> {
  try {
    await fetch("/api/stop", { method: "POST" });
  } catch (error) {
    console.error(error);
  }
}

export interface AlertOutcome {
  ok: boolean;
  /** The alert reached the local audit log on the server. */
  logged: boolean;
  /** Someone was actually notified via the configured webhook. */
  forwarded: boolean;
  detail: string;
}

/**
 * Forward a HELP alert. The browser has already sounded the local alarm
 * before this is called, so a failure here degrades the alert rather than
 * losing it -- which is why this resolves to an outcome instead of throwing.
 */
export async function raiseHelpAlert(
  message: string,
  trialId?: number,
  detail?: string,
): Promise<AlertOutcome> {
  try {
    const response = await fetch("/api/alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, trial_id: trialId, detail }),
    });

    if (!response.ok) {
      return {
        ok: false,
        logged: false,
        forwarded: false,
        detail: `Server returned ${response.status}.`,
      };
    }

    return (await response.json()) as AlertOutcome;
  } catch (error) {
    console.error(error);
    return {
      ok: false,
      logged: false,
      forwarded: false,
      detail: "Could not reach the server. The local alarm sounded only.",
    };
  }
}

export function beginCalibration(): Promise<Response> {
  return fetch("/api/calibration/begin", { method: "POST" });
}

export function cancelCalibrationRequest(): Promise<Response> {
  return fetch("/api/calibration/cancel", { method: "POST" });
}
