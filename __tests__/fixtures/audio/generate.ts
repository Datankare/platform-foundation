/**
 * __tests__/fixtures/audio/generate.ts — test audio made in code, so no such binary is committed
 * (TASK-234; DESIGN-56f1 §6)
 *
 * Every function here is pure and deterministic: no clock, no Math.random, only the seeded
 * generator below. The jest tests and the browser gate's server (e2e/audio/serve.mjs, which
 * transpiles this file) call the same functions, so every engine gets the same bytes.
 *
 * - `MALFORMED_GENERATORS`: the validator's property-test inputs (reviewer A's 27 generators,
 *   BROWSER-AUDIO-REVIEW-A, Datankare 2026-11-17), each a function of a seeded random source.
 * - `GENERATED_FIXTURES`: the WAVs the browser decodes, the duration-less WebM files, garbage and
 *   empty input — by name, as e2e/audio/expect.json lists them.
 *
 * Credits: "Multimedia Programming Interface and Data Specifications 1.0" (IBM and Microsoft,
 * 1991) — RIFF/WAVE. RFC 9559 "Matroska Media Container Format Specification" (S. Lhomme,
 * M. Bunkus, D. Rice) — the WebM writer. RFC 6716 "Definition of the Opus Audio Codec"
 * (J.-M. Valin, K. Vos, T. Terriberry) and RFC 7845 "Ogg Encapsulation for the Opus Audio Codec"
 * (T. Terriberry, R. Lee, R. Giles) — the Opus silence packet and OpusHead.
 */

/** A seeded xorshift32 source of numbers in [0, 1). */
export function seededRandom(start: number): () => number {
  let s = start >>> 0 || 0x5eed1234;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let k = 0;
  for (const p of parts) {
    out.set(p, k);
    k += p.length;
  }
  return out;
}

function ascii4(b: Uint8Array, offset: number, s: string): void {
  for (let i = 0; i < 4; i++) b[offset + i] = s.charCodeAt(i);
}

/**
 * The canonical 44-byte header for `dataBytes` of samples, written here independently of
 * platform/voice/canonical-wav.ts so the property test's oracle does not share its code.
 */
export function oracleHeader(dataBytes: number): Uint8Array {
  const b = new Uint8Array(44);
  const v = new DataView(b.buffer);
  ascii4(b, 0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii4(b, 8, "WAVE");
  ascii4(b, 12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii4(b, 36, "data");
  v.setUint32(40, dataBytes, true);
  return b;
}

export interface Limits {
  readonly maxBytes: number;
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

/** The oracle: accepted ⇔ the 44 header bytes equal the canonical header for the length, data even, within limits. */
export function oracleAccepts(b: Uint8Array, lim: Limits): boolean {
  if (b.length === 0 || b.length > lim.maxBytes || b.length < 44) return false;
  const h = oracleHeader(b.length - 44);
  for (let i = 0; i < 44; i++) if (b[i] !== h[i]) return false;
  if ((b.length - 44) % 2) return false;
  const s = (b.length - 44) / 32000;
  return s >= lim.minSeconds && s <= lim.maxSeconds;
}

type Rnd = () => number;
const ri = (rnd: Rnd, a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(rnd: Rnd, a: readonly T[]): T => a[ri(rnd, 0, a.length - 1)];

function randData(rnd: Rnd, n: number): Uint8Array {
  const d = new Uint8Array(n);
  for (let i = 0; i < n; i++) d[i] = (rnd() * 256) | 0;
  return d;
}

function chunk(id: string, body: Uint8Array, sizeOverride?: number): Uint8Array {
  const h = new Uint8Array(8);
  ascii4(h, 0, id);
  new DataView(h.buffer).setUint32(
    4,
    sizeOverride === undefined ? body.length : sizeOverride >>> 0,
    true
  );
  return concat(h, body, new Uint8Array(body.length % 2));
}

interface FmtSpec {
  size?: number;
  tag?: number;
  ch?: number;
  rate?: number;
  bits?: number;
  br?: number;
  ba?: number;
}

function fmt({
  size = 16,
  tag = 1,
  ch = 1,
  rate = 16000,
  bits = 16,
  br,
  ba,
}: FmtSpec = {}) {
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  if (size >= 2) v.setUint16(0, tag, true);
  if (size >= 4) v.setUint16(2, ch, true);
  if (size >= 8) v.setUint32(4, rate >>> 0, true);
  if (size >= 12) v.setUint32(8, (br ?? (rate * ch * bits) / 8) >>> 0, true);
  if (size >= 14) v.setUint16(12, (ba ?? (ch * bits) / 8) & 0xffff, true);
  if (size >= 16) v.setUint16(14, bits, true);
  if (size >= 18) v.setUint16(16, size - 18, true);
  if (size === 40) {
    v.setUint16(18, bits, true);
    v.setUint32(20, 4, true);
    b[24] = 1;
  }
  return b;
}

function riff(
  chunks: Uint8Array[],
  o: { tag?: string; form?: string; size?: number } = {}
) {
  const body = concat(...chunks);
  const h = new Uint8Array(12);
  ascii4(h, 0, o.tag ?? "RIFF");
  ascii4(h, 8, o.form ?? "WAVE");
  new DataView(h.buffer).setUint32(
    4,
    o.size === undefined ? 4 + body.length : o.size >>> 0,
    true
  );
  return concat(h, body);
}

function valid(rnd: Rnd, sec: number): Uint8Array {
  const n = Math.max(0, Math.round(sec * 16000)) * 2;
  return concat(oracleHeader(n), randData(rnd, n));
}

const MAX = 4 * 1024 * 1024;

/** Reviewer A's 27 generators: valid files, every structural malformation, flips, truncation, random. */
export const MALFORMED_GENERATORS: Readonly<Record<string, (rnd: Rnd) => Uint8Array>> = {
  valid: (r) => valid(r, pick(r, [0.5, 1, 3.3, 20, 59.99, 60])),
  rf64: (r) =>
    riff(
      [
        chunk("ds64", new Uint8Array(28)),
        chunk("fmt ", fmt()),
        chunk("data", randData(r, 32000), 0xffffffff),
      ],
      { tag: pick(r, ["RF64", "BW64"]), size: 0xffffffff }
    ),
  extensible: () =>
    riff([
      chunk("fmt ", fmt({ size: 40, tag: 0xfffe })),
      chunk("data", new Uint8Array(32000)),
    ]),
  fmt18: (r) =>
    riff([chunk("fmt ", fmt({ size: 18 })), chunk("data", randData(r, 32000))]),
  nonPcm: (r) =>
    riff([
      chunk("fmt ", fmt({ tag: pick(r, [0, 2, 3, 6, 7, 0x11, 0x55, 0xfffe, 0xffff]) })),
      chunk("data", randData(r, 32000)),
    ]),
  rateCh: (r) =>
    riff([
      chunk(
        "fmt ",
        fmt({
          rate: pick(r, [8000, 11025, 15999, 16001, 22050, 44100, 48000, 0, 0xffffffff]),
          ch: pick(r, [0, 1, 2, 6, 65535]),
          bits: pick(r, [8, 16, 24, 32, 0, 12]),
        })
      ),
      chunk("data", randData(r, 32000)),
    ]),
  badBrBa: (r) =>
    riff([
      chunk(
        "fmt ",
        fmt({
          br: pick(r, [0, 16000, 32001, 64000, 0xffffffff]),
          ba: pick(r, [0, 1, 3, 4, 65535]),
        })
      ),
      chunk("data", randData(r, 32000)),
    ]),
  extraChunk: (r) => {
    const id = pick(r, [
      "LIST",
      "id3 ",
      "ID3 ",
      "bext",
      "cue ",
      "JUNK",
      "fact",
      "PAD ",
      "iXML",
    ]);
    const extra = chunk(id, randData(r, ri(r, 0, 300)));
    const f = chunk("fmt ", fmt());
    const d = chunk("data", randData(r, 32000));
    return riff(
      pick(r, [
        [extra, f, d],
        [f, extra, d],
        [f, d, extra],
      ])
    );
  },
  twoFmt: (r) =>
    riff([
      chunk("fmt ", fmt()),
      chunk("fmt ", fmt({ rate: 48000 })),
      chunk("data", randData(r, 32000)),
    ]),
  twoData: (r) =>
    riff([
      chunk("fmt ", fmt()),
      chunk("data", randData(r, 16000)),
      chunk("data", randData(r, 16000)),
    ]),
  dataFirst: (r) => riff([chunk("data", randData(r, 32000)), chunk("fmt ", fmt())]),
  oddData: (r) => riff([chunk("fmt ", fmt()), chunk("data", randData(r, 32001))]),
  sizeLies: (r) => {
    const b = valid(r, 1);
    const v = new DataView(b.buffer);
    const at = pick(r, [4, 40, 16]);
    v.setUint32(
      at,
      pick(r, [
        0,
        1,
        0xffffffff,
        0x7fffffff,
        b.length,
        b.length - 7,
        b.length - 9,
        b.length - 43,
        b.length - 45,
        b.length * 2,
      ]) >>> 0,
      true
    );
    return b;
  },
  trailing: (r) => concat(valid(r, 1), randData(r, pick(r, [1, 2, 8, 1000]))),
  trailingFixedRiff: (r) => {
    const b = concat(valid(r, 1), randData(r, 2));
    new DataView(b.buffer).setUint32(4, b.length - 8, true);
    return b;
  },
  // RIFF and data sizes both cover the extra bytes: a genuinely canonical file — must be accepted.
  trailingBoth: (r) => {
    const b = concat(valid(r, 1), randData(r, 2));
    const v = new DataView(b.buffer);
    v.setUint32(4, b.length - 8, true);
    v.setUint32(40, b.length - 44, true);
    return b;
  },
  truncated: (r) => valid(r, 2).subarray(0, ri(r, 0, 64044)),
  flip: (r) => {
    const b = valid(r, pick(r, [0.5, 1, 2]));
    const k = ri(r, 1, 4);
    for (let i = 0; i < k; i++) b[ri(r, 0, 43)] ^= 1 << ri(r, 0, 7);
    return b;
  },
  // A data byte changed: still canonical unless the change lands in the header.
  flipAny: (r) => {
    const b = valid(r, 1);
    b[ri(r, 0, b.length - 1)] = ri(r, 0, 255);
    return b;
  },
  random: (r) => randData(r, ri(r, 0, 2000)),
  randomHdr: (r) => {
    const b = concat(oracleHeader(32000), randData(r, 32000));
    b[ri(r, 0, 43)] = ri(r, 0, 255);
    return b;
  },
  tooLong: (r) => valid(r, 60 + 1 / 16000),
  tooShort: (r) => valid(r, 0.4999),
  tooLarge: () => concat(oracleHeader(MAX - 44 + 2), new Uint8Array(MAX - 44 + 2)),
  empty: () => new Uint8Array(0),
  zeroData: () => oracleHeader(0),
  pooledBuffer: (r) => {
    const v = valid(r, 1);
    const big = new Uint8Array(v.length + 100);
    big.set(v, 37);
    return big.subarray(37, 37 + v.length);
  },
};

/** A PCM WAV of a sine tone (the classic 44-byte header; any rate, channels, 16 or 24 bits). */
export function pcmToneWav(o: {
  rate: number;
  channels: number;
  bits: 16 | 24;
  seconds: number;
  hz: number;
  amplitude?: number;
}): Uint8Array {
  const frames = Math.round(o.rate * o.seconds);
  const bytesPer = o.bits / 8;
  const dataBytes = frames * o.channels * bytesPer;
  const b = new Uint8Array(44 + dataBytes);
  const v = new DataView(b.buffer);
  ascii4(b, 0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii4(b, 8, "WAVE");
  ascii4(b, 12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, o.channels, true);
  v.setUint32(24, o.rate, true);
  v.setUint32(28, o.rate * o.channels * bytesPer, true);
  v.setUint16(32, o.channels * bytesPer, true);
  v.setUint16(34, o.bits, true);
  ascii4(b, 36, "data");
  v.setUint32(40, dataBytes, true);
  const amp = o.amplitude ?? 0.5;
  const full = o.bits === 16 ? 32767 : 8388607;
  let p = 44;
  for (let i = 0; i < frames; i++) {
    // An integer phase table keeps the samples identical on every engine for whole-hertz tones.
    const s = Math.round(
      amp * full * Math.sin((2 * Math.PI * ((i * o.hz) % o.rate)) / o.rate)
    );
    for (let c = 0; c < o.channels; c++) {
      if (o.bits === 16) {
        v.setInt16(p, s, true);
        p += 2;
      } else {
        const u = s < 0 ? s + 0x1000000 : s;
        b[p] = u & 0xff;
        b[p + 1] = (u >> 8) & 0xff;
        b[p + 2] = (u >> 16) & 0xff;
        p += 3;
      }
    }
  }
  return b;
}

/**
 * A duration-less WebM/Opus file of any length, as MediaRecorder writes it (live Matroska:
 * Segment and Clusters of unknown size, no Duration, no Cues), holding 20 ms Opus silence packets.
 */
export function webmOpusSilenceNoDuration(seconds: number): Uint8Array {
  const parts: Uint8Array[] = [];
  const u8 = (...b: number[]) => Uint8Array.from(b);
  const id = (hex: string) =>
    Uint8Array.from((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
  const size = (n: number) => {
    const b = new Uint8Array(8);
    b[0] = 0x01;
    let x = n;
    for (let i = 7; i >= 1; i--) {
      b[i] = x % 256;
      x = Math.floor(x / 256);
    }
    return b;
  };
  const UNKNOWN = u8(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
  const el = (hex: string, body: Uint8Array) => concat(id(hex), size(body.length), body);
  const uint = (hex: string, value: number) => {
    const b: number[] = [];
    let x = value;
    do {
      b.unshift(x & 0xff);
      x = Math.floor(x / 256);
    } while (x > 0);
    return el(hex, Uint8Array.from(b));
  };
  const str = (hex: string, s: string) => el(hex, new TextEncoder().encode(s));
  const f64 = (hex: string, value: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, value);
    return el(hex, b);
  };
  const opusHead = concat(
    new TextEncoder().encode("OpusHead"),
    u8(1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0)
  );
  parts.push(
    el(
      "1A45DFA3",
      concat(
        uint("4286", 1),
        uint("42F7", 1),
        uint("42F2", 4),
        uint("42F3", 8),
        str("4282", "webm"),
        uint("4287", 4),
        uint("4285", 2)
      )
    )
  );
  parts.push(id("18538067"), UNKNOWN);
  parts.push(
    el("1549A966", concat(uint("2AD7B1", 1000000), str("4D80", "t"), str("5741", "t")))
  );
  parts.push(
    el(
      "1654AE6B",
      el(
        "AE",
        concat(
          uint("D7", 1),
          uint("73C5", 1),
          uint("83", 2),
          str("86", "A_OPUS"),
          el("63A2", opusHead),
          el("E1", concat(f64("B5", 48000), uint("9F", 1)))
        )
      )
    )
  );
  // RFC 6716: config 31 (CELT, 20 ms), mono, one frame — decodes to silence.
  const frame = u8(0xf8, 0xff, 0xfe);
  const blocks = Math.round(seconds * 50);
  for (let c = 0; c * 500 < blocks; c++) {
    const inCluster = Math.min(500, blocks - c * 500);
    const body: Uint8Array[] = [uint("E7", c * 10000)];
    for (let k = 0; k < inCluster; k++) {
      body.push(el("A3", concat(u8(0x81, (k * 20) >> 8, (k * 20) & 0xff, 0x80), frame)));
    }
    parts.push(id("1F43B675"), UNKNOWN, concat(...body));
  }
  return concat(...parts);
}

/** 30 000 bytes from the seeded generator: no audio format starts this way. */
export function garbage(): Uint8Array {
  const rnd = seededRandom(0x0ddba11);
  return randData(rnd, 30000);
}

/** The generated fixtures by name (e2e/audio/expect.json and the README use these names). */
export const GENERATED_FIXTURES: Readonly<Record<string, () => Uint8Array>> = {
  "tone-44k-s16.wav": () =>
    pcmToneWav({ rate: 44100, channels: 2, bits: 16, seconds: 3, hz: 1234 }),
  "tone-48k-s24.wav": () =>
    pcmToneWav({ rate: 48000, channels: 2, bits: 24, seconds: 3, hz: 1234 }),
  "alias-12k.wav": () =>
    pcmToneWav({ rate: 48000, channels: 1, bits: 16, seconds: 3, hz: 12000 }),
  "tone-59s-48k-stereo.wav": () =>
    pcmToneWav({ rate: 48000, channels: 2, bits: 16, seconds: 59, hz: 1234 }),
  "nodur-30min.webm": () => webmOpusSilenceNoDuration(1800),
  "nodur-3s.webm": () => webmOpusSilenceNoDuration(3),
  "garbage.bin": () => garbage(),
  "empty.bin": () => new Uint8Array(0),
};

/**
 * A FLAC whose STREAMINFO lies about its length (CODE-REVIEW-A RA-1, -B RB-19): the first
 * `keepBytes` of an encoder-made FLAC, its declared total samples (36 bits at STREAMINFO bytes
 * 13–17) set to `declaredSamples`. The container then claims a short length while the stream holds
 * far more: the pre-decode probe believes it, and only the decoded length shows the truth.
 * ("Free Lossless Audio Codec", RFC 9639, M. Q. C. van Beurden, A. Weaver — the STREAMINFO layout.)
 */
export function lyingFlacLength(
  flac: Uint8Array,
  keepBytes: number,
  declaredSamples: number
): Uint8Array {
  // A copy, never a view: a Node Buffer's slice() shares memory, and the committed file must stay as it is.
  const out = new Uint8Array(keepBytes);
  out.set(flac.subarray(0, keepBytes));
  if (
    String.fromCharCode(out[0], out[1], out[2], out[3]) !== "fLaC" ||
    (out[4] & 0x7f) !== 0
  ) {
    throw new TypeError("not a FLAC that starts with its STREAMINFO block");
  }
  const at = 8; // "fLaC" + the 4-byte block header
  out[at + 13] = (out[at + 13] & 0xf0) | (Math.floor(declaredSamples / 2 ** 32) & 0x0f);
  new DataView(out.buffer, out.byteOffset).setUint32(at + 14, declaredSamples >>> 0);
  return out;
}

/** An EBML element ID at `i`: its bytes as hex and its width (the leading zero bits + 1). */
function ebmlId(b: Uint8Array, i: number): { hex: string; width: number } {
  let width = 1;
  while (width <= 4 && !(b[i] & (0x80 >> (width - 1)))) width++;
  if (width > 4 || i + width > b.length) throw new TypeError("not an EBML element ID");
  let hex = "";
  for (let k = 0; k < width; k++) hex += b[i + k].toString(16).padStart(2, "0");
  return { hex: hex.toUpperCase(), width };
}

/** An EBML size at `i`: its value, its width, and whether it is the "unknown size" mark. */
function ebmlSize(
  b: Uint8Array,
  i: number
): { value: number; width: number; unknown: boolean } {
  let width = 1;
  while (width <= 8 && !(b[i] & (0x80 >> (width - 1)))) width++;
  if (width > 8 || i + width > b.length) throw new TypeError("not an EBML size");
  let value = b[i] & (0xff >> width);
  let unknown = value === 0xff >> width;
  for (let k = 1; k < width; k++) {
    unknown = unknown && b[i + k] === 0xff;
    value = value * 256 + b[i + k];
  }
  return { value, width, unknown };
}

/**
 * A LONG duration-less WebM in the form a real recorder wrote (the gate's question after the
 * second Mac run: WebKit and Safari refuse the duration-less files webmOpusSilenceNoDuration
 * makes, yet measure Safari's own recording — what do they make of a long file in that form?).
 * `webm` is a live recording: an EBML header, a Segment of unknown size, Info without a Duration,
 * Tracks, then ONE Cluster of unknown size holding a Timecode and SimpleBlocks (and Cues after
 * it, which are dropped: their positions would be wrong). The result keeps everything before the
 * Cluster byte for byte and repeats the Cluster's blocks `copies` times, each copy a Cluster of
 * unknown size whose Timecode is `clusterMs` after the one before — so it holds
 * copies × clusterMs of the recording's own audio and still states no length anywhere.
 * Throws TypeError for any other layout. (RFC 9559, "Matroska Media Container Format
 * Specification", S. Lhomme, M. Bunkus, D. Rice — element IDs, sizes, unknown-size Clusters.)
 */
export function repeatedLiveWebm(
  webm: Uint8Array,
  copies: number,
  clusterMs: number
): Uint8Array {
  const b = webm;
  const no = (why: string) => new TypeError(`not a one-cluster live WebM: ${why}`);
  if (!Number.isInteger(copies) || copies < 1 || !Number.isInteger(clusterMs))
    throw no("copies and clusterMs must be whole numbers");
  if (clusterMs < 1 || copies * clusterMs > 0xffffffff) throw no("too long");
  const head = ebmlId(b, 0);
  if (head.hex !== "1A45DFA3") throw no("no EBML header");
  const headSize = ebmlSize(b, head.width);
  let i = head.width + headSize.width + headSize.value;
  const segment = ebmlId(b, i);
  const segmentSize = ebmlSize(b, i + segment.width);
  if (segment.hex !== "18538067" || !segmentSize.unknown)
    throw no("no Segment of unknown size");
  i += segment.width + segmentSize.width;
  // Segment children up to the Cluster; Info must not state a Duration.
  let clusterHeader = 0;
  for (;;) {
    if (i >= b.length) throw no("no Cluster");
    const id = ebmlId(b, i);
    const size = ebmlSize(b, i + id.width);
    if (id.hex === "1F43B675") {
      if (!size.unknown) throw no("its Cluster has a known size");
      clusterHeader = id.width + size.width;
      break;
    }
    if (size.unknown) throw no(`element ${id.hex} of unknown size before the Cluster`);
    const body = i + id.width + size.width;
    if (id.hex === "1549A966") {
      for (let k = body; k < body + size.value;) {
        const child = ebmlId(b, k);
        const childSize = ebmlSize(b, k + child.width);
        if (child.hex === "4489") throw no("it states a Duration");
        k += child.width + childSize.width + childSize.value;
      }
    }
    i = body + size.value;
  }
  const clusterAt = i;
  i += clusterHeader;
  const timecode = ebmlId(b, i);
  if (timecode.hex !== "E7") throw no("its Cluster does not start with a Timecode");
  const timecodeSize = ebmlSize(b, i + timecode.width);
  i += timecode.width + timecodeSize.width + timecodeSize.value;
  const blocksAt = i;
  let blocks = 0;
  while (i < b.length) {
    const id = ebmlId(b, i);
    if (id.width === 4) break; // a Segment-level element ends a Cluster of unknown size
    if (id.hex !== "A3") throw no(`element ${id.hex} in its Cluster`);
    const size = ebmlSize(b, i + id.width);
    i += id.width + size.width + size.value;
    blocks++;
  }
  if (i > b.length || blocks === 0) throw no("its Cluster holds no whole SimpleBlock");
  const blocksEnd = i;
  // What follows may only be Cues (to the end of the file): never a second Cluster.
  if (i < b.length) {
    const id = ebmlId(b, i);
    const size = ebmlSize(b, i + id.width);
    if (id.hex !== "1C53BB6B" || i + id.width + size.width + size.value !== b.length)
      throw no(`element ${id.hex} after its Cluster`);
  }
  const body = b.subarray(blocksAt, blocksEnd);
  const parts: Uint8Array[] = [b.slice(0, clusterAt)];
  for (let c = 0; c < copies; c++) {
    const t = c * clusterMs;
    parts.push(
      Uint8Array.from([
        0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      ]),
      Uint8Array.from([
        0xe7,
        0x84,
        t >>> 24,
        (t >>> 16) & 0xff,
        (t >>> 8) & 0xff,
        t & 0xff,
      ]),
      body
    );
  }
  return concat(...parts);
}

/** Fixtures made from a committed one (by name), as the gate's server builds them. */
export const DERIVED_FIXTURES: Readonly<
  Record<string, (committed: Readonly<Record<string, Uint8Array>>) => Uint8Array>
> = {
  // 110 000 bytes of the 1-hour silence (about 575 s of audio) declaring 10 s (160 000 samples).
  "lying-length.flac": (c) => lyingFlacLength(c["bomb-1h.flac"], 110000, 160000),
  // Safari's own recording (one Cluster of 1604 blocks of 2.5 ms: 4.01 s) 20 times over: 80.2 s
  // in a duration-less WebM of the form a real recorder wrote (about 2.1 MB).
  "nodur-80s-safari-form.webm": (c) =>
    repeatedLiveWebm(c["safari-26.6.2-webm.webm"], 20, 4010),
};
