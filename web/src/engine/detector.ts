/**
 * Local object detection, in the browser, at video framerate.
 *
 * WHY THIS EXISTS
 * ---------------
 * The scene layer originally sent every frame to Gemini. That works and the
 * labels are excellent, but each detection is a network round-trip: roughly
 * 1-2 s before a tag can move. No amount of tuning the interval fixes that,
 * because the latency is the request itself. Tags visibly lagged their
 * objects, and the scene looked like a slideshow rather than a live view.
 *
 * COCO-SSD runs on the GPU in this tab. Detection takes tens of milliseconds,
 * so tags track their objects continuously and the picture is genuinely live.
 *
 * WHAT IT COSTS
 * -------------
 * COCO-SSD knows 80 fixed classes, where Gemini can name anything it sees.
 * For a room -- cup, bottle, phone, laptop, book, chair, tv, remote,
 * keyboard, mouse, clock, vase, potted plant, bowl, scissors, banana -- the
 * 80 cover most of what a person would point at, and they come back every
 * frame instead of every other second. Gemini is still the better namer, so
 * `sceneApi.detectScene` remains available and Gemini keeps the job it is
 * genuinely better at: proposing what to DO with the thing once chosen.
 *
 * The weights are served from this app (web/public/models/coco-ssd), not from
 * Google's CDN. That was not the original design and it is not premature: on
 * a live test the CDN fetch failed with ERR_CONNECTION_RESET, the detector
 * silently fell back to the slower cloud path, and the only visible symptom
 * was a "Cloud vision" badge. Detection is now independent of the internet,
 * which also means the live session works on a venue's guest wifi or none at
 * all. `preload()` runs at startup so the first session does not wait for it.
 */
import "@tensorflow/tfjs";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import type { SceneObject } from "./types";

let model: cocoSsd.ObjectDetection | null = null;
let loading: Promise<cocoSsd.ObjectDetection> | null = null;
let loadError: string | null = null;

/*
 * Confidence floor.
 *
 * 0.5 is the usual COCO demo default and it was too strict here. Measured on
 * this rig in a dim room, the one real object in frame -- a wall clock --
 * scored 0.262, while the next predictions were noise: skateboard 0.11,
 * toilet 0.04, chair 0.016. The usable gap is therefore between 0.11 and
 * 0.262, so the floor sits at 0.25. In good light real objects score 0.6-0.9
 * and this floor is irrelevant.
 *
 * Being permissive is cheap here because COCO-SSD returns predictions sorted
 * by score and frequencies are handed out in that order: the confident
 * detections become selectable tags, and anything marginal is left as a
 * dashed outline that cannot be chosen.
 *
 * Erring permissive is deliberate: an empty screen reads as a broken system,
 * whereas a spurious box is visibly just a dashed outline that cannot be
 * selected.
 */
const MIN_SCORE = 0.25;

/** More than this and the frequency budget is irrelevant anyway. */
const MAX_DETECTIONS = 14;

/*
 * Nothing is filtered out by class.
 *
 * "person" was excluded at first on the reasoning that a person is not an
 * object to be handed over. That was wrong for this device: asking a
 * caregiver for something is among the most useful intents available, and a
 * person is the most reliably detected class COCO has -- excluding it can
 * leave a room with nothing selectable in it at all.
 */
const IGNORED = new Set<string>();

/*
 * COCO class names are terse and occasionally odd ("cell phone", "tvmonitor").
 * These read better on a tag and match how someone would actually refer to
 * the thing.
 */
const FRIENDLY: Record<string, string> = {
  "cell phone": "phone",
  "tv": "TV",
  "tvmonitor": "TV",
  "remote": "remote",
  "potted plant": "plant",
  "wine glass": "glass",
  "cup": "cup",
  "bottle": "bottle",
  "laptop": "laptop",
  "keyboard": "keyboard",
  "mouse": "mouse",
  "book": "book",
  "clock": "clock",
  "vase": "vase",
  "teddy bear": "teddy",
  "dining table": "table",
  "couch": "sofa",
  "chair": "chair",
  "bowl": "bowl",
  "scissors": "scissors",
  "toothbrush": "toothbrush",
  "hair drier": "hair dryer",
};

/**
 * Raw predictions with scores, before filtering. Exposed on `window` for
 * diagnosis: an empty board is otherwise ambiguous between "the detector is
 * broken" and "there is nothing here it knows".
 */
export async function debugDetect(
  video: HTMLVideoElement,
): Promise<{ class: string; score: number }[] | null> {
  const active = model ?? (await preload().catch(() => null));
  if (!active) return null;

  const raw = await active.detect(video, 20, 0.01);
  return raw.map((p) => ({ class: p.class, score: Number(p.score.toFixed(3)) }));
}

export function detectorState(): "idle" | "loading" | "ready" | "failed" {
  if (model) return "ready";
  if (loadError) return "failed";
  if (loading) return "loading";
  return "idle";
}

export function detectorError(): string | null {
  return loadError;
}

/**
 * Fetch and warm the model. Safe to call repeatedly; only the first call
 * does any work.
 */
export function preload(): Promise<cocoSsd.ObjectDetection> {
  if (model) return Promise.resolve(model);
  if (loading) return loading;

  loading = cocoSsd
    .load({
      // "lite_mobilenet_v2" is the fastest of the three and easily accurate
      // enough for tabletop objects at arm's length. Served locally: see the
      // note at the top of this file.
      base: "lite_mobilenet_v2",
      modelUrl: "/models/coco-ssd/model.json",
    })
    .then((loaded) => {
      model = loaded;
      loadError = null;
      return loaded;
    })
    .catch((error) => {
      loadError = String(error);
      loading = null;
      throw error;
    });

  return loading;
}

/**
 * Detect objects in a video element.
 *
 * Boxes come back in pixels relative to the video's intrinsic size; they are
 * converted to the same x-first fractions the Gemini path produces, so the
 * rest of the scene layer cannot tell the two apart.
 */
export async function detectFromVideo(
  video: HTMLVideoElement,
): Promise<SceneObject[] | null> {
  if (!video.videoWidth || !video.videoHeight) return null;

  let active = model;

  if (!active) {
    try {
      active = await preload();
    } catch {
      return null;
    }
  }

  let predictions: cocoSsd.DetectedObject[];

  try {
    predictions = await active.detect(video, MAX_DETECTIONS, MIN_SCORE);
  } catch (error) {
    console.error(error);
    return null;
  }

  const width = video.videoWidth;
  const height = video.videoHeight;
  const seen = new Map<string, number>();
  const objects: SceneObject[] = [];

  for (const prediction of predictions) {
    if (IGNORED.has(prediction.class)) continue;

    const [x, y, w, h] = prediction.bbox;
    const x0 = Math.max(0, x / width);
    const y0 = Math.max(0, y / height);
    const x1 = Math.min(1, (x + w) / width);
    const y1 = Math.min(1, (y + h) / height);

    if (x1 - x0 < 0.01 || y1 - y0 < 0.01) continue;

    const base = FRIENDLY[prediction.class] ?? prediction.class;

    /*
     * Two cups need two different labels, because a label is what pins an
     * object to its flicker frequency across frames (see scene.ts). Without
     * this they would fight over one frequency and both flicker wrongly.
     */
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const label = count === 1 ? base : `${base} ${count}`;

    objects.push({
      label,
      box: [
        Number(x0.toFixed(4)),
        Number(y0.toFixed(4)),
        Number(x1.toFixed(4)),
        Number(y1.toFixed(4)),
      ],
      actionable: true,
    });
  }

  return objects;
}

// Diagnostic handle only; nothing in the app reads this.
declare global {
  interface Window {
    __auraDetector?: {
      debugDetect: typeof debugDetect;
      detectFromVideo: typeof detectFromVideo;
      state: typeof detectorState;
    };
  }
}

if (typeof window !== "undefined") {
  window.__auraDetector = { debugDetect, detectFromVideo, state: detectorState };
}
