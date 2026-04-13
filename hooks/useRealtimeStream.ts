/**
 * hooks/useRealtimeStream.ts — AI streaming hook
 *
 * Connects to /api/stream via Server-Sent Events.
 * Returns accumulated text, streaming state, and abort capability.
 *
 * Usage:
 *   const { startStream, text, isStreaming, error, abort } = useRealtimeStream();
 *   startStream("Tell me a story");
 *
 * @module hooks
 */

"use client";

import { useState, useCallback, useRef } from "react";

export interface StreamRequestOptions {
  /** System prompt */
  system?: string;
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
  /** Abort the current stream */
  abort: () => void;
  /** Reset state for a new stream */
  reset: () => void;
}

export function useRealtimeStream(): UseRealtimeStreamResult {
  const [text, setText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  }, [abort]);

  const startStream = useCallback((prompt: string, options?: StreamRequestOptions) => {
    // Abort any existing stream
    abortControllerRef.current?.abort();

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setText("");
    setError(null);
    setIsStreaming(true);

    (async () => {
      try {
        const response = await fetch("/api/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            system: options?.system,
            maxTokens: options?.maxTokens,
            temperature: options?.temperature,
            tier: options?.tier,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error ?? `Stream request failed: ${response.status}`);
        }

        if (!response.body) {
          throw new Error("No response body");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;

            try {
              const chunk = JSON.parse(data);
              if (chunk.error) {
                setError(chunk.error);
              } else if (chunk.text) {
                setText((prev) => prev + chunk.text);
              }
            } catch {
              // Skip unparseable lines
            }
          }
        }
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
  }, []);

  return { startStream, text, isStreaming, error, abort, reset };
}
