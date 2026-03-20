import Anthropic from "@anthropic-ai/sdk";
import { SafetyResult } from "@/types";

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
        content: `You are a content safety classifier. Analyze the following text and respond with ONLY a JSON object. No markdown, no code fences, no explanation.

Text to analyze: "${text}"

Respond with exactly this format:
{"safe": true} if the content is appropriate for all ages (SFW)
{"safe": false, "reason": "brief reason"} if the content is inappropriate (NSFW, sexual, violent, hateful)

JSON only, no backticks, no markdown:`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== "text") {
    return { safe: true };
  }

  try {
    // Strip markdown code fences if present
    const cleaned = content.text
      .trim()
      .replace(/^```json\n?/, "")
      .replace(/^```\n?/, "")
      .replace(/\n?```$/, "")
      .trim();

    const result = JSON.parse(cleaned);
    return result as SafetyResult;
  } catch {
    // Log the unexpected response for debugging
    console.error("Safety parse error. Raw response:", content.text);
    // Default to UNSAFE on parse failure — fail closed, not open
    return { safe: false, reason: "Content could not be verified as safe." };
  }
}
