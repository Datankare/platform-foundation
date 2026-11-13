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

  it("the moderation journey's moderator and member are their own identities (TASK-210)", async () => {
    const auth = createMockAuthProvider();
    const m = await auth.verifyToken("mock-access-token:moderator-m");
    const u = await auth.verifyToken("mock-access-token:member-u");
    expect(m).toMatchObject({
      sub: "e2e00000-0000-4000-8000-00000000000d",
      email: "moderator-m@e2e.test",
    });
    expect(u).toMatchObject({
      sub: "e2e00000-0000-4000-8000-00000000000e",
      email: "member-u@e2e.test",
    });
    expect(new Set([m?.sessionId, u?.sessionId]).size).toBe(2);
  });

  it("the assistant journey's asker is its own identity (TASK-211)", async () => {
    const auth = createMockAuthProvider();
    const q = await auth.verifyToken("mock-access-token:asker-q");
    const u = await auth.verifyToken("mock-access-token:member-u");
    const d = await auth.verifyToken("mock-access-token");
    expect(q).toMatchObject({
      sub: "e2e00000-0000-4000-8000-00000000000f",
      email: "asker-q@e2e.test",
    });
    expect(new Set([q?.sub, u?.sub, d?.sub]).size).toBe(3);
  });

  it("the session journey's person with two devices is its own identity, and every identity's subject is distinct (TASK-214)", async () => {
    const auth = createMockAuthProvider();
    const d = await auth.verifyToken("mock-access-token:devices-d");
    expect(d).toMatchObject({
      sub: "e2e00000-0000-4000-8000-0000000000d2",
      email: "devices-d@e2e.test",
    });
    // Ending this person's sessions ("sign out everywhere") is ending no one else's: no other
    // identity shares the subject, the default user's included.
    const subjects = [
      (await auth.verifyToken("mock-access-token"))?.sub,
      ...Object.values(MOCK_EXTRA_IDENTITIES).map((identity) => identity.sub),
    ];
    expect(new Set(subjects).size).toBe(subjects.length);
    // They sign in by their address, as the journeys do.
    const signedIn = await auth.signIn("devices-d@e2e.test", "a-journey-password");
    expect(signedIn).toMatchObject({ success: true, userId: d?.sub });
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
