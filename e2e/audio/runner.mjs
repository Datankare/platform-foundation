/**
 * e2e/audio/runner.mjs — the browser-audio gate's in-page logic (TASK-234; DESIGN-56f1 §9)
 *
 * Runs in the page e2e/audio/serve.mjs serves, in every engine (Playwright's Chromium, Firefox
 * and WebKit, and real Safari through safaridriver), after a click on Start (the gesture audio
 * needs). It uses the SHIPPED modules (served by serve.mjs) and reports facts; the
 * comparison with e2e/audio/expect.json is e2e/audio/compare.mjs's, in Node.
 *
 * 1. The audio clock: an AudioContext must be running and its currentTime advancing, else the
 *    run reports "audio clock not running" (a runner without an audio device), never a table
 *    mismatch.
 * 2. detectAudioSupport(), MediaRecorder.isTypeSupported for each table type, the product's own
 *    pickRecorderType().
 * 3. Every case of the table converted by toCanonicalWav, counting decodeAudioData calls (a spy),
 *    and the result analysed: a genuine canonical WAV, its length, its peak frequency (tone), its
 *    level (alias, silence), and text that must be absent (tags). Every result names the STEP
 *    that ended it (`stage`: the product's own BrowserAudioError.stage, or "done") and what the
 *    pre-decode probe answered (`probe`: known via metadata or the seek probe, unknown, or
 *    unreadable with the media element's error code, and the type the element was told), so a
 *    refusal in 2 ms is never ambiguous.
 *    A case with a `pickerType` runs twice: as fetched here (a Blob with NO type — what drag and
 *    drop and some pickers give) into `files`, and typed as a file picker would type it into
 *    `filesTyped`. Both must hold the same cell: the product names the container from the
 *    file's bytes, never from the declared type.
 * 4. Two recordings of a 1234 Hz oscillator (no microphone) with the shipped startRecording:
 *    the product's default type and "audio/mp4", each converted as a recording.
 * 5. Diagnostics (the table's `diagnostics`; reported, never asserted beyond being present): for
 *    each listed file, what a bare media element does with it untyped, typed
 *    application/octet-stream (as the first Mac run's files were) and typed as a picker types
 *    it — the product's own probeDuration and an event trace with the element's error code and
 *    message — and,
 *    where the table asks, whether decodeAudioData alone decodes it. This is what tells an
 *    artefact of this harness from a fact about the engine.
 * Times are reported for information only; nothing asserts them.
 */

// The served copies of the shipped modules (serve.mjs transpiles platform/voice/*.ts to these
// URLs; the page's import map sends the modules' own "@/platform/voice/…" imports to the same
// URLs, so each module is loaded once).
import { detectAudioSupport, probeDuration, toCanonicalWav } from "./m/browser-audio.js";
import { pickRecorderType, startRecording } from "./m/browser-recorder.js";
import { checkCanonicalWav } from "./m/canonical-wav.js";

const RATE = 16000;
const TABLE_RECORDER_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Goertzel power of `f` Hz over x[0..n). */
function goertzel(x, n, f) {
  const coeff = 2 * Math.cos((2 * Math.PI * f) / RATE);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** The converted WAV's samples (as floats), level, peak frequency near the tone and its share. */
function analyse(bytes) {
  const n = (bytes.length - 44) >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset + 44, n * 2);
  const x = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    x[i] = view.getInt16(i * 2, true) / 32768;
    sum += x[i] * x[i];
  }
  const rms = n ? Math.sqrt(sum / n) : 0;
  // One second from 0.25 s in (past any codec priming), or what there is.
  const start = Math.min(4000, Math.max(0, n - RATE));
  const w = x.subarray(start, start + Math.min(RATE, n - start));
  let best = 0;
  let bestHz = 0;
  for (let f = 1100; f <= 1370; f += 0.5) {
    const p = goertzel(w, w.length, f);
    if (p > best) {
      best = p;
      bestHz = f;
    }
  }
  let wSum = 0;
  for (let i = 0; i < w.length; i++) wSum += w[i] * w[i];
  const amp = w.length ? (2 * Math.sqrt(best)) / w.length : 0;
  const toneShare = wSum > 0 ? (amp * amp) / 2 / (wSum / w.length) : 0;
  return { rms, peakHz: bestHz, toneShare: Math.round(toneShare * 1000) / 1000 };
}

function latin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return s;
}

function base64(bytes) {
  return btoa(latin1(bytes));
}

function describe(wav, absent) {
  const bytes = wav.copyBytes();
  const check = checkCanonicalWav(bytes, {
    maxBytes: 4194304,
    minSeconds: 1e-6,
    maxSeconds: 1e6,
  });
  const text = latin1(bytes);
  return {
    canonical: check.ok === true,
    ...analyse(bytes),
    present: (absent ?? []).filter((t) => text.includes(t)),
  };
}

function installDecodeSpy() {
  const counter = { decodes: 0 };
  const protos = [
    globalThis.BaseAudioContext?.prototype,
    globalThis.OfflineAudioContext?.prototype,
  ];
  for (const proto of protos) {
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, "decodeAudioData"))
      continue;
    const original = proto.decodeAudioData;
    proto.decodeAudioData = function (...args) {
      counter.decodes++;
      return original.apply(this, args);
    };
  }
  return counter;
}

async function fixtureBlob(base, fixture) {
  const zeros = /^@zeros:(\d+)$/.exec(fixture);
  if (zeros) return new Blob([new Uint8Array(Number(zeros[1]))]);
  const res = await fetch(`${base}fx/${fixture}`);
  if (!res.ok) throw new Error(`fixture ${fixture}: HTTP ${res.status}`);
  // A Blob with NO type. `res.blob()` would carry the response's Content-Type
  // (application/octet-stream) — the first Mac run's files were typed that way, which is what
  // its probe's media element was told.
  return new Blob([await res.arrayBuffer()]);
}

/** The product's own probe, with how long it took and the type its element was told. */
async function timedProbe(blob, o) {
  const t0 = performance.now();
  const r = await probeDuration(blob, o);
  return { ...r, typeGiven: blob.type, ms: Math.round(performance.now() - t0) };
}

async function convert(blob, options, spy, absent) {
  const before = spy.decodes;
  const t0 = performance.now();
  // The product's real probe, observed: what it answered is part of the result.
  let probe = null;
  const deps = {
    probe: async (typed, o) => {
      probe = await timedProbe(typed, o);
      const { typeGiven: _t, ms: _m, ...answer } = probe;
      return answer;
    },
  };
  try {
    const r = await toCanonicalWav(blob, options, deps);
    return {
      ok: true,
      stage: "done",
      declaredType: blob.type,
      probe,
      decodes: spy.decodes - before,
      seconds: r.seconds,
      decodedSeconds: r.decodedSeconds,
      trimmed: r.trimmed,
      ms: Math.round(performance.now() - t0),
      ...describe(r.wav, absent),
    };
  } catch (e) {
    return {
      ok: false,
      code: e && e.code ? e.code : `threw: ${e && e.name}: ${e && e.message}`,
      stage: e && e.stage ? e.stage : null,
      declaredType: blob.type,
      probe,
      decodes: spy.decodes - before,
      ms: Math.round(performance.now() - t0),
    };
  }
}

/**
 * What a bare media element does with `blob`, event by event (diagnosis only; the product's
 * probe is probeDuration): the same steps — metadata, then a seek far past the end when the
 * duration is not finite — with every event's time and duration, and the element's error.
 */
function trace(blob, timeoutMs) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.muted = true;
    const t0 = performance.now();
    const events = [];
    let done = false;
    const note = (name) =>
      events.push({
        event: name,
        ms: Math.round(performance.now() - t0),
        duration: Number.isFinite(audio.duration)
          ? audio.duration
          : String(audio.duration),
      });
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const error = audio.error
        ? { code: audio.error.code, message: String(audio.error.message ?? "") }
        : null;
      for (const name of NAMES) audio.removeEventListener(name, handlers[name]);
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      resolve({ typeGiven: blob.type, outcome, error, events });
    };
    const NAMES = ["loadstart", "loadedmetadata", "durationchange", "seeked", "error"];
    const handlers = {};
    for (const name of NAMES) {
      handlers[name] = () => {
        if (done) return;
        note(name);
        if (name === "error") return finish("error");
        if (Number.isFinite(audio.duration) && name !== "loadstart")
          return finish("finite duration");
        if (name === "loadedmetadata") audio.currentTime = 1e101;
      };
      audio.addEventListener(name, handlers[name]);
    }
    const timer = setTimeout(() => finish("no answer within the budget"), timeoutMs);
    audio.src = url;
  });
}

/** Whether decodeAudioData alone (no probe, no limits) decodes `blob`: small files only. */
async function rawDecode(blob) {
  try {
    const ctx = new OfflineAudioContext(1, 1, RATE);
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    return { ok: true, seconds: decoded.length / decoded.sampleRate };
  } catch (e) {
    return { ok: false, error: `${e && e.name}: ${e && e.message}` };
  }
}

/** The type the first Mac run's files carried (the gate server's Content-Type). */
const FIRST_RUN_TYPE = "application/octet-stream";

async function diagnose(blob, d, timeoutMs) {
  const o = { timeoutMs };
  const one = async (b) => ({
    probe: await timedProbe(b, o),
    trace: await trace(b, timeoutMs),
  });
  return {
    untyped: await one(blob),
    asFirstRun: await one(new Blob([blob], { type: FIRST_RUN_TYPE })),
    typed: await one(new Blob([blob], { type: d.pickerType })),
    ...(d.rawDecode ? { rawDecode: await rawDecode(blob) } : {}),
  };
}

async function record(ctx, mimeType, seconds, spy) {
  const osc = ctx.createOscillator();
  osc.frequency.value = 1234;
  const gain = ctx.createGain();
  gain.gain.value = 0.5;
  const dst = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dst);
  osc.start();
  try {
    const rec = startRecording(dst.stream, { mimeType, maxSeconds: seconds });
    const blob = await rec.result;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const converted = await convert(
      blob,
      { source: "recording", maxSeconds: seconds, minSeconds: 1 },
      spy
    );
    return {
      mimeType: blob.type,
      bytes: bytes.length,
      base64: base64(bytes),
      ...converted,
    };
  } catch (e) {
    return {
      ok: false,
      code: e && e.code ? e.code : `threw: ${e && e.name}: ${e && e.message}`,
    };
  } finally {
    osc.stop();
    osc.disconnect();
    gain.disconnect();
  }
}

/** The whole gate run; resolves the facts compare.mjs checks. */
export async function runGate({ base }) {
  const table = await (await fetch(`${base}expect.json`)).json();
  const out = {
    userAgent: navigator.userAgent,
    clock: {},
    files: {},
    filesTyped: {},
    recordings: {},
    diagnostics: {},
  };

  const Ctx = globalThis.AudioContext;
  if (typeof Ctx !== "function")
    return { ...out, fatal: "audio clock not running: no AudioContext" };
  const ctx = new Ctx();
  try {
    await Promise.race([ctx.resume(), wait(5000)]);
    const t0 = ctx.currentTime;
    await wait(400);
    out.clock = { state: ctx.state, advanced: ctx.currentTime > t0 };
    if (ctx.state !== "running" || !out.clock.advanced) {
      return {
        ...out,
        fatal: `audio clock not running (state ${ctx.state}, currentTime ${ctx.currentTime})`,
      };
    }

    const spy = installDecodeSpy();
    out.detect = detectAudioSupport();
    const MR = globalThis.MediaRecorder;
    out.recorderTypes = Object.fromEntries(
      TABLE_RECORDER_TYPES.map((t) => [
        t,
        typeof MR === "function" && MR.isTypeSupported(t) === true,
      ])
    );
    out.productRecorderType = pickRecorderType();

    for (const [name, c] of Object.entries(table.cases)) {
      const blob = await fixtureBlob(base, c.fixture);
      const options = {
        source: c.source,
        maxSeconds: c.maxSeconds,
        minSeconds: c.minSeconds,
        ...(c.source === "upload" ? { probeTimeoutMs: table.probeTimeoutMs } : {}),
      };
      out.files[name] = await convert(blob, options, spy, c.absent);
      if (c.pickerType) {
        out.filesTyped[name] = await convert(
          new Blob([blob], { type: c.pickerType }),
          options,
          spy,
          c.absent
        );
      }
    }

    const seconds = table.recordingSeconds;
    out.recordings.default = out.productRecorderType
      ? await record(ctx, out.productRecorderType, seconds, spy)
      : { unsupported: true };
    out.recordings["audio/mp4"] = out.recorderTypes["audio/mp4"]
      ? await record(ctx, "audio/mp4", seconds, spy)
      : { unsupported: true };

    const diagnostics = table.diagnostics ?? { files: {} };
    for (const [fixture, d] of Object.entries(diagnostics.files)) {
      out.diagnostics[fixture] = await diagnose(
        await fixtureBlob(base, fixture),
        d,
        diagnostics.probeTimeoutMs
      );
    }
    return out;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}
