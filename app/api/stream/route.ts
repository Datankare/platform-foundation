/**
 * app/api/stream/route.ts — Server-Sent Events streaming endpoint
 *
 * Accepts a prompt from a signed-in user and streams the AI response through the orchestrator
 * as SSE events. The system prompt is the platform's (prompts/assistant/stream-v1.ts); a caller
 * cannot send one. Output is released only after it is screened (platform/ai/screened-stream),
 * window by window — audit X-11.
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
 *   P3  — Safety at I/O (input screened before the model call; output screened before release)
 *   P5  — Cost-aware (server-side token and tier bounds)
 *   P11 — Fail-closed (unverified callers never reach the model)
 *
 * @module app/api/stream
 */

import { NextRequest } from "next/server";
import { getOrchestrator } from "@/platform/ai/orchestrator";
import { STREAM_FEATURE, validateStreamRequest } from "@/platform/ai/stream-policy";
import { requireActorWithStatus } from "@/platform/auth/actor-guard";
import {
  DEFAULT_RULES,
  enforceDailyPaidQuota,
  enforceRateLimit,
} from "@/platform/rate-limit";
import { apiError, apiErrorBody, readJsonObject } from "@/platform/errors";
import { screenStream } from "@/platform/ai/screened-stream";
import { checkOutputSafety, checkSafety } from "@/lib/safety";
import { buildStreamSystemPrompt } from "@/prompts";
import { logger, generateRequestId } from "@/lib/logger";
import { tenantRoute } from "@/platform/tenancy/route";

export const runtime = "nodejs";

export const POST = tenantRoute(async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const start = Date.now();

  const guard = await requireActorWithStatus(request, STREAM_FEATURE, {
    allowGuests: false,
  });
  if (guard.error) return guard.error;

  // ADR-052: per verified user, before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AI_PER_USER, {
    actorId: guard.actor.id,
  });
  if (limited) return limited;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body;

  const validation = validateStreamRequest(body);
  if (!validation.ok) {
    return apiError(validation.code, { params: validation.params, request });
  }
  const input = validation.input;

  // Before the first paid call (the safety classifier): the daily paid-request quota (audit X-12).
  const quota = await enforceDailyPaidQuota(request, guard.actor.id);
  if (quota) return quota;

  const safety = await checkSafety(input.prompt, {
    requestId,
    ...(guard.actor.kind === "user" ? { userId: guard.actor.id } : {}),
  });
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
  const send = (controller: ReadableStreamDefaultController, event: unknown) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  // A terminal event carrying a coded, catalog-rendered message only.
  const codedEnd = (
    controller: ReadableStreamDefaultController,
    code: "internal.error" | "content.rejected"
  ) => {
    const coded = apiErrorBody(code, { request });
    send(controller, {
      text: "",
      done: true,
      code: coded.code,
      error: coded.message,
      params: coded.params,
    });
  };
  const screenOutput = async (text: string) =>
    (await checkOutputSafety(text, { requestId })).safe;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const aiRequest = {
          tier: input.tier,
          system: buildStreamSystemPrompt(),
          messages: [{ role: "user" as const, content: input.prompt }],
          maxTokens: input.maxTokens,
          temperature: input.temperature,
        };
        const source = orchestrator.stream(aiRequest, {
          useCase: "api-stream",
          requestId,
        });

        for await (const event of screenStream(source, screenOutput)) {
          if (event.kind === "text") {
            send(controller, { text: event.text, done: false });
          } else if (event.kind === "done") {
            send(controller, { text: "", done: true, usage: event.usage });
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } else if (event.kind === "rejected") {
            logger.info("Stream output withheld by content screening", { requestId });
            codedEnd(controller, "content.rejected");
          } else {
            logger.error("Stream error", {
              requestId,
              error:
                event.error instanceof Error ? event.error.message : String(event.error),
              route: "/api/stream",
            });
            // Upstream error text never reaches the client.
            codedEnd(controller, "internal.error");
          }
        }
      } catch (err) {
        logger.error("Stream error", {
          requestId,
          error: err instanceof Error ? err.message : String(err),
          route: "/api/stream",
        });
        codedEnd(controller, "internal.error");
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
});
