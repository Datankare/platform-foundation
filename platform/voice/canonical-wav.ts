/**
 * platform/voice/canonical-wav.ts — the one place that reads or writes a WAV header (TASK-234, ADR-061)
 *
 * Canonical audio is exactly: "RIFF" · size = length − 8 · "WAVE" · "fmt " · 16 · format 1 (PCM) ·
 * 1 channel · 16 000 Hz · byte rate 32 000 · block align 2 · 16 bits · "data" · size = length − 44 ·
 * even. No other chunk. The browser writes it (`encodeCanonicalPcm`, used only by browser-audio.ts);
 * the server checks it (`checkCanonicalWav`). No server ever parses compressed media.
 *
 * `CanonicalWav` is a class so the guarantee holds at run time, not only in the types: only this
 * module can make one (a module-private mint symbol), its bytes live in an ES-private field and
 * leave only as copies, and the object, the class and its prototype are frozen. A provider calls
 * `requireCanonicalWav` at its boundary; anything not made here throws a TypeError there.
 *
 * Isomorphic: no Node or DOM API except `Blob` (toBlob) and `btoa` (toBase64), both present in
 * every supported browser and in Node 18+.
 *
 * Credits: "Multimedia Programming Interface and Data Specifications 1.0" (IBM and Microsoft,
 * 1991) — the RIFF/WAVE layout. BROWSER-AUDIO-REVIEW-A (Datankare, 2026-11-17) — the run-time
 * forgery forms and the validator's fuzz generators.
 *
 * @module platform/voice/canonical-wav
 */

const RATE = 16000;
const HEADER = 44;
const BYTES_PER_SECOND = 32000;
const MAX_SERVER_BYTES = 4194304;
/** One slice of the browser encoder: one second of samples, then the encoder yields. */
const SLICE_SAMPLES = RATE;

/**
 * Whole samples in `seconds` at 16 kHz, robust to binary rounding (2.01 × 16 000 is
 * 32 159.999… in floating point; it is 32 160 samples). The one place this is computed.
 */
export function samplesIn(seconds: number): number {
  return Math.floor(seconds * RATE + 1e-6);
}

/** The canonical format's numbers. `maxServerBytes` (4 MiB) is the server's cap on a converted WAV. */
export const CANONICAL: {
  readonly sampleRate: 16000;
  readonly headerBytes: 44;
  readonly bytesPerSecond: 32000;
  readonly maxServerBytes: 4194304;
} = Object.freeze({
  sampleRate: RATE,
  headerBytes: HEADER,
  bytesPerSecond: BYTES_PER_SECOND,
  maxServerBytes: MAX_SERVER_BYTES,
});

/**
 * The owner's audio decisions, in one place (DESIGN-56f1 §2). Changing a decision is a change here
 * and nowhere else; the tests read these values.
 * - `musicClipSeconds` — D-1: the Music clip length (applied by 56f-2's screen).
 * - `uploadMaxInputBytes` — D-7: the largest file a person may pick, 25 MiB (26 214 400 bytes;
 *   "25 MB" on screen), separate from the server's 4 MiB cap on the converted WAV.
 * - `claimSafariBefore18_4` — D-3: false = Safari older than 18.4 is not claimed; feature
 *   detection decides and such a browser gets "needs a newer browser" for the audio features.
 *   true = the alternative branch (adds "audio/mp4" recording, drops the Ogg/WebM upload rows).
 */
export const AUDIO_DECISIONS: {
  readonly musicClipSeconds: number;
  readonly uploadMaxInputBytes: number;
  readonly claimSafariBefore18_4: boolean;
} = Object.freeze({
  musicClipSeconds: 15,
  uploadMaxInputBytes: 26_214_400,
  claimSafariBefore18_4: false,
});

/**
 * The recorder and upload types each D-3 branch uses — the whole effect of the D-3 switch, here.
 * Default (not claimed): record WebM/Opus or Ogg/Opus only ("audio/mp4" is the only type Safari
 * before 18.4 records, and nothing proves those recordings decode); uploads need all seven formats.
 * Claimed: "audio/mp4" added last; the Ogg and WebM upload rows dropped (each file is then tried).
 */
export function audioTypesFor(claimSafariBefore18_4: boolean): {
  readonly recorder: readonly string[];
  readonly uploadCheck: readonly string[];
} {
  const upload = [
    "audio/wav",
    "audio/mpeg",
    'audio/mp4; codecs="mp4a.40.2"',
    "audio/flac",
    'audio/ogg; codecs="opus"',
    'audio/ogg; codecs="vorbis"',
    'audio/webm; codecs="opus"',
  ];
  const recorder = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus"];
  return Object.freeze({
    recorder: Object.freeze(
      claimSafariBefore18_4 ? [...recorder, "audio/mp4"] : recorder
    ),
    uploadCheck: Object.freeze(
      claimSafariBefore18_4 ? upload.filter((t) => !/ogg|webm/.test(t)) : upload
    ),
  });
}

/** The types in force under the current decision. */
export const AUDIO_TYPES = audioTypesFor(AUDIO_DECISIONS.claimSafariBefore18_4);

const MINT: unique symbol = Symbol("canonical-wav mint");

function ascii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < 4; i++) target[offset + i] = text.charCodeAt(i);
}

/** The canonical 44-byte header for `dataBytes` bytes of samples. */
function canonicalHeader(dataBytes: number): Uint8Array {
  const b = new Uint8Array(HEADER);
  const v = new DataView(b.buffer);
  ascii(b, 0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(b, 8, "WAVE");
  ascii(b, 12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, BYTES_PER_SECOND, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(b, 36, "data");
  v.setUint32(40, dataBytes, true);
  return b;
}

/** Module-local brand check, set once by the class below; nothing outside can replace it. */
let hasBrand: (x: object) => boolean = () => false;

/**
 * Checked canonical audio. Made only by `checkCanonicalWav` (server, tests) and
 * `encodeCanonicalPcm` (browser). Immutable: the samples are copied in, the bytes leave only as
 * fresh copies, and the object is frozen.
 */
export class CanonicalWav {
  readonly #bytes: Uint8Array;
  readonly #seconds: number;

  /** Not callable from outside this module: the token is module-private. */
  constructor(token: typeof MINT, pcm: Uint8Array) {
    if (token !== MINT) {
      throw new TypeError(
        "CanonicalWav is made only by checkCanonicalWav or the browser encoder"
      );
    }
    const bytes = new Uint8Array(HEADER + pcm.length);
    bytes.set(canonicalHeader(pcm.length), 0);
    bytes.set(pcm, HEADER);
    this.#bytes = bytes;
    this.#seconds = pcm.length / BYTES_PER_SECOND;
    Object.freeze(this);
  }

  static {
    hasBrand = (x: object) => #bytes in x;
  }

  /** True only for an object this module made (a copy, a clone, a proxy or a subclass is not). */
  static isCanonicalWav(x: unknown): x is CanonicalWav {
    return typeof x === "object" && x !== null && hasBrand(x);
  }

  get byteLength(): number {
    return this.#bytes.length;
  }

  get seconds(): number {
    return this.#seconds;
  }

  /** A fresh copy of the whole file (header and samples) on every call. */
  copyBytes(): Uint8Array {
    return this.#bytes.slice();
  }

  /** The whole file as base64, made fresh on every call. */
  toBase64(): string {
    const b = this.#bytes;
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) {
      s += String.fromCharCode.apply(
        null,
        Array.from(b.subarray(i, Math.min(b.length, i + 0x8000)))
      );
    }
    return btoa(s);
  }

  /** The whole file as an `audio/wav` Blob holding a fresh copy. */
  toBlob(): Blob {
    return new Blob([this.#bytes.slice()], { type: "audio/wav" });
  }

  /**
   * The first `maxSeconds` (header rewritten); this object when it is not longer.
   * Throws RangeError unless `maxSeconds` is a finite number greater than 0 that keeps at least
   * one sample.
   */
  slice(maxSeconds: number): CanonicalWav {
    if (
      typeof maxSeconds !== "number" ||
      !Number.isFinite(maxSeconds) ||
      maxSeconds <= 0
    ) {
      throw new RangeError("slice needs a finite number of seconds greater than 0");
    }
    const have = this.#bytes.length - HEADER;
    const keep = Math.min(have, samplesIn(maxSeconds) * 2);
    if (keep === 0) {
      throw new RangeError(
        "slice would keep no samples: an empty CanonicalWav is never made"
      );
    }
    if (keep === have) return this;
    return new CanonicalWav(MINT, this.#bytes.subarray(HEADER, HEADER + keep));
  }
}
Object.freeze(CanonicalWav.prototype);
Object.freeze(CanonicalWav);

/** Provider boundary: returns `x` when this module made it, else throws TypeError. */
export function requireCanonicalWav(x: unknown): CanonicalWav {
  if (typeof x !== "object" || x === null || !hasBrand(x)) {
    throw new TypeError("audio is not a checked CanonicalWav");
  }
  return x as CanonicalWav;
}

/** Limits for one check. Wrong limits are a configuration fault: they throw, never pass. */
export interface AudioLimits {
  readonly maxBytes: number;
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

/** Thrown for limits or options that are not usable numbers — a caller's bug, never input. */
export class AudioLimitsError extends Error {
  readonly code = "misconfigured" as const;
  constructor(message: string) {
    super(message);
    this.name = "AudioLimitsError";
  }
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * Returns the limits when usable: `maxBytes` an integer in (44, 4 194 304]; `minSeconds` and
 * `maxSeconds` finite with 0 < minSeconds ≤ maxSeconds. Anything else throws AudioLimitsError.
 */
export function validateAudioLimits(l: AudioLimits): AudioLimits {
  if (typeof l !== "object" || l === null) {
    throw new AudioLimitsError("audio limits must be an object");
  }
  // Each field is read exactly once into a frozen snapshot, and only the snapshot is used: a getter
  // or a proxy cannot pass validation and then answer differently.
  const snap: AudioLimits = Object.freeze({
    maxBytes: l.maxBytes,
    minSeconds: l.minSeconds,
    maxSeconds: l.maxSeconds,
  });
  const ok =
    typeof snap.maxBytes === "number" &&
    Number.isInteger(snap.maxBytes) &&
    snap.maxBytes > HEADER &&
    snap.maxBytes <= MAX_SERVER_BYTES &&
    isFiniteNumber(snap.minSeconds) &&
    isFiniteNumber(snap.maxSeconds) &&
    snap.minSeconds > 0 &&
    snap.minSeconds <= snap.maxSeconds;
  if (!ok) {
    throw new AudioLimitsError(
      "audio limits must be finite numbers: maxBytes an integer in (44, 4194304], 0 < minSeconds <= maxSeconds"
    );
  }
  return snap;
}

export type WavCheckCode = "invalid_audio" | "too_large" | "too_short" | "too_long";
export type WavCheck =
  | { readonly ok: true; readonly wav: CanonicalWav }
  | { readonly ok: false; readonly code: WavCheckCode };

function isUint8Array(x: unknown): x is Uint8Array {
  // Realm-independent (a Buffer or a Uint8Array from another realm passes; a Uint8ClampedArray,
  // another typed array, a DataView or an ArrayBuffer does not).
  return (
    ArrayBuffer.isView(x) && Object.prototype.toString.call(x) === "[object Uint8Array]"
  );
}

function isSharedMemory(x: Uint8Array): boolean {
  const SAB = (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer;
  return (
    typeof SAB === "function" &&
    Object.prototype.toString.call(x.buffer) === "[object SharedArrayBuffer]"
  );
}

/**
 * The strict check. Order: limits (throw when unusable) → not a Uint8Array / empty →
 * invalid_audio; over maxBytes → too_large (before reading anything else); under 44 bytes →
 * invalid_audio; the 44 header bytes must equal the canonical header for this length, byte for
 * byte (every field, both sizes, and "no other chunk") → else invalid_audio; odd data →
 * invalid_audio; shorter than minSeconds → too_short; longer than maxSeconds → too_long; else a
 * new CanonicalWav holding a copy. Never throws on input bytes; never puts input into a code.
 */
export function checkCanonicalWav(bytes: Uint8Array, limits: AudioLimits): WavCheck {
  const lim = validateAudioLimits(limits);
  if (!isUint8Array(bytes)) return { ok: false, code: "invalid_audio" };
  // Memory another thread can change (or grow) while it is read is refused; the length is read
  // once, and only a fixed-length view of that length is used from here on.
  if (isSharedMemory(bytes)) return { ok: false, code: "invalid_audio" };
  const len = bytes.length;
  if (len === 0) return { ok: false, code: "invalid_audio" };
  if (len > lim.maxBytes) return { ok: false, code: "too_large" };
  if (len < HEADER) return { ok: false, code: "invalid_audio" };
  const view = bytes.subarray(0, len);
  const want = canonicalHeader(len - HEADER);
  for (let i = 0; i < HEADER; i++) {
    if (view[i] !== want[i]) return { ok: false, code: "invalid_audio" };
  }
  const dataBytes = len - HEADER;
  if (dataBytes % 2 !== 0) return { ok: false, code: "invalid_audio" };
  const seconds = dataBytes / BYTES_PER_SECOND;
  if (seconds < lim.minSeconds) return { ok: false, code: "too_short" };
  if (seconds > lim.maxSeconds) return { ok: false, code: "too_long" };
  return { ok: true, wav: new CanonicalWav(MINT, view.subarray(HEADER, len)) };
}

/**
 * The browser's encoder (imported only by browser-audio.ts — a guard holds that): float channels
 * already at 16 kHz → mono PCM16 little-endian. Averages the channels, NaN → 0, clamps to [−1, 1],
 * negative × 32768, positive × 32767. Works one second (16 000 samples) per slice and awaits
 * `yieldFn` after each, so the page stays responsive. A RangeError (allocation) propagates for
 * the caller to report as out of memory; arguments that are not usable throw TypeError (a bug).
 */
export async function encodeCanonicalPcm(
  channels: readonly Float32Array[],
  length: number,
  yieldFn: () => Promise<void>
): Promise<CanonicalWav> {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new TypeError("encodeCanonicalPcm needs at least one channel");
  }
  if (!Number.isInteger(length) || length <= 0) {
    throw new TypeError(
      "encodeCanonicalPcm needs a whole length above 0: an empty CanonicalWav is never made"
    );
  }
  for (const ch of channels as readonly unknown[]) {
    if (
      !ArrayBuffer.isView(ch) ||
      Object.prototype.toString.call(ch) !== "[object Float32Array]" ||
      (ch as Float32Array).length < length
    ) {
      throw new TypeError(
        "every channel must be a Float32Array of at least `length` samples"
      );
    }
  }
  if (typeof yieldFn !== "function") {
    throw new TypeError("encodeCanonicalPcm needs a yield function");
  }
  const pcm = new Uint8Array(length * 2);
  const view = new DataView(pcm.buffer);
  const n = channels.length;
  for (let start = 0; start < length; start += SLICE_SAMPLES) {
    const end = Math.min(length, start + SLICE_SAMPLES);
    for (let i = start; i < end; i++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += channels[k][i];
      s /= n;
      if (s !== s) s = 0;
      else if (s < -1) s = -1;
      else if (s > 1) s = 1;
      view.setInt16(i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
    }
    await yieldFn();
  }
  return new CanonicalWav(MINT, pcm);
}

Object.freeze(audioTypesFor);
Object.freeze(samplesIn);
Object.freeze(requireCanonicalWav);
Object.freeze(validateAudioLimits);
Object.freeze(checkCanonicalWav);
Object.freeze(encodeCanonicalPcm);
Object.freeze(AudioLimitsError.prototype);
Object.freeze(AudioLimitsError);
