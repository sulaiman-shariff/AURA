import { useEffect, useRef, useState } from "react";
import { attachStimulus } from "../engine/animator";
import {
  FALLBACK_COMMAND_FREQUENCIES,
  MAX_STIMULUS_HZ,
  MIN_STIMULUS_HZ,
} from "../engine/clock";
import {
  cancelAutomaticTest,
  manualStart,
  runAutomaticTest,
  stopFlicker,
} from "../engine/session";
import { useStore } from "../engine/store";

export function Stage() {
  const discRef = useRef<HTMLDivElement>(null);

  const flickerRunning = useStore((s) => s.flickerRunning);
  const automaticRunning = useStore((s) => s.automaticRunning);
  const calibrationRunning = useStore((s) => s.calibrationRunning);
  const selectionBusy = useStore((s) => s.selection.busy);
  const refreshReady = useStore((s) => s.refreshReady);
  const refreshHz = useStore((s) => s.refreshHz);
  const requestedHz = useStore((s) => s.requestedHz);
  const actualHz = useStore((s) => s.actualHz);
  const clamped = useStore((s) => s.clamped);
  // Derived from the measured refresh so it is right before the first trial too.
  const framesPerCycle = actualHz > 0 ? refreshHz / actualHz : NaN;
  const status = useStore((s) => s.status);
  const commandFrequencies =
    useStore((s) => s.config)?.frequencies ?? FALLBACK_COMMAND_FREQUENCIES;

  // Defaults to the first command frequency; 10 Hz sat on the alpha peak.
  const [frequency, setFrequency] = useState(String(FALLBACK_COMMAND_FREQUENCIES[0]));

  useEffect(() => {
    attachStimulus(discRef.current);
    return () => attachStimulus(null);
  }, []);

  // The sweep drives the input so the operator can see which trial is live.
  useEffect(() => {
    if (automaticRunning) setFrequency(requestedHz.toFixed(3));
  }, [automaticRunning, requestedHz]);

  const trialStarting = useStore((s) => s.trialStarting);

  // flickerRunning and trialStarting belong here too: a trial is "busy" from
  // the instant it is requested, not from when the flicker begins.
  const busy =
    automaticRunning || calibrationRunning || selectionBusy || flickerRunning || trialStarting;
  const manualDisabled = busy || !refreshReady;

  return (
    <section className="card card--stage">
      <div className={`stage ${flickerRunning ? "is-live" : ""}`}>
        <div className="stage__corner">
          <span className="stage__corner-dot" aria-hidden="true" />
          {flickerRunning ? "Stimulus live" : "Stimulus idle"}
        </div>
        <div className="stage__corner stage__corner--right">
          {refreshReady ? `${refreshHz.toFixed(2)} Hz display` : "measuring display…"}
        </div>

        <div
          ref={discRef}
          className="stage__disc"
          role="img"
          aria-label="Visual stimulus"
        />

        <div className="stage__hint">Fixate on the centre of the disc</div>
      </div>

      <dl className="readout">
        <div className="readout__item">
          <dt>Requested</dt>
          <dd>{requestedHz.toFixed(3)} Hz</dd>
        </div>
        <div className="readout__item">
          <dt>Displayed</dt>
          <dd className={clamped ? "is-clamped" : ""}>
            {actualHz.toFixed(3)} Hz
            {clamped && <span className="readout__flag">clamped</span>}
          </dd>
        </div>
        <div className="readout__item">
          <dt>Frames / cycle</dt>
          <dd>{Number.isFinite(framesPerCycle) ? framesPerCycle.toFixed(2) : "—"}</dd>
        </div>
      </dl>

      <p className={`status-line ${flickerRunning || busy ? "is-active" : ""}`}>
        <span className="status-line__dot" aria-hidden="true" />
        {status}
      </p>

      <div className="card__section">
        <div className="card__head">
          <h2>Single trial</h2>
        </div>

        <div className="controls">
          <label className="field">
            <span className="field__label">Frequency (Hz)</span>
            <input
              className="field__input"
              name="frequency"
              type="number"
              inputMode="decimal"
              min={MIN_STIMULUS_HZ}
              max={MAX_STIMULUS_HZ}
              step={0.1}
              value={frequency}
              disabled={manualDisabled}
              onChange={(event) => setFrequency(event.target.value)}
            />
          </label>

          <button
            type="button"
            className="btn btn--primary"
            disabled={manualDisabled}
            onClick={() => void manualStart(Number(frequency))}
          >
            Start trial
          </button>

          <button type="button" className="btn btn--secondary" onClick={() => void stopFlicker()}>
            Stop
          </button>

          <span className="controls__gap" />

          <button
            type="button"
            className="btn btn--secondary"
            disabled={manualDisabled}
            onClick={() => void runAutomaticTest()}
          >
            Run {commandFrequencies.join(" / ")} Hz sweep
          </button>

          <button
            type="button"
            className="btn btn--danger"
            disabled={!automaticRunning}
            onClick={() => void cancelAutomaticTest()}
          >
            Cancel sweep
          </button>
        </div>

        <p className="hint">
          Esc or Space stops the stimulus immediately. Hiding the tab stops it too.
        </p>
      </div>
    </section>
  );
}
