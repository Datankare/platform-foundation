/**
 * platform/voice/browser-recorder.ts — the recorder core (TASK-234, ADR-061; DESIGN-56f1 §4.3)
 *
 * The app's recorder hook (56f-2) is a thin React wrapper around this module, and the
 * cross-browser gate (e2e/audio) runs this same module in every engine, so the gate exercises the
 * shipped recorder, not a copy.
 *
 * - `recorder.start()` with NO timeslice: one Blob at stop, nothing to merge, and immune to WebKit
 *   bug 301507 (empty Blobs for short timeslices).
 * - The Blob keeps `recorder.mimeType`.
 * - The timer stops the recorder at `maxSeconds` exactly once; a manual stop and the timer together
 *   stop it once. The clock is injectable (tests use a fake clock, never the wall clock).
 * - Interruptions are failures, never partial sends: a track ending, a recorder error, or the page
 *   becoming hidden rejects `result` with "recording_interrupted" and stops the tracks.
 * - Microphone failures are told apart (blocked / missing / unavailable).
 *
 * Imports only canonical-wav.ts and DOM globals (a guard holds that).
 *
 * Credits: "MediaStream Recording" (W3C; M. Casas-Sanchez, J. Barnett, T. Leithead) — MediaRecorder.
 * WebKit bug 301507 — empty Blobs with short timeslices.
 *
 * @module platform/voice/browser-recorder
 */

import { AUDIO_TYPES } from "@/platform/voice/canonical-wav";

/** Recorder types in order of preference under the current D-3 decision ("audio/mp4" never by default). */
export const RECORDER_TYPES: readonly string[] = AUDIO_TYPES.recorder;

export type MicrophoneFailure =
  "microphone_blocked" | "microphone_missing" | "microphone_unavailable";

export type RecorderCode =
  MicrophoneFailure | "recording_interrupted" | "browser_unsupported";

export class RecorderError extends Error {
  readonly code: RecorderCode;
  constructor(code: RecorderCode, cause?: unknown) {
    super(code);
    this.name = "RecorderError";
    this.code = code;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

interface MediaRecorderStatic {
  isTypeSupported?: (type: string) => boolean;
}

function recorderClass(): MediaRecorderStatic | undefined {
  const MR = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  return typeof MR === "function" ? (MR as MediaRecorderStatic) : undefined;
}

/** The first supported type of RECORDER_TYPES, or null when this browser records none of them. */
export function pickRecorderType(): string | null {
  const MR = recorderClass();
  if (!MR || typeof MR.isTypeSupported !== "function") return null;
  for (const t of RECORDER_TYPES) {
    try {
      if (MR.isTypeSupported(t) === true) return t;
    } catch {
      // a throwing isTypeSupported answers "no" for this type
    }
  }
  return null;
}

function errorName(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "name" in e
    ? String((e as { name: unknown }).name)
    : undefined;
}

/** Maps a getUserMedia rejection to what the person is told. */
export function classifyMicrophoneError(e: unknown): MicrophoneFailure {
  const name = errorName(e);
  if (name === "NotAllowedError" || name === "SecurityError") return "microphone_blocked";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "microphone_missing";
  return "microphone_unavailable";
}

/**
 * Opens the microphone. Rejects with RecorderError: "browser_unsupported" when this browser can
 * record none of RECORDER_TYPES or has no microphone API (the microphone is then never opened),
 * else the classified microphone failure.
 */
export async function acquireMicrophone(): Promise<MediaStream> {
  if (pickRecorderType() === null) throw new RecorderError("browser_unsupported");
  const md = (globalThis as { navigator?: { mediaDevices?: MediaDevices } }).navigator
    ?.mediaDevices;
  if (!md || typeof md.getUserMedia !== "function") {
    throw new RecorderError("browser_unsupported");
  }
  try {
    return await md.getUserMedia({ audio: true });
  } catch (e) {
    throw new RecorderError(classifyMicrophoneError(e), e);
  }
}

/** The timer the recorder uses; tests pass a fake one. */
export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Recording {
  /** Stops the recording (idempotent; the timer may already have stopped it). */
  stop(): void;
  /** The recording, or a RecorderError("recording_interrupted"). */
  readonly result: Promise<Blob>;
}

export interface StartOptions {
  readonly mimeType: string;
  readonly maxSeconds: number;
  readonly onTick?: (secondsLeft: number) => void;
  readonly clock?: Clock;
}

/**
 * Records `stream` (the microphone, or in the gate an oscillator's stream) as `mimeType` until
 * `stop()` or `maxSeconds`, whichever comes first. `onTick` is called with the whole seconds left,
 * once at the start and then every second.
 */
export function startRecording(stream: MediaStream, options: StartOptions): Recording {
  const o: StartOptions = Object.freeze({
    mimeType: options?.mimeType,
    maxSeconds: options?.maxSeconds,
    onTick: options?.onTick,
    clock: options?.clock,
  }) as StartOptions;
  if (
    typeof o?.maxSeconds !== "number" ||
    !Number.isFinite(o.maxSeconds) ||
    o.maxSeconds <= 0 ||
    typeof o.mimeType !== "string" ||
    o.mimeType === ""
  ) {
    throw new TypeError("startRecording needs a mimeType and a finite maxSeconds > 0");
  }
  const clock = o.clock ?? realClock;
  const tracks = stream.getTracks();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: o.mimeType });
  } catch (e) {
    // The microphone is never left open on a failure: every track is stopped before the throw.
    for (const t of tracks) t.stop();
    throw new RecorderError(
      errorName(e) === "NotSupportedError"
        ? "browser_unsupported"
        : "recording_interrupted",
      e
    );
  }
  const chunks: Blob[] = [];
  const doc = (globalThis as { document?: Document }).document;

  let stopped = false;
  let interrupted = false;
  const timers: { stop?: unknown; tick?: unknown } = {};
  let resolveResult!: (b: Blob) => void;
  let rejectResult!: (e: unknown) => void;
  const result = new Promise<Blob>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });
  // A rejection nobody has awaited yet must not be reported as unhandled by the page.
  result.catch(() => undefined);

  const onVisibility = () => {
    if (doc?.visibilityState === "hidden") interrupt();
  };
  const onTrackEnded = () => interrupt();

  const cleanUp = () => {
    clock.clearTimeout(timers.stop);
    clock.clearTimeout(timers.tick);
    doc?.removeEventListener("visibilitychange", onVisibility);
    for (const t of tracks) {
      t.removeEventListener("ended", onTrackEnded);
      t.stop();
    }
  };

  const stopOnce = () => {
    if (stopped) return;
    stopped = true;
    clock.clearTimeout(timers.stop);
    clock.clearTimeout(timers.tick);
    if (recorder.state !== "inactive") recorder.stop();
    else finish();
  };

  function interrupt() {
    // Once stop has been asked for, the recording is complete: locking the phone or a track
    // ending after Stop does not throw it away.
    if (stopped) return;
    interrupted = true;
    stopOnce();
  }

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    cleanUp();
    if (interrupted) {
      rejectResult(new RecorderError("recording_interrupted"));
      return;
    }
    const blob = new Blob(chunks, { type: recorder.mimeType || o.mimeType });
    if (blob.size === 0) rejectResult(new RecorderError("recording_interrupted"));
    else resolveResult(blob);
  }

  recorder.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => finish();
  recorder.onerror = () => interrupt();
  for (const t of tracks) t.addEventListener("ended", onTrackEnded);
  doc?.addEventListener("visibilitychange", onVisibility);

  const totalMs = Math.round(o.maxSeconds * 1000);
  let elapsedSeconds = 0;
  const tick = () => {
    if (stopped) return;
    o.onTick?.(Math.max(0, Math.ceil(o.maxSeconds - elapsedSeconds)));
    elapsedSeconds += 1;
    if (elapsedSeconds < o.maxSeconds) timers.tick = clock.setTimeout(tick, 1000);
  };

  try {
    recorder.start();
  } catch (e) {
    // Nothing recorded and nothing left behind: listeners removed, tracks stopped, timers clear.
    finished = true;
    stopped = true;
    cleanUp();
    const err = new RecorderError(
      errorName(e) === "NotSupportedError"
        ? "browser_unsupported"
        : "recording_interrupted",
      e
    );
    rejectResult(err);
    throw err;
  }
  timers.stop = clock.setTimeout(stopOnce, totalMs);
  tick();
  if (doc?.visibilityState === "hidden") interrupt();

  return { stop: stopOnce, result };
}
