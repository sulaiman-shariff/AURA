import { useStore } from "../engine/store";

export type TabKey = "live" | "bench" | "calibration";

const TABS: { key: TabKey; label: string; detail: string }[] = [
  { key: "live", label: "Live session", detail: "Camera, tags, HELP" },
  { key: "bench", label: "Bench", detail: "Single trials and selection tests" },
  { key: "calibration", label: "Calibration", detail: "Baseline and thresholds" },
];

/**
 * Top-level navigation.
 *
 * The page used to be one long scroll with every panel stacked, so the
 * controls that start a trial could sit thousands of pixels from the
 * stimulus they drive. Splitting it means the live session gets a clean
 * screen of its own -- which is what it is presented from -- and the bench
 * tools stay available without cluttering it.
 *
 * Switching is blocked while anything is running: tearing a panel out of the
 * DOM mid-session would unmount the flickering element the animator is
 * writing to, and abandon a trial the firmware is still recording.
 */
export function Tabs({
  active,
  onChange,
}: {
  active: TabKey;
  onChange: (tab: TabKey) => void;
}) {
  const calibrationRunning = useStore((s) => s.calibrationRunning);
  const sceneRunning = useStore((s) => s.scene.running);
  const liveRunning = useStore((s) => s.live.running);
  const selectionBusy = useStore((s) => s.selection.busy);
  const automaticRunning = useStore((s) => s.automaticRunning);

  const busy =
    calibrationRunning || sceneRunning || liveRunning || selectionBusy || automaticRunning;

  return (
    <nav className="tabs" aria-label="Sections">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          className={`tab ${active === tab.key ? "is-active" : ""}`}
          aria-current={active === tab.key ? "page" : undefined}
          disabled={busy && active !== tab.key}
          title={busy && active !== tab.key ? "Stop the running session first" : tab.detail}
          onClick={() => onChange(tab.key)}
        >
          <span className="tab__label">{tab.label}</span>
          <span className="tab__detail">{tab.detail}</span>
        </button>
      ))}
    </nav>
  );
}
