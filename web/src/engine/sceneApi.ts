/**
 * Client for the two Gemini-backed endpoints.
 *
 * Both resolve to a result or null rather than throwing: the scene loop has
 * to keep running and say what went wrong, not unwind.
 */
import type { SceneIntent, SceneObject } from "./types";

export interface SceneDetection {
  objects: SceneObject[];
  /** "gemini" for real detections, "stub" for placeholders. */
  source: string;
  detail: string;
}

export interface IntentProposal {
  intents: SceneIntent[];
  source: string;
  detail: string;
}

async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      console.error(`${url} returned ${response.status}`);
      return null;
    }

    return (await response.json()) as T;
  } catch (error) {
    console.error(error);
    return null;
  }
}

/** Call A: a frame in, taggable objects out. */
export function detectScene(imageDataUrl: string): Promise<SceneDetection | null> {
  return postJson<SceneDetection>("/api/scene", { image: imageDataUrl });
}

/**
 * Call B: a selected object in, candidate intents out.
 *
 * The frame is sent along so the model can see the object rather than only
 * read its name; the server treats it as optional.
 */
export function proposeIntents(
  label: string,
  imageDataUrl?: string,
): Promise<IntentProposal | null> {
  return postJson<IntentProposal>("/api/intents", { label, image: imageDataUrl });
}
