import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { attachTile } from "../engine/animator";
import { attachVideo, listCameras, startCamera, stopCamera } from "../engine/camera";
import { acknowledgeSceneHelp, startScene, stopScene } from "../engine/scene";
import { patchScene, useStore } from "../engine/store";
import { detectorState } from "../engine/detector";
import { SceneOverlay, type OverlayItem } from "./SceneOverlay";
import type { Box } from "../engine/labelLayout";
import type { Band, LiveTile } from "../engine/types";

const BANDS: { value: Band; label: string }[] = [
  // Default is "clear": above the alpha rhythm, which otherwise dominates.
  { value: "clear", label: "Clear · 14–20 Hz (above alpha)" },
  { value: "standard", label: "Standard · 8.0–15.6 Hz (alpha risk)" },
  { value: "comfort", label: "Comfort · 11–20 Hz" },
  { value: "high", label: "High · 30–35 Hz" },
];

/**
 * HELP and Cancel, pinned to the bottom corners of the view.
 *
 * They are stimuli like any other tag, so they carry a real reticle; the
 * difference is that they never move, which is the point. A control that can
 * summon help has to be findable without searching, and in a headset the
 * corners of the field are the only places that are always in the same
 * place.
 */
function CornerTarget({
  tile,
  corner,
  state,
  evidence,
}: {
  tile: LiveTile;
  corner: "left" | "right";
  state: "idle" | "winner" | "unsure";
  evidence: number | null;
}) {
  const patchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = patchRef.current;
    if (!element) return;
    return attachTile(`scene-${tile.hz.toFixed(2)}`, element, tile.hz, 0);
  }, [tile.hz]);

  return (
    <div className={`corner corner--${corner} corner--${tile.kind} corner--${state}`}>
      <div ref={patchRef} className={`reticle reticle--${state}`} />
      <div className="corner__text">
        <span className="corner__label">{tile.label}</span>
        <span className="corner__hz">
          {tile.hz.toFixed(1)}
          <i>Hz</i>
          {evidence !== null && <em>{evidence.toFixed(1)} dB</em>}
        </span>
      </div>
    </div>
  );
}

/** One proposed intent, shown as a target in a bar across the view. */
function IntentTarget({
  tile,
  state,
  evidence,
}: {
  tile: LiveTile;
  state: "idle" | "winner" | "unsure";
  evidence: number | null;
}) {
  const patchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = patchRef.current;
    if (!element) return;
    return attachTile(`scene-${tile.hz.toFixed(2)}`, element, tile.hz, 0);
  }, [tile.hz]);

  return (
    <div className={`intent intent--${state}`}>
      <div ref={patchRef} className={`reticle reticle--${state}`} />
      <span className="intent__label">{tile.label}</span>
      <span className="intent__hz">
        {tile.hz.toFixed(1)}
        <i>Hz</i>
        {/* Live evidence: during a demo this is the visible proof that the
            decode is responding to where the person is looking. */}
        {evidence !== null && <em>{evidence.toFixed(1)} dB</em>}
      </span>
    </div>
  );
}

export function ScenePanel() {
  const scene = useStore((s) => s.scene);
  const live = useStore((s) => s.live);
  const refreshReady = useStore((s) => s.refreshReady);
  const calibrationRunning = useStore((s) => s.calibrationRunning);

  const videoRef = useRef<HTMLVideoElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [presenting, setPresenting] = useState(false);
  const [band, setBand] = useState<Band>("clear");

  /*
   * Where the video actually is inside its box, in percentages.
   *
   * Detector boxes are fractions of the CAMERA FRAME. The element they are
   * drawn into is a fixed 16:9 panel, and a 4:3 camera does not fill it. The
   * video was previously `object-fit: cover`, which crops to fill -- so a
   * box at y=0.5 of the frame landed nowhere near y=50% of the panel, and the
   * error grew with every pan. The video is now letterboxed (`contain`) and
   * the tags live in an overlay pinned to exactly the rectangle the video
   * occupies, so frame fractions and overlay percentages are the same thing.
   */
  const [videoBox, setVideoBox] = useState({ left: 0, top: 0, width: 100, height: 100 });
  // Pixel size of the video rectangle: label collision is a px problem.
  const [overlaySize, setOverlaySize] = useState({ width: 0, height: 0 });
  // Rectangles of the fixed HUD, in overlay-local px, so labels dodge them.
  const [obstacles, setObstacles] = useState<Box[]>([]);
  const overlayRef = useRef<HTMLDivElement>(null);

  const measureVideo = useCallback(() => {
    const video = videoRef.current;
    const view = viewRef.current;
    if (!video || !view) return;

    const cw = view.clientWidth;
    const ch = view.clientHeight;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!cw || !ch || !vw || !vh) return;

    const scale = Math.min(cw / vw, ch / vh);
    const w = vw * scale;
    const h = vh * scale;

    setVideoBox({
      left: ((cw - w) / 2 / cw) * 100,
      top: ((ch - h) / 2 / ch) * 100,
      width: (w / cw) * 100,
      height: (h / ch) * 100,
    });
    setOverlaySize({ width: Math.round(w), height: Math.round(h) });
  }, []);

  /*
   * Presentation mode: the scene fills the screen, which is both how it
   * reads from the back of a room and how it would look through a headset --
   * the room with targets on it, and nothing else.
   */
  useEffect(() => {
    const onChange = () => {
      const active = document.fullscreenElement === stageRef.current;
      setPresenting(active);
      // The video rectangle changes completely; remeasure or every box lands
      // in the wrong place.
      window.setTimeout(measureVideo, 60);
    };

    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [measureVideo]);

  const togglePresenting = useCallback(async () => {
    const stage = stageRef.current;
    if (!stage) return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await stage.requestFullscreen();
      }
    } catch (error) {
      console.error(error);
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const view = viewRef.current;
    if (!video || !view) return;

    measureVideo();

    const observer = new ResizeObserver(measureVideo);
    observer.observe(view);
    video.addEventListener("loadedmetadata", measureVideo);
    // A camera can change resolution after the stream starts, and switching
    // cameras changes aspect ratio entirely.
    const poll = window.setInterval(measureVideo, 1000);

    return () => {
      observer.disconnect();
      video.removeEventListener("loadedmetadata", measureVideo);
      window.clearInterval(poll);
    };
  }, [measureVideo]);

  useEffect(() => {
    attachVideo(videoRef.current);
    // Populate the picker up front; labels fill in once permission is given.
    void listCameras().then((cameras) => patchScene({ cameras }));
    return () => {
      attachVideo(null);
      stopCamera();
    };
  }, []);

  async function handleCamera() {
    if (scene.cameraReady) {
      stopCamera();
      patchScene({ cameraReady: false, cameraDetail: "Camera stopped." });
      return;
    }

    const outcome = await startCamera(scene.cameraId || undefined);
    patchScene({ cameraReady: outcome.ok, cameraDetail: outcome.detail });

    // Labels are only exposed after permission has been granted once.
    void listCameras().then((cameras) => patchScene({ cameras }));
  }

  const blocked = calibrationRunning || live.running || !refreshReady;

  const tileState = (hz: number): "idle" | "winner" | "unsure" => {
    const winner = scene.tiles[scene.winner];
    if (!winner || Math.abs(winner.hz - hz) > 1e-6) return "idle";
    return scene.confident ? "winner" : "unsure";
  };

  const evidenceFor = (hz: number): number | null => {
    const index = scene.tiles.findIndex((tile) => Math.abs(tile.hz - hz) < 1e-6);
    if (index < 0) return null;
    const value = scene.evidence[index];
    return typeof value === "number" ? value : null;
  };

  const fixedTiles = scene.tiles.slice(0, 2);
  const showingObjects = scene.stage === "objects" || scene.stage === "scanning";

  /*
   * Measure the fixed HUD so labels can dodge it.
   *
   * The readout grows with its own text and the corner targets move between
   * windowed and presentation mode, so these rectangles are read from the DOM
   * rather than assumed -- the same reason chips are measured. Positions are
   * converted to overlay-local px, which is the space the layout works in.
   */
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const stage = stageRef.current;
    if (!overlay || !stage) return;

    const measure = () => {
      const base = overlay.getBoundingClientRect();
      const next: Box[] = [];

      stage.querySelectorAll(".readout, .corner, .intent-bar").forEach((node) => {
        const r = node.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        next.push({
          x: r.left - base.left,
          y: r.top - base.top,
          w: r.width,
          h: r.height,
        });
      });

      setObstacles((previous) => {
        const same =
          previous.length === next.length &&
          previous.every((b, i) =>
            Math.abs(b.x - next[i].x) < 1 &&
            Math.abs(b.y - next[i].y) < 1 &&
            Math.abs(b.w - next[i].w) < 1 &&
            Math.abs(b.h - next[i].h) < 1,
          );
        return same ? previous : next;
      });
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(overlay);
    stage.querySelectorAll(".readout, .corner, .intent-bar").forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [presenting, showingObjects, scene.running, scene.status, scene.detail, scene.intents.length, overlaySize]);

  const showingIntents = scene.stage === "intents" || scene.stage === "acted";

  // Objects carry their own pinned frequency, so tags survive re-detection.
  // Those without one were detected but the frequency budget was spent.
  const withFrequency = scene.objects.map((object, index) => ({
    object,
    hz: scene.objectFrequencies[index],
  }));

  const overlayItems: OverlayItem[] = withFrequency.map(({ object, hz }) => ({
    object,
    hz: typeof hz === "number" ? hz : null,
    state: typeof hz === "number" ? tileState(hz) : "idle",
    evidence: typeof hz === "number" ? evidenceFor(hz) : null,
  }));

  const detector = detectorState();

  const staleSeconds =
    scene.lastDetectionAt !== null
      ? Math.round((Date.now() - scene.lastDetectionAt) / 1000)
      : null;

  return (
    <section className={`card card--live${scene.helpFired ? " card--alarm" : ""}`}>
      <div className="card__head">
        <h2>Live session</h2>
        <div className="card__head-right">
          {scene.detectorSource && (
            <span className="pill pill--sm">
              {scene.detectorSource === "hybrid"
                ? scene.viewStill
                  ? "On-device + Gemini · enriching"
                  : "On-device + Gemini"
                : scene.detectorSource === "local"
                  ? "On-device vision"
                  : "Cloud vision"}
            </span>
          )}
          {scene.source === "stub" && (
            <span className="pill pill--sm pill--warn">Placeholder data</span>
          )}
          {scene.running && (
            <span className="pill pill--recording pill--sm">
              <span className="pill__dot" />
              Live
            </span>
          )}
        </div>
      </div>

      {scene.helpFired && (
        <div className="alarm-banner" role="alert">
          <strong>HELP TRIGGERED</strong>
          <span>
            The alarm sounded in this browser with no network call, so it works even offline.
          </span>
          <span className={scene.alertForwarded ? "alarm-banner__ok" : "alarm-banner__warn"}>
            {scene.alertForwarded === null
              ? "Contacting a caregiver…"
              : scene.alertForwarded
                ? "A caregiver was notified."
                : "Nobody was notified remotely."}
            {scene.alertDetail ? ` ${scene.alertDetail}` : ""}
          </span>
          <button type="button" className="btn btn--danger" onClick={acknowledgeSceneHelp}>
            Acknowledge
          </button>
        </div>
      )}

      <div className="controls">
        <button type="button" className="btn" onClick={() => void handleCamera()}>
          {scene.cameraReady ? "Stop camera" : "Start camera"}
        </button>

        {scene.cameras.length > 1 && (
          <label className="field">
            <span className="field__label">Camera</span>
            <select
              className="field__input"
              name="camera"
              value={scene.cameraId}
              disabled={scene.cameraReady || scene.running}
              onChange={(event) => patchScene({ cameraId: event.target.value })}
            >
              <option value="">Default</option>
              {scene.cameras.map((camera) => (
                <option key={camera.deviceId} value={camera.deviceId}>
                  {camera.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="field">
          <span className="field__label">Band</span>
          <select
            className="field__input"
            name="scene-band"
            value={band}
            disabled={scene.running || blocked}
            onChange={(event) => setBand(event.target.value as Band)}
          >
            {BANDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="btn"
          disabled={!scene.cameraReady}
          onClick={() => void togglePresenting()}
        >
          Full screen
        </button>

        {scene.running ? (
          <button type="button" className="btn btn--danger" onClick={stopScene}>
            Stop session
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            disabled={blocked || !scene.cameraReady}
            onClick={() => void startScene(band)}
          >
            Start session
          </button>
        )}
      </div>

      <div
        className={`stage-shell${presenting ? " is-presenting" : ""}`}
        ref={stageRef}
      >
        <div className="scene-view scene-view--large" ref={viewRef}>
          <video ref={videoRef} className="scene-view__video" muted playsInline />

          {!scene.cameraReady && (
            <div className="scene-view__empty">
              {scene.cameraDetail || "Start the camera to see the room."}
            </div>
          )}

          {/* Pinned to the video's real rectangle, so a box fraction and an
              overlay percentage mean the same thing at any aspect ratio. */}
          <div
            ref={overlayRef}
            className="scene-overlay"
            style={{
              left: `${videoBox.left}%`,
              top: `${videoBox.top}%`,
              width: `${videoBox.width}%`,
              height: `${videoBox.height}%`,
            }}
          >
            {showingObjects && (
              <SceneOverlay
                items={overlayItems}
                width={overlaySize.width}
                height={overlaySize.height}
                obstacles={obstacles}
              />
            )}
          </div>

          {scene.notice && <div className="notice">{scene.notice}</div>}

          {scene.running && (
            <div className="readout">
              <span className={`readout__dot ${scene.viewStill ? "is-settled" : ""}`} />
              <span className="readout__stage">{scene.status}</span>
              {scene.detail && <span className="readout__detail">{scene.detail}</span>}
            </div>
          )}

          {/*
            HELP and Cancel live in the view, not in a row beneath it. They
            are targets like any other -- the user looks at them -- so they
            belong in the same visual space as the objects, pinned to fixed
            corners where they can be found without hunting.
          */}
          {fixedTiles.map((tile, index) => (
            <CornerTarget
              key={tile.hz}
              tile={tile}
              corner={index === 0 ? "left" : "right"}
              state={tileState(tile.hz)}
              evidence={evidenceFor(tile.hz)}
            />
          ))}

          {/* Intent menus float over the view in presentation mode; there is
              no room beneath it. */}
          {showingIntents && scene.tiles.length > 2 && (
            <div className="intent-bar">
              {scene.tiles.slice(2).map((tile) => (
                <IntentTarget
                  key={tile.hz}
                  tile={tile}
                  state={tileState(tile.hz)}
                  evidence={evidenceFor(tile.hz)}
                />
              ))}
            </div>
          )}

          <button
            type="button"
            className="stage-exit"
            onClick={() => void togglePresenting()}
          >
            {presenting ? "Exit full screen" : "Full screen"}
          </button>
        </div>
      </div>

      <p className={`status-line ${scene.running ? "is-active" : ""}`}>
        <span className="status-line__dot" aria-hidden="true" />
        {scene.status || "Idle. Start the camera, then start a session."}
      </p>
      {scene.detail && <p className="hint">{scene.detail}</p>}
      {scene.running && scene.enrichedCount > 0 && (
        <p className="hint">
          Gemini added {scene.enrichedCount} object
          {scene.enrichedCount === 1 ? "" : "s"} the on-device detector missed.
        </p>
      )}
      {scene.cameraReady && scene.cameraDetail && (
        <p className="hint hint--mono">{scene.cameraDetail}</p>
      )}
      {scene.sourceDetail && <p className="hint hint--mono">{scene.sourceDetail}</p>}
      {detector === "loading" && !scene.running && (
        <p className="hint">Loading the on-device detector…</p>
      )}
      {detector === "failed" && (
        <p className="hint">
          On-device detection unavailable; falling back to Gemini, which is slower per frame.
        </p>
      )}
      {scene.running && staleSeconds !== null && staleSeconds > 8 && (
        <p className="hint hint--mono">
          Last detection {staleSeconds} s ago — tags may have drifted from their objects.
        </p>
      )}

      {scene.transcript.length > 0 && (
        <div className="transcript">
          <span className="transcript__label">This session</span>
          <ol className="transcript__list">
            {scene.transcript.slice(-8).map((entry, index) => (
              <li key={`${index}-${entry}`}>{entry}</li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
