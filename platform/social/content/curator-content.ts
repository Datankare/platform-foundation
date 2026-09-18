/**
 * platform/social/content/curator-content.ts — Curator as the ADR-037 reference content type.
 *
 * Brings the Curator digest under the content-generation framework: the digest is generated on the
 * ADR-039 runtime, schema-validated, and — the gap this closes — SCREENED through the Guardian
 * before it can surface (ADR-037 D4). Fail-closed to an empty digest (D3 / P11). Reuses the existing
 * "curator" agent (ADR-039) and the eval-gated "curator" prompt (ADR-038).
 *
 * The multi-step createCuratorWorkflow (platform/social/agents/curator.ts) is retained as the seam
 * Curator grows into when it gains tool use, content scoring, or reading-history memory — the
 * single-step content path cannot host that (see ADR-037 "Known limitations").
 */
import {
  CURATOR_V1,
  buildCuratorPrompt,
  parseCuratorResponse,
} from "@/prompts/social/curator-v1";
import type { CuratorInput, DigestItem } from "@/prompts/social/curator-v1";
import type { AIRequest } from "@/platform/ai/types";
import type { ContentType } from "@/platform/content/types";
import type { ContentScope } from "@/platform/content/loop";
import { generateContent } from "@/platform/content/loop";
import { registerContentType, hasContentType } from "@/platform/content/registry";

const DIGEST_ITEM_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    priority: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["title", "summary", "priority"],
  additionalProperties: false,
} as const;

/** Curator as a content type — the ADR-037 reference. Host = the existing "curator" agent. */
export const CURATOR_CONTENT_TYPE: ContentType<CuratorInput, readonly DigestItem[]> = {
  name: CURATOR_V1.name, // "curator" — the eval-gated prompt (ADR-038)
  agentId: "curator",
  build: (input): AIRequest => ({
    tier: CURATOR_V1.tier,
    messages: [{ role: "user", content: buildCuratorPrompt(input) }],
    maxTokens: CURATOR_V1.maxTokens,
    temperature: CURATOR_V1.temperature,
  }),
  parse: (raw) => parseCuratorResponse(raw),
  schema: { type: "array", items: DIGEST_ITEM_SCHEMA },
  renderFallback: () => [], // empty digest — the safe static template (D3 / P11)
  toScreenText: (digest) => digest.map((d) => `${d.title}\n${d.summary}`).join("\n\n"),
};

/**
 * Generate a screened content digest — the canonical path (ADR-037). No activity means no LLM call
 * and an empty digest (P12); otherwise the digest is generated and screened before it surfaces. A
 * screening block, a model failure, or invalid output all yield an empty digest.
 */
export async function generateCuratorDigest(
  input: CuratorInput,
  scope: ContentScope = { type: "group", id: input.groupName }
): Promise<readonly DigestItem[]> {
  if (input.recentActivity.length === 0) {
    return [];
  }
  const result = await generateContent(CURATOR_CONTENT_TYPE, input, scope);
  return result.content;
}

/** Register the platform's reference social content types. Idempotent; called at boot. */
export function registerSocialContentTypes(): void {
  if (!hasContentType(CURATOR_CONTENT_TYPE.name)) {
    registerContentType(CURATOR_CONTENT_TYPE);
  }
}
