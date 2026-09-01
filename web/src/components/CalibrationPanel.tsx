import {
  BASELINE_WINDOWS,
  CALIBRATION_TRIALS_PER_FREQUENCY,
  CALIBRATION_VALIDATION_TRIALS_PER_FREQUENCY,
  FALLBACK_COMMAND_FREQUENCIES,
} from "../engine/clock";
import { cancelCalibration, startCalibration } from "../engine/session";
import { useStore } from "../engine/store";
import type { CalibrationPhase, CalibrationStatus } from "../engine/types";
import { db } from "../format";
import { Pill, type PillTone } from "./Pill";

type StepState = "pending" | "active" | "done" | "failed";

interface Step {
  key: string;
  title: string;
  detail: string;
  count: number | null;
  total: number | null;
  state: StepState;
}

const PHASE_ORDER: CalibrationPhase[] = [
  "contact_check",
  "calibrate",
  "validation_ready",
  "validation",
  "done",
];

function phaseLabel(status: CalibrationStatus | null): string {
  const phase = status?.phase ?? "idle";
  switch (phase) {
    case "idle":
      return "Idle";
    case "contact_check":
      return "Resting baseline";
    case "calibrate":
      return status?.current_key ? `Calibrating ${status.current_key} Hz` : "Calibrating";
    case "validation_ready":
      return "Starting validation";
    case "validation":
      return "Validating";
    case "done":
      return "Complete";
    default:
      return phase;
  }
}

function rank(phase: CalibrationPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

function buildSteps(
  status: CalibrationStatus | null,
  running: boolean,
  keys: string[],
  perFrequency: number,
  validationPerFrequency: number,
  baselineWindows: number,
): Step[] {
  const phase = status?.phase ?? "idle";
  const current = rank(phase);
  const validation = status?.validation_results?.length ?? 0;
  const baselineDone = status?.baseline_windows ?? 0;
  const contactAttempts = status?.contact_attempts ?? 0;
  const contactOk = status?.contact_ok ?? false;

  const stateFor = (from: CalibrationPhase, to: CalibrationPhase, complete: boolean): StepState => {
    if (!status || phase === "idle") return "pending";
    if (complete || current > rank(to)) return "done";
    if (current >= rank(from) && current <= rank(to)) return running ? "active" : "pending";
    return "pending";
  };

  let contactState = stateFor("contact_check", "contact_check", baselineDone >= baselineWindows);
  if (contactAttempts > 0 && !contactOk && phase === "contact_check" && !running) {
    contactState = "failed";
  }

  const steps: Step[] = [
    {
      key: "baseline",
      title: "Resting baseline",
      detail:
        contactAttempts === 0
          ? "Static disc; measures each frequency's resting pedestal and checks contact"
          : baselineDone >= baselineWindows
            ? "Baseline measured; both channels reading cleanly"
            : `Window ${baselineDone}/${baselineWindows} — attempt ${contactAttempts}`,
      count: baselineDone,
      total: baselineWindows,
      state: contactState,
    },
  ];

  keys.forEach((key, index) => {
    const collected = status?.cal_data?.[key]?.length ?? 0;
    const isCurrent = phase === "calibrate" && status?.current_key === key;
    const previousDone = keys
      .slice(0, index)
      .every((k) => (status?.cal_data?.[k]?.length ?? 0) >= perFrequency);
    let state: StepState = "pending";
    if (collected >= perFrequency || current > rank("calibrate")) state = "done";
    else if (
      running &&
      phase === "calibrate" &&
      (isCurrent || (previousDone && !status?.current_key))
    )
      state = "active";

    steps.push({
      key: `cal-${key}`,
      title: `${key} Hz trials`,
      detail: "Each is also a negative example for every other frequency",
      count: collected,
      total: perFrequency,
      state,
    });
  });

  const validationTotal = validationPerFrequency * keys.length;
  steps.push({
    key: "validation",
    title: "Validation",
    detail: `Randomised trials across ${keys.join(" / ")} Hz against the new thresholds`,
    count: validation,
    total: validationTotal,
    state: stateFor(
      "validation_ready",
      "validation",
      validation >= validationTotal || phase === "done",
    ),
  });

  return steps;
}

function qualityTone(quality: "GOOD" | "FAIR" | "POOR"): PillTone {
  if (quality === "GOOD") return "match";
  if (quality === "FAIR") return "uncertain";
  return "no-match";
}

export function CalibrationPanel() {
  const calibration = useStore((s) => s.calibration);
  const calibrationRunning = useStore((s) => s.calibrationRunning);
  const automaticRunning = useStore((s) => s.automaticRunning);
  const selectionBusy = useStore((s) => s.selection.busy);
  const refreshReady = useStore((s) => s.refreshReady);

  const config = useStore((s) => s.config);

  const keys = config?.keys ?? FALLBACK_COMMAND_FREQUENCIES.map((hz) => String(hz));
  const perFrequency =
    config?.calibration_trials_per_frequency ?? CALIBRATION_TRIALS_PER_FREQUENCY;
  const validationPerFrequency =
    config?.validation_trials_per_frequency ?? CALIBRATION_VALIDATION_TRIALS_PER_FREQUENCY;
  const baselineWindows = config?.baseline_windows ?? BASELINE_WINDOWS;

  const phase = calibration?.phase ?? "idle";
  const steps = buildSteps(
    calibration,
    calibrationRunning,
    keys,
    perFrequency,
    validationPerFrequency,
    baselineWindows,
  );
  const summary = calibration?.summary ?? null;

  const phaseTone: PillTone =
    phase === "done" ? "match" : calibrationRunning ? "recording" : "idle";

  const startDisabled = calibrationRunning || automaticRunning || selectionBusy || !refreshReady;

  return (
    <section className="card">
      <div className="card__head">
        <h2>Guided calibration</h2>
        <Pill tone={phaseTone}>{phaseLabel(calibration)}</Pill>
      </div>

      <p className="lede">
        Measures each command frequency's resting baseline with the disc static, learns
        evidence and margin thresholds from {perFrequency} accepted trials per frequency
        ({keys.join(" / ")} Hz), then checks them with randomised validation trials. Roughly{" "}
        {Math.round((keys.length * (perFrequency + validationPerFrequency) * 18) / 60)} minutes
        with rests.
      </p>

      <div className="controls">
        <button
          type="button"
          className="btn btn--primary"
          disabled={startDisabled}
          onClick={() => void startCalibration()}
        >
          Start calibration
        </button>
        <button
          type="button"
          className="btn btn--danger"
          disabled={!calibrationRunning}
          onClick={() => void cancelCalibration()}
        >
          Cancel calibration
        </button>
      </div>

      <ol className="steps">
        {steps.map((step, index) => (
          <li key={step.key} className={`step step--${step.state}`}>
            <span className="step__marker" aria-hidden="true">
              {step.state === "done" ? "✓" : step.state === "failed" ? "!" : index + 1}
            </span>
            <div className="step__body">
              <div className="step__row">
                <span className="step__title">{step.title}</span>
                {step.total !== null && (
                  <span className="step__count">
                    {step.count}/{step.total}
                  </span>
                )}
              </div>
              <div className="step__detail">{step.detail}</div>
              {step.total !== null && (
                <div className="step__bar">
                  <span style={{ width: `${((step.count ?? 0) / step.total) * 100}%` }} />
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>

      {calibration?.message && (
        <p className="hint hint--mono">{calibration.message}</p>
      )}

      {summary && (
        <div className="summary">
          <div className="card__head">
            <h3>Calibration result</h3>
            <Pill tone={qualityTone(summary.quality)}>{summary.quality}</Pill>
          </div>

          <div className="summary__overall">
            <span className="summary__big">
              {summary.overall_correct}/{summary.overall_total}
            </span>
            <span className="summary__caption">
              validation trials correct · {summary.overall_accuracy_pct.toFixed(1)}% (chance{" "}
              {summary.chance_pct}%)
            </span>
          </div>

          <div className="summary__grid">
            {Object.keys(summary.per_frequency).map((key) => {
              const per = summary.per_frequency[key];
              const confusion = Object.entries(per.confusion ?? {})
                .sort((a, b) => b[1] - a[1])
                .map(([k, n]) => `${k}×${n}`)
                .join(" ");
              return (
                <div key={key} className="summary__block">
                  <div className="summary__block-title">{key} Hz</div>
                  <div className="metric">
                    <span>Baseline</span>
                    <strong>{db(per.baseline_db)}</strong>
                  </div>
                  <div className="metric">
                    <span>Evidence threshold</span>
                    <strong>{db(per.evidence_threshold)}</strong>
                  </div>
                  <div className="metric">
                    <span>Margin threshold</span>
                    <strong>{db(per.margin_threshold)}</strong>
                  </div>
                  <div className="metric">
                    <span>Validation</span>
                    <strong>
                      {per.validation_correct}/{per.validation_total}
                    </strong>
                  </div>
                  {confusion && (
                    <div className="metric">
                      <span>Decoded as</span>
                      <strong>{confusion}</strong>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
