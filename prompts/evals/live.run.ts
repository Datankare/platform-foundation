/**
 * prompts/evals/live.run.ts — the live eval lane, `npm run eval:live` (ADR-038 §1, TASK-204 N-43)
 *
 * Calls the real model for every suite's live cases, through the orchestrator (traced and costed
 * as production calls are), parses each answer with the prompt's own parser, asserts, and records
 * the answers in prompts/evals/recordings/<prompt>.json — which the deterministic lane replays on
 * every PR (__tests__/prompt-evals-recordings.test.ts), so a refreshed recording is a reviewable
 * diff of how the model now answers.
 *
 * Not part of `npm test` (jest's testMatch does not include it): run by `npm run eval:live`, by
 * hand or by the keyed workflow (.github/workflows/eval-live.yml). Never a CI gate on a PR.
 *
 * Without ANTHROPIC_API_KEY nothing is called, and the run says so — never a silent pass: a
 * `::notice::` line, a step-summary line when GITHUB_STEP_SUMMARY is set, and a test named for the
 * skip. With REQUIRE_EVAL_LIVE=true a missing key fails the run (the keyed workflow sets it).
 */
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getOrchestrator } from "@/platform/ai/orchestrator";
import { MODEL_REGISTRY } from "@/platform/ai/types";
import { listEvalSuites } from "@/prompts/evals";
import { runLive, type LiveCall } from "@/prompts/evals/runner";

// The test harness clears every platform setting the shell exported (jest.setup.ts,
// __tests__/helpers/isolate-env.ts) and keeps TEST_* and REQUIRE_*: `npm run eval:live` hands the
// operator's ANTHROPIC_API_KEY over as TEST_EVAL_LIVE_ANTHROPIC_KEY, and it is put back here for
// the provider. It is only ever sent as a header, never printed.
const KEY = (process.env.TEST_EVAL_LIVE_ANTHROPIC_KEY ?? "").trim();
if (KEY) process.env.ANTHROPIC_API_KEY = KEY;
const REQUIRED = process.env.REQUIRE_EVAL_LIVE === "true";
const OUT = join(process.cwd(), "prompts/evals/recordings");

function say(line: string, summary: string): void {
  process.stdout.write(`${line}\n`);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${summary}\n`);
}

const call: LiveCall = async (config, userMessage) => {
  const response = await getOrchestrator().complete(
    {
      tier: config.tier,
      messages: [{ role: "user", content: userMessage }],
      maxTokens: config.maxTokens,
      ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    },
    { useCase: `eval-live:${config.name}`, requestId: `eval-live-${config.name}` }
  );
  return response.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
};

if (!KEY) {
  describe("eval:live", () => {
    it(`SKIPPED: ANTHROPIC_API_KEY is not set — no prompt was evaluated against the model${
      REQUIRED ? " (REQUIRE_EVAL_LIVE=true: this fails)" : ""
    }`, () => {
      say(
        "::notice::eval:live skipped: ANTHROPIC_API_KEY is not set, so no prompt was evaluated against the model (ADR-038). Set the key and run npm run eval:live.",
        "## Live eval lane: skipped\n\nANTHROPIC_API_KEY is not set: no prompt was evaluated against the model (ADR-038)."
      );
      expect(REQUIRED).toBe(false);
    });
  });
} else {
  describe.each(listEvalSuites().map((s) => [s.prompt, s] as const))(
    "eval:live %s",
    (prompt, suite) => {
      it(`every live case passes against ${MODEL_REGISTRY[suite.live.config.tier].modelId}`, async () => {
        const results = await runLive(suite, call);
        mkdirSync(OUT, { recursive: true });
        writeFileSync(
          join(OUT, `${prompt}.json`),
          `${JSON.stringify(
            {
              prompt,
              model: MODEL_REGISTRY[suite.live.config.tier].modelId,
              cases: suite.live.cases.map((c, i) => ({
                id: c.id,
                input: c.input,
                raw: results[i].raw,
                passed: results[i].passed,
              })),
            },
            null,
            2
          )}\n`
        );
        const failed = results.filter((r) => !r.passed);
        say(
          `eval:live ${prompt}: ${results.length - failed.length}/${results.length} passed`,
          `- ${prompt}: ${results.length - failed.length}/${results.length} passed${
            failed.length ? ` — failed: ${failed.map((f) => f.id).join(", ")}` : ""
          }`
        );
        expect(failed.map((f) => `${f.id}${f.error ? `: ${f.error}` : ""}`)).toEqual([]);
      }, 120_000);
    }
  );
}
