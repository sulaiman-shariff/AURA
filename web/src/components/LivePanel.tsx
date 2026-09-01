import { useEffect, useRef, useState } from "react";
import { attachTile } from "../engine/animator";
import { acknowledgeHelp, startLiveSession, stopLiveSession } from "../engine/live";
import { speechAvailable } from "../engine/speech";
import { useStore } from "../engine/store";
import type { Band, LiveTile } from "../engine/types";

const BANDS: { value: Band; label: string }[] = [
  // Default is "clear": above the alpha rhythm, which otherwise dominates.
  { value: "clear", label: "Clear · 14–20 Hz (above alpha)" },
  { value: "standard", label: "Standard · 8.0–15.6 Hz (alpha risk)" },
  { value: "comfort", label: "Comfort · 11–20 Hz" },
  { value: "high", label: "High · 30–35 Hz" },
];

const DEFAULT_OPTIONS = ["Water", "Pain", "Reposition", "Too hot", "Too cold", "Toilet"];

interface TileProps {
  index: number;
  tile: LiveTile;
  state: "idle" | "winner" | "unsure";
  evidence: number | null;
  counting: boolean;
}

function LiveTileView({ index, tile, state, evidence, counting }: TileProps) {
  const patchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = patchRef.current;
    if (!element) return;
    return attachTile(`live-${index}`, element, tile.hz, 0);
  }, [index, tile.hz]);

  return (
    <div
      className={`tile tile--${state} tile--${tile.kind}${
        counting && tile.kind === "help" ? " tile--counting" : ""
      }`}
    >
      {/* Only this surface modulates; the label must stay readable. */}
      <div ref={patchRef} className="tile__patch" aria-hidden="true" />
      <div className="tile__label">{tile.label}</div>
      <div className="tile__meta">
        <span>{tile.hz.toFixed(2)} Hz</span>
        {evidence !== null && <span className="tile__evidence">{evidence.toFixed(1)} dB</span>}
      </div>
    </div>
  );
}

export function LivePanel() {
  const live = useStore((s) => s.live);
  const refreshReady = useStore((s) => s.refreshReady);
  const calibrationRunning = useStore((s) => s.calibrationRunning);
  const selectionBusy = useStore((s) => s.selection.busy);

  const [band, setBand] = useState<Band>("clear");

  const blocked = calibrationRunning || selectionBusy || !refreshReady;
  const counting = live.helpCountdown !== null;

  return (
    <section className={`card${live.helpFired ? " card--alarm" : ""}`}>
      <div className="card__head">
        <h2>Live session</h2>
        {live.running && (
          <span className="pill pill--recording pill--sm">
            <span className="pill__dot" />
            Window {live.windowsRun + 1}
          </span>
        )}
      </div>

      <p className="lede">
        Decode windows run back to back over a persistent tile set. HELP and Cancel are
        always present. HELP needs two consecutive windows: the first speaks a warning and
        starts a countdown, and looking away during the second aborts it.
      </p>

      {live.helpFired && (
        <div className="alarm-banner" role="alert">
          <strong>HELP TRIGGERED</strong>
          <span>
            The alarm sounded in this browser with no network call, so it works even offline.
          </span>
          {/* Never imply someone is coming until the server says they were told. */}
          <span className={live.alertForwarded ? "alarm-banner__ok" : "alarm-banner__warn"}>
            {live.alertForwarded === null
              ? "Contacting a caregiver…"
              : live.alertForwarded
                ? "A caregiver was notified."
                : "Nobody was notified remotely."}
            {live.alertDetail ? ` ${live.alertDetail}` : ""}
          </span>
          <button type="button" className="btn btn--danger" onClick={acknowledgeHelp}>
            Acknowledge
          </button>
        </div>
      )}

      <div className="controls">
        <label className="field">
          <span className="field__label">Band</span>
          <select
            className="field__input"
            name="live-band"
            value={band}
            disabled={live.running || blocked}
            onChange={(event) => setBand(event.target.value as Band)}
          >
            {BANDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {live.running ? (
          <button type="button" className="btn btn--danger" onClick={stopLiveSession}>
            Stop session
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            disabled={blocked}
            onClick={() => void startLiveSession(band, DEFAULT_OPTIONS)}
          >
            Start session
          </button>
        )}
      </div>

      {live.tiles.length > 0 && (
        <div className="tiles">
          {live.tiles.map((tile, index) => (
            <LiveTileView
              key={`${index}-${tile.hz}`}
              index={index}
              tile={tile}
              state={
                live.winner === index ? (live.confident ? "winner" : "unsure") : "idle"
              }
              evidence={live.evidence[index] ?? null}
              counting={counting}
            />
          ))}
        </div>
      )}

      <p className={`status-line ${live.running ? "is-active" : ""}`}>
        <span className="status-line__dot" aria-hidden="true" />
        {live.status || "Idle. Start a session to run continuous decode windows."}
      </p>
      {live.detail && <p className="hint">{live.detail}</p>}

      {live.transcript.length > 0 && (
        <div className="transcript">
          <span className="transcript__label">Selections</span>
          <ol className="transcript__list">
            {live.transcript.slice(-8).map((entry, index) => (
              <li key={`${index}-${entry}`}>{entry}</li>
            ))}
          </ol>
        </div>
      )}

      {!speechAvailable() && (
        <p className="hint">
          This browser has no speech synthesis, so spoken feedback — including the HELP
          countdown warning — will be silent.
        </p>
      )}
    </section>
  );
}
