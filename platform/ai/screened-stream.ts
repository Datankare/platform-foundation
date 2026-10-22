/**
 * platform/ai/screened-stream.ts — Release streamed model output only after it is screened
 *
 * /api/stream screened the input and then sent the model's output straight to the client
 * (audit X-11), so anything the model produced — however it was prompted — reached the user
 * unscreened. screenStream holds the output back in windows: each window is screened (with the
 * tail of what was already released, so a term split across two windows is still seen) before
 * any of it is released. The first window that fails ends the stream with a "rejected" event;
 * a screening error ends it as "failed" — never as released text (fail closed). Nothing the
 * screen has not passed is ever yielded.
 *
 * The screen is a parameter, so an app can use its own moderation (or the platform's,
 * lib/safety checkOutputSafety).
 *
 * GenAI Principles: P3 (safety at I/O), P11 (fail-closed)
 *
 * @module platform/ai
 */

import type { AIStreamChunk } from "./types";

/** Is this text safe to show? Throwing counts as "no". */
export type OutputScreen = (text: string) => Promise<boolean>;

/** Characters held back and screened together. */
export const OUTPUT_SCREEN_WINDOW = 400;
/** Characters of already-released text screened again with the next window. */
export const OUTPUT_SCREEN_OVERLAP = 120;

export type ScreenedEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "done"; readonly usage?: AIStreamChunk["usage"] }
  | { readonly kind: "rejected" }
  | { readonly kind: "failed"; readonly error: unknown };

export interface ScreenStreamOptions {
  readonly window?: number;
  readonly overlap?: number;
}

/**
 * Screen a model stream. Yields released text, then exactly one terminal event: done, rejected
 * or failed. Stops reading the source on rejection or failure.
 */
export async function* screenStream(
  source: AsyncIterable<AIStreamChunk>,
  screen: OutputScreen,
  options: ScreenStreamOptions = {}
): AsyncGenerator<ScreenedEvent> {
  const window = Math.max(1, options.window ?? OUTPUT_SCREEN_WINDOW);
  const overlap = Math.max(0, options.overlap ?? OUTPUT_SCREEN_OVERLAP);
  let pending = "";
  let tail = "";

  // Screen what is pending; true when it may be released.
  const pass = async (): Promise<boolean> => {
    if (!pending) return true;
    return (await screen(tail + pending)) === true;
  };
  const release = (): ScreenedEvent => {
    const text = pending;
    // slice(-0) would keep everything, so an overlap of 0 keeps nothing explicitly.
    tail = overlap > 0 ? (tail + pending).slice(-overlap) : "";
    pending = "";
    return { kind: "text", text };
  };

  try {
    for await (const chunk of source) {
      pending += typeof chunk.text === "string" ? chunk.text : "";
      if (pending.length < window && !chunk.done) continue;
      if (!(await pass())) {
        yield { kind: "rejected" };
        return;
      }
      if (pending) yield release();
      if (chunk.done) {
        yield { kind: "done", usage: chunk.usage };
        return;
      }
    }
    // The source ended without a final chunk: screen what is left, then finish.
    if (!(await pass())) {
      yield { kind: "rejected" };
      return;
    }
    if (pending) yield release();
    yield { kind: "done" };
  } catch (error) {
    yield { kind: "failed", error };
  }
}
