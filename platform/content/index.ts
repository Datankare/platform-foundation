/**
 * platform/content — ADR-037 dynamic content generation framework.
 * The platform owns generation, screening, and surfacing; consumers supply
 * build/parse/schema/renderFallback/toScreenText per content type.
 */
export type { ContentType, AnyContentType } from "./types";
export {
  registerContentType,
  getContentType,
  hasContentType,
  listContentTypes,
  resetContentTypes,
} from "./registry";
export { generateContent } from "./loop";
export type { ContentScope, ContentResult, ContentFallbackReason } from "./loop";
