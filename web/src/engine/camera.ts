/**
 * Camera capture for the scene layer.
 *
 * The v1 form factor is a screen on an articulated arm with the camera
 * behind it, looking at what the user is looking at. The browser owns the
 * camera; frames are posted to the server, which owns the Gemini key.
 *
 * WHY FRAMES ARE FROZEN DURING A SELECTION
 * ----------------------------------------
 * Tags are anchored to boxes from one analysed frame. If live video kept
 * playing underneath them, the tags would drift off their objects the moment
 * anything moved -- and a decode window lasts several seconds, so "anything"
 * includes a nurse walking past. Capturing a still and tagging that keeps the
 * tag on its object for the whole window, which is the property the whole
 * interaction depends on. Object tracking across live video is a v2 problem.
 */

let stream: MediaStream | null = null;
let video_el: HTMLVideoElement | null = null;

export function attachVideo(element: HTMLVideoElement | null): void {
  video_el = element;
}

/** The live <video>, for detectors that read frames directly. */
export function videoElement(): HTMLVideoElement | null {
  return video_el;
}

export function cameraRunning(): boolean {
  return stream !== null;
}

export interface CameraStartResult {
  ok: boolean;
  detail: string;
}

export interface CameraDevice {
  deviceId: string;
  label: string;
}

/**
 * Cameras this browser can see.
 *
 * Labels are hidden until the page has been granted camera permission at
 * least once, so this is worth calling again after the first successful
 * start.
 */
export async function listCameras(): Promise<CameraDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === "videoinput")
      .map((d, index) => ({
        deviceId: d.deviceId,
        label: d.label || `Camera ${index + 1}`,
      }));
  } catch (error) {
    console.error(error);
    return [];
  }
}

/**
 * Open a camera.
 *
 * `deviceId` picks a specific one. This matters on a machine with more than
 * one: asking only for facingMode "environment" gets whichever the browser
 * prefers, which on a laptop with a USB webcam attached is usually the
 * built-in one pointing at the operator rather than the scene.
 */
export async function startCamera(deviceId?: string): Promise<CameraStartResult> {
  if (stream) return { ok: true, detail: "Camera already running." };

  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      ok: false,
      detail: "This browser exposes no camera API.",
    };
  }

  const video: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };

  if (deviceId) {
    video.deviceId = { exact: deviceId };
  } else {
    // The scene camera faces away from the user, at the room.
    video.facingMode = "environment";
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (error) {
    const name = (error as DOMException)?.name ?? "";

    // These are the ones the operator can actually do something about.
    if (name === "NotAllowedError") {
      return { ok: false, detail: "Camera permission was denied." };
    }
    if (name === "NotFoundError") {
      return { ok: false, detail: "No camera was found on this machine." };
    }
    if (name === "NotReadableError") {
      return {
        ok: false,
        detail:
          "Camera is in use by another application. Close whatever is using " +
          "it (another browser, a video call) and try again.",
      };
    }

    return { ok: false, detail: `Could not open the camera: ${name || error}` };
  }

  if (video_el) {
    video_el.srcObject = stream;
    try {
      await video_el.play();
    } catch (error) {
      console.error(error);
    }
  }

  const track = stream.getVideoTracks()[0];
  return { ok: true, detail: track?.label ? `Camera: ${track.label}` : "Camera running." };
}

export function stopCamera(): void {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;

  if (video_el) video_el.srcObject = null;
}

/**
 * Grab the current frame as a JPEG data URL.
 *
 * Downscaled hard: the upload and the model's decode are both on the
 * critical path for how quickly a tag catches up with its object, and Gemini
 * does not need 720p to find a glass on a table. 768px at q0.55 is roughly
 * a third of the bytes of 960px at q0.72, which is most of the latency.
 */
export function captureFrame(maxWidth = 768, quality = 0.55): string | null {
  if (!video_el || !video_el.videoWidth || !video_el.videoHeight) return null;

  const scale = Math.min(1, maxWidth / video_el.videoWidth);
  const width = Math.round(video_el.videoWidth * scale);
  const height = Math.round(video_el.videoHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) return null;

  context.drawImage(video_el, 0, 0, width, height);

  try {
    return canvas.toDataURL("image/jpeg", quality);
  } catch (error) {
    console.error(error);
    return null;
  }
}
