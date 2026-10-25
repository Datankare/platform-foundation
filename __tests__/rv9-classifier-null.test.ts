/**
 * __tests__/rv9-classifier-null.test.ts — A null optional field is an absent one (review 9 M3)
 *
 * The reviewer's proof (review9/__tests__/rv9/classify.test.ts): a safe answer carrying
 * "reason": null was read as "not fully readable" and marked unjudged, so a well-formed safe
 * verdict never cleared. `reason` is the classifier answer's only optional field: null now means
 * no reason given. The required fields stay strict — null, or an unknown value, is not a verdict.
 */
import { parseClassifierResponse } from "@/prompts/safety/classify-v1";
import { isJudgement } from "@/platform/moderation/guardian";

const judged = (raw: string) => isJudgement(parseClassifierResponse(raw));

describe("an optional field given as null", () => {
  it.each([
    '{"safe":true,"categories":[],"confidence":0.98,"severity":"low","reason":null}',
    '{"safe":true,"categories":[],"confidence":0.98,"severity":"low","reason":""}',
    '{"safe":true,"categories":[],"confidence":1,"severity":"low"} ',
  ])("is a judgement: %s", (raw) => {
    const out = parseClassifierResponse(raw);
    expect(isJudgement(out)).toBe(true);
    expect(out).toMatchObject({ safe: true, categories: [], severity: "low" });
    expect(out.reason ?? "").toBe("");
  });

  it("a null reason on an unsafe answer is a judgement too", () => {
    const out = parseClassifierResponse(
      '{"safe":false,"categories":["hate"],"confidence":0.9,"severity":"high","reason":null}'
    );
    expect(isJudgement(out)).toBe(true);
    expect(out).toMatchObject({ safe: false, categories: ["hate"], severity: "high" });
  });
});

describe("the required fields stay strict", () => {
  it.each([
    '{"safe":null,"categories":[],"confidence":0.9,"severity":"low"}',
    '{"safe":true,"categories":null,"confidence":0.9,"severity":"low"}',
    '{"safe":true,"categories":[],"confidence":null,"severity":"low"}',
    '{"safe":true,"categories":[],"confidence":0.9,"severity":null}',
    '{"safe":true,"categories":[],"confidence":0.98,"severity":"none"}',
    '{"safe":true,"categories":[],"confidence":0.9,"severity":"low","reason":5}',
    // A duplicated key: JSON keeps the last ("safe": true) — with a category, never safe.
    '{"safe":false,"categories":["hate"],"confidence":0.9,"severity":"critical","safe":true}',
  ])("not a judgement, never safe: %s", (raw) => {
    const out = parseClassifierResponse(raw);
    expect(judged(raw)).toBe(false);
    expect(out.safe).toBe(false);
  });

  it("an unsafe verdict without categories is still a judgement", () => {
    expect(
      judged('{"safe":false,"categories":[],"confidence":0.9,"severity":"critical"}')
    ).toBe(true);
  });
});
