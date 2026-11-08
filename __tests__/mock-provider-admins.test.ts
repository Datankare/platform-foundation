/**
 * __tests__/mock-provider-admins.test.ts — the test double's two administrators (TASK-202)
 *
 * The E2E admin walk needs two administrators (one asks, another approves: dual control). The mock
 * provider knows them by token only; any other token is no one. The environment contract refuses
 * the mock provider off the ci and local hosts (ADR-050 D1; environment-contract tests).
 */
import {
  createMockAuthProvider,
  MOCK_EXTRA_IDENTITIES,
} from "@/platform/auth/mock-provider";

describe("the test double's administrators", () => {
  it("each token verifies as its own identity, with a second factor and its own session", async () => {
    const auth = createMockAuthProvider();
    const a = await auth.verifyToken("mock-access-token:admin-a");
    const b = await auth.verifyToken("mock-access-token:admin-b");
    expect(a).toMatchObject({
      sub: MOCK_EXTRA_IDENTITIES["mock-access-token:admin-a"].sub,
      email: "admin-a@e2e.test",
      mfaEnabled: true,
      emailVerified: true,
    });
    expect(b?.sub).toBe(MOCK_EXTRA_IDENTITIES["mock-access-token:admin-b"].sub);
    expect(a?.sessionId).not.toBe(b?.sessionId);
  });

  it("[hostile:id-spelling] another spelling of a token, or an inherited property name, is no one", async () => {
    const auth = createMockAuthProvider();
    for (const token of [
      "mock-access-token:ADMIN-A",
      "mock-access-token:admin-c",
      "__proto__",
      "constructor",
    ])
      expect(await auth.verifyToken(token)).toBeNull();
  });
});
