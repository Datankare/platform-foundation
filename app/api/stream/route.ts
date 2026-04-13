/**
 * app/api/stream/route.ts — Server-Sent Events streaming endpoint
 *
 * Edge runtime for low latency. Accepts a prompt, streams AI response
 * through the orchestrator as SSE events.
 *
 * GenAI Principles:
 *   P1  — All AI through orchestration (uses orchestrator.stream())
 *   P2  — Every call instrumented (TTFT, tokens, cost via orchestrator)
 *   P3  — Safety at I/O (accumulated output checked)
 *   P13 — Rate limited (middleware applied)
 *
 * @module app/api/stream
 */

import { NextRequest } from "next/server";
import { getOrchestrator } from "@/platform/ai/orchestrator";
import { logger, generateRequestId } from "@/lib/logger";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const start = Date.now();

  let body: {
    prompt?: string;
    system?: string;
    maxTokens?: number;
    temperature?: number;
    tier?: "fast" | "standard";
  };

  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body.prompt || body.prompt.trim().length === 0) {
    return new Response(JSON.stringify({ error: "Prompt is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const orchestrator = getOrchestrator();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const aiRequest = {
          tier: body.tier ?? ("standard" as const),
          system: body.system,
          messages: [{ role: "user" as const, content: body.prompt! }],
          maxTokens: body.maxTokens ?? 1024,
          temperature: body.temperature,
        };

        for await (const chunk of orchestrator.stream(aiRequest, {
          useCase: "api-stream",
          requestId,
        })) {
          const sseData = JSON.stringify(chunk);
          controller.enqueue(encoder.encode(`data: ${sseData}\n\n`));

          if (chunk.done) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Streaming failed";
        logger.error("Stream error", {
          requestId,
          error: errorMessage,
          route: "/api/stream",
        });
        const errorData = JSON.stringify({
          text: "",
          done: true,
          error: errorMessage,
        });
        controller.enqueue(encoder.encode(`data: ${errorData}\n\n`));
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
