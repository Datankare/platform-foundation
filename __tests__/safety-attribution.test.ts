/**
 * __tests__/safety-attribution.test.ts — screening knows who is being screened (audit X-5)
 *
 * No AI route passed the user to the safety check, so a block never recorded a strike and an
 * escalation never reached the review queue. checkSafety now passes the signed-in user through
 * to the Guardian's screening context, and omits it for guests (who have no account).
 */

jest.mock("@/platform/moderation", () => ({
  screenContent: jest.fn(async () => ({ action: "allow", blocklistMatches: [] })),
}));

import { screenContent } from "@/platform/moderation";
import { checkOutputSafety, checkSafety } from "@/lib/safety";

const screen = screenContent as jest.Mock;
const USER = "00000000-0000-4000-8000-00000000b001";

beforeEach(() => screen.mockClear());

describe("checkSafety attribution", () => {
  it("passes the signed-in user and request to the screening context", async () => {
    await checkSafety("hello", { requestId: "req-1", userId: USER });
    expect(screen).toHaveBeenCalledWith("hello", {
      direction: "input",
      requestId: "req-1",
      context: { contentType: "generation", contentRatingLevel: 1, userId: USER },
    });
  });

  it("omits the user for a guest", async () => {
    await checkSafety("hello", { requestId: "req-2" });
    expect(screen.mock.calls[0][1].context).not.toHaveProperty("userId");
  });

  it("still accepts a bare request id (backward compatible)", async () => {
    await checkSafety("hello", "req-3");
    expect(screen.mock.calls[0][1].requestId).toBe("req-3");
  });
});

describe("checkOutputSafety (audit X-11)", () => {
  it("screens as model output, attributed to no user", async () => {
    await checkOutputSafety("model text", { requestId: "req-4" });
    expect(screen).toHaveBeenCalledWith("model text", {
      direction: "output",
      requestId: "req-4",
      context: { contentType: "ai-output", contentRatingLevel: 1 },
    });
  });

  it.each([
    ["allow", true],
    ["block", false],
    ["escalate", false],
    ["warn", false],
  ])("treats %s as safe=%s (only an outright allow is shown)", async (action, safe) => {
    screen.mockResolvedValueOnce({ action, blocklistMatches: [], reasoning: "r" });
    expect((await checkOutputSafety("t")).safe).toBe(safe);
  });
});

describe("checkSafety follows the pipeline's final action (release review)", () => {
  it.each([
    ["allow", true],
    ["warn", true],
    ["block", false],
    ["escalate", false],
  ])("action %s with a classifier that said safe → safe=%s", async (action, safe) => {
    screen.mockResolvedValueOnce({
      action,
      blocklistMatches: [],
      classifierOutput: { safe: true, categories: [], confidence: 0.9, severity: "low" },
    });
    expect((await checkSafety("t")).safe).toBe(safe);
  });
});
