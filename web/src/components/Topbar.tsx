import { useStore } from "../engine/store";
import { enterFullscreen } from "../engine/session";

export function Topbar() {
  const refreshHz = useStore((s) => s.refreshHz);
  const refreshReady = useStore((s) => s.refreshReady);
  const serverOnline = useStore((s) => s.serverOnline);
  const profile = useStore((s) => s.profile);

  return (
    <header className="topbar">
      <div className="brand">
        <h1 className="brand__mark">AURA</h1>
        <span className="brand__sub">SSVEP bench</span>
      </div>

      <div className="topbar__chips">
        <div className="chip">
          <span className="chip__label">Display</span>
          <span className="chip__value">
            {refreshReady ? `${refreshHz.toFixed(2)} Hz` : "measuring…"}
          </span>
        </div>

        <div className="chip">
          <span className="chip__label">Evidence / margin</span>
          <span className="chip__value">
            {profile
              ? profile.keys
                  .map(
                    (k) =>
                      `${k} Hz ${profile.thresholds[k].evidence_threshold.toFixed(1)}/${profile.thresholds[k].margin_threshold.toFixed(1)}`,
                  )
                  .join(" · ") + " dB"
              : "—"}
          </span>
        </div>

        <div className={`chip chip--status ${serverOnline ? "is-on" : "is-off"}`}>
          <span className="chip__dot" aria-hidden="true" />
          <span className="chip__value">{serverOnline ? "Server linked" : "Server offline"}</span>
        </div>

        <button type="button" className="btn btn--ghost" onClick={enterFullscreen}>
          Fullscreen
        </button>
      </div>
    </header>
  );
}
