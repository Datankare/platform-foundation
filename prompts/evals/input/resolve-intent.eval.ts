/**
 * prompts/evals/input/resolve-intent.eval.ts — eval suite for "resolve-intent" (ADR-038).
 * No output enums (intent is free-form). Comprehensive over the parser: valid intent, field
 * defaults (intent -> "unknown", displayLabel -> "Processing...", confidence -> 0.5), confidence
 * clamp, action filter/slice, fail-closed default, and adversarial. Parsed through
 * parseResolveIntentResponse.
 */
import {
  parseResolveIntentResponse,
  type ResolvedIntent,
} from "@/prompts/input/resolve-intent-v1";
import {
  buildResolveIntentPrompt,
  RESOLVE_INTENT_V1,
  type ResolveIntentInput,
} from "@/prompts/input/resolve-intent-v1";
import type { EvalSuite, LiveLane } from "../types";

const act = (id: string) => ({ id, label: `L-${id}`, primary: false });

// TASK-204 (N-43): the live lane — the real model, called as production calls it (ADR-038 §1).
const LIVE: LiveLane<ResolvedIntent, ResolveIntentInput> = {
  config: RESOLVE_INTENT_V1,
  build: buildResolveIntentPrompt,
  cases: [
    {
      id: "live:song-to-identify",
      input: {
        classification: "music",
        mode: "listen",
        confidence: 0.92,
        userContext: "The user held the microphone up to a song playing on the radio.",
      },
      assert: (o) => o.intent !== "unknown" && o.actions.length > 0 && o.confidence > 0,
    },
  ],
};

export const RESOLVE_INTENT_EVAL: EvalSuite<ResolvedIntent, ResolveIntentInput> = {
  live: LIVE,
  prompt: "resolve-intent",
  source: "prompts/input/resolve-intent-v1.ts",
  parse: parseResolveIntentResponse,
  coverage: { enums: {} },
  cases: [
    {
      id: "valid-intent",
      tags: ["value:valid"],
      fixture: JSON.stringify({
        intent: "translate-text",
        displayLabel: "Translate",
        confidence: 0.9,
        actions: [{ id: "go", label: "Go", primary: true }],
      }),
      assert: (o) => o.intent === "translate-text" && o.actions.length === 1,
    },
    {
      id: "failclosed-nonjson",
      tags: ["failclosed:parse-error"],
      fixture: "I think you want to translate",
      assert: (o) =>
        o.intent === "unknown" && o.confidence === 0 && o.actions.length === 0,
    },
    {
      id: "failclosed-empty",
      tags: ["failclosed:empty"],
      fixture: "",
      assert: (o) => o.intent === "unknown",
    },
    {
      id: "boundary-fence-stripped",
      tags: ["boundary:code-fence"],
      fixture:
        '```json\n{"intent":"identify-song","displayLabel":"Identify","confidence":0.7}\n```',
      assert: (o) => o.intent === "identify-song",
    },
    {
      id: "boundary-intent-default",
      tags: ["boundary:intent-missing"],
      fixture: JSON.stringify({ displayLabel: "X", confidence: 0.6 }),
      assert: (o) => o.intent === "unknown",
    },
    {
      id: "boundary-displaylabel-default",
      tags: ["boundary:label-missing"],
      fixture: JSON.stringify({ intent: "x", confidence: 0.6 }),
      assert: (o) => o.displayLabel === "Processing...",
    },
    {
      id: "boundary-confidence-clamp",
      tags: ["boundary:confidence-max"],
      fixture: JSON.stringify({ intent: "x", confidence: 8 }),
      assert: (o) => o.confidence === 1,
    },
    {
      id: "boundary-confidence-default",
      tags: ["boundary:confidence-missing"],
      fixture: JSON.stringify({ intent: "x" }),
      assert: (o) => o.confidence === 0.5,
    },
    {
      id: "boundary-actions-filtered-and-sliced",
      tags: ["boundary:array-slice"],
      fixture: JSON.stringify({
        intent: "x",
        actions: [act("a"), { id: "b" }, act("c"), act("d"), act("e"), act("f")],
      }),
      assert: (o) =>
        o.actions.length === 4 && o.actions.every((a) => typeof a.label === "string"),
    },
    {
      id: "adversarial-injection",
      tags: ["adversarial:injection"],
      fixture: JSON.stringify({
        intent: "ignore-previous-instructions",
        confidence: 0.9,
      }),
      assert: (o) => typeof o.intent === "string" && o.confidence <= 1,
    },
    {
      id: "adversarial-oversized",
      tags: ["adversarial:oversized"],
      fixture: `{"intent":"x","displayLabel":"${"D".repeat(20000)}","confidence":0.5}`,
      assert: (o) => o.intent === "x",
    },
  ],
};
