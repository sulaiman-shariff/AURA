import { useEffect, useRef, useState } from "react";
import { attachTile } from "../engine/animator";
import { runSelection } from "../engine/session";
import { useStore } from "../engine/store";
import type { Band } from "../engine/types";

const BANDS: { value: Band; label: string; range: string }[] = [
  // "clear" is the default: it sits above the alpha rhythm (8-13 Hz), which
  // otherwise outscores a real SSVEP at any other frequency.
  { value: "clear", label: "Clear", range: "14–20 Hz · above alpha" },
  { value: "standard", label: "Standard", range: "8.0–15.6 Hz · best SNR, alpha risk" },
  { value: "comfort", label: "Comfort", range: "11–20 Hz · overlaps alpha" },
  { value: "high", label: "High", range: "30–35 Hz · limited by decoder low-pass" },
];

interface TileProps {
  index: number;
  hz: number;
  label: string;
  state: "idle" | "winner" | "unsure";
  evidence: number | null;
}

function Tile({ index, hz, label, state, evidence }: TileProps) {
  const patchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = patchRef.current;
    if (!element) return;
    return attachTile(`selection-${index}`, element, hz, 0);
  }, [index, hz]);

  return (
    <div className={`tile tile--${state}`}>
      {/* The label never flickers: reading it must not require staring at a strobing surface. */}
      <div ref={patchRef} className="tile__patch" aria-hidden="true" />
      <div className="tile__label">{label}</div>
      <div className="tile__meta">
        <span>{hz.toFixed(2)} Hz</span>
        {evidence !== null && <span className="tile__evidence">{evidence.toFixed(1)} dB</span>}
      </div>
    </div>
  );
}

export function SelectionPanel() {
  const selection = useStore((s) => s.selection);
  const automaticRunning = useStore((s) => s.automaticRunning);
  const calibrationRunning = useStore((s) => s.calibrationRunning);
  const refreshReady = useStore((s) => s.refreshReady);

  const [count, setCount] = useState("4");
  const [band, setBand] = useState<Band>("clear");

  const disabled = selection.busy || automaticRunning || calibrationRunning || !refreshReady;
  const hasTiles = selection.frequencies.length > 0;

  return (
    <section className="card">
      <div className="card__head">
        <h2>Multi-target selection</h2>
        {selection.busy && <span className="pill pill--recording pill--sm"><span className="pill__dot" />Running</span>}
      </div>

      <p className="lede">
        Several tiles flicker at once, each at its own frequency, and the headset decodes
        which one you looked at. Frequencies are allocated for this display inside a
        single octave, so no tile's second harmonic can land on another.
      </p>

      <div className="controls">
        <label className="field">
          <span className="field__label">Targets</span>
          <input
            className="field__input field__input--short"
            name="targets"
            type="number"
            min={2}
            max={8}
            step={1}
            value={count}
            disabled={disabled}
            onChange={(event) => setCount(event.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">Band</span>
          <select
            className="field__input"
            name="band"
            value={band}
            disabled={disabled}
            onChange={(event) => setBand(event.target.value as Band)}
          >
            {BANDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} · {option.range}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="btn btn--primary"
          disabled={disabled}
          onClick={() => void runSelection(parseInt(count, 10) || 4, band)}
        >
          Run selection
        </button>
      </div>

      {hasTiles && (
        <div className="tiles">
          {selection.frequencies.map((hz, index) => (
            <Tile
              key={`${index}-${hz}`}
              index={index}
              hz={hz}
              label={selection.labels[index]}
              state={
                selection.winner === index
                  ? selection.confident
                    ? "winner"
                    : "unsure"
                  : "idle"
              }
              evidence={selection.evidence[index] ?? null}
            />
          ))}
        </div>
      )}

      <p className={`status-line ${selection.busy ? "is-active" : ""}`}>
        <span className="status-line__dot" aria-hidden="true" />
        {selection.status || "Idle. Choose a target count and band, then run a selection."}
      </p>
      {selection.detail && <p className="hint">{selection.detail}</p>}
    </section>
  );
}
