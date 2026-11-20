/**
 * e2e/audio/__tests__/browser-audio-gate.test.ts — the gate's own tools, without a browser
 * (TASK-234; DESIGN-56f1 §9, tests T21 and T22). Platform Foundation only: e2e/ is not synced.
 *
 * - compare.mjs asserts every cell: a flipped cell, a missing cell, an engine recording none of
 *   the product's types, or a run without a running audio clock each fail with their reason;
 * - expect.json: every engine has a cell for every case, and the cells are of the known forms;
 * - safari-check.mjs where safaridriver is absent exits 1 ("it never skips"); a Safari older than
 *   18.4 is refused; recordings are named by type;
 * - serve.mjs serves only under /audio-gate/, the shipped modules transpiled, and refuses --lan
 *   without a certificate (a LAN page over http has no microphone API).
 * The modules are ES modules, so each case runs them in a child `node`.
 *
 * @not-guard: tests the gate's own tools against its committed expectation table
 */

import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DIR = "e2e/audio";
const table = JSON.parse(readFileSync(join(DIR, "expect.json"), "utf8"));

/** Runs an ES-module snippet in a child node; returns its JSON output. */
function esm(code: string): unknown {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  return JSON.parse(out);
}

const CONTAINER_TYPE: Record<string, string> = {
  webm: "audio/webm",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  wav: "audio/wav",
};

type FileResult = Record<string, unknown>;
type RunResult = {
  recorderTypes: Record<string, boolean>;
  productRecorderType: string | null;
  detect: { music: boolean; upload: boolean; missing: string[] };
  files: Record<string, FileResult>;
  filesTyped: Record<string, FileResult>;
  recordings: Record<string, Record<string, unknown>>;
  diagnostics: Record<string, Record<string, unknown>>;
};

/** One case's result that satisfies `cell`, declared as `declaredType`. */
function passingFile(name: string, cell: string, declaredType: string): FileResult {
  const c = table.cases[name];
  const typeGiven = CONTAINER_TYPE[String(c.fixture).split(".").pop() ?? ""];
  const known = { status: "known", seconds: 3, via: "metadata", typeGiven, ms: 3 };
  if (cell === "bounded-by-declared-length")
    return {
      ok: true,
      stage: "done",
      declaredType,
      probe: { ...known, seconds: c.declaredSeconds + 0.008 },
      decodes: 1,
      canonical: true,
      seconds: c.declaredSeconds,
      decodedSeconds: c.declaredSeconds,
      peakHz: 0,
      toneShare: 0,
      rms: 0,
      present: [],
    };
  const after = /^refused-after-decode:([a-z_]+)/.exec(cell);
  if (after)
    return {
      ok: false,
      code: after[1],
      stage: "length",
      declaredType,
      probe: known,
      decodes: 1,
    };
  const refused = /^refused:([a-z_]+)@([a-z]+):0-decodes$/.exec(cell);
  if (refused)
    return {
      ok: false,
      code: refused[1],
      stage: refused[2],
      declaredType,
      probe:
        refused[2] !== "probe"
          ? null
          : refused[1] === "too_long"
            ? { ...known, seconds: 3600 }
            : {
                status: "unreadable",
                phase: "metadata",
                mediaErrorCode: 4,
                typeGiven,
                ms: 2,
              },
      decodes: 0,
    };
  return {
    ok: true,
    stage: "done",
    declaredType,
    probe: c.source === "upload" ? known : null,
    decodes: 1,
    canonical: true,
    seconds: c.seconds,
    peakHz: c.check === "tone" ? 1234 : 0,
    toneShare: c.check === "tone" ? 0.99 : 0,
    rms: c.check === "tone" ? 0.3 : 0,
    present: [],
  };
}

/** A run result that satisfies `engine`'s column exactly. */
function passingResult(engine: string): RunResult {
  const col = table.engines[engine];
  const files: Record<string, FileResult> = {};
  const filesTyped: Record<string, FileResult> = {};
  for (const [name, cell] of Object.entries<string>(col.files)) {
    const c = table.cases[name];
    files[name] = passingFile(name, cell, "");
    if (c.pickerType) filesTyped[name] = passingFile(name, cell, c.pickerType);
  }
  const recording = {
    ok: true,
    canonical: true,
    seconds: table.recordingSeconds - 0.04,
    peakHz: 1234,
    toneShare: 0.98,
  };
  const one = { probe: { status: "known" }, trace: { outcome: "finite duration" } };
  return {
    recorderTypes: { ...col.recorderTypes },
    productRecorderType: "audio/webm;codecs=opus",
    detect: { ...col.detect, missing: [] },
    files,
    filesTyped,
    recordings: {
      default: { ...recording, mimeType: col.recordedAs.default },
      "audio/mp4":
        col.recordings["audio/mp4"] === "valid"
          ? { ...recording, mimeType: col.recordedAs["audio/mp4"] }
          : { unsupported: true },
    },
    diagnostics: Object.fromEntries(
      Object.entries<{ rawDecode?: boolean }>(table.diagnostics.files).map(([f, d]) => [
        f,
        {
          untyped: one,
          asFirstRun: one,
          typed: one,
          ...(d.rawDecode ? { rawDecode: { ok: true, seconds: 3 } } : {}),
        },
      ])
    ),
  };
}

function compare(engine: string, result: unknown, t: unknown = table): string[] {
  return esm(
    `import { compare } from "./${DIR}/compare.mjs";
     const [t, e, r] = ${JSON.stringify([t, engine, result])};
     console.log(JSON.stringify(compare(t, e, r)));`
  ) as string[];
}

describe("compare.mjs asserts every cell (T21)", () => {
  it.each(Object.keys(table.engines))("a run matching the %s column passes", (engine) => {
    expect(compare(engine, passingResult(engine))).toEqual([]);
  });

  it("a flipped cell fails: tone.m4a expected refused", () => {
    const t = structuredClone(table);
    t.engines.chromium.files["tone.m4a"] = "refused:undecodable@probe:0-decodes";
    expect(compare("chromium", passingResult("chromium"), t)).toEqual([
      "tone.m4a: expected refused undecodable, but it converted",
      "tone.m4a: expected 0 decodes, got 1",
      "tone.m4a (typed audio/mp4): expected refused undecodable, but it converted",
      "tone.m4a (typed audio/mp4): expected 0 decodes, got 1",
    ]);
  });

  it("RA-1: a lying-length file must end refused (too_long or out_of_memory) — accepted or another code fails", () => {
    const ok = passingResult("chromium");
    Object.assign(ok.files["lying-length.flac"], {
      code: "out_of_memory",
      stage: "decode",
    });
    expect(compare("chromium", ok)).toEqual([]);
    const accepted = passingResult("chromium");
    accepted.files["lying-length.flac"] = {
      ok: true,
      decodes: 1,
      canonical: true,
      seconds: 60,
      declaredType: "",
      probe: accepted.files["lying-length.flac"].probe,
    };
    expect(compare("chromium", accepted)).toEqual([
      "lying-length.flac: expected refused (too_long or out_of_memory), but it converted",
    ]);
    const other = passingResult("chromium");
    Object.assign(other.files["lying-length.flac"], {
      code: "threw: TypeError: x",
      stage: null,
    });
    expect(compare("chromium", other)).toEqual([
      "lying-length.flac: expected too_long or out_of_memory, got threw: TypeError: x at an unnamed step (probe: 3 s via metadata, told audio/flac)",
    ]);
  });

  it("a refusal that decoded first fails (the bomb must be refused by the probe)", () => {
    const r = passingResult("chromium");
    (r.files["bomb-1h.flac"] as { decodes: number }).decodes = 1;
    expect(compare("chromium", r)).toEqual(["bomb-1h.flac: expected 0 decodes, got 1"]);
  });

  it("R3: a refusal names its step — the right code at another step fails, with what the probe answered", () => {
    const r = passingResult("safari");
    // The first Mac run's ambiguity: "undecodable, 0 decodes, 2 ms" — at the probe, or before it?
    Object.assign(r.files["garbage.bin"], {
      stage: "probe",
      probe: {
        status: "unreadable",
        phase: "metadata",
        mediaErrorCode: 4,
        typeGiven: "audio/mpeg",
      },
    });
    Object.assign(r.files["bomb-1h.flac"], {
      code: "undecodable",
      probe: {
        status: "unreadable",
        phase: "seek-probe",
        mediaErrorCode: 3,
        typeGiven: "",
      },
    });
    Object.assign(r.files["nodur-3s.webm"], {
      code: "unmeasurable",
      probe: { status: "unknown", phase: "seek-probe", typeGiven: "audio/webm" },
    });
    Object.assign(r.files["empty.bin"], { stage: undefined });
    expect(compare("safari", r).sort()).toEqual(
      [
        "garbage.bin: expected refused at container, got undecodable at probe (probe: media error 4 during metadata, told audio/mpeg)",
        'garbage.bin: the probe was told "audio/mpeg" for the untyped file and "undefined" for the typed one (the declared type must not matter)',
        "bomb-1h.flac: expected refused too_long, got undecodable at probe (probe: media error 3 during seek-probe, told no type)",
        'bomb-1h.flac: the probe was told "" for the untyped file and "audio/flac" for the typed one (the declared type must not matter)',
        "nodur-3s.webm: expected refused undecodable, got unmeasurable at probe (probe: no answer during seek-probe, told audio/webm)",
        "empty.bin: expected refused at input, got empty at an unnamed step",
      ].sort()
    );
  });

  it("R3: a refusal after the decode must end at the decode or the length check, after one decode at most", () => {
    const r = passingResult("webkit");
    const name = "tone-fmp4-60s.m4a, max 59";
    expect(table.engines.webkit.files[name]).toBe("refused-after-decode:too_long");
    expect(table.engines.chromium.files[name]).toBe("refused:too_long@probe:0-decodes");
    Object.assign(r.files[name], { stage: "probe", decodes: 0 });
    Object.assign(r.filesTyped[name], { decodes: 2 });
    expect(compare("webkit", r)).toEqual([
      `${name}: expected to end at the decode or the length check, got too_long at probe (probe: 3 s via metadata, told audio/mp4)`,
      `${name} (typed audio/mp4): expected at most 1 decode, got 2`,
    ]);
  });

  it("R3: an upload that decodes must have had its length known from the probe; a recording is never probed", () => {
    const r = passingResult("chromium");
    r.files["tone.mp3"].probe = null;
    r.filesTyped["tone.flac"].probe = { status: "unknown", phase: "metadata" };
    r.files["tone.webm"].stage = undefined;
    const rec = "safari-26.6.2-webm.webm as a recording, max 4";
    r.files[rec].probe = { status: "known", seconds: 4, via: "metadata", typeGiven: "" };
    expect(compare("chromium", r).sort()).toEqual(
      [
        "tone.mp3: decoded without its length known from the probe first",
        'tone.mp3: the probe was told "undefined" for the untyped file and "audio/mpeg" for the typed one (the declared type must not matter)',
        "tone.flac (typed audio/flac): decoded without its length known from the probe first",
        'tone.flac: the probe was told "audio/flac" for the untyped file and "undefined" for the typed one (the declared type must not matter)',
        'tone.webm: converted, but the run names no "done" step',
        `${rec}: a recording was probed (it is bounded by its own timer)`,
      ].sort()
    );
  });

  it("R4: a live recording that was probed fails (recording in the page never depends on the probe)", () => {
    const r = passingResult("safari");
    (r.recordings.default as Record<string, unknown>).probe = {
      status: "known",
      seconds: 4,
      via: "seek-probe",
      typeGiven: "audio/webm",
    };
    expect(compare("safari", r)).toEqual([
      "recording default: it was probed (a recording is bounded by its own timer)",
    ]);
    (r.recordings.default as Record<string, unknown>).probe = null;
    expect(compare("safari", r)).toEqual([]);
  });

  it("R3: a case with a pickerType needs both runs, declared as the table says", () => {
    const r = passingResult("firefox");
    delete r.filesTyped["tone.mp3"];
    r.filesTyped["tone.flac"].declaredType = "";
    r.files["tone-opus.ogg"].declaredType = "application/octet-stream";
    expect(compare("firefox", r).sort()).toEqual(
      [
        "tone.mp3 (typed audio/mpeg): no result from the run",
        'tone.flac (typed audio/flac): the run declared ""',
        'tone-opus.ogg: the untyped run declared "application/octet-stream"',
      ].sort()
    );
    expect(
      compare("firefox", { ...passingResult("firefox"), filesTyped: undefined })
    ).toHaveLength(
      Object.values<{ pickerType?: string }>(table.cases).filter((c) => c.pickerType)
        .length
    );
  });

  it("R3: fragmented MP4 has its measured tolerance in WebKit and Safari only", () => {
    const name = "tone-fmp4-20s.m4a as a recording, max 20";
    for (const engine of ["webkit", "safari"]) {
      const r = passingResult(engine);
      r.files[name].seconds = 19.990875;
      expect(compare(engine, r)).toEqual([]);
      r.files[name].seconds = 19.94;
      expect(compare(engine, r)).toEqual([
        `${name}: length 19.94 s, expected 20 ± 0.05 s`,
      ]);
    }
    const r = passingResult("chromium");
    r.files[name].seconds = 19.990875;
    expect(compare("chromium", r)).toEqual([
      `${name}: length 19.990875 s, expected 20 ± 0 s`,
    ]);
    // A result with no length at all must not pass by comparing as "not greater".
    delete r.files[name].seconds;
    expect(compare("chromium", r)).toEqual([
      `${name}: length undefined s, expected 20 ± 0 s`,
    ]);
  });

  it("R3: each recording carries the type the column says (spaces ignored)", () => {
    const r = passingResult("safari");
    r.recordings.default.mimeType = "audio/webm; codecs=opus";
    r.recordings["audio/mp4"].mimeType = "audio/mp4; codecs=opus";
    expect(compare("safari", r)).toEqual([
      'recording audio/mp4: recorded as "audio/mp4; codecs=opus", expected "audio/mp4;codecs=mp4a.40.2"',
    ]);
    const t = structuredClone(table);
    delete t.engines.safari.recordedAs["audio/mp4"];
    t.engines.firefox.recordedAs["audio/mp4"] = "audio/mp4";
    expect(compare("safari", passingResult("safari"), t)).toEqual([
      'recording audio/mp4: the "safari" column does not say what type it records as',
    ]);
    expect(compare("firefox", passingResult("firefox"), t)).toEqual([
      "recording audio/mp4: a recorded type for a recording that is not expected",
    ]);
  });

  it("R3: every listed diagnostic must be reported in full (its content is not asserted)", () => {
    const r = passingResult("safari");
    delete r.diagnostics["tone.mp3"];
    delete r.diagnostics["tone.flac"].asFirstRun;
    delete r.diagnostics["nodur-3s.webm"].rawDecode;
    r.diagnostics["bomb-1h.flac"].typed = { probe: { status: "unreadable" } };
    r.diagnostics["tone.webm"].untyped = {
      probe: { status: "unreadable", mediaErrorCode: 4 },
      trace: { outcome: "error", error: { code: 4, message: "Unsupported" } },
    };
    expect(compare("safari", r)).toEqual([
      "diagnostics tone.mp3: the run did not report it in full",
      "diagnostics tone.flac: the run did not report it in full",
      "diagnostics bomb-1h.flac: the run did not report it in full",
      "diagnostics nodur-3s.webm: the run did not report it in full",
    ]);
  });

  it("R3: a refused cell must name a step before decoding", () => {
    const t = structuredClone(table);
    t.engines.chromium.files["garbage.bin"] = "refused:undecodable@decode:0-decodes";
    t.engines.chromium.files["empty.bin"] = "refused:empty:0-decodes";
    expect(compare("chromium", passingResult("chromium"), t).sort()).toEqual(
      [
        'garbage.bin: unknown cell "refused:undecodable@decode:0-decodes" (a step before decoding: input, container, probe)',
        'garbage.bin (typed audio/mpeg): unknown cell "refused:undecodable@decode:0-decodes" (a step before decoding: input, container, probe)',
        'empty.bin: unknown cell "refused:empty:0-decodes"',
      ].sort()
    );
  });

  it("an engine recording none of the product's types fails", () => {
    const r = { ...passingResult("chromium"), productRecorderType: null };
    expect(compare("chromium", r)).toEqual([
      "this engine records none of the product's RECORDER_TYPES",
    ]);
  });

  it("a cell missing from a column, or a cell for an unknown case, fails", () => {
    const t = structuredClone(table);
    delete t.engines.firefox.files["tone.mp3"];
    t.engines.firefox.files["ghost.wav"] = "decodes";
    expect(compare("firefox", passingResult("firefox"), t).sort()).toEqual([
      "ghost.wav: a cell for a case the table does not define",
      'tone.mp3: the "firefox" column has no cell',
    ]);
  });

  it("length, tone, tags, recording length and detection each fail with their reason", () => {
    const r = passingResult("chromium");
    (r.files["tone.webm"] as { seconds: number }).seconds = 2.9;
    (r.files["tone.flac"] as { peakHz: number }).peakHz = 1240;
    (r.files["tagged.webm"] as { present: string[] }).present = ["SECRETTITLE"];
    (r.files["alias-12k.wav"] as { rms: number }).rms = 0.01;
    (r.recordings.default as { seconds: number }).seconds = 4.2;
    r.detect.upload = false;
    expect(compare("chromium", r).sort()).toEqual(
      [
        "alias-12k.wav: RMS 0.01, expected under 0.001 (alias)",
        "detect upload: expected true, got false (missing: )",
        'tagged.webm: "SECRETTITLE" reached the WAV',
        "tone.flac: peak 1240 Hz, expected 1234 ± 4 Hz",
        "tone.webm: length 2.9 s, expected 3 ± 0.05 s",
        "recording default: length 4.2 s, expected within [3.5, 4]",
      ].sort()
    );
  });

  it("a run without a running audio clock reports exactly that, not a table mismatch", () => {
    expect(
      compare("webkit", { fatal: "audio clock not running (state suspended)" })
    ).toEqual(["audio clock not running (state suspended)"]);
  });

  it("an unknown engine column fails", () => {
    expect(compare("opera", passingResult("chromium"))).toEqual([
      'the table has no column "opera"',
    ]);
  });
});

describe("compare.mjs: a file whose container lies about its length (R4; ADR-061 D4)", () => {
  it("R4: Firefox's cell for the lying-length file names the codes it may end in — undecodable (seen), too_long, out_of_memory — and nothing else", () => {
    expect(table.engines.firefox.files["lying-length.flac"]).toBe(
      "refused-after-decode:undecodable|too_long|out_of_memory"
    );
    // What run b56f1r3-mac-pf-1 saw: undecodable at the decode, one decode, the probe at 10 s.
    const seen = passingResult("firefox");
    for (const set of [seen.files, seen.filesTyped])
      Object.assign(set["lying-length.flac"], {
        code: "undecodable",
        stage: "decode",
        probe: { status: "known", seconds: 10, via: "metadata", typeGiven: "audio/flac" },
      });
    expect(compare("firefox", seen)).toEqual([]);
    for (const code of ["too_long", "out_of_memory"]) {
      const r = passingResult("firefox");
      Object.assign(r.files["lying-length.flac"], { code, stage: "length" });
      expect(compare("firefox", r)).toEqual([]);
    }
    // The same outcome is NOT accepted where the column does not name it (Chromium decodes it all).
    const chromium = passingResult("chromium");
    Object.assign(chromium.files["lying-length.flac"], {
      code: "undecodable",
      stage: "decode",
    });
    expect(compare("chromium", chromium)).toEqual([
      "lying-length.flac: expected too_long or out_of_memory, got undecodable at decode (probe: 3 s via metadata, told audio/flac)",
    ]);
    // Another error, a refusal before the decode, a second decode, or a conversion each fail.
    const r = passingResult("firefox");
    Object.assign(r.files["lying-length.flac"], { code: "read_failed", stage: "read" });
    Object.assign(r.filesTyped["lying-length.flac"], {
      code: "undecodable",
      stage: "probe",
      decodes: 2,
    });
    expect(compare("firefox", r)).toEqual([
      "lying-length.flac: expected undecodable or too_long or out_of_memory, got read_failed at read (probe: 3 s via metadata, told audio/flac)",
      "lying-length.flac (typed audio/flac): expected to end at the decode or the length check, got undecodable at probe (probe: 3 s via metadata, told audio/flac)",
      "lying-length.flac (typed audio/flac): expected at most 1 decode, got 2",
    ]);
    const converted = passingResult("firefox");
    converted.files["lying-length.flac"] = passingFile(
      "lying-length.flac",
      "bounded-by-declared-length",
      ""
    );
    expect(compare("firefox", converted)).toEqual([
      "lying-length.flac: expected refused (undecodable or too_long or out_of_memory), but it converted",
    ]);
  });

  describe("R4: bounded-by-declared-length — a lying file may convert only to the length it declares (ADR-061 D4)", () => {
    const name = "lying-length.flac";
    const typed = `${name} (typed audio/flac)`;
    const run = (change: (r: FileResult) => void, engine = "safari") => {
      const r = passingResult(engine);
      change(r.files[name]);
      return compare(engine, r);
    };

    it("is the cell of WebKit and Safari, on a case that declares 10 s, holds more, and has a limit of 60 s", () => {
      for (const e of ["webkit", "safari"])
        expect(table.engines[e].files[name]).toBe("bounded-by-declared-length");
      expect(table.engines.chromium.files[name]).toBe(
        "refused-after-decode:too_long|out_of_memory"
      );
      expect(table.cases[name]).toEqual({
        fixture: "lying-length.flac",
        source: "upload",
        maxSeconds: 60,
        minSeconds: 0.5,
        pickerType: "audio/flac",
        declaredSeconds: 10,
        declaredWithin: 0.05,
        check: "silence",
      });
    });

    it("what run b56f1r3-mac-pf-1 saw passes: probe 10.008 s, decoded exactly 10 s, one decode, silence", () => {
      const r = passingResult("safari");
      for (const set of [r.files, r.filesTyped])
        Object.assign(set[name], {
          probe: {
            status: "known",
            seconds: 10.008,
            via: "metadata",
            typeGiven: "audio/flac",
          },
          seconds: 10,
          decodedSeconds: 10,
          rms: 0,
        });
      expect(compare("safari", r)).toEqual([]);
      expect(
        run((f) => Object.assign(f, { seconds: 10.05, decodedSeconds: 10.05 }))
      ).toEqual([]);
      expect(
        run((f) => Object.assign(f, { seconds: 9.95, decodedSeconds: 9.95 }))
      ).toEqual([]);
    });

    it("anything longer than declared fails — decoded past the declared length, even when trimmed to the limit", () => {
      // The engine decoded everything and the product accepted it (the length check gone): 575 s.
      expect(
        run((f) => Object.assign(f, { seconds: 60, decodedSeconds: 575.496 }))
      ).toEqual([
        `${name}: decoded 575.496 s, over the limit of 60 s`,
        `${name}: decoded 575.496 s, more than the 10 s the container declares (+ 0.05 s) — the engine went past the declared length and the result was accepted`,
        `${name}: converted 60 s, more than the 10 s the container declares (+ 0.05 s) — the engine went past the declared length and the result was accepted`,
      ]);
      // Under the limit but past the declared length: still a failure.
      expect(
        run((f) => Object.assign(f, { seconds: 10.06, decodedSeconds: 10.06 }))
      ).toEqual([
        `${name}: decoded 10.06 s, more than the 10 s the container declares (+ 0.05 s) — the engine went past the declared length and the result was accepted`,
        `${name}: converted 10.06 s, more than the 10 s the container declares (+ 0.05 s) — the engine went past the declared length and the result was accepted`,
      ]);
      expect(run((f) => Object.assign(f, { decodedSeconds: 30 }))).toEqual([
        `${name}: decoded 30 s, more than the 10 s the container declares (+ 0.05 s) — the engine went past the declared length and the result was accepted`,
      ]);
      expect(run((f) => Object.assign(f, { seconds: 30 }))).toEqual([
        `${name}: converted 30 s, more than the 10 s the container declares (+ 0.05 s) — the engine went past the declared length and the result was accepted`,
      ]);
    });

    it("a result with no length, a shorter one, a second decode, an unprobed decode or a longer probe each fail", () => {
      expect(
        run((f) => {
          delete f.decodedSeconds;
          delete f.seconds;
        })
      ).toEqual([
        `${name}: decoded length undefined is not a length`,
        `${name}: converted length undefined is not a length`,
      ]);
      // NaN arrives as null through JSON, and null compares as 0: it must not pass as "not over".
      expect(run((f) => Object.assign(f, { decodedSeconds: NaN }))).toEqual([
        `${name}: decoded length null is not a length`,
      ]);
      expect(run((f) => Object.assign(f, { seconds: "10" }))).toEqual([
        `${name}: converted length 10 is not a length`,
      ]);
      expect(
        run((f) => {
          f.probe = { ...(f.probe as object), seconds: null };
        })
      ).toEqual([
        `${name}: the probe answered null s, more than the 10 s the container declares (+ 0.05 s)`,
      ]);
      expect(run((f) => Object.assign(f, { seconds: 3, decodedSeconds: 3 }))).toEqual([
        `${name}: decoded 3 s, expected the declared 10 ± 0.05 s`,
        `${name}: converted 3 s, expected the declared 10 ± 0.05 s`,
      ]);
      expect(run((f) => Object.assign(f, { decodes: 2 }))).toEqual([
        `${name}: expected 1 decode, got 2`,
      ]);
      expect(run((f) => Object.assign(f, { decodes: 0 }))).toEqual([
        `${name}: expected 1 decode, got 0`,
      ]);
      expect(run((f) => Object.assign(f, { probe: null }))).toEqual([
        `${name}: decoded without its length known from the probe first`,
        `${name}: the probe was told "undefined" for the untyped file and "audio/flac" for the typed one (the declared type must not matter)`,
      ]);
      expect(
        run((f) => {
          f.probe = { ...(f.probe as object), seconds: 575.5 };
        })
      ).toEqual([
        `${name}: the probe answered 575.5 s, more than the 10 s the container declares (+ 0.05 s)`,
      ]);
      expect(
        run((f) => Object.assign(f, { rms: 0.2, canonical: false, stage: undefined }))
      ).toEqual([
        `${name}: converted, but the run names no "done" step`,
        `${name}: the result is not a canonical WAV`,
        `${name}: RMS 0.2, expected under 0.001 (silence)`,
      ]);
    });

    it("a refusal fails too: the cell says what this engine does, and a change is a reviewed one", () => {
      const r = passingResult("webkit");
      r.files[name] = {
        ok: false,
        code: "too_long",
        stage: "length",
        declaredType: "",
        probe: r.files[name].probe,
        decodes: 1,
      };
      r.filesTyped[name] = { ...r.files[name], declaredType: "audio/flac" };
      expect(compare("webkit", r)).toEqual([
        `${name}: expected it to convert to the 10 s its container declares, refused too_long at length (probe: 10.008 s via metadata, told audio/flac)`,
        `${typed}: expected it to convert to the 10 s its container declares, refused too_long at length (probe: 10.008 s via metadata, told audio/flac)`,
      ]);
    });

    it("the cell is refused on a case that cannot carry it: no declared length, one over the limit, or a recording", () => {
      const needs = (n: string) =>
        `${n}: a "bounded-by-declared-length" cell needs an upload case with declaredSeconds and declaredWithin, the declared length under maxSeconds`;
      for (const change of [
        (c: Record<string, unknown>) => delete c.declaredSeconds,
        (c: Record<string, unknown>) => delete c.declaredWithin,
        (c: Record<string, unknown>) => (c.declaredSeconds = 59.99),
        (c: Record<string, unknown>) => (c.declaredSeconds = 0),
        (c: Record<string, unknown>) => (c.declaredWithin = -1),
        (c: Record<string, unknown>) => (c.source = "recording"),
      ]) {
        const t = structuredClone(table);
        change(t.cases[name]);
        expect(compare("safari", passingResult("safari"), t)).toEqual([
          needs(name),
          needs(typed),
        ]);
      }
    });
  });
});

describe("expect.json", () => {
  const CELL =
    /^(decodes|bounded-by-declared-length|refused:[a-z_]+@(input|container|probe):0-decodes|refused-after-decode:[a-z_]+(\|[a-z_]+)*)$/;
  it("has the four engines, each with a known cell for every case", () => {
    expect(Object.keys(table.engines).sort()).toEqual([
      "chromium",
      "firefox",
      "safari",
      "webkit",
    ]);
    for (const [engine, col] of Object.entries<{ files: Record<string, string> }>(
      table.engines
    )) {
      expect([engine, Object.keys(col.files).sort()]).toEqual([
        engine,
        Object.keys(table.cases).sort(),
      ]);
      for (const cell of Object.values(col.files)) expect(cell).toMatch(CELL);
    }
  });

  it("R3: every upload of a compressed file runs typed and untyped; WAVs, recordings and made-in-page inputs do not", () => {
    const typed: Record<string, string> = {};
    for (const [name, c] of Object.entries<{
      fixture: string;
      source: string;
      pickerType?: string;
    }>(table.cases)) {
      const ext = c.fixture.split(".").pop() ?? "";
      const compressed = ["webm", "ogg", "m4a", "mp3", "flac"].includes(ext);
      expect([name, c.pickerType !== undefined]).toEqual([
        name,
        (compressed && c.source === "upload") || c.fixture === "garbage.bin",
      ]);
      // One fixture is never typed two ways (it may be a case twice: as a recording, as an upload).
      if (c.pickerType)
        expect([name, typed[c.fixture] ?? c.pickerType]).toEqual([name, c.pickerType]);
      if (c.pickerType) typed[c.fixture] = c.pickerType;
    }
    // Typed as a picker types the extension; the damaged input declared as audio it is not.
    expect(typed).toEqual({
      "tone.webm": "audio/webm",
      "tagged.webm": "audio/webm",
      "tone-opus.ogg": "audio/ogg",
      "tone-vorbis.ogg": "audio/ogg",
      "tone.m4a": "audio/mp4",
      "tone-fmp4.m4a": "audio/mp4",
      "tone-fmp4-60s.m4a": "audio/mp4",
      "tone.mp3": "audio/mpeg",
      "tone.flac": "audio/flac",
      "bomb-1h.flac": "audio/flac",
      "wide-8ch-192k.flac": "audio/flac",
      "nodur-30min.webm": "audio/webm",
      "nodur-3s.webm": "audio/webm",
      "lying-length.flac": "audio/flac",
      "garbage.bin": "audio/mpeg",
      "safari-26.6.2-webm.webm": "audio/webm",
    });
  });

  it("R3: both Safari recordings are cases every engine converts; the diagnostics name served files", () => {
    for (const f of ["safari-26.6.2-webm.webm", "safari-26.6.2-mp4.m4a"]) {
      const name = `${f} as a recording, max 4`;
      expect(table.cases[name]).toEqual({
        fixture: f,
        source: "recording",
        maxSeconds: 4,
        minSeconds: 1,
        seconds: 4,
        within: 0.05,
        check: "tone",
      });
      for (const col of Object.values<{ files: Record<string, string> }>(table.engines))
        expect(col.files[name]).toBe("decodes");
    }
    const served = esm(
      `import { startServer } from "./${DIR}/serve.mjs";
       const s = await startServer(); await s.close();
       console.log(JSON.stringify(s.fixtureNames));`
    ) as string[];
    const listed = Object.keys(table.diagnostics.files);
    expect(listed.filter((f) => !served.includes(f))).toEqual([]);
    // R4: the two entries that exist to answer a question in the third Mac run.
    expect(table.diagnostics.files["lying-length.flac"]).toEqual({
      pickerType: "audio/flac",
      rawDecode: true,
    });
    expect(table.diagnostics.files["nodur-80s-safari-form.webm"]).toEqual({
      pickerType: "audio/webm",
      rawDecode: true,
    });
    expect(listed).toEqual(
      expect.arrayContaining([
        "tone.mp3",
        "tone.flac",
        "nodur-3s.webm",
        "safari-26.6.2-webm.webm",
      ])
    );
    expect(table.diagnostics.probeTimeoutMs).toBe(10000);
    for (const c of Object.values<{ fixture: string }>(table.cases))
      if (!c.fixture.startsWith("@")) expect(served).toContain(c.fixture);
  });

  it("R4: Safari's own duration-less recording is also an upload case every engine converts (the probe must measure it)", () => {
    const name = "safari-26.6.2-webm.webm as an upload, max 60";
    expect(table.cases[name]).toEqual({
      fixture: "safari-26.6.2-webm.webm",
      source: "upload",
      maxSeconds: 60,
      minSeconds: 0.5,
      seconds: 4.01,
      within: 0.05,
      check: "tone",
      pickerType: "audio/webm",
    });
    for (const col of Object.values<{ files: Record<string, string> }>(table.engines))
      expect(col.files[name]).toBe("decodes");
    // An engine whose probe refuses it (as WebKit and Safari refuse the generated nodur files) fails.
    const r = passingResult("safari");
    r.files[name] = { ...r.files["nodur-3s.webm"] };
    expect(compare("safari", r)).toEqual([
      `${name}: expected it to decode, refused undecodable at probe (probe: media error 4 during metadata, told audio/webm)`,
    ]);
  });

  it("R3, R4: only the cells the two Mac runs corrected differ between the columns", () => {
    const differ: Record<string, Record<string, string>> = {};
    for (const name of Object.keys(table.cases)) {
      const cells = Object.fromEntries(
        Object.entries<{ files: Record<string, string> }>(table.engines).map(
          ([e, col]) => [e, col.files[name]]
        )
      );
      if (new Set(Object.values(cells)).size > 1) differ[name] = cells;
    }
    const webkit = (cell: string, other: string) => ({
      chromium: other,
      firefox: other,
      webkit: cell,
      safari: cell,
    });
    expect(differ).toEqual({
      "tone-fmp4-60s.m4a, max 59": webkit(
        "refused-after-decode:too_long",
        "refused:too_long@probe:0-decodes"
      ),
      "nodur-30min.webm": webkit(
        "refused:undecodable@probe:0-decodes",
        "refused:too_long@probe:0-decodes"
      ),
      "nodur-3s.webm": webkit("refused:undecodable@probe:0-decodes", "decodes"),
      "lying-length.flac": {
        chromium: "refused-after-decode:too_long|out_of_memory",
        firefox: "refused-after-decode:undecodable|too_long|out_of_memory",
        webkit: "bounded-by-declared-length",
        safari: "bounded-by-declared-length",
      },
    });
  });

  it("R3: a run in which probes get no answer still ends inside the spec's and Safari's budgets", () => {
    // The realistic worst case seen so far is the two duration-less WebM files left unanswered:
    // their four conversions (30 s each) and their six diagnostics (two 10 s waits each).
    const worst = 4 * table.probeTimeoutMs + 6 * 2 * table.diagnostics.probeTimeoutMs;
    const spec = readFileSync(join(DIR, "browser-audio.spec.ts"), "utf8");
    const safari = readFileSync(join(DIR, "safari-check.mjs"), "utf8");
    const config = readFileSync(join(DIR, "playwright.config.ts"), "utf8");
    const number = (text: string, re: RegExp) =>
      Number((re.exec(text) ?? [])[1]?.replace(/_/g, ""));
    const waits = number(spec, /timeout: ([\d_]+),/);
    const budget = number(safari, /const RUN_BUDGET_MS = ([\d_]+);/);
    const test = number(config, /timeout: ([\d_]+),/);
    expect(waits).toBeGreaterThanOrEqual(2 * worst);
    expect(budget).toBeGreaterThanOrEqual(2 * worst);
    expect(test).toBeGreaterThan(waits);
  });

  it("the browser spec's probe budget is 30 s (a slow VM must not turn a refusal into 'unmeasurable')", () => {
    expect(table.probeTimeoutMs).toBe(30000);
  });
});

describe("safari-check.mjs (T22)", () => {
  it("where safaridriver is absent: exits 1, 'it never skips'", () => {
    const out = mkdtempSync(join(tmpdir(), "safari-check-"));
    try {
      const r = spawnSync(
        process.execPath,
        [
          join(DIR, "safari-check.mjs"),
          "--out",
          out,
          "--driver",
          join(out, "no-such-driver"),
        ],
        { encoding: "utf8" }
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(
        /safaridriver not found .* this check fails, it never skips/
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("without --out: exits 1 with its usage", () => {
    const r = spawnSync(process.execPath, [join(DIR, "safari-check.mjs")], {
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/usage/);
  });

  it("R3: no session — a timeout names the steps in Safari's menus, any other refusal names safaridriver --enable", () => {
    expect(
      esm(
        `import { noSessionMessage } from "./${DIR}/safari-check.mjs";
         console.log(JSON.stringify(["POST /session: timed out after 90 s", "Request Timeout", "The operation timed-out", "You must enable 'Allow remote automation'", undefined].map(noSessionMessage)));`
      )
    ).toEqual([
      "no Safari session (POST /session: timed out after 90 s) — open Safari once by hand, then Settings → Advanced → Show features for web developers, then Developer → Allow remote automation",
      "no Safari session (Request Timeout) — open Safari once by hand, then Settings → Advanced → Show features for web developers, then Developer → Allow remote automation",
      "no Safari session (The operation timed-out) — run: safaridriver --enable (sudo safaridriver --enable only if that refuses)",
      "no Safari session (You must enable 'Allow remote automation') — run: safaridriver --enable (sudo safaridriver --enable only if that refuses)",
      "no Safari session () — run: safaridriver --enable (sudo safaridriver --enable only if that refuses)",
    ]);
  });

  it("requires Safari 18.4 or later; names recordings by type", () => {
    expect(
      esm(
        `import { safariVersionOk, recordingName } from "./${DIR}/safari-check.mjs";
         console.log(JSON.stringify([
           ["17.6", "18.3", "18.4", "18.10", "26.1", "", "x"].map(safariVersionOk),
           recordingName("26.1", "audio/mp4"), recordingName("26.1", "audio/webm;codecs=opus"),
           recordingName("26.1", "audio/ogg;codecs=opus")]));`
      )
    ).toEqual([
      [false, false, true, true, true, false, false],
      "safari-26.1-mp4.m4a",
      "safari-26.1-webm.webm",
      "safari-26.1-ogg.ogg",
    ]);
  });
});

describe("serve.mjs", () => {
  it("serves the page, the shipped modules and the fixtures under /audio-gate/ only", () => {
    const r = esm(
      `import { startServer } from "./${DIR}/serve.mjs";
       const s = await startServer();
       const get = async (p) => { const r = await fetch(new URL(p, s.url)); return [r.status, await r.text()]; };
       const out = {
         url: s.url,
         page: (await get("/audio-gate/")).map((x) => typeof x === "string" ? x.slice(0, 4000) : x),
         wav: (await get("/audio-gate/m/canonical-wav.js"))[1].includes("class CanonicalWav"),
         importsMapped: (await get("/audio-gate/"))[1].includes('"@/platform/voice/browser-audio":"/audio-gate/m/browser-audio.js"'),
         fixture: (await get("/audio-gate/fx/tone.webm"))[0],
         generated: (await get("/audio-gate/fx/nodur-3s.webm"))[0],
         outside: (await get("/api/health"))[0],
         proto: [(await get("/audio-gate/constructor"))[0], (await get("/audio-gate/__proto__"))[0], (await get("/audio-gate/toString"))[0]],
         after: (await get("/audio-gate/"))[0],
         readme: (await get("/audio-gate/fx/README.md"))[0],
       };
       await s.close();
       console.log(JSON.stringify(out));`
    ) as Record<string, unknown>;
    expect(r.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/audio-gate\/$/);
    expect((r.page as [number, string])[0]).toBe(200);
    expect((r.page as [number, string])[1]).toContain('id="start"');
    expect(r.wav).toBe(true);
    expect(r.importsMapped).toBe(true);
    expect(r.fixture).toBe(200);
    expect(r.generated).toBe(200);
    expect(r.outside).toBe(404);
    // RA-6: an inherited key is no file, and the server is still up after it.
    expect(r.proto).toEqual([404, 404, 404]);
    expect(r.after).toBe(200);
    expect(r.readme).toBe(404);
  });

  it("--lan without a certificate refuses to start (E-10)", () => {
    const r = spawnSync(process.execPath, [join(DIR, "serve.mjs"), "--lan"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--lan needs --cert and --key: .* not a secure context/);
  });
});
