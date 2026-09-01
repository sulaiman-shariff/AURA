import { useEffect, useState } from "react";
import { CalibrationPanel } from "./components/CalibrationPanel";
import { HistoryTable } from "./components/HistoryTable";
import { LivePanel } from "./components/LivePanel";
import { Notice } from "./components/Notice";
import { ResultPanel } from "./components/ResultPanel";
import { ScenePanel } from "./components/ScenePanel";
import { SelectionPanel } from "./components/SelectionPanel";
import { Stage } from "./components/Stage";
import { Tabs, type TabKey } from "./components/Tabs";
import { Topbar } from "./components/Topbar";
import { initialise } from "./engine/session";

export default function App() {
  const [tab, setTab] = useState<TabKey>("live");

  useEffect(() => {
    initialise();
  }, []);

  return (
    <div className="app">
      <Topbar />
      <Notice />

      <aside className="warning" role="alert">
        <strong>Flashing-light warning.</strong> Do not use with anyone who has photosensitive
        epilepsy, a history of seizures, unexplained blackouts, or discomfort from flashing
        lights. Stop immediately if symptoms occur.
      </aside>

      <Tabs active={tab} onChange={setTab} />

      {/*
        The Stage is mounted on the bench and calibration tabs only. It owns
        the element the animator writes the stimulus to, so calibration --
        which drives that disc -- cannot run without it. The live session
        flickers its own tags and does not need it.
      */}
      <main className={`layout${tab === "live" ? " layout--wide" : ""}`}>
        <div className="layout__main">
          {tab === "live" && <ScenePanel />}

          {tab === "bench" && (
            <>
              <Stage />
              <LivePanel />
              <SelectionPanel />
            </>
          )}

          {tab === "calibration" && (
            <>
              <Stage />
              <CalibrationPanel />
            </>
          )}
        </div>

        {/*
          History is a bench tool. Beside the live video it is noise, and it
          is the first thing an audience reads instead of the demo.
        */}
        <div className="layout__rail">
          <ResultPanel />
          {tab !== "live" && <HistoryTable />}
        </div>
      </main>
    </div>
  );
}
