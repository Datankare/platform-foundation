/**
 * __tests__/canonical-wav.test.ts — the strict canonical-WAV check and CanonicalWav (TASK-234)
 *
 * T1 forgeries at run time, T2 immutability, T3 limits fail closed, T4 the property test over
 * reviewer A's 27 generators (BROWSER-AUDIO-REVIEW-A, Datankare 2026-11-17) with the oracle
 * "accepted ⇔ the 44 header bytes equal the canonical header for the length, data even, within
 * limits", the encoder's conversion and slicing, and the confirmation review's Lows (slice
 * arguments, a frozen class).
 */

import fc from "fast-check";
import {
  AUDIO_DECISIONS,
  AUDIO_TYPES,
  AudioLimitsError,
  CANONICAL,
  CanonicalWav,
  audioTypesFor,
  checkCanonicalWav,
  encodeCanonicalPcm,
  requireCanonicalWav,
  validateAudioLimits,
  type AudioLimits,
} from "@/platform/voice/canonical-wav";
import {
  MALFORMED_GENERATORS,
  concat,
  oracleAccepts,
  oracleHeader,
  seededRandom,
} from "./fixtures/audio/generate";
import { fuzzParams } from "./helpers/fuzz";

fc.configureGlobal(fuzzParams());

const L: AudioLimits = { maxBytes: 4194304, minSeconds: 0.5, maxSeconds: 60 };

function wavOf(seconds: number, fill = 7): Uint8Array {
  const n = Math.round(seconds * 16000) * 2;
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = (i * fill) & 0xff;
  return concat(oracleHeader(n), data);
}

function genuine(seconds = 1): CanonicalWav {
  const r = checkCanonicalWav(wavOf(seconds), L);
  if (!r.ok) throw new Error("fixture not accepted");
  return r.wav;
}

/** Byte equality without jest's element-by-element diff (inputs reach 4 MiB). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.length).equals(
    Buffer.from(b.buffer, b.byteOffset, b.length)
  );
}

const provider = (audio: unknown) => requireCanonicalWav(audio).toBase64().length;

describe("CanonicalWav: forgeries (T1, WA-1 forms 1–7 and the run-time forms)", () => {
  const raw = wavOf(1);
  const forms: Record<string, () => unknown> = {
    "1 JSON.parse of a body": () => JSON.parse(JSON.stringify({ ...genuine() })),
    "2 raw bytes as never": () => raw as never,
    "3 raw bytes as the request's audio type": () => raw as unknown as CanonicalWav,
    "4 raw bytes as a parameter type": () =>
      raw as unknown as Parameters<typeof provider>[0],
    "5 a type predicate over raw bytes": () => {
      const isWav = (x: unknown): x is CanonicalWav => x instanceof Uint8Array;
      return isWav(raw) ? raw : null;
    },
    "6 a generic forge<T>": () => {
      const forge = <T>(x: unknown) => x as T;
      return forge<CanonicalWav>(raw);
    },
    "7 a suppressed type error": () => {
      const audio: CanonicalWav = raw as unknown as CanonicalWav;
      return audio;
    },
    "Object.create(CanonicalWav.prototype)": () => Object.create(CanonicalWav.prototype),
    "Object.setPrototypeOf(raw, CanonicalWav.prototype)": () =>
      Object.setPrototypeOf(wavOf(1), CanonicalWav.prototype),
    "structuredClone(genuine)": () => structuredClone(genuine()),
    "new Proxy(genuine, {})": () => new Proxy(genuine(), {}),
    "Object.assign({}, genuine)": () => Object.assign({}, genuine()),
    "Object.create(genuine)": () => Object.create(genuine()),
    "a plain object with the same getters": () => ({
      byteLength: raw.length,
      seconds: 1,
      copyBytes: () => raw.slice(),
      toBase64: () => "",
    }),
  };

  it.each(Object.keys(forms))("%s is refused with TypeError at the boundary", (name) => {
    expect(() => provider(forms[name]())).toThrow(TypeError);
    expect(CanonicalWav.isCanonicalWav(forms[name]())).toBe(false);
  });

  it("the constructor without the module's token throws TypeError (undefined, Symbol.for, a guess)", () => {
    const pcm = new Uint8Array(32000);
    const Ctor = CanonicalWav as unknown as new (
      t: unknown,
      p: Uint8Array
    ) => CanonicalWav;
    expect(() => new Ctor(undefined, pcm)).toThrow(TypeError);
    expect(() => new Ctor(Symbol.for("canonical-wav mint"), pcm)).toThrow(TypeError);
    expect(() => new Ctor(Symbol("canonical-wav mint"), pcm)).toThrow(TypeError);
    expect(() => Reflect.construct(Ctor, [undefined, pcm])).toThrow(TypeError);
  });

  it("a subclass cannot mint one", () => {
    const Base = CanonicalWav as unknown as new (t: unknown, p: Uint8Array) => object;
    class X extends Base {
      constructor() {
        super(Symbol("canonical-wav mint"), new Uint8Array(32000));
      }
    }
    expect(() => new X()).toThrow(TypeError);
  });

  it("prototype methods called on a fake throw TypeError", () => {
    const fake = Object.create(CanonicalWav.prototype) as CanonicalWav;
    expect(() => fake.copyBytes()).toThrow(TypeError);
    expect(() => fake.toBase64()).toThrow(TypeError);
    expect(() => fake.byteLength).toThrow(TypeError);
  });

  it("a genuine object passes the boundary and keeps its bytes", () => {
    const w = genuine(1);
    expect(requireCanonicalWav(w)).toBe(w);
    expect(provider(w)).toBeGreaterThan(0);
    expect(CanonicalWav.isCanonicalWav(w)).toBe(true);
    expect(w.byteLength).toBe(32044);
    expect(w.seconds).toBe(1);
  });

  it("[Low] the class, its prototype and the functions are frozen: the brand check cannot be replaced", () => {
    expect(Object.isFrozen(CanonicalWav)).toBe(true);
    expect(Object.isFrozen(CanonicalWav.prototype)).toBe(true);
    expect(Object.isFrozen(requireCanonicalWav)).toBe(true);
    expect(() => {
      (CanonicalWav as unknown as { isCanonicalWav: unknown }).isCanonicalWav = () =>
        true;
    }).toThrow(TypeError);
    expect(() => {
      (CanonicalWav.prototype as unknown as { toBase64: unknown }).toBase64 = () => "x";
    }).toThrow(TypeError);
    expect(() => requireCanonicalWav(wavOf(1))).toThrow(TypeError);
  });
});

describe("CanonicalWav: immutable after the check (T2, form 10)", () => {
  it("mutating the checked input and a copy changes nothing; adding a property throws", () => {
    const input = wavOf(1);
    const r = checkCanonicalWav(input, L);
    if (!r.ok) throw new Error("not accepted");
    const before = r.wav.toBase64();
    const copy = r.wav.copyBytes();
    copy.set([76, 73, 83, 84], 36); // "LIST" into the copy
    input.set([76, 73, 83, 84], 36); // and into the checked input
    expect(r.wav.toBase64()).toBe(before);
    expect(r.wav.copyBytes()[36]).toBe("d".charCodeAt(0));
    expect(Object.isFrozen(r.wav)).toBe(true);
    expect(() => {
      (r.wav as unknown as { extra: number }).extra = 1;
    }).toThrow(TypeError);
    expect(checkCanonicalWav(r.wav.copyBytes(), L).ok).toBe(true);
  });

  it("copyBytes and toBlob give fresh data each call", async () => {
    const w = genuine(1);
    const a = w.copyBytes();
    const b = w.copyBytes();
    expect(a).not.toBe(b);
    expect(a.buffer).not.toBe(b.buffer);
    const blob = w.toBlob();
    expect(blob.type).toBe("audio/wav");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(a);
  });

  it("toBase64 encodes the whole file, past one 32 KiB block", () => {
    const w = genuine(3);
    expect(Buffer.from(w.toBase64(), "base64")).toEqual(Buffer.from(w.copyBytes()));
  });
});

describe("CanonicalWav.slice", () => {
  it("keeps the first maxSeconds with the header rewritten; itself when not longer", () => {
    const w = genuine(3);
    const s = w.slice(1.5);
    expect(s.seconds).toBe(1.5);
    expect(s.byteLength).toBe(44 + 48000);
    expect(checkCanonicalWav(s.copyBytes(), L).ok).toBe(true);
    expect(s.copyBytes().subarray(44)).toEqual(w.copyBytes().subarray(44, 44 + 48000));
    expect(w.slice(3)).toBe(w);
    expect(w.slice(10)).toBe(w);
  });

  it("RB-4/RA-8: a cut between samples keeps the whole samples before it, robust to rounding", () => {
    const w = genuine(3);
    expect(w.slice(1.00003).byteLength).toBe(44 + 16000 * 2);
    expect(w.slice(2.01).byteLength).toBe(44 + 32160 * 2);
  });

  it("RA-4: a cut that keeps no sample throws RangeError (no empty CanonicalWav)", () => {
    expect(() => genuine(1).slice(1e-9)).toThrow(RangeError);
    expect(() => genuine(1).slice(0.00006)).toThrow(RangeError);
  });

  it.each([NaN, -1, 0, Infinity, -Infinity, "2" as unknown as number])(
    "[Low] slice(%p) throws RangeError",
    (v) => {
      expect(() => genuine(1).slice(v)).toThrow(RangeError);
    }
  );
});

describe("limits fail closed and loudly (T3, WA-3)", () => {
  const bad: Array<[string, unknown]> = [
    ["maxSeconds NaN", { ...L, maxSeconds: NaN }],
    ["minSeconds NaN", { ...L, minSeconds: NaN }],
    ["maxSeconds undefined", { maxBytes: L.maxBytes, minSeconds: 0.5 }],
    ["minSeconds 0", { ...L, minSeconds: 0 }],
    ["minSeconds -1", { ...L, minSeconds: -1 }],
    ["min > max", { ...L, minSeconds: 10, maxSeconds: 5 }],
    ["maxBytes over 4 MiB", { ...L, maxBytes: 4194305 }],
    ["maxBytes 44", { ...L, maxBytes: 44 }],
    ["maxBytes 1.5", { ...L, maxBytes: 1000.5 }],
    ["maxBytes NaN", { ...L, maxBytes: NaN }],
    ["maxSeconds a string", { ...L, maxSeconds: "60" }],
    ["maxSeconds Infinity", { ...L, maxSeconds: Infinity }],
    ["limits null", null],
    ["limits a number", 5],
  ];
  it.each(bad)("%s throws misconfigured, never passes", (_name, limits) => {
    let thrown: unknown;
    try {
      checkCanonicalWav(wavOf(200), limits as AudioLimits);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AudioLimitsError);
    expect((thrown as AudioLimitsError).code).toBe("misconfigured");
    expect(() => validateAudioLimits(limits as AudioLimits)).toThrow(AudioLimitsError);
  });

  it("usable limits come back as a frozen snapshot with the same values", () => {
    const snap = validateAudioLimits(L);
    expect(snap).toEqual(L);
    expect(snap).not.toBe(L);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it("RA-3: limits read once — getters that change after validation cannot pass a file", () => {
    const after = (first: number, later: number) => {
      let reads = 0;
      return () => (reads++ === 0 ? first : later);
    };
    const shifty = {} as AudioLimits;
    Object.defineProperty(shifty, "maxBytes", { get: after(100000, NaN) });
    Object.defineProperty(shifty, "minSeconds", { get: after(0.5, NaN) });
    Object.defineProperty(shifty, "maxSeconds", { get: after(1, NaN) });
    expect(checkCanonicalWav(wavOf(125), shifty)).toEqual({
      ok: false,
      code: "too_large",
    });
    const shifty2 = {} as AudioLimits;
    Object.defineProperty(shifty2, "maxBytes", { get: after(4194304, NaN) });
    Object.defineProperty(shifty2, "minSeconds", { get: after(0.5, NaN) });
    Object.defineProperty(shifty2, "maxSeconds", { get: after(1, NaN) });
    expect(checkCanonicalWav(wavOf(3), shifty2)).toEqual({ ok: false, code: "too_long" });
  });
});

describe("check order and codes", () => {
  it("not a Uint8Array, or empty → invalid_audio; a Buffer is a Uint8Array", () => {
    const w = wavOf(1);
    for (const x of [
      w.buffer,
      new Uint16Array(w.buffer),
      new Int8Array(w.buffer),
      new DataView(w.buffer),
      new Uint8ClampedArray(w.buffer),
      "RIFF",
      null,
      undefined,
      new Uint8Array(0),
    ]) {
      expect(checkCanonicalWav(x as Uint8Array, L)).toEqual({
        ok: false,
        code: "invalid_audio",
      });
    }
    expect(checkCanonicalWav(Buffer.from(w), L).ok).toBe(true);
  });

  it("over maxBytes → too_large before the header is read", () => {
    const junk = new Uint8Array(5000).fill(0x41);
    expect(checkCanonicalWav(junk, { ...L, maxBytes: 4999 })).toEqual({
      ok: false,
      code: "too_large",
    });
  });

  it("RB-3: exactly maxSeconds is accepted; two bytes more is too long", () => {
    const sixty = concat(oracleHeader(1920000), new Uint8Array(1920000));
    expect(checkCanonicalWav(sixty, L).ok).toBe(true);
    const over = concat(oracleHeader(1920002), new Uint8Array(1920002));
    expect(checkCanonicalWav(over, L)).toEqual({ ok: false, code: "too_long" });
  });

  it("RA-11: bytes in shared memory are refused (another thread could change them mid-check)", () => {
    const w = wavOf(1);
    const shared = new Uint8Array(new SharedArrayBuffer(w.length));
    shared.set(w);
    expect(checkCanonicalWav(shared, L)).toEqual({ ok: false, code: "invalid_audio" });
  });

  it("short, long and odd", () => {
    expect(checkCanonicalWav(wavOf(0.4), L)).toEqual({ ok: false, code: "too_short" });
    expect(checkCanonicalWav(wavOf(61), L)).toEqual({ ok: false, code: "too_long" });
    expect(checkCanonicalWav(new Uint8Array(43), L)).toEqual({
      ok: false,
      code: "invalid_audio",
    });
    const odd = concat(oracleHeader(32001), new Uint8Array(32001));
    expect(checkCanonicalWav(odd, L)).toEqual({ ok: false, code: "invalid_audio" });
  });

  it("an input byte never reaches a code or a message", () => {
    const r = checkCanonicalWav(new TextEncoder().encode("<script>SECRET</script>"), L);
    expect(JSON.stringify(r)).not.toMatch(/SECRET/);
  });

  it("CANONICAL states the format", () => {
    expect(CANONICAL).toEqual({
      sampleRate: 16000,
      headerBytes: 44,
      bytesPerSecond: 32000,
      maxServerBytes: 4194304,
    });
    expect(Object.isFrozen(CANONICAL)).toBe(true);
  });
});

describe("the validator's property test (T4)", () => {
  const names = Object.keys(MALFORMED_GENERATORS);

  it("covers reviewer A's 27 generators", () => {
    expect(names).toHaveLength(27);
  });

  const limitsArb = fc.oneof(
    fc.constant(L),
    fc.record({
      maxBytes: fc.integer({ min: 45, max: 4194304 }),
      minSeconds: fc.double({ min: 0.01, max: 5, noNaN: true }),
      maxSeconds: fc.double({ min: 5, max: 120, noNaN: true }),
    })
  );

  it("0 false accepts, 0 false rejects, 0 throws; output never aliases the input", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...names),
        fc.integer({ min: 1, max: 0x7fffffff }),
        limitsArb,
        (name, start, lim) => {
          const b = MALFORMED_GENERATORS[name](seededRandom(start));
          const before = b.slice();
          const r = checkCanonicalWav(b, lim);
          expect(r.ok).toBe(oracleAccepts(b, lim));
          expect(sameBytes(b, before)).toBe(true);
          if (r.ok) {
            const out = r.wav.copyBytes();
            expect(out.buffer).not.toBe(b.buffer);
            expect(sameBytes(out, b)).toBe(true);
            expect(r.wav.seconds).toBe((b.length - 44) / 32000);
            expect(requireCanonicalWav(r.wav)).toBe(r.wav);
          }
        }
      )
    );
  });

  it("every generator runs once on a fixed source (each oracle verdict met)", () => {
    for (const name of names) {
      const b = MALFORMED_GENERATORS[name](seededRandom(42));
      expect([name, checkCanonicalWav(b, L).ok]).toEqual([name, oracleAccepts(b, L)]);
    }
  });

  it("the generators are deterministic for a given source (T23 part)", () => {
    for (const name of names) {
      const a = MALFORMED_GENERATORS[name](seededRandom(7));
      const b = MALFORMED_GENERATORS[name](seededRandom(7));
      expect([name, sameBytes(a, b)]).toEqual([name, true]);
    }
  });
});

describe("encodeCanonicalPcm (the browser's encoder)", () => {
  const noYield = () => Promise.resolve();

  it("averages channels to mono, clamps, NaN → 0, negative × 32768, positive × 32767", async () => {
    const left = Float32Array.from([1, -1, 0.5, NaN, 2, -2, 0]);
    const right = Float32Array.from([1, -1, -0.5, 0, 2, -2, 0]);
    const w = await encodeCanonicalPcm([left, right], 7, noYield);
    const v = new DataView(w.copyBytes().buffer);
    const samples = Array.from({ length: 7 }, (_, i) => v.getInt16(44 + i * 2, true));
    expect(samples).toEqual([32767, -32768, 0, 0, 32767, -32768, 0]);
    expect(checkCanonicalWav(w.copyBytes(), { ...L, minSeconds: 0.0001 }).ok).toBe(true);
  });

  it("keeps only `length` samples", async () => {
    const w = await encodeCanonicalPcm([new Float32Array(100)], 40, noYield);
    expect(w.byteLength).toBe(44 + 80);
  });

  it("structural slicing (T8): one yield per 16 000 samples, no slice over 16 000", async () => {
    const len = 16000 * 7 + 5;
    let writesSinceYield = 0;
    let maxSlice = 0;
    const real = DataView.prototype.setInt16;
    const spy = jest.spyOn(DataView.prototype, "setInt16").mockImplementation(function (
      this: DataView,
      ...a: [number, number, boolean?]
    ) {
      writesSinceYield++;
      return real.apply(this, a);
    });
    let yields = 0;
    try {
      await encodeCanonicalPcm([new Float32Array(len)], len, () => {
        yields++;
        maxSlice = Math.max(maxSlice, writesSinceYield);
        writesSinceYield = 0;
        return Promise.resolve();
      });
    } finally {
      spy.mockRestore();
    }
    expect(yields).toBe(Math.ceil(len / 16000));
    expect(maxSlice).toBe(16000);
  });

  it("unusable arguments throw TypeError (a bug, never a person's error)", async () => {
    await expect(encodeCanonicalPcm([], 0, noYield)).rejects.toThrow(TypeError);
    await expect(encodeCanonicalPcm([new Float32Array(4)], 5, noYield)).rejects.toThrow(
      TypeError
    );
    await expect(encodeCanonicalPcm([new Float32Array(4)], -1, noYield)).rejects.toThrow(
      TypeError
    );
    await expect(encodeCanonicalPcm([new Float32Array(4)], 1.5, noYield)).rejects.toThrow(
      TypeError
    );
    await expect(
      encodeCanonicalPcm(
        [new Float32Array(4)],
        4,
        undefined as unknown as () => Promise<void>
      )
    ).rejects.toThrow(TypeError);
  });

  it("RA-4: an empty length is refused — no empty CanonicalWav is ever made", async () => {
    await expect(encodeCanonicalPcm([new Float32Array(0)], 0, noYield)).rejects.toThrow(
      TypeError
    );
  });

  it("RA-9: a channel that is not a Float32Array is refused (a plain array, other typed arrays)", async () => {
    const bad: unknown[] = [
      ["a", "b"],
      [0.1, 0.2],
      new Float64Array(2),
      new Int16Array(2),
    ];
    for (const ch of bad) {
      await expect(encodeCanonicalPcm([ch as Float32Array], 2, noYield)).rejects.toThrow(
        TypeError
      );
    }
  });

  it("RB-1: channels are averaged (not summed, not channel 0 only)", async () => {
    const w = await encodeCanonicalPcm(
      [Float32Array.from([0.5, -0.5, 0]), Float32Array.from([0, 0, 0.5])],
      3,
      noYield
    );
    const v = new DataView(w.copyBytes().buffer);
    expect([0, 1, 2].map((i) => v.getInt16(44 + i * 2, true))).toEqual([
      8192, -8192, 8192,
    ]);
  });
});

describe("the owner's decisions in one place (D-1, D-3, D-7)", () => {
  it("states the defaults", () => {
    expect(AUDIO_DECISIONS).toEqual({
      musicClipSeconds: 15,
      uploadMaxInputBytes: 26214400,
      claimSafariBefore18_4: false,
    });
    expect(Object.isFrozen(AUDIO_DECISIONS)).toBe(true);
  });

  it("D-3 default: WebM/Opus then Ogg/Opus, never mp4; all seven upload rows", () => {
    expect(AUDIO_TYPES).toEqual(audioTypesFor(false));
    expect(AUDIO_TYPES.recorder).toEqual([
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
    ]);
    expect(AUDIO_TYPES.uploadCheck).toHaveLength(7);
  });

  it("D-3 alternative: mp4 recorded last; the Ogg and WebM upload rows dropped", () => {
    const alt = audioTypesFor(true);
    expect(alt.recorder).toEqual([
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ]);
    expect(alt.uploadCheck).toEqual([
      "audio/wav",
      "audio/mpeg",
      'audio/mp4; codecs="mp4a.40.2"',
      "audio/flac",
    ]);
  });
});
