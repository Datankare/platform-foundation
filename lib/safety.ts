import Anthropic from "@anthropic-ai/sdk";
import { SafetyResult } from "@/types";
import { sanitizeForPrompt } from "@/lib/sanitize";
import { logger, generateRequestId } from "@/lib/logger";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function checkSafety(text: string): Promise<SafetyResult> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        // OWASP A03: sanitize user input before embedding in LLM prompt
        content: `You are a content safety classifier. Analyze the following text and respond with ONLY a JSON object. No markdown, no code fences, no explanation.

Text to analyze: ${sanitizeForPrompt(text)}

Respond with exactly this format:
{"safe": true} if the content is appropriate for all ages (SFW)
{"safe": false, "reason": "brief reason"} if the content is inappropriate (NSFW, sexual, violent, hateful)

JSON only, no backticks, no markdown:`,
      },
    ],
  });

  const content = response.content[0];
  if (!content || content.type !== "text") {
    return {
      safe: false,
      reason: "Safety classifier returned unexpected response type.",
    };
  }

  try {
    const cleaned = content.text
      .trim()
      .replace(/^```json\n?/, "")
      .replace(/^```\n?/, "")
      .replace(/\n?```$/, "")
      .trim();

    const result = JSON.parse(cleaned);
    return result as SafetyResult;
  } catch {
    /* justified */
    // Parse failure — fail closed (safe:false)
    const requestId = generateRequestId();
    // OWASP A09: structured logging — never log user content
    logger.error("Safety parse error — fail closed", { requestId, route: "lib/safety" });
    return { safe: false, reason: "Content could not be verified as safe." };
  }
}
