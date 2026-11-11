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
}
