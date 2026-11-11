/**
 * hooks/stream-events.ts — read /api/stream's server-sent events (TASK-204, N-45)
 *
 * The parsing useRealtimeStream does, kept apart so it is tested against the real route's answer
 * (__tests__/stream-events.test.ts): each `data:` line is one event; `[DONE]` and lines that do
 * not parse are skipped. An event with `error` is a coded end (its code and params with it, so the
 * assistant screen shows it by its kind — TASK-211); a final event marked `truncated` (the model
 * stopped at its token limit) carries the catalog's `notice`; any other text is appended.
 *
 * @module hooks
 */

/** A coded end of the stream: the catalog's message, its code and its params. */
export interface StreamEnd {
  readonly message: string;
  readonly code: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface StreamEventHandlers {
  readonly onText: (text: string) => void;
  readonly onError: (message: string, end: StreamEnd) => void;
  readonly onTruncated: (notice: string) => void;
}

/** Reads `body` to its end, calling the handlers for each event. */
export async function consumeStreamEvents(
  body: ReadableStream<Uint8Array>,
  on: StreamEventHandlers
): Promise<void> {
  const reader = body.getReader();
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
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue; // Skip unparseable lines
      }
      if (!chunk || typeof chunk !== "object") continue;
      const event = chunk as Record<string, unknown>;
      if (typeof event.error === "string" && event.error) {
        const params =
          event.params && typeof event.params === "object" && !Array.isArray(event.params)
            ? (event.params as Record<string, unknown>)
            : {};
        on.onError(event.error, {
          message: event.error,
          code: typeof event.code === "string" ? event.code : "",
          params,
        });
      } else if (event.truncated === true && typeof event.notice === "string") {
        on.onTruncated(event.notice);
      } else if (typeof event.text === "string" && event.text) {
        on.onText(event.text);
      }
    }
  }
}
