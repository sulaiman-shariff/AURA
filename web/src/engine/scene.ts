/**
 * The scene layer: the complete AURA interaction.
 *
 *   live camera -> Gemini names the objects -> each becomes a flickering tag
 *   -> gaze selects one -> Gemini proposes intents -> each becomes a tile
 *   -> gaze selects one -> the action happens
 *
 * The two-stage structure is the safety property, not a UI flourish. The
 * model never decides an action; it proposes a menu, and the user's second
 * deliberate act of attention is what commits. README section 4.3 has the
 * reasoning (the Midas-touch problem).
 *
 * HELP and Cancel are present in every stage at fixed frequencies, and HELP
 * is never routed through the model.
 *
 * WHY THE VIDEO IS LIVE
 * --------------------
 * An earlier version froze the frame for the duration of a selection, so a
 * tag could not drift off its object. That was safe and looked dead. The
 * camera now runs continuously and a background vision loop re-detects every
 * few seconds, gliding each tag to its object's new position.
 *
 * The thing that must NOT change mid-window is the frequency assignment: the
 * server has already told the firmware which frequencies are in play, so
 * reshuffling them would decode the wrong tile. Positions update freely;
 * the tile set is rebuilt only between windows, and frequencies stay pinned
 * to object labels across re-detections so a tag keeps its frequency even as
 * the detector reorders its output.
 */
import { sleep } from "./clock";
import { fetchAllocation, raiseHelpAlert, stopTrial } from "./api";
import { detectScene, proposeIntents } from "./sceneApi";
import { captureFrame, videoElement } from "./camera";
import { detectFromVideo, detectorState, preload } from "./detector";
import { frameChange, resetMotion } from "./motion";
import { runDecodeWindow } from "./decode";
import { getState, notify, patchScene, setState } from "./store";
import { alarmTone, speak, stopSpeaking } from "./speech";
import type { Band, LiveTile, SceneIntent, SceneObject, TrialResult } from "./types";

const HELP_WINDOWS_REQUIRED = 2;

/*
 * Gap between local detections. COCO-SSD takes tens of milliseconds on the
 * GPU, so this is the actual cadence: ~8 detections a second, which is
 * smoother than the eye needs and leaves the tab responsive.
 */
const VISION_INTERVAL_MS = 120;

/*
 * How often to ask Gemini when it is the ONLY detector available.
 */
const CLOUD_VISION_INTERVAL_MS = 250;

/* ---------------------------------------------------------------------
 * Hybrid enrichment
 *
 * The local detector answers in 64 ms but only knows COCO's 80 classes; on
 * a real wall it found one clock where Gemini found four objects. Gemini
 * names anything but costs a 1-2 s round-trip, which is useless while the
 * view is moving -- its answer would describe a frame that has already gone.
 *
 * So: run the local detector continuously, and spend a Gemini call only
 * once the view has settled, when a slow answer is still a correct one.
 * The user sees boxes instantly and better labels a moment later.
 * ------------------------------------------------------------------- */

/*
 * Frame-difference below which the view counts as SETTLED (0..1).
 *
 * Not "still": a handheld or arm-mounted camera never is. Sensor noise on a
 * static view sits near 0.005 and slow drift around 0.01-0.03, while a
 * deliberate pan or rotation runs an order of magnitude higher. 0.05
 * therefore means "the rapid movement has stopped", which is the real
 * condition -- a 1-2 s cloud answer survives slow drift but not a pan.
 */
const SETTLED_THRESHOLD = 0.05;

/** How long it must stay settled before spending a call. */
const SETTLED_HOLD_MS = 600;

/** Never enrich more often than this, however settled things are. */
const MIN_ENRICH_INTERVAL_MS = 4000;

/**
 * Total accumulated view change after which Gemini's boxes are discarded.
 *
 * Nothing tracks a Gemini-only box, so it is pinned to where the world was
 * when the frame was taken. Slow drift is survivable for a while and then it
 * is not: past this budget the outlines no longer sit on their objects, and
 * a mislabelled box on the wrong thing is worse than no box.
 */
const ENRICH_DRIFT_BUDGET = 1.6;

/** And a hard ceiling on age, for a scene that is changing without moving. */
const ENRICH_TTL_MS = 25000;

/** Boxes overlapping more than this are treated as the same object. */
const SAME_OBJECT_IOU = 0.35;
const INTER_WINDOW_MS = 900;

/** How long a large on-view notice stays up. Long enough to read across a room. */
const NOTICE_MS = 1800;

/** How long an intent menu waits before giving up and returning to the scene. */
const INTENT_MENU_WINDOWS = 3;

let generation = 0;

export function stopScene(): void {
  generation += 1;
  visionGeneration += 1;
  resetAssignments();
  clearEnrichment();
  stopSpeaking();
  setState({ selectionRunning: false });
  patchScene({
    running: false,
    stage: "idle",
    helpStreak: 0,
    status: "Scene session stopped.",
    detail: "",
  });
  void stopTrial();
}

export function acknowledgeSceneHelp(): void {
  patchScene({ helpFired: false, status: "Help acknowledged.", detail: "" });
}

/*
 * Frequencies are pinned to object labels for the life of a session, so a
 * tag keeps its frequency even when the detector returns objects in a
 * different order or briefly loses one. Freed only when the label has been
 * absent for a while, so a flicker of detection noise does not reshuffle
 * the board.
 */
const assignedFrequency = new Map<string, number>();
let visionGeneration = 0;

function resetAssignments(): void {
  assignedFrequency.clear();
}

/**
 * Give each detected object a stable frequency from the item pool.
 *
 * Objects already seen keep theirs; new ones take the lowest free slot.
 * Returns only the objects that could be given a frequency -- the pool is
 * finite (README section 6.5), so surplus objects are dropped rather than
 * sharing a frequency with something else.
 */
function assignFrequencies(
  objects: SceneObject[],
  itemFrequencies: number[],
): { object: SceneObject; hz: number | null }[] {
  const taken = new Set<number>();
  const out: { object: SceneObject; hz: number | null }[] = [];
  const pending: SceneObject[] = [];

  for (const object of objects) {
    const existing = assignedFrequency.get(object.label);
    if (existing !== undefined && itemFrequencies.includes(existing) && !taken.has(existing)) {
      taken.add(existing);
      out.push({ object, hz: existing });
    } else {
      pending.push(object);
    }
  }

  for (const object of pending) {
    const free = itemFrequencies.find((hz) => !taken.has(hz));

    if (free === undefined) {
      // Detected, shown, but not selectable this round: there are more
      // objects than the frequency budget allows (README section 6.5).
      out.push({ object, hz: null });
      continue;
    }

    taken.add(free);
    assignedFrequency.set(object.label, free);
    out.push({ object, hz: free });
  }

  // Selectable tags first and in frequency order; the rest keep detection
  // order behind them.
  out.sort((a, b) => {
    if (a.hz === null && b.hz === null) return 0;
    if (a.hz === null) return 1;
    if (b.hz === null) return -1;
    return a.hz - b.hz;
  });

  return out;
}

function intersectionOverUnion(a: number[], b: number[]): number {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);

  const overlap = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (overlap <= 0) return 0;

  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);

  return overlap / (areaA + areaB - overlap);
}

/**
 * Gemini's most recent contribution, plus how far the view has moved since
 * it was taken.
 */
let enriched: { objects: SceneObject[]; at: number; drift: number } = {
  objects: [],
  at: 0,
  drift: 0,
};

function clearEnrichment(): void {
  enriched = { objects: [], at: 0, drift: 0 };
}

/**
 * Combine the two detectors.
 *
 * Where both saw the same thing, the local box wins -- it is live, and
 * Gemini's is already a second old -- but Gemini's name is adopted, because
 * "water glass" reads better on a tag than "cup". The object's identity
 * (`label`) deliberately does NOT change, since frequencies are pinned to
 * it; only `displayLabel` does.
 *
 * Objects only Gemini saw are added as-is. They do not track, so they expire.
 */
function mergeDetections(local: SceneObject[], now: number): SceneObject[] {
  const usable =
    now - enriched.at < ENRICH_TTL_MS && enriched.drift < ENRICH_DRIFT_BUDGET;
  const fresh = usable ? enriched.objects : [];
  if (fresh.length === 0) return local;

  const usedByLocal = new Set<number>();

  // Annotated: inference would narrow this to origin "local" from the map
  // and then refuse the Gemini-only objects pushed in below.
  const merged: SceneObject[] = local.map((object) => {
    let bestIndex = -1;
    let bestIou = SAME_OBJECT_IOU;

    fresh.forEach((candidate, index) => {
      if (usedByLocal.has(index)) return;
      const iou = intersectionOverUnion(object.box, candidate.box);
      if (iou > bestIou) {
        bestIou = iou;
        bestIndex = index;
      }
    });

    if (bestIndex < 0) return { ...object, origin: "local" as const };

    usedByLocal.add(bestIndex);
    return {
      ...object,
      displayLabel: fresh[bestIndex].label,
      origin: "local" as const,
    };
  });

  /*
   * `label` is the identity a frequency is pinned to, so it has to be unique
   * across the whole merged list -- not just within one detector. Gemini
   * happily returns four "picture frame"s, which previously collapsed onto a
   * single frequency and drew four chips at one spot.
   */
  const usedLabels = new Set(merged.map((object) => object.label));

  fresh.forEach((candidate, index) => {
    if (usedByLocal.has(index)) return;
    // Also drop anything overlapping a local box we did not match, to avoid
    // two outlines around one object.
    if (local.some((o) => intersectionOverUnion(o.box, candidate.box) > SAME_OBJECT_IOU)) return;

    let label = candidate.label;
    for (let n = 2; usedLabels.has(label); n += 1) label = `${candidate.label} ${n}`;
    usedLabels.add(label);

    merged.push({ ...candidate, label, displayLabel: label, origin: "gemini" as const });
  });

  return merged;
}

/**
 * Continuously re-detect the scene.
 *
 * Local detection every iteration; a Gemini call only once the view has held
 * still, and never more often than MIN_ENRICH_INTERVAL_MS. The Gemini call
 * is fired without awaiting it, so the local loop never stalls waiting for
 * the network.
 */
async function runVisionLoop(myGeneration: number, itemFrequencies: number[]): Promise<void> {
  let useLocal = detectorState() !== "failed";

  if (useLocal) {
    try {
      await preload();
    } catch {
      useLocal = false;
    }
  }

  if (visionGeneration !== myGeneration) return;

  resetMotion();
  clearEnrichment();

  patchScene({ detectorSource: useLocal ? "hybrid" : "cloud" });

  let stillSince = 0;
  let lastEnrich = 0;
  let enrichInFlight = false;

  while (visionGeneration === myGeneration) {
    const video = videoElement();
    let objects: SceneObject[] | null = null;
    let source = useLocal ? "local" : "cloud";
    let detail = "";

    if (useLocal && video) {
      objects = await detectFromVideo(video);

      if (objects === null && detectorState() === "failed") {
        useLocal = false;
        patchScene({ detectorSource: "cloud" });
      }
    }

    if (useLocal && video && objects) {
      // --- is the view settled enough for a slow, accurate answer? ------
      const change = frameChange(video);
      const now = Date.now();

      // Every frame of movement ages Gemini's boxes, whether or not the
      // view currently counts as settled.
      enriched.drift += change;

      if (change < SETTLED_THRESHOLD) {
        if (stillSince === 0) stillSince = now;
      } else {
        stillSince = 0;
      }

      const settled = stillSince !== 0 && now - stillSince >= SETTLED_HOLD_MS;

      patchScene({ viewStill: settled });

      if (
        settled &&
        !enrichInFlight &&
        now - lastEnrich >= MIN_ENRICH_INTERVAL_MS &&
        getState().scene.running
      ) {
        enrichInFlight = true;
        lastEnrich = now;

        const frame = captureFrame();

        // Fired, not awaited: the local loop must keep running at full rate
        // while this is in flight.
        void (frame ? detectScene(frame) : Promise.resolve(null))
          .then((scene) => {
            if (visionGeneration !== myGeneration) return;

            if (scene && scene.objects.length > 0) {
              // Drift resets: these boxes describe the view as it is now.
              enriched = { objects: scene.objects, at: Date.now(), drift: 0 };
              patchScene({
                lastEnrichedAt: enriched.at,
                source: scene.source,
                sourceDetail: scene.detail,
              });
            }
          })
          .finally(() => {
            enrichInFlight = false;
          });
      }

      objects = mergeDetections(objects, now);
      source = "local";
    }

    if (!useLocal) {
      const frame = captureFrame();
      const scene = frame ? await detectScene(frame) : null;

      if (scene) {
        objects = scene.objects;
        source = scene.source;
        detail = scene.detail;
      }
    }

    if (visionGeneration !== myGeneration) return;

    if (objects) {
      const assigned = assignFrequencies(objects, itemFrequencies);
      const fromGemini = objects.filter((o) => o.origin === "gemini").length;

      patchScene({
        objects: assigned.map((a) => a.object),
        // null where the object was detected but there was no frequency
        // left for it; the panel still draws a labelled box.
        objectFrequencies: assigned.map((a) => a.hz),
        ...(useLocal ? {} : { source, sourceDetail: detail }),
        enrichedCount: fromGemini,
        lastDetectionAt: Date.now(),
      });
    }

    await sleep(useLocal ? VISION_INTERVAL_MS : CLOUD_VISION_INTERVAL_MS);
  }
}

/** HELP and Cancel first, then one tile per item, all at fixed frequencies. */
function buildTiles(
  allocated: number[],
  items: { label: string; hz: number }[],
): LiveTile[] {
  const tiles: LiveTile[] = [
    { hz: allocated[0], label: "HELP", kind: "help" },
    { hz: allocated[1], label: "Cancel", kind: "cancel" },
  ];

  for (const item of items) {
    tiles.push({ hz: item.hz, label: item.label, kind: "option" });
  }

  return tiles;
}

function fireHelp(trialId?: number): void {
  // Local alarm first: it depends on nothing outside this browser.
  stopSpeaking();
  alarmTone();
  window.setTimeout(() => speak("Calling for help now."), 700);

  generation += 1;
  visionGeneration += 1;

  patchScene((current) => ({
    running: false,
    stage: "idle",
    helpFired: true,
    helpStreak: 0,
    status: "HELP TRIGGERED",
    detail: "Alarm sounded locally. Contacting a caregiver…",
    alertForwarded: null,
    alertDetail: null,
    transcript: [...current.transcript, "HELP triggered"],
  }));

  setState({ selectionRunning: false });
  void stopTrial();

  void raiseHelpAlert(
    "Help requested via the AURA headset.",
    trialId,
    "Decoded from two consecutive SSVEP windows on the HELP target.",
  ).then((outcome) => {
    patchScene({
      alertForwarded: outcome.forwarded,
      alertDetail: outcome.detail,
      detail: outcome.forwarded
        ? "Alarm sounded locally and a caregiver was notified."
        : "Alarm sounded locally. Nobody was notified remotely.",
    });
  });
}

/**
 * Run windows until one of them confidently picks a tile.
 *
 * Returns the chosen index, or -1 if the caller should give up (aborted, or
 * the attempt budget ran out). HELP is handled here rather than by the
 * caller, because it must work identically in every stage.
 */
async function decideOne(
  tiles: LiveTile[],
  refreshHz: number,
  myGeneration: number,
  maxWindows: number,
  prompt: string,
): Promise<number> {
  for (let window = 0; window < maxWindows; window++) {
    if (generation !== myGeneration) return -1;

    const outcome = await runDecodeWindow({
      frequencies: tiles.map((tile) => tile.hz),
      refreshHz,
      isAborted: () => generation !== myGeneration,
      onTick: (remaining) =>
        patchScene((current) => ({
          detail:
            current.helpStreak > 0
              ? `Calling for help in ${remaining} s — look away to cancel.`
              : `${prompt} ${remaining} s`,
        })),
    });

    if (generation !== myGeneration) return -1;

    if (outcome.failure === "start-failed") {
      notify("Could not start a decode window: " + (outcome.detail ?? "unknown"));
      return -1;
    }

    const result = outcome.result;

    if (!result) {
      patchScene({
        status: "No result from the headset.",
        detail: "Is the ESP32 powered and connected? Retrying…",
        helpStreak: 0,
      });
      await sleep(INTER_WINDOW_MS);
      continue;
    }

    const chosen = interpret(result, tiles);

    if (chosen >= 0) return chosen;

    await sleep(INTER_WINDOW_MS);
  }

  return -1;
}

/**
 * Turn one decode result into a tile index, or -1 to keep waiting.
 *
 * Also owns the HELP streak, because a rejected or unconfident window must
 * neither advance nor abort a countdown -- it says nothing about where the
 * user was looking.
 */
function interpret(result: TrialResult, tiles: LiveTile[]): number {
  const evidence = Array.isArray(result.evidence_db) ? result.evidence_db : [];
  const index = typeof result.best_index === "number" ? result.best_index : -1;

  patchScene({
    evidence: tiles.map((_, i) =>
      typeof evidence[i] === "number" ? evidence[i] : null,
    ),
  });

  if (!result.accepted) {
    patchScene({
      winner: -1,
      confident: false,
      status: `Window rejected: ${result.reason ?? "signal quality"}.`,
      detail: "Check the electrodes.",
      helpStreak: 0,
    });
    return -1;
  }

  if (!result.confident || index < 0 || index >= tiles.length) {
    patchScene({
      winner: -1,
      confident: false,
      status: "No confident selection.",
      detail: "Keep your gaze steady on one tag.",
      helpStreak: 0,
    });
    return -1;
  }

  patchScene({ winner: index, confident: true });

  if (tiles[index].kind === "help") {
    patchScene((current) => ({ helpStreak: current.helpStreak + 1 }));

    if (getState().scene.helpStreak >= HELP_WINDOWS_REQUIRED) {
      fireHelp(result.trial_id);
      return -1;
    }

    patchScene({
      status: "HELP selected — confirming.",
      detail: "Look away now to cancel.",
    });
    speak("Help selected. Look away to cancel.");
    return -1;
  }

  patchScene({ helpStreak: 0 });
  return index;
}

function performIntent(intent: SceneIntent): string {
  /*
   * Only "speak" does anything outward today, and what it does is talk to
   * the person in the room -- which is the honest v1 capability. The others
   * are announced and recorded so the interaction is complete end to end,
   * without pretending a bed or a phone is actually being driven. Wiring
   * those up is a hardware and credentials question, not a model question.
   */
  switch (intent.action) {
    case "speak":
      speak(intent.params || intent.label);
      return `Said: “${intent.params || intent.label}”`;
    case "call":
      speak(`Calling ${intent.params}.`);
      return `Would call ${intent.params} (not wired up).`;
    case "device":
      speak(intent.params || intent.label);
      return `Would operate: ${intent.params} (not wired up).`;
    default:
      speak(intent.label);
      return `Noted: ${intent.params || intent.label}`;
  }
}

export async function startScene(band: Band): Promise<void> {
  const state = getState();

  if (state.scene.running || state.live.running || state.calibrationRunning) return;

  if (!state.refreshReady) {
    notify("The display refresh-rate measurement is not finished yet.");
    return;
  }

  const allocation = await fetchAllocation(state.refreshHz, band);

  /*
   * Prefer the calibrated command set over the band allocation once a
   * profile exists: those are the frequencies that have thresholds and
   * resting baselines. The band allocation is the bench tool for exploring;
   * the product should run on what was calibrated.
   */
  const profile = getState().profile;
  if (
    allocation &&
    profile?.calibrated_at &&
    Array.isArray(profile.frequencies) &&
    // Only if it leaves a useful number of object slots after HELP and
    // Cancel. A 3-frequency calibrated set would allow exactly ONE tag,
    // which is worse for the user than uncalibrated thresholds on a wider
    // band -- the server still supplies baselines for whichever of these
    // frequencies it knows.
    profile.frequencies.length >= 5
  ) {
    allocation.allocated = [...profile.frequencies];
    allocation.band = "calibrated";
  }

  if (!allocation || allocation.allocated.length < 3) {
    notify("This band does not allocate enough frequencies for HELP, Cancel and a tag.");
    return;
  }

  generation += 1;
  visionGeneration += 1;
  const myGeneration = generation;
  const myVision = visionGeneration;
  resetAssignments();
  clearEnrichment();

  // Two reserved for HELP and Cancel in every stage; the rest carry objects.
  const itemFrequencies = allocation.allocated.slice(2);

  patchScene({
    running: true,
    stage: "scanning",
    helpFired: false,
    helpStreak: 0,
    transcript: [],
    band: allocation.band,
    objects: [],
    objectFrequencies: [],
    intents: [],
    selectedObject: null,
    notice: null,
    tiles: [],
    winner: -1,
    evidence: [],
    status: "Looking at the scene…",
    detail: "",
  });

  // Detection runs continuously from here; the decode loop reads whatever it
  // has most recently found.
  void runVisionLoop(myVision, itemFrequencies);

  /*
   * Wait for a first detection, but do NOT end the session if none arrives.
   *
   * This used to stop after ten seconds with "nothing actionable in view",
   * which is the worst possible behaviour in front of an audience: point the
   * camera somewhere unhelpful for a moment and the demo shuts itself down.
   * The vision loop keeps running and the session picks up whatever comes
   * into frame.
   */
  for (let i = 0; i < 20 && getState().scene.objects.length === 0; i++) {
    if (generation !== myGeneration) return;

    patchScene({
      status: "Looking at the scene…",
      detail: "Point the camera at objects — a cup, bottle, phone, book, laptop.",
    });

    await sleep(500);
  }

  while (generation === myGeneration) {
    // ---- Stage 1: tag whatever is in view right now --------------------
    const current = getState().scene;
    const items = current.objects
      .map((object, index) => ({
        // Identity stays `label`; the tile shows the better name if there is
        // one, so a Gemini rename cannot move a tag to another frequency.
        label: object.displayLabel || object.label,
        identity: object.label,
        hz: current.objectFrequencies[index],
      }))
      .filter(
        (item): item is { label: string; identity: string; hz: number } =>
          typeof item.hz === "number",
      );

    if (items.length === 0) {
      patchScene({
        status: "Nothing recognised yet.",
        detail: "Point the camera at objects — a cup, bottle, phone, book, laptop.",
      });
      await sleep(INTER_WINDOW_MS);
      continue;
    }

    const tiles = buildTiles(allocation.allocated, items);

    patchScene({
      stage: "objects",
      tiles,
      status:
        current.objects.length > items.length
          ? `${items.length} of ${current.objects.length} objects selectable.`
          : `${items.length} object(s) tagged.`,
      detail: "Look at the tag on what you want.",
      evidence: [],
      winner: -1,
    });

    speak("Look at what you want.");

    // ---- Stage 2: choose an object -------------------------------------
    const objectIndex = await decideOne(
      tiles,
      state.refreshHz,
      myGeneration,
      6,
      "Look at a tag…",
    );

    if (generation !== myGeneration) return;

    if (objectIndex < 0) {
      patchScene({ status: "No selection made.", detail: "Still watching…" });
      await sleep(INTER_WINDOW_MS);
      continue;
    }

    if (tiles[objectIndex].kind === "cancel") {
      speak("Cancelled.");
      patchScene({
        status: "Cancelled.",
        detail: "Back to the scene.",
        notice: "Cancelled",
      });
      // Long enough to actually be read, since this is the one outcome that
      // otherwise looks identical to nothing happening at all.
      await sleep(NOTICE_MS);
      patchScene({ notice: null });
      continue;
    }

    const chosenLabel = tiles[objectIndex].label;

    patchScene((currentScene) => ({
      stage: "intents",
      selectedObject: chosenLabel,
      status: `Selected: ${chosenLabel}`,
      detail: "Thinking about what you might want…",
      transcript: [...currentScene.transcript, chosenLabel],
      evidence: [],
      winner: -1,
    }));

    speak(chosenLabel);

    // ---- Stage 3: the model proposes, it does not decide ---------------
    // A fresh frame of the chosen object, not a stale one.
    const proposal = await proposeIntents(chosenLabel, captureFrame() ?? undefined);

    if (generation !== myGeneration) return;

    const intents = (proposal?.intents ?? []).slice(0, itemFrequencies.length);

    if (intents.length === 0) {
      patchScene({ status: "No intents proposed.", detail: "Back to the scene." });
      await sleep(INTER_WINDOW_MS);
      continue;
    }

    const intentTiles = buildTiles(
      allocation.allocated,
      intents.map((intent, index) => ({
        label: intent.label,
        hz: itemFrequencies[index],
      })),
    );

    patchScene({
      intents,
      tiles: intentTiles,
      source: proposal?.source ?? "stub",
      sourceDetail: proposal?.detail ?? "",
      status: `What would you like done with the ${chosenLabel}?`,
      detail: "Look at one option.",
      evidence: [],
      winner: -1,
    });

    speak(`What about the ${chosenLabel}?`);

    // ---- Stage 4: the user commits -------------------------------------
    const intentIndex = await decideOne(
      intentTiles,
      state.refreshHz,
      myGeneration,
      INTENT_MENU_WINDOWS,
      "Look at an option…",
    );

    if (generation !== myGeneration) return;

    if (intentIndex < 0 || intentTiles[intentIndex].kind === "cancel") {
      if (intentIndex >= 0) speak("Cancelled.");
      patchScene({
        status: intentIndex < 0 ? "No option chosen." : "Cancelled.",
        detail: "Back to the scene.",
        notice: intentIndex < 0 ? "No option chosen" : "Cancelled",
      });
      await sleep(NOTICE_MS);
      patchScene({ notice: null });
      continue;
    }

    const intent = intents[intentIndex - 2];

    if (!intent) {
      await sleep(INTER_WINDOW_MS);
      continue;
    }

    const outcome = performIntent(intent);

    patchScene((currentScene) => ({
      stage: "acted",
      status: intent.label,
      detail: outcome,
      transcript: [...currentScene.transcript, `${intent.label} — ${outcome}`],
    }));

    // Let the spoken confirmation finish before the next window starts
    // flickering, or the user is choosing while being talked at.
    await sleep(2500);
  }
}
