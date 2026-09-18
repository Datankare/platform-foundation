/**
 * platform/content/loop.ts — the content generation loop (ADR-037 D2/D3/D4).
 *
 * Runs a content type's generation inside executeAgent, so every generation is a traced trajectory
 * (D2). Fail-closed by construction (D3/P11): an orchestrator error, an open circuit breaker (the
 * orchestrator throws when open, ADR-015), a parse failure, or schema-invalid output each drive the
 * consumer's static-template fallback; a run that never completes falls back too. The generated
 * content is then screened through the Guardian before it can surface (D4/P4): a block, an escalate,
 * or a screening error withholds it and yields the static template. The static template is authored,
 * safe-by-construction content and is never re-screened. Content is generated fresh — no memory (D7).
 */
import { getOrchestrator } from "@/platform/ai";
import { executeAgent } from "@/platform/agents/runtime";
import type { WorkflowFn, StepOutcome, WorkflowContext } from "@/platform/agents/runtime";
import { isValidSchema } from "@/platform/agents/schema";
import { screenContent } from "@/platform/moderation/middleware";
import type { ContentType } from "./types";

export interface ContentScope {
  readonly type: "group" | "user" | "platform";
  readonly id: string | undefined;
}

export type ContentFallbackReason =
  | "orchestrator-error"
  | "parse-error"
  | "schema-invalid"
  | "run-incomplete"
  | "screening-blocked";

export interface ContentResult<TContent> {
  readonly content: TContent;
  readonly usedFallback: boolean;
  readonly trajectoryId: string;
  /** Set iff the fallback fired; names which stage failed (observability). */
  readonly fallbackReason?: ContentFallbackReason;
}

export async function generateContent<TInput, TContent>(
  contentType: ContentType<TInput, TContent>,
  input: TInput,
  scope: ContentScope
): Promise<ContentResult<TContent>> {
  let candidate: TContent | undefined;
  let fallbackReason: ContentFallbackReason | undefined;

  const workflow: WorkflowFn = async (ctx: WorkflowContext): Promise<StepOutcome> => {
    let text: string | undefined;

    // Stage 1 — orchestration. Any throw here is an orchestrator error or an open breaker.
    try {
      const request = contentType.build(input);
      const response = await getOrchestrator().complete(request, {
        useCase: `content:${contentType.name}`,
        requestId: ctx.trajectoryId,
      });
      const block = response.content.find((b) => b.type === "text");
      if (!block || block.type !== "text") {
        throw new Error("content: no text block in response");
      }
      text = block.text;
    } catch {
      fallbackReason = "orchestrator-error";
    }

    // Stage 2 — parse. Stage 3 — schema validation (P6).
    if (text !== undefined) {
      try {
        const parsed = contentType.parse(text);
        if (isValidSchema(contentType.schema, parsed)) {
          candidate = parsed;
        } else {
          fallbackReason = "schema-invalid";
        }
      } catch {
        fallbackReason = "parse-error";
      }
    }

    return {
      action: "content-generate",
      boundary: "cognition",
      input: { contentType: contentType.name },
      output: {
        produced: candidate !== undefined,
        fallbackReason: fallbackReason ?? null,
      },
      costUsd: 0,
      continueExecution: false,
    };
  };

  const exec = await executeAgent(
    contentType.agentId,
    `content-${contentType.name}`,
    scope.type,
    scope.id,
    workflow
  );

  let content: TContent | undefined;
  if (!exec.success || candidate === undefined) {
    // Post-run guard (D3): a run that did not complete produced no candidate.
    fallbackReason = fallbackReason ?? "run-incomplete";
  } else {
    // Stage 4 — screen before surfacing (D4/P4). Fail-closed: a block, an escalate, or a
    // screening error withholds the generated content and yields the static template.
    try {
      const verdict = await screenContent(contentType.toScreenText(candidate), {
        direction: "output",
        requestId: exec.trajectoryId,
      });
      if (verdict.action === "block" || verdict.action === "escalate") {
        fallbackReason = "screening-blocked";
      } else {
        content = candidate;
      }
    } catch {
      fallbackReason = "screening-blocked";
    }
  }

  if (content === undefined) {
    content = contentType.renderFallback(input);
  }

  return {
    content,
    usedFallback: fallbackReason !== undefined,
    trajectoryId: exec.trajectoryId,
    fallbackReason,
  };
}
