/**
 * platform/voice/browser-audio.ts — turn a recording or a picked file into canonical WAV in the
 * person's browser, bounded before decoding (TASK-234, ADR-061; DESIGN-56f1 §4.2)
 *
 * Steps (each failure has one code; the screen text is 56f-2's):
 *   U(−1) options usable, else AudioLimitsError (a caller's bug)
 *   U0  empty Blob → empty
 *   U1  upload larger than the pick limit (25 MiB) → too_large, before reading a byte
 *   U1b upload: its container named from its first 16 bytes (WAV, MP3, FLAC, Ogg, WebM/Matroska,
 *       MP4/M4A — exactly the formats the product claims); the 16 bytes cannot be read →
 *       read_failed; any other start → undecodable. The type the Blob declares is never used: a
 *       picked file can arrive with an empty or a wrong type, and it never widens what is accepted
 *   U2  upload: its length measured BEFORE decoding, on a Blob typed from U1b (metadata, then a
 *       seek probe; 3 s budget); unknown → unmeasurable, unreadable → undecodable, over
 *       max + 1 s → too_long
 *   U3  no 16 kHz OfflineAudioContext → browser_unsupported
 *   U4  the Blob cannot be read (a picked file moved or evicted) → read_failed
 *   U5  decodeAudioData (decoding is the 16 kHz resample): NotSupportedError → browser_unsupported,
 *       RangeError → out_of_memory, other → undecodable
 *   U6  not 16 kHz → browser_unsupported; no samples → empty
 *   U7  recording: trimmed to maxSeconds, never refused for length; upload: over max + 0.25 s →
 *       too_long, else trimmed to maxSeconds
 *   U8  kept length under minSeconds → too_short (the only minimum check, on decoded length)
 *   U9  encode (one second per slice, yielding between): RangeError → out_of_memory; any other
 *       error is a bug and is rethrown unchanged (never shown as "damaged file")
 *
 * Imports only canonical-wav.ts and DOM globals (a guard holds that). Never reads the browser's
 * name or version: `detectAudioSupport` tests capabilities.
 *
 * Credits: "Web Audio API" (W3C; editors P. Adenot, H. Choi) — decode-time resampling and
 * OfflineAudioContext. BROWSER-AUDIO-REVIEW-A (Datankare, 2026-11-17) — the seek probe that
 * measures a duration-less file without decoding it. WebKit Bugzilla 198015 "Cannot play audio
 * created from blob" (reported by jordan.michael.last; analysis by Jer Noble) — a media element
 * needs the Blob's type because the engine does not reliably recognise a file from its bytes;
 * hence U1b. Naming a media type from a file's leading bytes is the practice of the "MIME
 * Sniffing" standard (WHATWG; editor Gordon P. Hemsley); the table here is stricter and is built
 * from each format's own specification.
 *
 * @module platform/voice/browser-audio
 */

import {
  AUDIO_DECISIONS,
  AUDIO_TYPES,
  AudioLimitsError,
  CANONICAL,
  encodeCanonicalPcm,
  samplesIn,
  type CanonicalWav,
} from "@/platform/voice/canonical-wav";

/** The complete list of conversion failures. */
export type BrowserAudioCode =
  | "empty"
  | "too_large"
  | "too_long"
  | "too_short"
  | "undecodable"
  | "unmeasurable"
  | "read_failed"
  | "out_of_memory"
  | "browser_unsupported";

/**
 * The step that ended a conversion (diagnosis only; what the person sees depends on the code):
 * input U0/U1, container U1b, probe U2, context U3, read U4, decode U5/U6, length U7/U8,
 * encode U9.
 */
export type BrowserAudioStage =
  "input" | "container" | "probe" | "context" | "read" | "decode" | "length" | "encode";

export class BrowserAudioError extends Error {
  readonly code: BrowserAudioCode;
  readonly stage: BrowserAudioStage;
  constructor(code: BrowserAudioCode, stage: BrowserAudioStage, cause?: unknown) {
    super(code);
    this.name = "BrowserAudioError";
    this.code = code;
    this.stage = stage;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** D-7: the largest file a person may pick (25 MiB = 26 214 400 bytes; "25 MB" on screen). */
export const UPLOAD_MAX_INPUT_BYTES: number = AUDIO_DECISIONS.uploadMaxInputBytes;
/** Container length vs the limit, before decoding (container durations are coarse). */
export const METADATA_TOLERANCE_SECONDS = 1;
/** Decoded length vs the limit, uploads only (AAC priming and padding). */
export const UPLOAD_TOLERANCE_SECONDS = 0.25;
/** The pre-decode probe's budget; a file whose length is not known by then is refused. */
export const PROBE_TIMEOUT_MS = 3000;

const RATE = CANONICAL.sampleRate;

export interface ToWavOptions {
  readonly source: "recording" | "upload";
  readonly minSeconds: number;
  readonly maxSeconds: number;
  readonly maxInputBytes?: number;
  readonly probeTimeoutMs?: number;
}

/** Where the probe was when it ended: before the metadata arrived, or during the seek probe. */
export type ProbePhase = "metadata" | "seek-probe";

/**
 * `phase` and `mediaErrorCode` are for diagnosis (the gate's log): the element's own
 * MediaError.code (1 aborted, 2 network, 3 decode, 4 source not supported), or null when the
 * element gave none.
 */
export type ProbeResult =
  | {
      readonly status: "known";
      readonly seconds: number;
      readonly via: "metadata" | "seek-probe";
    }
  | { readonly status: "unknown"; readonly phase?: ProbePhase }
  | {
      readonly status: "unreadable";
      readonly phase?: ProbePhase;
      readonly mediaErrorCode?: number | null;
    };

/** The containers an upload may be, and the type each is given for the probe. */
export const CONTAINER_TYPES = Object.freeze({
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  ogg: "audio/ogg",
  webm: "audio/webm",
  mp4: "audio/mp4",
} as const);
export type AudioContainer = keyof typeof CONTAINER_TYPES;

/** How many leading bytes `sniffAudioContainer` looks at. */
export const SNIFF_BYTES = 16;

/** True when `text` stands at `offset`; a byte past the end is `undefined` and matches nothing. */
function startsWith(b: Uint8Array, offset: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (b[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * The container a file's first bytes name, or null. Strict on purpose: only the six containers
 * of the claimed upload formats, each by the mark its own specification puts at offset 0.
 *   WAV   "RIFF" ···· "WAVE"
 *   FLAC  "fLaC"
 *   Ogg   "OggS", stream version 0, a first page (beginning-of-stream flag)
 *   WebM/Matroska  the EBML mark 1A 45 DF A3
 *   MP4/M4A  a first box "ftyp" of a whole number of 4-byte brands (size ≥ 16, a multiple of 4)
 *   MP3   an ID3v2 tag ("ID3", version and revision not FF, a 4 × 7-bit size), or an MPEG audio
 *         Layer III frame header (sync, a real version, layer III, a real bitrate and rate) —
 *         which an AAC/ADTS or a Layer I/II stream is not
 * A file that starts with anything else (padding, another container, text) is not named.
 */
export function sniffAudioContainer(head: Uint8Array): AudioContainer | null {
  const b = head;
  if (startsWith(b, 0, "RIFF") && startsWith(b, 8, "WAVE")) return "wav";
  if (startsWith(b, 0, "fLaC")) return "flac";
  if (startsWith(b, 0, "OggS") && b[4] === 0 && (b[5] & 0x02) !== 0) {
    return "ogg";
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return "webm";
  }
  const size = b[0] * 0x1000000 + b[1] * 0x10000 + b[2] * 0x100 + b[3];
  if (startsWith(b, 4, "ftyp") && size >= 16 && size % 4 === 0) return "mp4";
  if (startsWith(b, 0, "ID3")) {
    // A tag cut short has no size bytes: `undefined < 0x80` is false, so it is not named.
    const ok =
      b[3] !== 0xff &&
      b[4] !== 0xff &&
      b[6] < 0x80 &&
      b[7] < 0x80 &&
      b[8] < 0x80 &&
      b[9] < 0x80;
    return ok ? "mp3" : null;
  }
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    const version = (b[1] >> 3) & 3;
    const layer = (b[1] >> 1) & 3;
    const bitrate = b[2] >> 4;
    const rate = (b[2] >> 2) & 3;
    if (version !== 1 && layer === 1 && bitrate !== 0 && bitrate !== 15 && rate !== 3) {
      return "mp3";
    }
  }
  return null;
}

/** Test seams; production uses the defaults. */
export interface Deps {
  readonly probe?: (blob: Blob, o: { timeoutMs: number }) => Promise<ProbeResult>;
  readonly createContext?: () => BaseAudioContext;
  readonly yieldFn?: () => Promise<void>;
}

export interface ToWavResult {
  readonly wav: CanonicalWav;
  readonly seconds: number;
  readonly decodedSeconds: number;
  readonly trimmed: boolean;
}

/** Yields to the event loop without a timer (a hidden tab does not clamp it to 1 Hz). */
export function messageChannelYield(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

/**
 * A picked file's length, learnt without decoding its audio: `<audio preload="metadata">` on an
 * object URL; a finite duration is known; a non-finite one (a duration-less WebM reports Infinity)
 * makes the element seek far past the end so the engine finds the real end. The first outcome
 * wins; listeners, the timer and the object URL are released. The element is told the file's
 * type only by `blob.type`, so the caller passes a Blob typed from the file's own bytes (U1b).
 */
export function probeDuration(
  blob: Blob,
  o: { timeoutMs: number }
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.muted = true;
    let done = false;
    let phase: ProbePhase = "metadata";
    const finish = (r: ProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      audio.onerror = null;
      audio.onloadedmetadata = null;
      audio.ondurationchange = null;
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ status: "unknown", phase }), o.timeoutMs);
    audio.onerror = () => {
      const code = audio.error ? audio.error.code : null;
      finish({
        status: "unreadable",
        phase,
        mediaErrorCode: typeof code === "number" ? code : null,
      });
    };
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration >= 0) {
        finish({ status: "known", seconds: audio.duration, via: "metadata" });
        return;
      }
      phase = "seek-probe";
      audio.ondurationchange = () => {
        if (Number.isFinite(audio.duration) && audio.duration >= 0) {
          finish({ status: "known", seconds: audio.duration, via: "seek-probe" });
        }
      };
      audio.currentTime = 1e101;
    };
    audio.src = url;
  });
}

function positiveInteger(x: unknown): boolean {
  return typeof x === "number" && Number.isInteger(x) && x > 0;
}

/**
 * The options, each field read exactly once into a frozen snapshot and validated; only the
 * snapshot is used afterwards, so a getter, a proxy or a caller changing the object during the
 * conversion cannot change a limit after it was checked.
 */
function checkOptions(o: ToWavOptions): ToWavOptions {
  if (typeof o !== "object" || o === null) {
    throw new AudioLimitsError("toCanonicalWav options must be an object");
  }
  const snap: ToWavOptions = Object.freeze({
    source: o.source,
    minSeconds: o.minSeconds,
    maxSeconds: o.maxSeconds,
    maxInputBytes: o.maxInputBytes,
    probeTimeoutMs: o.probeTimeoutMs,
  });
  const ok =
    (snap.source === "recording" || snap.source === "upload") &&
    typeof snap.minSeconds === "number" &&
    typeof snap.maxSeconds === "number" &&
    Number.isFinite(snap.minSeconds) &&
    Number.isFinite(snap.maxSeconds) &&
    snap.minSeconds > 0 &&
    snap.minSeconds <= snap.maxSeconds &&
    (snap.maxInputBytes === undefined || positiveInteger(snap.maxInputBytes)) &&
    (snap.probeTimeoutMs === undefined || positiveInteger(snap.probeTimeoutMs));
  if (!ok) {
    throw new AudioLimitsError(
      "toCanonicalWav options: source recording|upload, 0 < minSeconds <= maxSeconds (finite), positive whole maxInputBytes and probeTimeoutMs"
    );
  }
  return snap;
}

function errorName(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "name" in e
    ? String((e as { name: unknown }).name)
    : undefined;
}

/**
 * Converts a recording made by this tab's recorder (source "recording") or a file the person
 * picked (source "upload") into canonical WAV. Rejects with BrowserAudioError(code), with
 * AudioLimitsError for unusable options, or with the original error for a bug.
 */
export async function toCanonicalWav(
  blob: Blob,
  options: ToWavOptions,
  d: Deps = {}
): Promise<ToWavResult> {
  const o = checkOptions(options);
  if (!blob || blob.size === 0) throw new BrowserAudioError("empty", "input");

  if (o.source === "upload") {
    const maxInputBytes = o.maxInputBytes ?? UPLOAD_MAX_INPUT_BYTES;
    if (blob.size > maxInputBytes) throw new BrowserAudioError("too_large", "input");
    let head: Uint8Array;
    try {
      head = new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer());
    } catch (e) {
      throw new BrowserAudioError("read_failed", "container", e);
    }
    const container = sniffAudioContainer(head);
    if (container === null) throw new BrowserAudioError("undecodable", "container");
    // The probe's media element learns the type from the Blob alone; the declared type is
    // replaced (never trusted) by the one the bytes name. No bytes are copied.
    const typed = blob.slice(0, blob.size, CONTAINER_TYPES[container]);
    const probe = d.probe ?? probeDuration;
    const length = await probe(typed, {
      timeoutMs: o.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
    });
    if (length.status === "unknown") throw new BrowserAudioError("unmeasurable", "probe");
    if (length.status !== "known") throw new BrowserAudioError("undecodable", "probe");
    if (length.seconds > o.maxSeconds + METADATA_TOLERANCE_SECONDS) {
      throw new BrowserAudioError("too_long", "probe");
    }
  }

  let ctx: BaseAudioContext;
  try {
    ctx = d.createContext ? d.createContext() : new OfflineAudioContext(1, 1, RATE);
  } catch (e) {
    throw new BrowserAudioError("browser_unsupported", "context", e);
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await blob.arrayBuffer();
  } catch (e) {
    throw new BrowserAudioError("read_failed", "read", e);
  }

  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(bytes);
  } catch (e) {
    if (errorName(e) === "NotSupportedError")
      throw new BrowserAudioError("browser_unsupported", "decode", e);
    if (e instanceof RangeError)
      throw new BrowserAudioError("out_of_memory", "decode", e);
    throw new BrowserAudioError("undecodable", "decode", e);
  }

  if (decoded.sampleRate !== RATE)
    throw new BrowserAudioError("browser_unsupported", "decode");
  if (decoded.length === 0) throw new BrowserAudioError("empty", "decode");
  const decodedSeconds = decoded.length / RATE;
  if (o.source === "upload" && decodedSeconds > o.maxSeconds + UPLOAD_TOLERANCE_SECONDS) {
    throw new BrowserAudioError("too_long", "length");
  }
  const keep = Math.min(decoded.length, samplesIn(o.maxSeconds));
  if (keep / RATE < o.minSeconds) throw new BrowserAudioError("too_short", "length");

  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++)
    channels.push(decoded.getChannelData(c));
  let wav: CanonicalWav;
  try {
    wav = await encodeCanonicalPcm(channels, keep, d.yieldFn ?? messageChannelYield);
  } catch (e) {
    if (e instanceof RangeError)
      throw new BrowserAudioError("out_of_memory", "encode", e);
    throw e;
  }
  return { wav, seconds: wav.seconds, decodedSeconds, trimmed: keep < decoded.length };
}

/** The upload formats the support check asks for under the current D-3 decision. */
export const UPLOAD_CHECK_TYPES: readonly string[] = AUDIO_TYPES.uploadCheck;

/** What the support check looks at; defaults to the page's globals. */
export interface AudioEnv {
  readonly OfflineAudioContext?: unknown;
  readonly MediaRecorder?: unknown;
  readonly navigator?: { readonly mediaDevices?: { readonly getUserMedia?: unknown } };
  readonly document?: {
    createElement(tag: "audio"): { canPlayType(type: string): string };
  };
}

/**
 * Which audio features this browser can run, by capability (never by name or version):
 * decode at 16 kHz, record one of the recorder types (browser-recorder's RECORDER_TYPES), the microphone API, and every upload format.
 * `missing` names each capability that failed.
 */
export function detectAudioSupport(env: AudioEnv = globalThis as unknown as AudioEnv): {
  music: boolean;
  upload: boolean;
  missing: readonly string[];
} {
  const missing: string[] = [];
  let decode = false;
  try {
    const Ctor = env.OfflineAudioContext as
      (new (channels: number, length: number, rate: number) => unknown) | undefined;
    if (typeof Ctor === "function") {
      new Ctor(1, 1, RATE);
      decode = true;
    }
  } catch {
    decode = false;
  }
  if (!decode) missing.push("decode-16k");

  let record = false;
  const MR = env.MediaRecorder as
    { (): unknown; isTypeSupported?: (t: string) => boolean } | undefined;
  const isTypeSupported = typeof MR === "function" ? MR.isTypeSupported : undefined;
  if (typeof isTypeSupported === "function") {
    record = AUDIO_TYPES.recorder.some((t) => {
      try {
        return isTypeSupported.call(MR, t) === true;
      } catch {
        return false;
      }
    });
  }
  if (!record) missing.push("record");

  const mic = typeof env.navigator?.mediaDevices?.getUserMedia === "function";
  if (!mic) missing.push("microphone");

  let formats = false;
  try {
    const el = env.document?.createElement("audio");
    if (el && typeof el.canPlayType === "function") {
      const lacking = UPLOAD_CHECK_TYPES.filter((t) => el.canPlayType(t) === "");
      for (const t of lacking) missing.push(`play:${t}`);
      formats = lacking.length === 0;
    } else {
      missing.push("play");
    }
  } catch {
    missing.push("play");
  }

  return {
    music: decode && record && mic,
    upload: decode && formats,
    missing: Object.freeze(missing),
  };
}
