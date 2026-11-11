/**
 * __tests__/prompt-evals-live.test.ts — the live eval lane's structure, its runner, and the replay
 * of its recordings (ADR-038 §1 and D3, TASK-204 N-43)
 *
 * @guard a suite with no live cases, a live case its builder cannot build, or a recording that no
 * longer parses and passes
 *
 * Deterministic: no model is called. The live lane itself is `npm run eval:live`
 * (prompts/evals/live.run.ts).
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { getPromptConfig } from "@/prompts";
import { listEvalSuites } from "@/prompts/evals";
import { runLive, type LiveCall } from "@/prompts/evals/runner";
import type { EvalSuite } from "@/prompts/evals/types";

const RECORDINGS = join(process.cwd(), "prompts/evals/recordings");

interface Recording {
  prompt: string;
  model: string;
  cases: { id: string; input: unknown; raw: string; passed: boolean }[];
}

/** The recordings on disk, by prompt (the README is not one). */
export function readRecordings(dir: string = RECORDINGS): Recording[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Recording);
}

/** What is wrong with a recording against the suites: unknown prompt, stale input, failing replay. */
export function recordingProblems(
  rec: Recording,
  suites: readonly EvalSuite<unknown>[]
): string[] {
  const suite = suites.find((s) => s.prompt === rec.prompt);
  if (!suite) return [`${rec.prompt}: no suite for this recording`];
  const out: string[] = [];
  for (const c of rec.cases) {
    const live = suite.live.cases.find((l) => l.id === c.id);
    if (!live) {
      out.push(`${rec.prompt}/${c.id}: no live case of that id — re-record`);
      continue;
    }
    if (JSON.stringify(live.input) !== JSON.stringify(c.input)) {
      out.push(
        `${rec.prompt}/${c.id}: the input changed since it was recorded — re-record`
      );
      continue;
    }
    let ok = false;
    try {
      ok = live.assert(suite.parse(c.raw));
    } catch {
      ok = false;
    }
    if (ok !== c.passed) {
      out.push(
        `${rec.prompt}/${c.id}: replays ${ok ? "passing" : "failing"}, recorded ${c.passed}`
      );
    }
  }
  return out;
}

describe("the live lane's cases (ADR-038 §1)", () => {
  const suites = listEvalSuites();

  it.each(suites.map((s) => [s.prompt, s] as const))(
    "%s: has live cases, each built by the prompt's builder, under its registered config",
    (prompt, suite) => {
      expect(suite.live.cases.length).toBeGreaterThan(0);
      const ids = suite.live.cases.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^live:[a-z0-9-]+$/);
      for (const c of suite.live.cases) {
        const text = suite.live.build(c.input);
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(50);
      }
      // The lane calls the model as production does: the registered prompt's own config.
      const registered = getPromptConfig(prompt);
      expect(suite.live.config.name).toBe(prompt);
      expect(suite.live.config.tier).toBe(registered.tier);
      expect(suite.live.config.maxTokens).toBe(registered.maxTokens);
      expect(suite.live.config.temperature).toBe(registered.temperature);
    }
  );
});

describe("runLive", () => {
  const suite = listEvalSuites().find(
    (s) => s.prompt === "safety-classify"
  ) as EvalSuite<unknown>;

  it("sends each case's built prompt under the suite's config, and keeps the raw answer", async () => {
    const seen: { tier: string; text: string }[] = [];
    const call: LiveCall = async (config, text) => {
      seen.push({ tier: config.tier, text });
      return '{"safe": true, "categories": [], "confidence": 0.9, "severity": "low"}';
    };
    const results = await runLive(suite, call);
    expect(seen).toHaveLength(suite.live.cases.length);
    expect(seen[0].text).toBe(suite.live.build(suite.live.cases[0].input));
    expect(results.map((r) => r.id)).toEqual(suite.live.cases.map((c) => c.id));
    expect(results[0]).toMatchObject({ passed: true });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.raw.includes('"safe"'))).toBe(true);
  });

  it("[hostile:store-down] a call that throws is a failed case with its error, never a pass", async () => {
    const results = await runLive(suite, async () => {
      throw new Error("529 overloaded");
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => !r.passed && r.error === "529 overloaded")).toBe(true);
  });

  it("[hostile] an unparseable answer fails its case (the parser's fail-closed default is no pass)", async () => {
    const results = await runLive(suite, async () => "I cannot help with that.");
    expect(results[0].passed).toBe(false);
  });
});

describe("the recordings replay (ADR-038 D3)", () => {
  it("every recording parses and passes as recorded, for the case's current input", () => {
    const problems = readRecordings().flatMap((r) =>
      recordingProblems(r, listEvalSuites())
    );
    expect(problems).toEqual([]);
  });

  it("[self-test] a stale input, an unknown case and a changed verdict are each found", () => {
    const suite = listEvalSuites().find(
      (s) => s.prompt === "safety-classify"
    ) as EvalSuite<unknown>;
    const c = suite.live.cases[0];
    const ok = '{"safe": true, "categories": [], "confidence": 0.9, "severity": "low"}';
    const rec = (cases: Recording["cases"]): Recording => ({
      prompt: "safety-classify",
      model: "m",
      cases,
    });
    expect(
      recordingProblems(rec([{ id: c.id, input: c.input, raw: ok, passed: true }]), [
        suite,
      ])
    ).toEqual([]);
    expect(
      recordingProblems(rec([{ id: c.id, input: "other", raw: ok, passed: true }]), [
        suite,
      ])[0]
    ).toMatch(/input changed/);
    expect(
      recordingProblems(rec([{ id: "live:gone", input: 1, raw: ok, passed: true }]), [
        suite,
      ])[0]
    ).toMatch(/no live case/);
    expect(
      recordingProblems(rec([{ id: c.id, input: c.input, raw: "junk", passed: true }]), [
        suite,
      ])[0]
    ).toMatch(/replays failing/);
    expect(
      recordingProblems({ prompt: "nope", model: "m", cases: [] }, [suite])[0]
    ).toMatch(/no suite/);
  });
});
