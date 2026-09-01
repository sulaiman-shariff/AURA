import { useStore } from "../engine/store";
import { formatMetric } from "../format";

export function HistoryTable() {
  const history = useStore((s) => s.history);
  const rows = [...history].reverse();

  return (
    <section className="card card--history">
      <div className="card__head">
        <h2>History</h2>
        <span className="card__meta">{history.length ? `last ${history.length}` : ""}</span>
      </div>

      {rows.length === 0 ? (
        <p className="empty">No trials yet. Results from the headset appear here as they arrive.</p>
      ) : (
        <div className="table-scroll">
          <table className="history">
            <thead>
              <tr>
                <th>#</th>
                <th>Target</th>
                <th>Detected</th>
                <th>Evidence</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((result) => {
                const tone = !result.confident
                  ? "uncertain"
                  : result.match
                    ? "match"
                    : "no-match";
                const text = !result.confident
                  ? "Uncertain"
                  : result.match
                    ? "Match"
                    : "No match";
                return (
                  <tr key={result.trial_id} className={result.accepted === false ? "is-rejected" : ""}>
                    <td>{result.trial_id}</td>
                    <td>{formatMetric(result.target_hz, 2)}</td>
                    <td>{formatMetric(result.detected_hz, 2)}</td>
                    <td>{formatMetric(result.score, 2)}</td>
                    <td>
                      <span className={`result-tag result-tag--${tone}`}>
                        <span className="result-tag__dot" aria-hidden="true" />
                        {text}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
