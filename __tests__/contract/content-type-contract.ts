/**
 * __tests__/contract/content-type-contract.ts — ADR-037 §7 (L21) conformance kit.
 *
 * The portable kit that proves a ContentType satisfies the ADR-037 contract: fail-closed to the
 * consumer's static template on every runtime failure (D3/P11), the generated content screened
 * through the Guardian before it can surface (D4/P4), durable surfacing routed through the governed
 * commitment boundary (D5/P17), and an eval-gated prompt (ADR-038). A consumer (Playform, or any app
 * on this platform) runs it against its own content type to learn whether that type behaves as the
 * ADR requires; this repo's own invocation is __tests__/content-type-conformance.test.ts.
 *
 * The invoking file MUST, before calling this kit:
 *   - jest.mock("@/platform/ai") with getOrchestrator: jest.fn()                     (partial mock)
 *   - jest.mock("@/platform/moderation/middleware") with screenContent: jest.fn()    (partial mock)
 *   - jest.mock("@/platform/action-pipeline") with executeActionPipeline: jest.fn()  (partial mock)
 *   - register the content type and its host agent (so the loop's run resolves the host)
 *
 * A conformant parser is fail-closed (never throws, never emits an invalid value), so the parse-error
 * and schema-invalid branches cannot be reached through the real parser. The kit injects those two
 * failures at the seam (a throwing / schema-violating parse on a copy of the type) to prove the
 * framework returns THIS type's static template for each. Orchestrator error, open breaker,
 * run-incomplete, and Guardian block are driven through the real path.
 */
import { getOrchestrator } from "@/platform/ai";
import { executeActionPipeline } from "@/platform/action-pipeline";
import { screenContent } from "@/platform/moderation/middleware";
import { generateContent } from "@/platform/content/loop";
import type { ContentScope } from "@/platform/content/loop";
import { registerContentType } from "@/platform/content/registry";
import { routeContentEffect } from "@/platform/content/effect";
import type { ContentEffectRequest } from "@/platform/content/effect";
import type { ContentType } from "@/platform/content/types";
import { EVAL_SUITES } from "@/prompts/evals";

export interface ContentTypeContractSpec<TInput, TContent> {
  /** The registered content type under test. */
  readonly contentType: ContentType<TInput, TContent>;
  /** A valid input the type's build() accepts. */
  readonly sampleInput: TInput;
  /** A raw model output the type's parse() maps to schema-valid content (the success path). */
  readonly sampleValidRaw: string;
}

const textResponse = (text: string) => ({
  content: [{ type: "text", text }],
  model: "contract",
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: "end_turn",
});

/** Run the ADR-037 L21 contract against one content type. */
export function runContentTypeContract<TInput, TContent>(
  spec: ContentTypeContractSpec<TInput, TContent>
): void {
  const { contentType, sampleInput, sampleValidRaw } = spec;
  const orch = getOrchestrator as jest.Mock;
  const screen = screenContent as jest.Mock;
  const pipe = executeActionPipeline as jest.Mock;
  const scope: ContentScope = { type: "group", id: "contract-content" };
  const expectedFallback = () => contentType.renderFallback(sampleInput);

  describe(`content type contract — ${contentType.name} (ADR-037 L21)`, () => {
    beforeEach(() => {
      orch.mockReset();
      screen.mockReset();
      pipe.mockReset();
      screen.mockResolvedValue({ action: "allow" });
    });

    it("registration is rejected without a static-template fallback (D3)", () => {
      const noFallback = {
        ...contentType,
        name: `${contentType.name}__contract-no-fallback`,
        renderFallback: undefined as unknown as ContentType<
          TInput,
          TContent
        >["renderFallback"],
      };
      expect(() => registerContentType(noFallback)).toThrow(/fallback/i);
    });

    it("an orchestrator error yields the static template (D3/P11)", async () => {
      orch.mockReturnValue({
        complete: jest.fn().mockRejectedValue(new Error("orchestrator unavailable")),
      });
      const r = await generateContent(contentType, sampleInput, scope);
      expect(r.usedFallback).toBe(true);
      expect(r.fallbackReason).toBe("orchestrator-error");
      expect(r.content).toEqual(expectedFallback());
      expect(screen).not.toHaveBeenCalled(); // nothing to screen; the template is never re-screened
    });

    it("an open circuit breaker yields the static template", async () => {
      // ADR-015: the orchestrator throws when the breaker is open; the loop treats it as an
      // orchestration failure, so a dead provider can never skip the fallback.
      orch.mockReturnValue({
        complete: jest
          .fn()
          .mockRejectedValue(
            new Error("Circuit breaker is open — AI provider is unavailable")
          ),
      });
      const r = await generateContent(contentType, sampleInput, scope);
      expect(r.usedFallback).toBe(true);
      expect(r.fallbackReason).toBe("orchestrator-error");
      expect(r.content).toEqual(expectedFallback());
    });

    it("a parse failure yields the static template", async () => {
      orch.mockReturnValue({
        complete: jest.fn().mockResolvedValue(textResponse("anything")),
      });
      const throwing: ContentType<TInput, TContent> = {
        ...contentType,
        parse: () => {
          throw new Error("parse boom");
        },
      };
      const r = await generateContent(throwing, sampleInput, scope);
      expect(r.usedFallback).toBe(true);
      expect(r.fallbackReason).toBe("parse-error");
      expect(r.content).toEqual(expectedFallback());
    });

    it("a schema-invalid output yields the static template (P6)", async () => {
      orch.mockReturnValue({
        complete: jest.fn().mockResolvedValue(textResponse("anything")),
      });
      const invalid: ContentType<TInput, TContent> = {
        ...contentType,
        // Returns a value the type's own schema rejects, exercising the schema-invalid branch
        // rather than a parser throw.
        parse: () => null as unknown as TContent,
      };
      const r = await generateContent(invalid, sampleInput, scope);
      expect(r.usedFallback).toBe(true);
      expect(r.fallbackReason).toBe("schema-invalid");
      expect(r.content).toEqual(expectedFallback());
    });

    it("a run that never completes yields the static template", async () => {
      orch.mockReturnValue({
        complete: jest.fn().mockResolvedValue(textResponse(sampleValidRaw)),
      });
      const unhosted: ContentType<TInput, TContent> = {
        ...contentType,
        agentId: "contract-unregistered-host",
      };
      const r = await generateContent(unhosted, sampleInput, scope);
      expect(r.usedFallback).toBe(true);
      expect(r.fallbackReason).toBe("run-incomplete");
      expect(r.content).toEqual(expectedFallback());
    });

    it("a Guardian block withholds the content and yields the static template (D4/P4)", async () => {
      orch.mockReturnValue({
        complete: jest.fn().mockResolvedValue(textResponse(sampleValidRaw)),
      });
      screen.mockResolvedValue({ action: "block" });
      const r = await generateContent(contentType, sampleInput, scope);
      expect(r.usedFallback).toBe(true);
      expect(r.fallbackReason).toBe("screening-blocked");
      expect(r.content).toEqual(expectedFallback());
    });

    it("generated content is screened on the output path before it surfaces (D4/P4)", async () => {
      orch.mockReturnValue({
        complete: jest.fn().mockResolvedValue(textResponse(sampleValidRaw)),
      });
      screen.mockResolvedValue({ action: "allow" });
      const r = await generateContent(contentType, sampleInput, scope);
      expect(screen).toHaveBeenCalledTimes(1);
      expect(screen).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ direction: "output" })
      );
      expect(r.usedFallback).toBe(false);
      expect(r.content).toEqual(contentType.parse(sampleValidRaw));
    });

    it("durable content surfaces through the governed commitment boundary, never a direct write (D5/P17)", async () => {
      pipe.mockResolvedValue({
        conflict: false,
        tier: "durable",
        context: {},
        committed: {
          sessionId: "contract-content",
          state: { surfaced: true },
          version: 1,
        },
        step: null,
        trajectory: null,
      });
      const req: ContentEffectRequest<{ surfaced: boolean }> = {
        spec: { type: `content-${contentType.name}-surface`, effects: ["stateWrite"] },
        actor: { actorType: "agent", actorId: contentType.agentId, agentRole: "content" },
        sessionId: "contract-content",
        label: `content-${contentType.name}-surface`,
        cost: 0,
        stateStore: {} as never,
        trajectoryStore: {} as never,
        trajectoryId: "contract-ct1",
        stepIndex: 0,
        expectedVersion: 0,
        computeNextState: () => ({ surfaced: true }),
      };
      const out = await routeContentEffect(req);
      // The pipeline is the only surfacing path, and the boundary is forced — a caller cannot
      // surface durable content directly or downgrade the gate.
      expect(pipe).toHaveBeenCalledTimes(1);
      expect(pipe).toHaveBeenCalledWith(
        expect.objectContaining({ boundary: "commitment" })
      );
      expect(out.status).toBe("applied");
    });

    it("the content type's prompt has an authored eval suite (ADR-038)", () => {
      expect(EVAL_SUITES.map((s) => s.prompt)).toContain(contentType.name);
    });
  });
}
