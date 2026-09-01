/**
 * Spoken feedback.
 *
 * Audio carries most of the feedback load in AURA: the user may be looking
 * at a tile rather than at a status line, and for the HELP countdown the
 * whole point is that they can abort by looking away -- which means they
 * cannot be reading the screen to know a countdown is running.
 *
 * Uses the browser's built-in speech synthesis, so there is no dependency
 * and no network round-trip. If the API is missing (or the user's browser
 * has no voices installed) every call degrades to a no-op rather than
 * throwing, because losing audio must never break the interaction loop.
 */

function synth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return window.speechSynthesis ?? null;
}

export function speechAvailable(): boolean {
  return synth() !== null;
}

/**
 * Speak a phrase. `interrupt` cancels anything still queued, which is what
 * you want for status changes -- a stale "Option 2" arriving after the user
 * has moved on is worse than silence.
 */
export function speak(text: string, interrupt = true): void {
  const speech = synth();
  if (!speech) return;

  try {
    if (interrupt) speech.cancel();

    const utterance = new SpeechSynthesisUtterance(text);

    // Slightly quicker than default: these are short, repeated phrases and
    // the default rate makes the countdown drift behind the decode window.
    utterance.rate = 1.05;
    utterance.pitch = 1.0;

    speech.speak(utterance);
  } catch (error) {
    console.error(error);
  }
}

export function stopSpeaking(): void {
  const speech = synth();
  if (!speech) return;

  try {
    speech.cancel();
  } catch (error) {
    console.error(error);
  }
}

/**
 * A short attention tone, used when HELP actually fires.
 *
 * Deliberately generated with WebAudio rather than an audio file: it must
 * work with no network and no assets, since the whole point of the local
 * HELP path is that it survives losing connectivity.
 */
export function alarmTone(): void {
  try {
    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;

    if (!AudioCtor) return;

    const context = new AudioCtor();
    const now = context.currentTime;

    // Two rising beeps -- distinct from any notification sound the room
    // is likely to produce.
    for (let i = 0; i < 2; i++) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = "sine";
      oscillator.frequency.value = 880 + i * 220;

      const start = now + i * 0.28;
      const end = start + 0.22;

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
    }

    window.setTimeout(() => void context.close().catch(() => {}), 1200);
  } catch (error) {
    console.error(error);
  }
}
