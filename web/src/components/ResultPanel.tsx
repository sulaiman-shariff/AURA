import { useStore } from "../engine/store";
import { db, formatMetric, hz } from "../format";
import { Pill, type PillTone } from "./Pill";

interface Row {
  label: string;
  value: string;
}

function Group({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="metric-group">
      <div className="metric-group__title">{title}</div>
      {rows.map((row) => (
        <div key={row.label} className="metric">
          <span>{row.label}</span>
          <strong>{row.value}</strong>
        </div>
      ))}
    </div>
  );
}

export function ResultPanel() {
  const result = useStore((s) => s.lastResult);
  const tone = useStore((s) => s.matchTone);
  const flickerRunning = useStore((s) => s.flickerRunning);
  const requestedHz = useStore((s) => s.requestedHz);
  const actualHz = useStore((s) => s.actualHz);

  let pillTone: PillTone = tone;
  let pillText: string;

  switch (tone) {
    case "recording":
      pillText = flickerRunning ? "Recording" : "Awaiting result";
      break;
    case "match":
      pillText = "Match";
      break;
    case "no-match":
      pillText = "No match";
      break;
    case "uncertain":
      pillText = "No confident peak";
      break;
    default:
      pillTone = "idle";
      pillText = "Waiting";
  }

  const competitor =
    result?.competitor_evidence_db == null
      ? "—"
      : `${db(result.competitor_evidence_db)}${result.competitor_hz ? ` @ ${formatMetric(result.competitor_hz, 1)} Hz` : ""}`;

  return (
    <section className="card card--result">
      <div className="card__head">
        <h2>Latest result</h2>
        <Pill tone={pillTone}>{pillText}</Pill>
      </div>

      <div className="result-hero">
        {result ? (
          <>
            <div className="result-hero__value">
              {formatMetric(result.detected_hz, 2)}
              <span className="result-hero__unit">Hz</span>
            </div>
            <div className="result-hero__caption">
              detected · trial {result.trial_id} · target {hz(result.target_hz)}
            </div>
          </>
        ) : (
          <>
            <div className="result-hero__value result-hero__value--empty">
              <span className="result-hero__unit">no result yet</span>
            </div>
            <div className="result-hero__caption">
              the headset posts here after each trial
            </div>
          </>
        )}
      </div>

      <Group
        title="Stimulus"
        rows={[
          { label: "Requested", value: hz(requestedHz, 3) },
          { label: "Displayed", value: hz(actualHz, 3) },
        ]}
      />

      <Group
        title="Main channel"
        rows={[
          { label: "Target SNR", value: db(result?.main_fundamental_snr_db) },
          { label: "2nd-harmonic SNR", value: db(result?.main_harmonic_snr_db) },
          { label: "Peak-to-peak", value: formatMetric(result?.main_p2p, 0) },
        ]}
      />

      <Group
        title="Artifact channel"
        rows={[
          { label: "Target SNR", value: db(result?.artifact_fundamental_snr_db) },
          { label: "Peak-to-peak", value: formatMetric(result?.artifact_p2p, 0) },
        ]}
      />

      <Group
        title="Decision"
        rows={[
          { label: "Evidence", value: db(result?.score) },
          { label: "Margin", value: db(result?.margin) },
          { label: "Competitor", value: competitor },
          { label: "Source", value: result?.source || "—" },
          { label: "Rejection reason", value: result?.reason || "—" },
        ]}
      />
    </section>
  );
}
