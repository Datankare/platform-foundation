/**
 * app/api/stream/route.ts — Server-Sent Events streaming endpoint
 *
 * Accepts a prompt from a signed-in user and streams the AI response through the orchestrator
 * as SSE events.
 *
 * The proxy only checks that credentials are present; this handler verifies them
 * (requireActorWithStatus — signed-in users only, governed by account status under the
 * `stream` feature). Every field the caller may send is bounded server-side
 * (platform/ai/stream-policy), and the input is screened before any model call. Errors are coded
 * (ADR-051); an upstream failure is logged in full and reported to the client by code only.
 *
 * GenAI Principles:
 *   P1  — All AI through orchestration (uses orchestrator.stream())
 *   P2  — Every call instrumented (TTFT, tokens, cost via orchestrator)
 *   P3  — Safety at I/O (input screened before the model call)
 *   P5  — Cost-aware (server-side token and tier bounds)
 *   P11 — Fail-closed (unverified callers never reach the model)
 *
 * @module app/api/stream
 */

import { NextRequest } from "next/server";
import { getOrchestrator } from "@/platform/ai/orchestrator";
import { STREAM_FEATURE, validateStreamRequest } from "@/platform/ai/stream-policy";
import { requireActorWithStatus } from "@/platform/auth/actor-guard";
import { apiError, apiErrorBody } from "@/platform/errors";
import { checkSafety } from "@/lib/safety";
import { logger, generateRequestId } from "@/lib/logger";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const start = Date.now();

  const guard = await requireActorWithStatus(request, STREAM_FEATURE, {
    allowGuests: false,
  });
  if (guard.error) return guard.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("request.invalid_json", { request });
  }

  const validation = validateStreamRequest(body);
  if (!validation.ok) {
    return apiError(validation.code, { params: validation.params, request });
  }
  const input = validation.input;

  const safety = await checkSafety(
    input.system ? `${input.system}\n${input.prompt}` : input.prompt
  );
  if (!safety.safe) {
    // The classifier's reason may quote matched terms: it goes to the log, not the response.
    logger.info("Stream input rejected by content screening", {
      requestId,
      reason: safety.reason,
    });
    return apiError("content.rejected", { request });
  }

  const orchestrator = getOrchestrator();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const aiRequest = {
          tier: input.tier,
          system: input.system,
          messages: [{ role: "user" as const, content: input.prompt }],
          maxTokens: input.maxTokens,
          temperature: input.temperature,
        };

        for await (const chunk of orchestrator.stream(aiRequest, {
          useCase: "api-stream",
          requestId,
        })) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          if (chunk.done) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
        }
      } catch (err) {
        logger.error("Stream error", {
          requestId,
          error: err instanceof Error ? err.message : String(err),
          route: "/api/stream",
        });
        // Coded, catalog-rendered message only — upstream error text never reaches the client.
        const coded = apiErrorBody("internal.error", { request });
        const errorEvent = {
          text: "",
          done: true,
          code: coded.code,
          error: coded.message,
          params: coded.params,
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
      } finally {
        logger.response("/api/stream", "POST", 200, requestId, Date.now() - start);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Request-Id": requestId,
    },
  });
}
