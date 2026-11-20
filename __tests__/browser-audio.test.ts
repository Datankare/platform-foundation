/**
 * __tests__/browser-audio.test.ts — the browser converter's logic with injected fakes (TASK-234)
 *
 * Node environment: no browser here, so the decoder, the probe and the yield are fakes, and each
 * step's outcome is asserted (DESIGN-56f1 §4.2, tests T5–T12, T18). The real engines are
 * exercised by e2e/audio (Chromium here and in CI; Firefox, WebKit and Safari on macOS).
 *
 * @not-guard: unit tests of the converter; one case feeds its container table the first bytes of
 * each committed test audio file as input (the files' integrity is
 * __tests__/audio-fixtures-integrity.test.ts's).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  BrowserAudioError,
  CONTAINER_TYPES,
  METADATA_TOLERANCE_SECONDS,
  PROBE_TIMEOUT_MS,
  UPLOAD_CHECK_TYPES,
  UPLOAD_MAX_INPUT_BYTES,
  UPLOAD_TOLERANCE_SECONDS,
  detectAudioSupport,
  messageChannelYield,
  probeDuration,
  SNIFF_BYTES,
  sniffAudioContainer,
  toCanonicalWav,
  type AudioContainer,
  type AudioEnv,
  type BrowserAudioStage,
  type Deps,
  type ProbeResult,
  type ToWavOptions,
} from "@/platform/voice/browser-audio";
import {
  AudioLimitsError,
  CanonicalWav,
  checkCanonicalWav,
} from "@/platform/voice/canonical-wav";

const RATE = 16000;

/** A decoded buffer of `seconds` at 16 kHz (or `rate`), `channels` channels of a constant value. */
function decodedOf(
  seconds: number,
  o: { rate?: number; channels?: number; value?: number; values?: number[] } = {}
) {
  const rate = o.rate ?? RATE;
  const length = Math.round(seconds * rate);
  const ch = (
    o.values ?? Array.from({ length: o.channels ?? 1 }, () => o.value ?? 0.25)
  ).map((v) => new Float32Array(length).fill(v));
  return {
    sampleRate: rate,
    length,
    numberOfChannels: ch.length,
    duration: length / rate,
    getChannelData: (c: number) => ch[c],
  } as unknown as AudioBuffer;
}

interface Fakes {
  decodes: number;
  arrayBufferCalls: number;
  headReads: number;
  probes: number;
  probed: Blob[];
  deps: Deps;
}

/** Fakes: a context whose decode returns `decoded` (or rejects), a probe answering `probe`. */
function fakes(
  decoded: AudioBuffer | (() => Promise<AudioBuffer>),
  probe: ProbeResult = { status: "known", seconds: 3, via: "metadata" }
): Fakes {
  const f: Fakes = {
    decodes: 0,
    arrayBufferCalls: 0,
    headReads: 0,
    probes: 0,
    probed: [],
    deps: {},
  };
  f.deps = {
    probe: async (b) => {
      f.probes++;
      f.probed.push(b);
      return probe;
    },
    createContext: () =>
      ({
        decodeAudioData: () => {
          f.decodes++;
          return typeof decoded === "function" ? decoded() : Promise.resolve(decoded);
        },
      }) as unknown as BaseAudioContext,
    yieldFn: () => Promise.resolve(),
  };
  return f;
}

/** The first bytes of a file of each container (what `sniffAudioContainer` reads). */
const HEADS: Readonly<Record<AudioContainer, number[]>> = {
  wav: [
    0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  ],
  mp3: [0xff, 0xfb, 0x70, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  flac: [0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0x22, 0x12, 0, 0x12, 0, 0, 1, 0xb4, 0],
  ogg: [0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
  webm: [
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0xf7, 0x81, 1, 0x42, 0xf2,
    0x81,
  ],
  mp4: [0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x35, 0, 0, 2, 0],
};

interface BlobFake {
  /** The file's first bytes (default: a WebM start). */
  head?: number[];
  /** The type the picker declared (default "audio/webm"). */
  type?: string;
  /** Reading the first bytes fails this way. */
  headError?: unknown;
  /** Every slice call, as [start, end, type]. */
  slices?: Array<[number | undefined, number | undefined, string | undefined]>;
}

/**
 * A stand-in Blob of `size` bytes: `arrayBuffer` is the whole-file read (counted in
 * `f.arrayBufferCalls`); `slice(0, n)` with n ≤ SNIFF_BYTES is the read of the first bytes
 * (counted in `f.headReads`); `slice(0, size, type)` is the same file under another type.
 */
function blobOf(
  size: number,
  f?: Fakes,
  arrayBuffer?: () => Promise<ArrayBuffer>,
  o: BlobFake = {}
): Blob {
  const head = Uint8Array.from(o.head ?? HEADS.webm);
  const make = (type: string): Blob =>
    ({
      size,
      type,
      arrayBuffer: () => {
        if (f) f.arrayBufferCalls++;
        return arrayBuffer ? arrayBuffer() : Promise.resolve(new ArrayBuffer(8));
      },
      slice: (start?: number, end?: number, contentType?: string) => {
        o.slices?.push([start, end, contentType]);
        if (start === 0 && end !== undefined && end <= SNIFF_BYTES && end < size) {
          return {
            size: end,
            type: "",
            arrayBuffer: () => {
              if (f) f.headReads++;
              if (o.headError !== undefined) return Promise.reject(o.headError);
              return Promise.resolve(head.slice(0, end).buffer);
            },
          } as unknown as Blob;
        }
        return make(contentType ?? "");
      },
    }) as unknown as Blob;
  return make(o.type ?? "audio/webm");
}

const REC = (max: number, min = 1): ToWavOptions => ({
  source: "recording",
  maxSeconds: max,
  minSeconds: min,
});
const UP = (max: number, min = 0.5, extra: Partial<ToWavOptions> = {}): ToWavOptions => ({
  source: "upload",
  maxSeconds: max,
  minSeconds: min,
  ...extra,
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof BrowserAudioError ? e.code : `other:${String(e)}`;
  }
}

async function stageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof BrowserAudioError ? `${e.code}@${e.stage}` : `other:${String(e)}`;
  }
}

describe("constants (D-7 and the tolerances)", () => {
  it("states the pick limit and tolerances", () => {
    expect(UPLOAD_MAX_INPUT_BYTES).toBe(26214400);
    expect(METADATA_TOLERANCE_SECONDS).toBe(1);
    expect(UPLOAD_TOLERANCE_SECONDS).toBe(0.25);
    expect(PROBE_TIMEOUT_MS).toBe(3000);
  });
});

describe("options are checked first ([Low] U−1)", () => {
  const bad: Array<[string, unknown]> = [
    ["maxSeconds NaN", { source: "upload", minSeconds: 1, maxSeconds: NaN }],
    ["minSeconds NaN", { source: "upload", minSeconds: NaN, maxSeconds: 10 }],
    ["min > max", { source: "recording", minSeconds: 10, maxSeconds: 5 }],
    ["minSeconds 0", { source: "recording", minSeconds: 0, maxSeconds: 5 }],
    ["unknown source", { source: "file", minSeconds: 1, maxSeconds: 5 }],
    [
      "maxInputBytes 0",
      { source: "upload", minSeconds: 1, maxSeconds: 5, maxInputBytes: 0 },
    ],
    [
      "probeTimeoutMs 1.5",
      { source: "upload", minSeconds: 1, maxSeconds: 5, probeTimeoutMs: 1.5 },
    ],
    ["no options", null],
  ];
  it.each(bad)("%s throws misconfigured before anything is read", async (_n, o) => {
    const f = fakes(decodedOf(3));
    await expect(
      toCanonicalWav(blobOf(100, f), o as ToWavOptions, f.deps)
    ).rejects.toThrow(AudioLimitsError);
    expect(f.arrayBufferCalls).toBe(0);
    expect(f.decodes).toBe(0);
  });
});

describe("U0/U1: empty and too large", () => {
  it("an empty Blob → empty", async () => {
    const f = fakes(decodedOf(3));
    expect(await codeOf(toCanonicalWav(blobOf(0, f), REC(15), f.deps))).toBe("empty");
  });

  it("T10: 25 MiB + 1 byte → too_large before reading a byte (arrayBuffer and probe never called)", async () => {
    const f = fakes(decodedOf(3));
    expect(
      await codeOf(toCanonicalWav(blobOf(UPLOAD_MAX_INPUT_BYTES + 1, f), UP(60), f.deps))
    ).toBe("too_large");
    expect(f.arrayBufferCalls).toBe(0);
    expect(f.headReads).toBe(0);
    expect(f.probes).toBe(0);
  });

  it("T10: an 11.3 MB file (over the server's 4 MiB, under the pick limit) is converted", async () => {
    const f = fakes(decodedOf(59));
    const r = await toCanonicalWav(blobOf(11_328_044, f), UP(60), f.deps);
    expect(r.seconds).toBe(59);
    expect(r.wav.byteLength).toBe(44 + 59 * 32000);
  });

  it("a caller's own maxInputBytes is honoured", async () => {
    const f = fakes(decodedOf(3));
    expect(
      await codeOf(
        toCanonicalWav(blobOf(1001, f), UP(60, 0.5, { maxInputBytes: 1000 }), f.deps)
      )
    ).toBe("too_large");
  });
});

describe("U2: an upload's length is known before decoding (T5, WA-4)", () => {
  it.each<[string, ProbeResult, string]>([
    [
      "unknown (budget passed)",
      { status: "unknown", phase: "seek-probe" },
      "unmeasurable",
    ],
    [
      "unreadable",
      { status: "unreadable", phase: "metadata", mediaErrorCode: 4 },
      "undecodable",
    ],
    [
      "unreadable, as an older caller's probe answers",
      { status: "unreadable" },
      "undecodable",
    ],
    ["known 1800 s", { status: "known", seconds: 1800, via: "seek-probe" }, "too_long"],
    [
      "T7: metadata 61.2 s, max 60",
      { status: "known", seconds: 61.2, via: "metadata" },
      "too_long",
    ],
  ])("%s → %s with 0 decodes", async (_n, probe, code) => {
    const f = fakes(decodedOf(3), probe);
    expect(await codeOf(toCanonicalWav(blobOf(1000, f), UP(60), f.deps))).toBe(code);
    expect(f.decodes).toBe(0);
    expect(f.arrayBufferCalls).toBe(0);
  });

  it("the probe gets the default 3 s budget, or the caller's", async () => {
    const seen: number[] = [];
    const deps: Deps = {
      ...fakes(decodedOf(3)).deps,
      probe: async (_b, o) => {
        seen.push(o.timeoutMs);
        return { status: "known", seconds: 3, via: "metadata" };
      },
    };
    await toCanonicalWav(blobOf(1000), UP(60), deps);
    await toCanonicalWav(blobOf(1000), UP(60, 0.5, { probeTimeoutMs: 30000 }), deps);
    expect(seen).toEqual([3000, 30000]);
  });

  it("a recording is not probed (bounded by its own timer)", async () => {
    const f = fakes(decodedOf(5));
    await toCanonicalWav(blobOf(1000, f), REC(15), f.deps);
    expect(f.probes).toBe(0);
  });
});

describe("U3–U6: context, read, decode", () => {
  it("no 16 kHz OfflineAudioContext → browser_unsupported (the default context, absent in Node)", async () => {
    const { createContext: _drop, ...rest } = fakes(decodedOf(3)).deps;
    void _drop;
    expect(await codeOf(toCanonicalWav(blobOf(1000), REC(15), rest))).toBe(
      "browser_unsupported"
    );
  });

  it("T11: arrayBuffer rejects NotReadableError → read_failed", async () => {
    const f = fakes(decodedOf(3));
    const notReadable = Object.assign(new Error("file moved"), {
      name: "NotReadableError",
    });
    const blob = blobOf(1000, f, () => Promise.reject(notReadable));
    expect(await codeOf(toCanonicalWav(blob, REC(15), f.deps))).toBe("read_failed");
    expect(f.decodes).toBe(0);
  });

  it.each<[string, () => unknown, string]>([
    [
      "NotSupportedError",
      () => Object.assign(new Error("x"), { name: "NotSupportedError" }),
      "browser_unsupported",
    ],
    ["RangeError", () => new RangeError("allocation"), "out_of_memory"],
    [
      "EncodingError",
      () => Object.assign(new Error("x"), { name: "EncodingError" }),
      "undecodable",
    ],
    ["a non-error value", () => "nope", "undecodable"],
  ])("decode rejecting with %s → %s", async (_n, err, code) => {
    const f = fakes(() => Promise.reject(err()));
    expect(await codeOf(toCanonicalWav(blobOf(1000, f), REC(15), f.deps))).toBe(code);
  });

  it("decoded at another rate → browser_unsupported; no samples → empty", async () => {
    const a = fakes(decodedOf(3, { rate: 44100 }));
    expect(await codeOf(toCanonicalWav(blobOf(1000, a), REC(15), a.deps))).toBe(
      "browser_unsupported"
    );
    const b = fakes(decodedOf(0));
    expect(await codeOf(toCanonicalWav(blobOf(1000, b), REC(15), b.deps))).toBe("empty");
  });

  it("the error carries its cause", async () => {
    const cause = new RangeError("allocation");
    const f = fakes(() => Promise.reject(cause));
    const e = await toCanonicalWav(blobOf(1000, f), REC(15), f.deps).catch((x) => x);
    expect(e).toBeInstanceOf(BrowserAudioError);
    expect((e as { cause?: unknown }).cause).toBe(cause);
    expect(e.message).toBe("out_of_memory");
  });
});

describe("U7/U8: trim, tolerance, minimum (T6, T7, WB-2, WB-19)", () => {
  it("T6: a recording decoded 20.023 s with max 20 is trimmed to 320 000 samples, never refused", async () => {
    const f = fakes(decodedOf(20.0231875));
    const r = await toCanonicalWav(blobOf(1000, f), REC(20, 10), f.deps);
    expect(r.trimmed).toBe(true);
    expect(r.seconds).toBe(20);
    expect(r.wav.byteLength).toBe(44 + 320000 * 2);
    expect(r.decodedSeconds).toBeCloseTo(20.0231875, 6);
  });

  it("T6: a recording of 9.9 s with min 10 → too_short (on decoded length)", async () => {
    const f = fakes(decodedOf(9.9));
    expect(await codeOf(toCanonicalWav(blobOf(1000, f), REC(15, 10), f.deps))).toBe(
      "too_short"
    );
  });

  it("T7: an upload decoded 60.023 s with max 60 is kept as 60.000 s", async () => {
    const f = fakes(decodedOf(60.0231875), {
      status: "known",
      seconds: 60.02,
      via: "metadata",
    });
    const r = await toCanonicalWav(blobOf(1000, f), UP(60), f.deps);
    expect(r.seconds).toBe(60);
    expect(r.trimmed).toBe(true);
  });

  it("T7: an upload decoded 60.26 s with max 60 → too_long", async () => {
    const f = fakes(decodedOf(60.26), {
      status: "known",
      seconds: 60.26,
      via: "metadata",
    });
    expect(await codeOf(toCanonicalWav(blobOf(1000, f), UP(60), f.deps))).toBe(
      "too_long"
    );
  });

  it("a recording far over its timer is still trimmed (the timer bounds it)", async () => {
    const f = fakes(decodedOf(25));
    const r = await toCanonicalWav(blobOf(1000, f), REC(20, 10), f.deps);
    expect(r.seconds).toBe(20);
  });

  it("a short upload passes untrimmed and the result is a genuine canonical WAV", async () => {
    const f = fakes(decodedOf(3, { channels: 2 }));
    const r = await toCanonicalWav(blobOf(1000, f), UP(60), f.deps);
    expect(r.trimmed).toBe(false);
    expect(CanonicalWav.isCanonicalWav(r.wav)).toBe(true);
    expect(
      checkCanonicalWav(r.wav.copyBytes(), {
        maxBytes: 4194304,
        minSeconds: 1,
        maxSeconds: 60,
      }).ok
    ).toBe(true);
  });
});

describe("the fix round (CODE-REVIEW-A/B)", () => {
  it("RA-3: an options object changed during the probe does not change the outcome", async () => {
    const opts = { source: "upload" as const, minSeconds: 0.5, maxSeconds: 60 };
    const f = fakes(decodedOf(30));
    const deps: Deps = {
      ...f.deps,
      probe: async () => {
        (opts as { maxSeconds: number }).maxSeconds = NaN;
        return { status: "known", seconds: 30, via: "metadata" };
      },
    };
    const r = await toCanonicalWav(blobOf(1000), opts, deps);
    expect(r.seconds).toBe(30);
    const opts2 = { source: "upload" as const, minSeconds: 0.5, maxSeconds: 10 };
    const deps2: Deps = {
      ...f.deps,
      probe: async () => {
        (opts2 as { maxSeconds: number }).maxSeconds = 100;
        return { status: "known", seconds: 10, via: "metadata" };
      },
    };
    const g = fakes(decodedOf(30));
    expect(
      await codeOf(toCanonicalWav(blobOf(1000), opts2, { ...g.deps, probe: deps2.probe }))
    ).toBe("too_long");
  });

  it("RB-1: the converter averages every channel into the mono result", async () => {
    const f = fakes(decodedOf(1, { values: [0.5, 0] }));
    const r = await toCanonicalWav(blobOf(1000, f), REC(15, 0.5), f.deps);
    expect(new DataView(r.wav.copyBytes().buffer).getInt16(44, true)).toBe(8192);
  });

  it("RA-8: a limit of 2.01 s keeps 32 160 samples (no sample lost to rounding)", async () => {
    const f = fakes(decodedOf(3));
    const r = await toCanonicalWav(blobOf(1000, f), REC(2.01, 1), f.deps);
    expect(r.wav.byteLength).toBe(44 + 32160 * 2);
  });
});

describe("U9: the encoder's failures (T12, WA-20)", () => {
  it("T12: a TypeError during encoding is rethrown unchanged (a bug, never 'damaged file')", async () => {
    const bug = new TypeError("a bug");
    const f = fakes(decodedOf(2));
    const deps: Deps = { ...f.deps, yieldFn: () => Promise.reject(bug) };
    const e = await toCanonicalWav(blobOf(1000, f), REC(15), deps).catch((x) => x);
    expect(e).toBe(bug);
  });

  it("a RangeError during encoding → out_of_memory", async () => {
    const f = fakes(decodedOf(2));
    const deps: Deps = {
      ...f.deps,
      yieldFn: () => Promise.reject(new RangeError("alloc")),
    };
    expect(await codeOf(toCanonicalWav(blobOf(1000, f), REC(15), deps))).toBe(
      "out_of_memory"
    );
  });
});

describe("the yield (T9, WA-5)", () => {
  it("the default yield is a MessageChannel post, not a timer", async () => {
    const spy = jest.spyOn(globalThis, "setTimeout");
    try {
      const f = fakes(decodedOf(3));
      const { yieldFn: _drop, ...deps } = f.deps;
      void _drop;
      const r = await toCanonicalWav(blobOf(1000, f), REC(15), deps);
      expect(r.seconds).toBe(3);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("messageChannelYield resolves through a MessageChannel and closes it", async () => {
    const real = globalThis.MessageChannel;
    let closed = 0;
    class Counting extends real {
      constructor() {
        super();
        const close = this.port1.close.bind(this.port1);
        this.port1.close = () => {
          closed++;
          close();
        };
      }
    }
    globalThis.MessageChannel = Counting;
    try {
      await messageChannelYield();
      await messageChannelYield();
    } finally {
      globalThis.MessageChannel = real;
    }
    expect(closed).toBe(2);
  });
});

describe("R3 U1b: an upload's container is named from its first bytes, never from its declared type", () => {
  const bytes = (...b: number[]) => Uint8Array.from(b);
  const text = (t: string) => Uint8Array.from(Array.from(t, (c) => c.charCodeAt(0)));

  it.each(Object.keys(HEADS) as AudioContainer[])("names %s", (container) => {
    expect(sniffAudioContainer(Uint8Array.from(HEADS[container]))).toBe(container);
  });

  it("names MP3 with an ID3v2 tag, and each MPEG version's Layer III header", () => {
    expect(sniffAudioContainer(bytes(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0x0f, 0x76))).toBe(
      "mp3"
    );
    for (const second of [0xfb, 0xfa, 0xf3, 0xf2, 0xe3, 0xe2]) {
      expect(sniffAudioContainer(bytes(0xff, second, 0x90, 0x64))).toBe("mp3");
    }
  });

  it("gives each container the type the probe's element is told", () => {
    expect(CONTAINER_TYPES).toEqual({
      wav: "audio/wav",
      mp3: "audio/mpeg",
      flac: "audio/flac",
      ogg: "audio/ogg",
      webm: "audio/webm",
      mp4: "audio/mp4",
    });
    expect(Object.isFrozen(CONTAINER_TYPES)).toBe(true);
    expect(SNIFF_BYTES).toBe(16);
  });

  it.each<[string, Uint8Array]>([
    ["nothing", bytes()],
    ["zeros", new Uint8Array(16)],
    ["text", text("<!doctype html><p>")],
    ["RIFF that is not WAVE (AVI)", text("RIFF\u0010\u0000\u0000\u0000AVI LIST")],
    ["RIFF cut before WAVE", text("RIFF\u0010\u0000\u0000\u0000WAV")],
    ["RF64", text("RF64ÿÿÿÿWAVEds64")],
    ["fLa", text("fLa")],
    ["OggS of another stream version", bytes(0x4f, 0x67, 0x67, 0x53, 1, 2, 0, 0)],
    ["OggS that is not a first page", bytes(0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0)],
    ["OggS cut short", bytes(0x4f, 0x67, 0x67, 0x53, 0)],
    ["three of the four EBML bytes", bytes(0x1a, 0x45, 0xdf)],
    ["EBML bytes not at the start", bytes(0, 0x1a, 0x45, 0xdf, 0xa3)],
    [
      "ftyp of 12 bytes (no brand list)",
      bytes(0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4),
    ],
    [
      "ftyp of a size that is no multiple of 4",
      bytes(0, 0, 0, 0x1d, 0x66, 0x74, 0x79, 0x70),
    ],
    ["ftyp not at offset 4", bytes(0, 0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70)],
    ["moov first", bytes(0, 0, 0, 0x6c, 0x6d, 0x6f, 0x6f, 0x76)],
    ["ID3 cut short", bytes(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0)],
    ["ID3 of version FF", bytes(0x49, 0x44, 0x33, 0xff, 0, 0, 0, 0, 0, 0)],
    ["ID3 of revision FF", bytes(0x49, 0x44, 0x33, 4, 0xff, 0, 0, 0, 0, 0)],
    [
      "ID3 with a size byte over 7 bits (1st)",
      bytes(0x49, 0x44, 0x33, 4, 0, 0, 0x80, 0, 0, 0),
    ],
    [
      "ID3 with a size byte over 7 bits (2nd)",
      bytes(0x49, 0x44, 0x33, 4, 0, 0, 0, 0x80, 0, 0),
    ],
    [
      "ID3 with a size byte over 7 bits (3rd)",
      bytes(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0x80, 0),
    ],
    [
      "ID3 with a size byte over 7 bits (4th)",
      bytes(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0x80),
    ],
    ["AAC/ADTS (layer bits 00)", bytes(0xff, 0xf1, 0x50, 0x80)],
    ["MPEG Layer II", bytes(0xff, 0xfd, 0x90, 0x64)],
    ["MPEG Layer I", bytes(0xff, 0xff, 0x90, 0x64)],
    ["the reserved MPEG version", bytes(0xff, 0xea, 0x90, 0x64)],
    ["a free-format bitrate", bytes(0xff, 0xfb, 0x00, 0x64)],
    ["the forbidden bitrate", bytes(0xff, 0xfb, 0xf0, 0x64)],
    ["the reserved sample rate", bytes(0xff, 0xfb, 0x9c, 0x64)],
    ["a sync byte alone", bytes(0xff, 0xfb)],
    ["FF then no sync", bytes(0xff, 0x1b, 0x90, 0x64)],
    ["padding before an MP3 frame", bytes(0, 0xff, 0xfb, 0x90, 0x64)],
  ])("does not name %s", (_n, head) => {
    expect(sniffAudioContainer(head)).toBeNull();
  });

  it("names every committed test file by its own bytes (the extension is never read)", () => {
    const dir = join(__dirname, "fixtures", "audio");
    const byExtension: Record<string, AudioContainer> = {
      webm: "webm",
      ogg: "ogg",
      m4a: "mp4",
      mp3: "mp3",
      flac: "flac",
    };
    const tracked = execFileSync("git", ["ls-files", "--", "."], {
      cwd: dir,
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => /\.(?:webm|ogg|m4a|mp3|flac)$/.test(f));
    expect(tracked.length).toBeGreaterThanOrEqual(14);
    for (const f of tracked) {
      const head = Uint8Array.from(readFileSync(join(dir, f)).subarray(0, SNIFF_BYTES));
      expect([f, sniffAudioContainer(head)]).toEqual([
        f,
        byExtension[f.slice(f.lastIndexOf(".") + 1)],
      ]);
    }
  });

  it.each<[string, string, AudioContainer]>([
    ["no declared type (drag and drop, some pickers)", "", "mp3"],
    ["the right declared type", "audio/flac", "flac"],
    ["a wrong declared type (a renamed file)", "audio/wav", "mp3"],
    ["a declared type that is no audio type", "application/octet-stream", "mp4"],
  ])(
    "the probe is given the file typed from its bytes: %s",
    async (_n, declared, container) => {
      const f = fakes(decodedOf(3));
      const slices: NonNullable<BlobFake["slices"]> = [];
      const blob = blobOf(1000, f, undefined, {
        head: HEADS[container],
        type: declared,
        slices,
      });
      await toCanonicalWav(blob, UP(60), f.deps);
      expect(f.probed.map((b) => [b.type, b.size])).toEqual([
        [CONTAINER_TYPES[container], 1000],
      ]);
      expect(slices).toEqual([
        [0, SNIFF_BYTES, undefined],
        [0, 1000, CONTAINER_TYPES[container]],
      ]);
      expect(f.headReads).toBe(1);
      // The decoder is given the picked file itself, read once.
      expect(f.arrayBufferCalls).toBe(1);
      expect(f.decodes).toBe(1);
    }
  );

  it.each<[string, string]>([
    ["no declared type", ""],
    ["declared audio/mpeg", "audio/mpeg"],
    ["declared audio/wav", "audio/wav"],
  ])(
    "unknown bytes are refused before the probe and the decoder, %s (a declared type never widens)",
    async (_n, declared) => {
      const f = fakes(decodedOf(3));
      const blob = blobOf(1000, f, undefined, {
        head: [
          0x3c, 0x21, 0x64, 0x6f, 0x63, 0x74, 0x79, 0x70, 0x65, 0x20, 0x68, 0x74, 0x6d,
          0x6c, 0x3e, 0x0a,
        ],
        type: declared,
      });
      expect(await stageOf(toCanonicalWav(blob, UP(60), f.deps))).toBe(
        "undecodable@container"
      );
      expect(f.probes).toBe(0);
      expect(f.decodes).toBe(0);
      expect(f.arrayBufferCalls).toBe(0);
    }
  );

  it("a file shorter than its container's mark is refused the same way", async () => {
    const f = fakes(decodedOf(3));
    const blob = blobOf(3, f, undefined, { head: [0x66, 0x4c, 0x61] });
    // 3 bytes: the whole file is the head (slice(0, 16) of a 3-byte Blob is the Blob).
    (blob as unknown as { slice: () => Blob }).slice = () =>
      ({
        arrayBuffer: () => Promise.resolve(Uint8Array.from([0x66, 0x4c, 0x61]).buffer),
      }) as unknown as Blob;
    expect(await stageOf(toCanonicalWav(blob, UP(60), f.deps))).toBe(
      "undecodable@container"
    );
    expect(f.probes).toBe(0);
  });

  it("the first bytes cannot be read (a picked file moved or evicted) → read_failed, nothing probed", async () => {
    const f = fakes(decodedOf(3));
    const cause = Object.assign(new Error("file moved"), { name: "NotReadableError" });
    const blob = blobOf(1000, f, undefined, { headError: cause });
    const e = await toCanonicalWav(blob, UP(60), f.deps).catch((x) => x);
    expect(e).toBeInstanceOf(BrowserAudioError);
    expect([e.code, e.stage, (e as { cause?: unknown }).cause]).toEqual([
      "read_failed",
      "container",
      cause,
    ]);
    expect(f.probes).toBe(0);
    expect(f.decodes).toBe(0);
  });

  it("a recording is not sniffed (it is this tab's own recorder's Blob)", async () => {
    const f = fakes(decodedOf(5));
    const slices: NonNullable<BlobFake["slices"]> = [];
    await toCanonicalWav(
      blobOf(1000, f, undefined, { head: new Array(16).fill(0), slices }),
      REC(15),
      f.deps
    );
    expect(slices).toEqual([]);
    expect(f.headReads).toBe(0);
  });
});

describe("R3: every refusal names the step that ended it", () => {
  const notSupported = () => Object.assign(new Error("x"), { name: "NotSupportedError" });
  const cases: Array<[string, () => Promise<unknown>, `${string}@${BrowserAudioStage}`]> =
    [
      [
        "an empty Blob",
        () => toCanonicalWav(blobOf(0), UP(60), fakes(decodedOf(3)).deps),
        "empty@input",
      ],
      [
        "over the pick limit",
        () =>
          toCanonicalWav(
            blobOf(UPLOAD_MAX_INPUT_BYTES + 1),
            UP(60),
            fakes(decodedOf(3)).deps
          ),
        "too_large@input",
      ],
      [
        "the probe's budget passed",
        () =>
          toCanonicalWav(
            blobOf(1000),
            UP(60),
            fakes(decodedOf(3), { status: "unknown" }).deps
          ),
        "unmeasurable@probe",
      ],
      [
        "the probe's element reported an error",
        () =>
          toCanonicalWav(
            blobOf(1000),
            UP(60),
            fakes(decodedOf(3), { status: "unreadable" }).deps
          ),
        "undecodable@probe",
      ],
      [
        "the declared length is over the limit",
        () =>
          toCanonicalWav(
            blobOf(1000),
            UP(60),
            fakes(decodedOf(3), { status: "known", seconds: 1800, via: "metadata" }).deps
          ),
        "too_long@probe",
      ],
      [
        "no 16 kHz context",
        () => {
          const { createContext: _drop, ...rest } = fakes(decodedOf(3)).deps;
          void _drop;
          return toCanonicalWav(blobOf(1000), REC(15), rest);
        },
        "browser_unsupported@context",
      ],
      [
        "the file cannot be read",
        () =>
          toCanonicalWav(
            blobOf(1000, undefined, () => Promise.reject(new Error("moved"))),
            REC(15),
            fakes(decodedOf(3)).deps
          ),
        "read_failed@read",
      ],
      [
        "the decoder refuses the format",
        () =>
          toCanonicalWav(
            blobOf(1000),
            REC(15),
            fakes(() => Promise.reject(notSupported())).deps
          ),
        "browser_unsupported@decode",
      ],
      [
        "the decoder runs out of memory",
        () =>
          toCanonicalWav(
            blobOf(1000),
            REC(15),
            fakes(() => Promise.reject(new RangeError("allocation"))).deps
          ),
        "out_of_memory@decode",
      ],
      [
        "the decoder rejects the bytes",
        () =>
          toCanonicalWav(
            blobOf(1000),
            REC(15),
            fakes(() => Promise.reject(new Error("bad"))).deps
          ),
        "undecodable@decode",
      ],
      [
        "decoded at another rate",
        () =>
          toCanonicalWav(
            blobOf(1000),
            REC(15),
            fakes(decodedOf(3, { rate: 44100 })).deps
          ),
        "browser_unsupported@decode",
      ],
      [
        "decoded to no samples",
        () => toCanonicalWav(blobOf(1000), REC(15), fakes(decodedOf(0)).deps),
        "empty@decode",
      ],
      [
        "the decoded upload is over the limit",
        () => toCanonicalWav(blobOf(1000), UP(60), fakes(decodedOf(60.26)).deps),
        "too_long@length",
      ],
      [
        "the kept length is under the minimum",
        () => toCanonicalWav(blobOf(1000), REC(15, 10), fakes(decodedOf(9.9)).deps),
        "too_short@length",
      ],
      [
        "the encoder runs out of memory",
        () =>
          toCanonicalWav(blobOf(1000), REC(15), {
            ...fakes(decodedOf(3)).deps,
            yieldFn: () => Promise.reject(new RangeError("allocation")),
          }),
        "out_of_memory@encode",
      ],
    ];
  it.each(cases)("%s", async (_n, run, expected) => {
    expect(await stageOf(run())).toBe(expected);
  });
});

describe("probeDuration (the pre-decode length probe)", () => {
  interface FakeAudio {
    preload: string;
    muted: boolean;
    duration: number;
    currentTime: number;
    src: string;
    onerror: null | (() => void);
    onloadedmetadata: null | (() => void);
    ondurationchange: null | (() => void);
    removeAttribute: jest.Mock;
    load: jest.Mock;
  }
  let el: FakeAudio;
  const realDocument = (globalThis as { document?: unknown }).document;
  let revoke: jest.SpyInstance;

  beforeEach(() => {
    el = {
      preload: "",
      muted: false,
      duration: NaN,
      currentTime: 0,
      src: "",
      onerror: null,
      onloadedmetadata: null,
      ondurationchange: null,
      removeAttribute: jest.fn(),
      load: jest.fn(),
    };
    (globalThis as { document?: unknown }).document = { createElement: () => el };
    jest.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
    revoke = jest.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });
  afterEach(() => {
    (globalThis as { document?: unknown }).document = realDocument;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const released = () => {
    expect(el.onerror).toBeNull();
    expect(el.onloadedmetadata).toBeNull();
    expect(el.ondurationchange).toBeNull();
    expect(el.removeAttribute).toHaveBeenCalledWith("src");
    expect(el.load).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:fake");
  };

  it("a finite duration in the metadata is known, via metadata", async () => {
    const p = probeDuration(new Blob(["x"]), { timeoutMs: 3000 });
    expect(el.preload).toBe("metadata");
    expect(el.muted).toBe(true);
    expect(el.src).toBe("blob:fake");
    el.duration = 3.008;
    el.onloadedmetadata!();
    expect(await p).toEqual({ status: "known", seconds: 3.008, via: "metadata" });
    released();
  });

  it("Infinity in the metadata: a seek far past the end, then the real end (seek-probe)", async () => {
    const p = probeDuration(new Blob(["x"]), { timeoutMs: 3000 });
    el.duration = Infinity;
    el.onloadedmetadata!();
    expect(el.currentTime).toBe(1e101);
    el.ondurationchange!(); // still Infinity: keeps waiting
    el.duration = 1800.001;
    el.ondurationchange!();
    expect(await p).toEqual({ status: "known", seconds: 1800.001, via: "seek-probe" });
    released();
  });

  it("an error event → unreadable", async () => {
    const p = probeDuration(new Blob(["x"]), { timeoutMs: 3000 });
    el.onerror!();
    expect(await p).toEqual({
      status: "unreadable",
      phase: "metadata",
      mediaErrorCode: null,
    });
    released();
  });

  it("R3: an error names the element's own error code and where the probe was", async () => {
    const before = probeDuration(new Blob(["x"]), { timeoutMs: 3000 });
    (el as { error?: unknown }).error = { code: 4 };
    el.onerror!();
    expect(await before).toEqual({
      status: "unreadable",
      phase: "metadata",
      mediaErrorCode: 4,
    });

    const during = probeDuration(new Blob(["x"]), { timeoutMs: 3000 });
    el.duration = Infinity;
    el.onloadedmetadata!();
    (el as { error?: unknown }).error = { code: 3 };
    el.onerror!();
    expect(await during).toEqual({
      status: "unreadable",
      phase: "seek-probe",
      mediaErrorCode: 3,
    });

    const odd = probeDuration(new Blob(["x"]), { timeoutMs: 3000 });
    (el as { error?: unknown }).error = { code: "4" };
    el.onerror!();
    expect(await odd).toEqual({
      status: "unreadable",
      phase: "metadata",
      mediaErrorCode: null,
    });
  });

  it("R3: a budget that passes before the metadata says so (phase metadata)", async () => {
    jest.useFakeTimers();
    const p = probeDuration(new Blob(["x"]), { timeoutMs: 3000 });
    jest.advanceTimersByTime(3000);
    expect(await p).toEqual({ status: "unknown", phase: "metadata" });
  });

  it("RB-9: every outcome leaves no timer behind (metadata, seek probe, error)", async () => {
    jest.useFakeTimers();
    const p1 = probeDuration(new Blob(["x"]), { timeoutMs: 3000 });
    el.duration = 2;
    el.onloadedmetadata!();
    await p1;
    expect(jest.getTimerCount()).toBe(0);
    const p2 = probeDuration(new Blob(["x"]), { timeoutMs: 3000 });
    el.onerror!();
    await p2;
    expect(jest.getTimerCount()).toBe(0);
  });

  it("no finite length within the budget → unknown; a late answer changes nothing", async () => {
    jest.useFakeTimers();
    const p = probeDuration(new Blob(["x"]), { timeoutMs: 3000 });
    el.duration = Infinity;
    const onMeta = el.onloadedmetadata!;
    onMeta();
    const onChange = el.ondurationchange!;
    jest.advanceTimersByTime(2999);
    jest.advanceTimersByTime(1);
    expect(await p).toEqual({ status: "unknown", phase: "seek-probe" });
    el.duration = 5;
    onChange();
    released();
  });
});

describe("detectAudioSupport by capability, never by name (T18, WB-3, WB-20)", () => {
  type Profile = {
    recorder: Record<string, boolean>;
    cannotPlay: string[];
    decode?: boolean;
    mic?: boolean;
  };
  function envOf(p: Profile): AudioEnv {
    const MR = Object.assign(function MediaRecorder() {}, {
      isTypeSupported: (t: string) => p.recorder[t] === true,
    });
    return {
      OfflineAudioContext:
        p.decode === false
          ? undefined
          : function OfflineAudioContext(_c: number, _l: number, rate: number) {
              if (rate < 3000) throw new Error("rate");
            },
      MediaRecorder: MR,
      navigator: {
        mediaDevices: p.mic === false ? {} : { getUserMedia: () => undefined },
      },
      document: {
        createElement: () => ({
          canPlayType: (t: string) => (p.cannotPlay.includes(t) ? "" : "maybe"),
        }),
      },
    };
  }
  const AAC = 'audio/mp4; codecs="mp4a.40.2"';
  const OGG_OPUS = 'audio/ogg; codecs="opus"';
  const OGG_VORBIS = 'audio/ogg; codecs="vorbis"';
  const WEBM = 'audio/webm; codecs="opus"';
  const profiles: Array<[string, Profile, { music: boolean; upload: boolean }]> = [
    [
      "Chromium",
      { recorder: { "audio/webm;codecs=opus": true, "audio/mp4": true }, cannotPlay: [] },
      { music: true, upload: true },
    ],
    [
      "Firefox on macOS",
      {
        recorder: { "audio/webm;codecs=opus": true, "audio/ogg;codecs=opus": true },
        cannotPlay: [],
      },
      { music: true, upload: true },
    ],
    [
      "Firefox on Linux without AAC",
      {
        recorder: { "audio/webm;codecs=opus": true, "audio/ogg;codecs=opus": true },
        cannotPlay: [AAC],
      },
      { music: true, upload: false },
    ],
    [
      "Safari 18.4 on macOS 15.4",
      { recorder: { "audio/webm;codecs=opus": true, "audio/mp4": true }, cannotPlay: [] },
      { music: true, upload: true },
    ],
    [
      "Safari 17",
      { recorder: { "audio/mp4": true }, cannotPlay: [OGG_OPUS, OGG_VORBIS, WEBM] },
      { music: false, upload: false },
    ],
  ];

  it.each(profiles)("%s", (_n, p, want) => {
    const got = detectAudioSupport(envOf(p));
    expect({ music: got.music, upload: got.upload }).toEqual(want);
  });

  it("RB-5: every upload format playable but no 16 kHz decoder → no upload", () => {
    const got = detectAudioSupport({
      ...envOf(profiles[0][1]),
      OfflineAudioContext: undefined,
    });
    expect(got.upload).toBe(false);
    expect(got.music).toBe(false);
    expect(got.missing).toEqual(["decode-16k"]);
  });

  it("Safari 17 is told what it lacks; a full browser lacks nothing", () => {
    expect(detectAudioSupport(envOf(profiles[4][1])).missing).toEqual([
      "record",
      `play:${OGG_OPUS}`,
      `play:${OGG_VORBIS}`,
      `play:${WEBM}`,
    ]);
    expect(detectAudioSupport(envOf(profiles[0][1])).missing).toEqual([]);
  });

  it("asks canPlayType for every upload format of the default branch", () => {
    expect(UPLOAD_CHECK_TYPES).toEqual([
      "audio/wav",
      "audio/mpeg",
      AAC,
      "audio/flac",
      OGG_OPUS,
      OGG_VORBIS,
      WEBM,
    ]);
  });

  it("no decoder, no microphone API, no audio element, a throwing recorder check", () => {
    const got = detectAudioSupport({
      OfflineAudioContext: function () {
        throw new Error("16 kHz refused");
      },
      MediaRecorder: Object.assign(function () {}, {
        isTypeSupported: () => {
          throw new Error("x");
        },
      }),
      navigator: {},
      document: undefined,
    });
    expect(got).toEqual({
      music: false,
      upload: false,
      missing: ["decode-16k", "record", "microphone", "play"],
    });
    const throwing = detectAudioSupport({
      ...envOf(profiles[0][1]),
      document: {
        createElement: () => {
          throw new Error("no DOM");
        },
      },
    });
    expect(throwing.missing).toEqual(["play"]);
    expect(detectAudioSupport({}).missing).toEqual([
      "decode-16k",
      "record",
      "microphone",
      "play",
    ]);
  });
});
