/**
 * __tests__/escalate-withhold-contract.test.ts
 *
 * ADR-041 D4 — callers must treat action "escalate" as a withhold (not-permitted-yet),
 * never as "allow". This pins the shared safety facade so a regression that quietly
 * maps escalate → safe fails here.
 */
jest.mock("@/platform/moderation", () => ({
  screenContent: jest.fn(),
}));

import { classifyContent } from "@/lib/safety";
import { screenContent } from "@/platform/moderation";

const mockScreen = screenContent as jest.Mock;

function result(action: string) {
  // No classifierOutput → classifyContent takes the synthesize branch (safe = allow?).
  return { action, blocklistMatches: [] };
}

describe("ADR-041 D4 — escalate is a withhold, not an allow", () => {
  it("classifyContent marks an escalate result as NOT safe", async () => {
    mockScreen.mockResolvedValue(result("escalate"));
    const out = await classifyContent("x");
    expect(out.safe).toBe(false);
  });

  it("self-test: an allow result IS safe (so the check above can actually fail)", async () => {
    mockScreen.mockResolvedValue(result("allow"));
    const out = await classifyContent("x");
    expect(out.safe).toBe(true);
  });

  it("a block result is also not safe", async () => {
    mockScreen.mockResolvedValue(result("block"));
    const out = await classifyContent("x");
    expect(out.safe).toBe(false);
  });
});
