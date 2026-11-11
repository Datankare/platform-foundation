/**
 * hooks/useRealtimeStream.ts — AI streaming hook
 *
 * Connects to /api/stream via Server-Sent Events.
 * Returns accumulated text, streaming state, and abort capability.
 *
 * The route serves signed-in users only and verifies the token (TASK-133), so pass the
 * caller's access token getter.
 *
 * Usage:
 *   const { startStream, text, isStreaming, error, abort } = useRealtimeStream({
 *     getAccessToken: () => session.accessToken,
 *   });
 *   startStream("Tell me a story");
 *
 * @module hooks
 */

"use client";

import { readRefusal } from "@/platform/errors/refusal";
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
  /** Start streaming a prompt */
  startStream: (prompt: string, options?: StreamRequestOptions) => void;
  /** Accumulated response text */
  text: string;
  /** Whether streaming is active */
  isStreaming: boolean;
  /** Error message if streaming failed */
  error: string | null;
  /**
   * The answer was cut off at its token limit (TASK-204, N-45): `text` is incomplete, and
   * `notice` says so in the catalog's words. Null while streaming and for a complete answer.
   */
  truncated: { notice: string } | null;
  /** Abort the current stream */
  abort: () => void;
  /** Reset state for a new stream */
  reset: () => void;
}

export interface UseRealtimeStreamOptions {
  /** Returns the signed-in user's access token, sent as a Bearer credential. */
  getAccessToken?: () => string | null | Promise<string | null>;
}

export function useRealtimeStream(
  hookOptions: UseRealtimeStreamOptions = {}
): UseRealtimeStreamResult {
  const { getAccessToken } = hookOptions;
  const [text, setText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState<{ notice: string } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsStreaming(false);
  }, []);

  const reset = useCallback(() => {
    abort();
    setText("");
    setError(null);
    setTruncated(null);
  }, [abort]);

  const startStream = useCallback(
    (prompt: string, options?: StreamRequestOptions) => {
      // Abort any existing stream
      abortControllerRef.current?.abort();

      const controller = new AbortController();
      abortControllerRef.current = controller;

      setText("");
      setError(null);
      setTruncated(null);
      setIsStreaming(true);

      (async () => {
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          const token = getAccessToken ? await getAccessToken() : null;
          if (token) headers.Authorization = `Bearer ${token}`;
          const response = await fetch("/api/stream", {
            method: "POST",
            headers,
            body: JSON.stringify({
              prompt,
              maxTokens: options?.maxTokens,
              temperature: options?.temperature,
              tier: options?.tier,
            }),
            signal: controller.signal,
          });

          if (!response.ok) {
            // The refusal's own message, by its code (the shared handler, TASK-181/194).
            throw new Error((await readRefusal(response)).message);
          }

          if (!response.body) {
            throw new Error("No response body");
          }

          await consumeStreamEvents(response.body, {
            onText: (t) => setText((prev) => prev + t),
            onError: setError,
            onTruncated: (notice) => setTruncated({ notice }),
          });
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            // User cancelled — not an error
            return;
          }
          setError(err instanceof Error ? err.message : "Streaming failed");
        } finally {
          setIsStreaming(false);
          abortControllerRef.current = null;
        }
      })();
    },
    [getAccessToken]
  );

  return { startStream, text, isStreaming, error, truncated, abort, reset };
}
