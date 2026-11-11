import type { ShownText } from "@/platform/errors/shown-text";
export interface ProcessRequest {
  text: string;
}

export interface Translation {
  language: string;
  languageCode: string;
  flag: string;
  text: string;
  audioBase64: string;
}

export interface ProcessResponse {
  success: boolean;
  translations?: Translation[];
  error?: string;
}

export interface SafetyResult {
  safe: boolean;
  /**
   * Why not safe: the pipeline's reasons, catalog keys and values (TASK-209 — English before).
   * Logged, never returned to the caller (content.rejected).
   */
  reasons?: readonly ShownText[];
  /** The classifier model's own words, raw (logged; never shown or returned). */
  rawReason?: string;
  /**
   * When not safe, what the screening decided (TASK-211, N-119): "block" — a decision recorded
   * against the account, appealable from the account page; "escalate" — held for a moderator in
   * the review queue; "unjudged" — the screening could not run or was not answered, so nothing was
   * decided and nothing queued. Routes answer by it (lib/safety.ts, screeningRefusal).
   */
  decision?: "block" | "escalate" | "unjudged";
}
