/**
 * e2e/audio/compare.mjs — a gate run's facts against e2e/audio/expect.json (TASK-234;
 * DESIGN-56f1 §9.1). Shared by the Playwright spec and safari-check.mjs; runs in Node.
 *
 * Returns every mismatch as a sentence; [] means the engine's column holds in full. A cell the
 * table lacks, or a case the run lacks, is a mismatch too: nothing passes by being absent — that
 * holds for the typed run of a case with a `pickerType` and for each listed diagnostic as well
 * (a diagnostic's content is reported, not asserted).
 *
 * Cells: `decodes`; `refused:<code>@<stage>:0-decodes` (the product's step that refused it:
 * input, container or probe); `refused-after-decode:<code>|<code>` (ended at the decode or the
 * length check, after the one decode, in one of the codes NAMED — never "any error");
 * `bounded-by-declared-length` (a file whose container declares less than it holds, in an
 * engine that decodes only what is declared: it converts, and the conversion is accepted only
 * when the decoded length is the case's `declaredSeconds` ± `declaredWithin`, never over
 * `maxSeconds`, after exactly one decode; anything longer fails — ADR-061 D4).
 */

const TONE_HZ = 1234;
const TONE_TOLERANCE_HZ = 4;
const MIN_TONE_SHARE = 0.5;
const QUIET_RMS = 0.001;
const RECORDING_SLACK_SECONDS = 0.5;

const BEFORE_DECODE = ["input", "container", "probe"];
const AFTER_DECODE = ["decode", "length"];

/** Where and how a refusal ended, for a mismatch sentence: "undecodable at the probe (…)". */
function ended(r) {
  const p = r.probe;
  const detail = !p
    ? ""
    : p.status === "known"
      ? ` (probe: ${p.seconds} s via ${p.via}, told ${p.typeGiven || "no type"})`
      : p.status === "unreadable"
        ? ` (probe: media error ${p.mediaErrorCode} during ${p.phase}, told ${p.typeGiven || "no type"})`
        : ` (probe: no answer during ${p.phase}, told ${p.typeGiven || "no type"})`;
  return `${r.code} at ${r.stage ?? "an unnamed step"}${detail}`;
}

function fileProblems(name, c, cell, r, engine) {
  const out = [];
  if (!r) return [`${name}: no result from the run`];
  const after = /^refused-after-decode:([a-z_|]+)$/.exec(cell);
  if (after) {
    const codes = after[1].split("|");
    if (r.ok)
      return [`${name}: expected refused (${codes.join(" or ")}), but it converted`];
    if (!codes.includes(r.code))
      out.push(`${name}: expected ${codes.join(" or ")}, got ${ended(r)}`);
    else if (!AFTER_DECODE.includes(r.stage))
      out.push(
        `${name}: expected to end at the decode or the length check, got ${ended(r)}`
      );
    if (!(r.decodes <= 1))
      out.push(`${name}: expected at most 1 decode, got ${r.decodes}`);
    return out;
  }
  if (cell === "bounded-by-declared-length") return declaredLengthProblems(name, c, r);
  const refused = /^refused:([a-z_]+)@([a-z]+):0-decodes$/.exec(cell);
  if (refused) {
    if (!BEFORE_DECODE.includes(refused[2]))
      return [
        `${name}: unknown cell "${cell}" (a step before decoding: input, container, probe)`,
      ];
    if (r.ok) out.push(`${name}: expected refused ${refused[1]}, but it converted`);
    else if (r.code !== refused[1])
      out.push(`${name}: expected refused ${refused[1]}, got ${ended(r)}`);
    else if (r.stage !== refused[2])
      out.push(`${name}: expected refused at ${refused[2]}, got ${ended(r)}`);
    if (r.decodes !== 0) out.push(`${name}: expected 0 decodes, got ${r.decodes}`);
    return out;
  }
  if (cell !== "decodes") return [`${name}: unknown cell "${cell}"`];
  if (!r.ok) return [`${name}: expected it to decode, refused ${ended(r)}`];
  if (r.decodes !== 1) out.push(`${name}: expected 1 decode, got ${r.decodes}`);
  if (r.stage !== "done")
    out.push(`${name}: converted, but the run names no "done" step`);
  if (c.source === "upload" && r.probe?.status !== "known")
    out.push(`${name}: decoded without its length known from the probe first`);
  if (c.source !== "upload" && r.probe)
    out.push(`${name}: a recording was probed (it is bounded by its own timer)`);
  if (!r.canonical) out.push(`${name}: the result is not a canonical WAV`);
  const within = c.withinFor?.[engine] ?? c.within;
  if (
    typeof c.seconds === "number" &&
    !(Math.abs(r.seconds - c.seconds) <= within + 1e-9)
  ) {
    out.push(`${name}: length ${r.seconds} s, expected ${c.seconds} ± ${within} s`);
  }
  out.push(...checkProblems(name, c.check, r));
  for (const t of r.present ?? []) out.push(`${name}: "${t}" reached the WAV`);
  return out;
}

/**
 * `bounded-by-declared-length`: the file declares `declaredSeconds` and holds more. An engine that
 * decodes only the declared length converts it, and that is safe only while the bound is real —
 * so the bound is asserted on the DECODED length (what the engine produced, before any trim) and
 * on the result: within `declaredWithin` of the declared length, never over `maxSeconds`, one
 * decode, the probe's answer no longer than the declared length either. A result with no length
 * fails.
 */
function declaredLengthProblems(name, c, r) {
  const declared = c.declaredSeconds;
  const within = c.declaredWithin;
  const usable =
    c.source === "upload" &&
    typeof declared === "number" &&
    typeof within === "number" &&
    declared > 0 &&
    within >= 0 &&
    declared + within <= c.maxSeconds;
  if (!usable)
    return [
      `${name}: a "bounded-by-declared-length" cell needs an upload case with declaredSeconds and declaredWithin, the declared length under maxSeconds`,
    ];
  if (!r.ok)
    return [
      `${name}: expected it to convert to the ${declared} s its container declares, refused ${ended(r)}`,
    ];
  const out = [];
  if (r.decodes !== 1) out.push(`${name}: expected 1 decode, got ${r.decodes}`);
  if (r.stage !== "done")
    out.push(`${name}: converted, but the run names no "done" step`);
  if (r.probe?.status !== "known")
    out.push(`${name}: decoded without its length known from the probe first`);
  else if (!(typeof r.probe.seconds === "number" && r.probe.seconds <= declared + within))
    out.push(
      `${name}: the probe answered ${r.probe.seconds} s, more than the ${declared} s the container declares (+ ${within} s)`
    );
  if (!r.canonical) out.push(`${name}: the result is not a canonical WAV`);
  for (const [what, seconds] of [
    ["decoded", r.decodedSeconds],
    ["converted", r.seconds],
  ]) {
    // A missing length must fail: null (what JSON makes of NaN) compares as 0.
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
      out.push(`${name}: ${what} length ${seconds} is not a length`);
      continue;
    }
    if (!(seconds <= c.maxSeconds))
      out.push(`${name}: ${what} ${seconds} s, over the limit of ${c.maxSeconds} s`);
    if (!(seconds <= declared + within))
      out.push(
        `${name}: ${what} ${seconds} s, more than the ${declared} s the container declares (+ ${within} s) — the engine went past the declared length and the result was accepted`
      );
    else if (!(seconds >= declared - within))
      out.push(
        `${name}: ${what} ${seconds} s, expected the declared ${declared} ± ${within} s`
      );
  }
  out.push(...checkProblems(name, c.check, r));
  for (const t of r.present ?? []) out.push(`${name}: "${t}" reached the WAV`);
  return out;
}

function checkProblems(name, check, r) {
  if (check === "tone") {
    const out = [];
    if (Math.abs(r.peakHz - TONE_HZ) > TONE_TOLERANCE_HZ) {
      out.push(
        `${name}: peak ${r.peakHz} Hz, expected ${TONE_HZ} ± ${TONE_TOLERANCE_HZ} Hz`
      );
    }
    if (!(r.toneShare >= MIN_TONE_SHARE))
      out.push(`${name}: the tone is ${r.toneShare} of the signal`);
    return out;
  }
  if (check === "alias" || check === "silence") {
    return r.rms < QUIET_RMS
      ? []
      : [`${name}: RMS ${r.rms}, expected under ${QUIET_RMS} (${check})`];
  }
  return check === undefined ? [] : [`${name}: unknown check "${check}"`];
}

function recordingProblems(key, cell, r, seconds) {
  if (!r) return [`recording ${key}: no result from the run`];
  if (cell === "unsupported") {
    return r.unsupported
      ? []
      : [`recording ${key}: expected unsupported, but it recorded`];
  }
  if (cell !== "valid") return [`recording ${key}: unknown cell "${cell}"`];
  if (r.unsupported)
    return [`recording ${key}: expected valid, but the type is unsupported`];
  if (!r.ok) return [`recording ${key}: expected valid, got ${r.code}`];
  const out = [];
  // A recording is bounded by its own timer and never probed (ADR-061 §6: a picked WebM that
  // states no length may be refused in Safari; recording in the page must not depend on that).
  if (r.probe)
    out.push(`recording ${key}: it was probed (a recording is bounded by its own timer)`);
  if (!r.canonical) out.push(`recording ${key}: the result is not a canonical WAV`);
  if (r.seconds > seconds + 1e-9 || r.seconds < seconds - RECORDING_SLACK_SECONDS) {
    out.push(
      `recording ${key}: length ${r.seconds} s, expected within [${seconds - RECORDING_SLACK_SECONDS}, ${seconds}]`
    );
  }
  out.push(...checkProblems(`recording ${key}`, "tone", r));
  return out;
}

const bare = (type) =>
  String(type ?? "")
    .replace(/\s+/g, "")
    .toLowerCase();

/** The typed run of a case with a `pickerType`: the same cell, and the same type given to the probe. */
function typedProblems(name, c, cell, untyped, typed, engine) {
  const label = `${name} (typed ${c.pickerType})`;
  if (!typed) return [`${label}: no result from the run`];
  const out = fileProblems(label, c, cell, typed, engine);
  if (typed.declaredType !== c.pickerType)
    out.push(`${label}: the run declared "${typed.declaredType}"`);
  if (untyped && untyped.declaredType !== "")
    out.push(`${name}: the untyped run declared "${untyped.declaredType}"`);
  const a = untyped?.probe?.typeGiven;
  const b = typed.probe?.typeGiven;
  if (a !== b)
    out.push(
      `${name}: the probe was told "${a}" for the untyped file and "${b}" for the typed one (the declared type must not matter)`
    );
  return out;
}

function diagnosticProblems(table, result) {
  const out = [];
  for (const [fixture, d] of Object.entries(table.diagnostics?.files ?? {})) {
    const r = result.diagnostics?.[fixture];
    const whole =
      r &&
      [r.untyped, r.asFirstRun, r.typed].every(
        (x) => x && x.probe?.status && x.trace?.outcome
      ) &&
      (!d.rawDecode || typeof r.rawDecode?.ok === "boolean");
    if (!whole) out.push(`diagnostics ${fixture}: the run did not report it in full`);
  }
  return out;
}

/** Every way `result` differs from `table.engines[engine]`. */
export function compare(table, engine, result) {
  const col = table.engines?.[engine];
  if (!col) return [`the table has no column "${engine}"`];
  if (!result) return ["the run returned nothing"];
  if (result.fatal) return [result.fatal];
  const out = [];
  for (const [t, want] of Object.entries(col.recorderTypes)) {
    if (result.recorderTypes?.[t] !== want) {
      out.push(`recorder type ${t}: expected ${want}, got ${result.recorderTypes?.[t]}`);
    }
  }
  if (!result.productRecorderType) {
    out.push("this engine records none of the product's RECORDER_TYPES");
  }
  for (const k of ["music", "upload"]) {
    if (result.detect?.[k] !== col.detect[k]) {
      out.push(
        `detect ${k}: expected ${col.detect[k]}, got ${result.detect?.[k]} (missing: ${(result.detect?.missing ?? []).join(", ")})`
      );
    }
  }
  const names = new Set([...Object.keys(table.cases), ...Object.keys(col.files)]);
  for (const name of names) {
    const c = table.cases[name];
    const cell = col.files[name];
    if (!c) out.push(`${name}: a cell for a case the table does not define`);
    else if (cell === undefined) out.push(`${name}: the "${engine}" column has no cell`);
    else {
      out.push(...fileProblems(name, c, cell, result.files?.[name], engine));
      if (c.pickerType)
        out.push(
          ...typedProblems(
            name,
            c,
            cell,
            result.files?.[name],
            result.filesTyped?.[name],
            engine
          )
        );
    }
  }
  for (const key of ["default", "audio/mp4"]) {
    const cell = col.recordings?.[key];
    if (cell === undefined)
      out.push(`recording ${key}: the "${engine}" column has no cell`);
    else
      out.push(
        ...recordingProblems(key, cell, result.recordings?.[key], table.recordingSeconds)
      );
    const type = result.recordings?.[key]?.mimeType;
    const want = col.recordedAs?.[key];
    if (cell === "valid" && want === undefined)
      out.push(
        `recording ${key}: the "${engine}" column does not say what type it records as`
      );
    else if (cell === "valid" && bare(type) !== bare(want))
      out.push(`recording ${key}: recorded as "${type}", expected "${want}"`);
    else if (cell !== "valid" && want !== undefined)
      out.push(`recording ${key}: a recorded type for a recording that is not expected`);
  }
  out.push(...diagnosticProblems(table, result));
  return out;
}

/**
 * Per-engine facts for the log: each case's outcome, the step that ended it and what the probe
 * answered (untyped and typed), the recordings, and the diagnostics in full. Timings are never
 * asserted.
 */
export function information(result) {
  const brief = (set) =>
    Object.fromEntries(
      Object.entries(set ?? {}).map(([n, r]) => [
        n,
        {
          ms: r.ms,
          seconds: r.seconds,
          decodedSeconds: r.decodedSeconds,
          code: r.code,
          stage: r.stage,
          decodes: r.decodes,
          probe: r.probe,
          peakHz: r.peakHz,
          rms: r.rms,
        },
      ])
    );
  const files = brief(result?.files);
  const filesTyped = brief(result?.filesTyped);
  const recordings = Object.fromEntries(
    Object.entries(result?.recordings ?? {}).map(([k, r]) => [
      k,
      {
        mimeType: r.mimeType,
        bytes: r.bytes,
        seconds: r.seconds,
        decodedSeconds: r.decodedSeconds,
        peakHz: r.peakHz,
        code: r.code,
        probe: r.probe,
      },
    ])
  );
  return {
    userAgent: result?.userAgent,
    clock: result?.clock,
    files,
    filesTyped,
    recordings,
    diagnostics: result?.diagnostics,
  };
}
