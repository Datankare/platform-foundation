/**
 * lib/output-screening.ts — what a model or a third party produced is screened before a caller
 * sees it (audit D-17)
 *
 * The platform screens its streamed output window by window (/api/stream: screenStream, X-11).
 * Every route that returns whole text a model or a third-party service produced — translations
 * (platform-foundation's and Playform's /api/process, Playform's /api/translate/dispatch and its
 * agent workflows), a transcript (/api/transcribe), text extracted from a file or a recording
 * (/api/extract), a song match's title and artist (Playform's /api/identify) — runs it through the
 * platform's output screen (checkOutputSafety: direction "output", the strictest rating) and
 * withholds the whole response when it is not allowed (`content.withheld`, TASK-211; the classifier's reason
 * logged, never returned). TASK-204 (N-47) moved this helper from Playform to the platform, which
 * has a route of its own that needs it.
 *
 * Fail closed: a screen that cannot run (the classifier is down, it throws) withholds, as the
 * platform's screen does (ADR-016). One screening call per response — the texts are joined —
 * so a response with ten translations costs one classifier call, not ten.
 *
 * @module lib
 */

import { checkOutputSafety } from "@/lib/safety";
import { logger } from "@/lib/logger";

/** How deep and how much of a structured output is collected (bounded work, ring 7). */
const MAX_DEPTH = 6;
const MAX_STRINGS = 200;

/** Every string in `value` (objects and arrays walked, bounded), in order. */
export function textsOf(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (out.length >= MAX_STRINGS || depth > MAX_DEPTH) return;
    if (typeof v === "string") {
      if (v.trim()) out.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
    } else if (v && typeof v === "object") {
      for (const item of Object.values(v as Record<string, unknown>))
        walk(item, depth + 1);
    }
  };
  walk(value, 0);
  return out;
}

/**
 * Whether `texts` may be shown: true when there is nothing to screen, or the platform's output
 * screen allows them; false when it does not, or cannot say.
 * @external Calls the safety classifier (the AI model provider).
 */
export async function isOutputAllowed(
  texts: readonly string[],
  context: { requestId: string; route: string }
): Promise<boolean> {
  const text = texts.filter((t) => t.trim()).join("\n");
  if (!text) return true;
  try {
    const result = await checkOutputSafety(text, { requestId: context.requestId });
    if (!result.safe) {
      // The reason may quote the output: the log only.
      logger.info("Output withheld by content screening", {
        requestId: context.requestId,
        route: context.route,
        reasons: result.reasons,
      });
    }
    return result.safe;
  } catch (err) {
    logger.warn("Output screening unavailable: output withheld", {
      requestId: context.requestId,
      route: context.route,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** The translated texts of a translation result list. */
export const translatedTexts = (
  translations: ReadonlyArray<{ readonly translated?: unknown }>
): string[] =>
  translations.flatMap((t) => (typeof t.translated === "string" ? [t.translated] : []));
