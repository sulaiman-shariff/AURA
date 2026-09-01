import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { getState, setState } from "./engine/store";
import "./styles/global.css";

// Dev-only hook so UI states (results, calibration, selection) can be
// injected from the console without driving the real headset.
if (import.meta.env.DEV) {
  (window as unknown as { __aura: unknown }).__aura = { getState, setState };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
