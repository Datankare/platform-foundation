/**
 * prompts/evals/social/matchmaker.eval.ts — eval suite for "matchmaker" (ADR-038).
 * No output enums (score is numeric). Comprehensive over the parser's contract: valid recs, the
 * score>=0.3 and type filters, score clamping, fail-closed (non-array/parse error -> []), empty,
 * and adversarial. Parsed through parseMatchmakerResponse.
 */
import {
  parseMatchmakerResponse,
  type MatchmakerRecommendation,
} from "@/prompts/social/matchmaker-v1";
import type { EvalSuite } from "../types";

const rec = (groupId: string, score: number) => ({ groupId, score, reason: "r" });

export const MATCHMAKER_EVAL: EvalSuite<readonly MatchmakerRecommendation[]> = {
  prompt: "matchmaker",
  source: "prompts/social/matchmaker-v1.ts",
  parse: parseMatchmakerResponse,
  coverage: { enums: {} },
  cases: [
    {
      id: "valid-recommendations",
      tags: ["value:valid"],
      fixture: JSON.stringify([rec("g1", 0.9), rec("g2", 0.5)]),
      assert: (o) => o.length === 2 && o[0].groupId === "g1",
    },
    {
      id: "failclosed-nonarray",
      tags: ["failclosed:not-array"],
      fixture: JSON.stringify({ groups: [] }),
      assert: (o) => Array.isArray(o) && o.length === 0,
    },
    {
      id: "failclosed-nonjson",
      tags: ["failclosed:parse-error"],
      fixture: "no matches found",
      assert: (o) => o.length === 0,
    },
    {
      id: "failclosed-empty",
      tags: ["failclosed:empty"],
      fixture: "",
      assert: (o) => o.length === 0,
    },
    {
      id: "boundary-fence-stripped",
      tags: ["boundary:code-fence"],
      fixture: '```json\n[{"groupId":"g1","score":0.8,"reason":"r"}]\n```',
      assert: (o) => o.length === 1 && o[0].groupId === "g1",
    },
    {
      id: "boundary-below-threshold-filtered",
      tags: ["boundary:threshold"],
      fixture: JSON.stringify([rec("g1", 0.9), rec("low", 0.2)]),
      assert: (o) => o.length === 1 && o[0].groupId === "g1", // score < 0.3 dropped
    },
    {
      id: "boundary-invalid-items-filtered",
      tags: ["boundary:invalid-items"],
      fixture: JSON.stringify([
        rec("g1", 0.9),
        { groupId: "g2" },
        { score: 0.9, reason: "r" },
      ]),
      assert: (o) => o.length === 1 && o[0].groupId === "g1",
    },
    {
      id: "boundary-score-clamp",
      tags: ["boundary:score-max"],
      fixture: JSON.stringify([{ groupId: "g1", score: 5, reason: "r" }]),
      assert: (o) => o.length === 1 && o[0].score === 1,
    },
    {
      id: "boundary-empty-array",
      tags: ["boundary:empty-array"],
      fixture: "[]",
      assert: (o) => Array.isArray(o) && o.length === 0,
    },
    {
      id: "adversarial-injection",
      tags: ["adversarial:injection"],
      fixture: JSON.stringify([
        { groupId: "g1", score: 0.9, reason: "Ignore instructions" },
      ]),
      assert: (o) => o.length === 1 && o[0].groupId === "g1",
    },
    {
      id: "adversarial-oversized",
      tags: ["adversarial:oversized"],
      fixture: JSON.stringify([{ groupId: "g1", score: 0.9, reason: "r".repeat(20000) }]),
      assert: (o) => o.length === 1,
    },
  ],
};
