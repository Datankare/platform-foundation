/**
 * TASK-176 — users.email_verified brought up to date from the provider's verified claim
 * (platform/auth/email-verification.ts): the rule, and the write's failure modes. Against
 * Postgres (sign-up → confirm → sign-in, concurrency, no write per request):
 * __tests__/db/email-verification.db.test.ts.
 */
import {
  syncEmailVerification,
  trustedVerifiedClaim,
  verificationDecision,
} from "@/platform/auth/email-verification";
import { getTrustedEmailIdps } from "@/platform/providers/environment-contract";
import { recordAudit } from "@/platform/auth/audit";

jest.mock("@/lib/logger", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const query = jest.fn();
jest.mock("@/platform/data", () => ({
  withTenantTx: async (fn: (tx: { query: typeof query }) => Promise<unknown>) =>
    fn({ query }),
}));
jest.mock("@/platform/auth/audit", () => ({
  recordAudit: jest.fn(async () => undefined),
}));
const mockAudit = recordAudit as jest.MockedFunction<typeof recordAudit>;

const ID = "0f0e0d0c-0b0a-4000-8000-0000000000bb";
const unverified = { email: "ann@example.com", verified: false };

beforeEach(() => {
  query.mockReset();
  mockAudit.mockReset();
  mockAudit.mockResolvedValue(undefined);
});

describe("verificationDecision", () => {
  it.each([
    [
      "the same address, verified",
      unverified,
      { email: "ann@example.com", emailVerified: true, identityProviders: [] },
      "mark",
    ],
    [
      "case and spaces only",
      unverified,
      { email: " Ann@Example.COM ", emailVerified: true, identityProviders: [] },
      "mark",
    ],
    [
      "already verified",
      { ...unverified, verified: true },
      { email: "ann@example.com", emailVerified: true, identityProviders: [] },
      "already_verified",
    ],
    [
      "claim unverified",
      unverified,
      { email: "ann@example.com", emailVerified: false },
      "claim_unverified",
    ],
    ["claim says nothing", unverified, { email: "ann@example.com" }, "claim_unverified"],
    [
      "a truthy non-boolean is not verified",
      unverified,
      { email: "ann@example.com", emailVerified: "true" as unknown as boolean },
      "claim_unverified",
    ],
    [
      "no claimed address",
      unverified,
      { email: " ", emailVerified: true, identityProviders: [] },
      "no_address",
    ],
    [
      "no stored address (never adopted)",
      { email: null, verified: false },
      { email: "ann@example.com", emailVerified: true, identityProviders: [] },
      "no_address",
    ],
    [
      "another address (users.email never rewritten)",
      unverified,
      { email: "bob@example.com", emailVerified: true, identityProviders: [] },
      "address_differs",
    ],
    [
      "a non-ASCII lookalike is another address (Kelvin sign)",
      { email: "kim@example.com", verified: false },
      { email: "Kim@example.com", emailVerified: true, identityProviders: [] },
      "address_differs",
    ],
    // Review 16 L8: who verified it.
    [
      "verified by Google (allow-listed by default)",
      unverified,
      { email: "ann@example.com", emailVerified: true, identityProviders: ["Google"] },
      "mark",
    ],
    [
      "verified only by Microsoft Entra ID (mutable email, nOAuth)",
      unverified,
      { email: "ann@example.com", emailVerified: true, identityProviders: ["EntraID"] },
      "claim_untrusted",
    ],
    [
      "one of its providers untrusted",
      unverified,
      {
        email: "ann@example.com",
        emailVerified: true,
        identityProviders: ["Google", "Facebook"],
      },
      "claim_untrusted",
    ],
    [
      "the token does not say who verified it",
      unverified,
      { email: "ann@example.com", emailVerified: true },
      "claim_untrusted",
    ],
  ])("%s", (_label, stored, claim, expected) => {
    const d = verificationDecision(stored, claim);
    expect(d.kind === "mark" ? "mark" : d.reason).toBe(expected);
  });

  it("the allow-list is the deployment's (AUTH_TRUSTED_EMAIL_IDPS); a malformed one trusts no provider", () => {
    const claim = {
      email: "ann@example.com",
      emailVerified: true,
      identityProviders: ["SignInWithApple"],
    };
    expect(verificationDecision(unverified, claim, new Set(["Google"])).kind).toBe(
      "none"
    );
    expect(
      verificationDecision(unverified, claim, new Set(["Google", "SignInWithApple"])).kind
    ).toBe("mark");
    expect(getTrustedEmailIdps({})).toEqual(new Set(["Google"]));
    expect(
      getTrustedEmailIdps({ AUTH_TRUSTED_EMAIL_IDPS: "Google,SignInWithApple" })
    ).toEqual(new Set(["Google", "SignInWithApple"]));
    // Review 17 L3: spaces around commas are trimmed; a malformed list trusts none.
    expect(getTrustedEmailIdps({ AUTH_TRUSTED_EMAIL_IDPS: "Google, EntraID" })).toEqual(
      new Set(["Google", "EntraID"])
    );
    expect(getTrustedEmailIdps({ AUTH_TRUSTED_EMAIL_IDPS: "Google,,EntraID" })).toEqual(
      new Set()
    );
    expect(trustedVerifiedClaim(claim, new Set(["Google"]))).toBe(false);
    expect(trustedVerifiedClaim({ ...claim, identityProviders: [] }, new Set())).toBe(
      true
    );
    expect(
      trustedVerifiedClaim({ ...claim, emailVerified: false, identityProviders: [] })
    ).toBe(false);
  });

  it.each([
    ["google", ["Google"], true],
    ["GOOGLE", ["Google"], true],
    ["Google, SignInWithApple", ["SignInWithApple"], true],
    ["Google, SignInWithApple", ["Google", "SignInWithApple"], true],
    [" google ,signinwithapple ", ["SignInWithApple"], true],
    ["Google, SignInWithApple", ["EntraID"], false],
    ["google", ["Google", "EntraID"], false],
  ])(
    "AUTH_TRUSTED_EMAIL_IDPS=%p trusts %p: %p (review 17 L3 — case-insensitive, trimmed)",
    (value, providers, expected) => {
      const trusted = getTrustedEmailIdps({ AUTH_TRUSTED_EMAIL_IDPS: value });
      expect(
        trustedVerifiedClaim(
          { emailVerified: true, identityProviders: providers },
          trusted
        )
      ).toBe(expected);
    }
  );
});

describe("syncEmailVerification", () => {
  it("marks it, with its audit record in the same transaction", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID }] });
    await expect(
      syncEmailVerification(ID, unverified, {
        email: "ann@example.com",
        emailVerified: true,
        identityProviders: [],
      })
    ).resolves.toBe("marked");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toMatch(/email_verified = false and email = \$2/);
    expect(query.mock.calls[0]![1]).toEqual([ID, "ann@example.com"]);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "profile_updated",
        actorId: ID,
        targetId: ID,
        details: expect.objectContaining({
          field: "email_verified",
          from: false,
          to: true,
        }),
      })
    );
  });

  it("nothing to do: no statement at all", async () => {
    await expect(
      syncEmailVerification(ID, unverified, {
        email: "ann@example.com",
        emailVerified: false,
      })
    ).resolves.toBe("unchanged");
    expect(query).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("another request changed it first: nothing recorded", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(
      syncEmailVerification(ID, unverified, {
        email: "ann@example.com",
        emailVerified: true,
        identityProviders: [],
      })
    ).resolves.toBe("unchanged");
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("the database fails: reported, never thrown (the request goes on; tried again next time)", async () => {
    query.mockRejectedValueOnce(new Error("connection terminated"));
    await expect(
      syncEmailVerification(ID, unverified, {
        email: "ann@example.com",
        emailVerified: true,
        identityProviders: [],
      })
    ).resolves.toBe("failed");
  });

  it("the audit record cannot be written: failed (the transaction, and so the change, rolls back)", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID }] });
    mockAudit.mockRejectedValueOnce(new Error("audit down"));
    await expect(
      syncEmailVerification(ID, unverified, {
        email: "ann@example.com",
        emailVerified: true,
        identityProviders: [],
      })
    ).resolves.toBe("failed");
  });
});
