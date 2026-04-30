/**
 * platform/social/agents/analyst.ts — Group health analysis agent
 *
 * Analyzes group health metrics and detects anomalies.
 * Runs on schedule — not triggered by user actions.
 *
 * P2:  Multi-step: gather metrics → LLM analyze
 * P6:  Structured health report output
 * P11: Parse failure → unknown health status
 * P12: Standard tier for nuanced analysis
 *
 * @module platform/social/agents
 */

import type { WorkflowFn, StepOutcome, WorkflowContext } from "@/platform/agents/runtime";
import type { Orchestrator } from "@/platform/ai/orchestrator";
import type { AIResponse } from "@/platform/ai/types";
import {
  ANALYST_V1,
  buildAnalystPrompt,
  parseAnalystResponse,
} from "@/prompts/social/analyst-v1";
import type { AnalystInput, HealthReport } from "@/prompts/social/analyst-v1";
import { estimateCost } from "@/platform/ai/instrumentation";

/** Result of the analyst workflow */
export interface AnalystResult {
  readonly report: HealthReport;
}

/**
 * Create an analyst workflow function.
 *
 * Step 0 (cognition): Validate group metrics.
 * Step 1 (cognition): LLM analyzes health.
 */
/**
 * Create an analyst workflow function.
 *
 * Returns { workflow, getResult } — workflow is the step function passed to
 * executeAgent(); getResult() returns the health report after execution
 * completes (closure-based result extraction).
 *
 * The 2-step structure is intentionally simple. As analyst gains trend
 * comparison (previous report vs current, P16) and anomaly escalation
 * (alert Guardian on threshold breach), steps will diverge.
 *
 * Step 0 (cognition): Validate group metrics.
 * Step 1 (cognition): LLM analyzes health.
 */
export function createAnalystWorkflow(
  input: AnalystInput,
  orchestrator: Orchestrator
): { workflow: WorkflowFn; getResult: () => AnalystResult } {
  let report: HealthReport = {
    status: "unknown",
    score: 0,
    insights: [],
    anomalies: [],
  };

  const workflow: WorkflowFn = async (context: WorkflowContext): Promise<StepOutcome> => {
    switch (context.stepCount) {
      case 0: {
        return {
          action: "gather-metrics",
          boundary: "cognition",
          input: {
            groupName: input.groupName,
            memberCount: input.memberCount,
          },
          output: { metricsReady: true },
          costUsd: 0,
          continueExecution: true,
        };
      }
      case 1: {
        const prompt = buildAnalystPrompt(input);
        const response: AIResponse = await orchestrator.complete(
          {
            tier: ANALYST_V1.tier,
            messages: [{ role: "user", content: prompt }],
            maxTokens: ANALYST_V1.maxTokens,
            temperature: ANALYST_V1.temperature,
          },
          { useCase: ANALYST_V1.name, requestId: context.trajectoryId }
        );

        const raw =
          response.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("") || "{}";

        report = parseAnalystResponse(raw);
        const cost = estimateCost(
          ANALYST_V1.tier,
          response.usage.inputTokens,
          response.usage.outputTokens
        );

        return {
          action: "analyze-health",
          boundary: "cognition",
          input: { groupName: input.groupName },
          output: { status: report.status, score: report.score },
          costUsd: cost,
          continueExecution: false,
        };
      }
      default:
        return {
          action: "done",
          boundary: "cognition",
          input: {},
          output: {},
          costUsd: 0,
          continueExecution: false,
        };
    }
  };

  return { workflow, getResult: () => ({ report }) };
}
