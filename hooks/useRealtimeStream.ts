/**
 * hooks/useRealtimeStream.ts — the assistant's streamed answer (/api/stream, ADR-018)
 *
 * Sends a question to /api/stream as the signed-in user (apiFetch: the session's token, renewed
 * once on a 401 — the route serves signed-in users only and verifies the token, TASK-133) and
 * reads the answer as it is written (hooks/stream-events.ts). Used by the assistant screen
 * (components/assistant/AssistantPanel.tsx, /assistant — TASK-211, N-118: until then no screen
 * used it).
 *
 * A refused question is a `refusal` (platform/errors/refusal.ts), shown by its kind: refused before
 * any answer (`refusedAt: "request"` — rejected content, a rate limit, a restricted account) or
 * ended by the server mid-answer (`refusedAt: "stream"` — output withheld by screening, the model
 * declining, the provider failing). A new question, a stop or a reset ends the one before it, and
 * nothing from an ended question reaches the state of the next.
 *
 * Usage:
 *   const { startStream, text, isStreaming, refusal, truncated, abort } = useRealtimeStream();
 *   startStream("Tell me a story");
 *
 * @module hooks
 */

"use client";

import { apiFetch } from "@/platform/auth/api-fetch";
import {
  handleRefusal,
  networkRefusal,
  readRefusal,
  type Refusal,
} from "@/platform/errors/refusal";
import { consumeStreamEvents } from "./stream-events";
import { useState, useCallback, useRef } from "react";

export interface StreamRequestOptions {
  // No system prompt: the server always uses the platform's (audit X-11).
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Temperature (0–1) */
  temperature?: number;
  /** Model tier */
  tier?: "fast" | "standard";
}

export interface UseRealtimeStreamResult {
  /** Start streaming a prompt (ending any stream before it) */
  startStream: (prompt: string, options?: StreamRequestOptions) => void;
  /** Accumulated response text */
  text: string;
  /** Whether streaming is active */
  isStreaming: boolean;
  /** The refused question's message, if it was refused (the refusal's own words) */
  error: string | null;
  /** The refusal, by its kind (platform/errors/refusal.ts); null when not refused. */
  refusal: Refusal | null;
  /** Where it was refused: before any answer, or by the server mid-answer. */
  refusedAt: "request" | "stream" | null;
  /**
   * The answer was cut off at its token limit (TASK-204, N-45): `text` is incomplete, and
   * `notice` says so in the catalog's words. Null while streaming and for a complete answer.
   */
  truncated: { notice: string } | null;
  /** The user stopped the answer before its end: `text` is incomplete. */
  stopped: boolean;
  /** Abort the current stream */
  abort: () => void;
  /** Reset state for a new stream */
  reset: () => void;
}

export function useRealtimeStream(): UseRealtimeStreamResult {
  const [text, setText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [refused, setRefused] = useState<{
    refusal: Refusal;
    at: "request" | "stream";
  } | null>(null);
  const [truncated, setTruncated] = useState<{ notice: string } | null>(null);
  const [stopped, setStopped] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    const controller = abortControllerRef.current;
    abortControllerRef.current = null;
    if (controller) {
      controller.abort();
      setStopped(true);
    }
    setIsStreaming(false);
  }, []);

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsStreaming(false);
    setText("");
    setRefused(null);
    setTruncated(null);
    setStopped(false);
  }, []);

  const startStream = useCallback((prompt: string, options?: StreamRequestOptions) => {
    // End any stream before this one: its events no longer reach the state.
    abortControllerRef.current?.abort();

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const current = () => abortControllerRef.current === controller;

    setText("");
    setRefused(null);
    setTruncated(null);
    setStopped(false);
    setIsStreaming(true);

    (async () => {
      try {
        const response = await apiFetch("/api/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            maxTokens: options?.maxTokens,
            temperature: options?.temperature,
            tier: options?.tier,
          }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          // The refusal's own message, by its code (the shared handler, TASK-181/194).
          const refusal = await readRefusal(response);
          if (current()) setRefused({ refusal, at: "request" });
          return;
        }

        await consumeStreamEvents(response.body, {
          onText: (t) => {
            if (current()) setText((prev) => prev + t);
          },
          onError: (_message, end) => {
            if (!current()) return;
            setRefused({
              refusal: handleRefusal(end.code, {
                message: end.message,
                params: end.params,
              }),
              at: "stream",
            });
          },
          onTruncated: (notice) => {
            if (current()) setTruncated({ notice });
          },
        });
      } catch (err) {
        // A stop or a newer question ended it — not a refusal.
        if (controller.signal.aborted) return;
        if (err instanceof Error && err.name === "AbortError") return;
        if (current()) setRefused({ refusal: networkRefusal(), at: "request" });
      } finally {
        if (current()) {
          setIsStreaming(false);
          abortControllerRef.current = null;
        }
      }
    })();
  }, []);

  return {
    startStream,
    text,
    isStreaming,
    error: refused?.refusal.message ?? null,
    refusal: refused?.refusal ?? null,
    refusedAt: refused?.at ?? null,
    truncated,
    stopped,
    abort,
    reset,
  };
}
