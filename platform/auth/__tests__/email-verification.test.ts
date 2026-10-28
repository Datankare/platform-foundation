/**
 * TASK-176, TASK-185 — users.email_verified and users.email brought up to date from the
 * provider's verified claim (platform/auth/email-verification.ts): the rule, and the write's
 * failure modes. Against
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
      "TASK-185: no stored address — the verified one is recorded",
      { email: null, verified: false },
      { email: "Ann@example.com ", emailVerified: true, identityProviders: [] },
      "record:absent",
    ],
    [
      "TASK-185: a blank stored address counts as none",
      { email: "  ", verified: false, status: "banned" },
      { email: "ann@example.com", emailVerified: true, identityProviders: [] },
      "record:absent",
    ],
    [
      "TASK-185: no stored address, an UNVERIFIED claim — nothing recorded",
      { email: null, verified: false },
      { email: "ann@example.com", emailVerified: false, identityProviders: [] },
      "claim_unverified",
    ],
    [
      "TASK-185: no stored address, an untrusted provider (Entra ID) — nothing recorded",
      { email: null, verified: false, status: "active" },
      { email: "ann@example.com", emailVerified: true, identityProviders: ["EntraID"] },
      "claim_untrusted",
    ],
    [
      "TASK-185: another address on an active account — recorded",
      { ...unverified, verified: true, status: "active" },
      {
        email: "bob@example.com",
        emailVerified: true,
        identityProviders: [],
        addressFresh: true,
      },
      "record:changed",
    ],
    [
      "TASK-185: another address on a warned account — recorded",
      { ...unverified, status: "warned" },
      {
        email: "bob@example.com",
        emailVerified: true,
        identityProviders: [],
        addressFresh: true,
      },
      "record:changed",
    ],
    [
      "TASK-185: another address from a REMEMBERED answer (not fresh) — kept, so two devices never flip it",
      { ...unverified, verified: true, status: "active" },
      { email: "bob@example.com", emailVerified: true, identityProviders: [] },
      "claim_not_fresh",
    ],
    [
      "TASK-185: another address, freshness said as a truthy non-boolean — kept",
      { ...unverified, verified: true, status: "active" },
      {
        email: "bob@example.com",
        emailVerified: true,
        identityProviders: [],
        addressFresh: "true" as unknown as boolean,
      },
      "claim_not_fresh",
    ],
    [
      "TASK-185: no stored address — recorded from a remembered answer too (it cannot flip)",
      { email: null, verified: false, status: "active" },
      { email: "ann@example.com", emailVerified: true, identityProviders: [] },
      "record:absent",
    ],
    [
      "TASK-185: another address on a BANNED account — never moved (the ban follows it)",
      { ...unverified, status: "banned" },
      { email: "bob@example.com", emailVerified: true, identityProviders: [] },
      "address_differs",
    ],
    [
      "TASK-185: another address on a suspended account — kept",
      { ...unverified, status: "suspended" },
      { email: "bob@example.com", emailVerified: true, identityProviders: [] },
      "address_differs",
    ],
    [
      "TASK-185: another address, status unknown — kept (fail closed)",
      unverified,
      { email: "bob@example.com", emailVerified: true, identityProviders: [] },
      "address_differs",
    ],
    [
      "TASK-185: another address from an untrusted provider — kept",
      { ...unverified, status: "active" },
      { email: "bob@example.com", emailVerified: true, identityProviders: ["EntraID"] },
      "claim_untrusted",
    ],
    [
      "TASK-185: a claim that is not an address (no @) — nothing recorded",
      { email: null, verified: false },
      { email: "not-an-address", emailVerified: true, identityProviders: [] },
      "no_address",
    ],
    [
      "TASK-185: a claim with a control character or an inner space — nothing recorded",
      { email: null, verified: false },
      { email: "ann\u0000@example.com", emailVerified: true, identityProviders: [] },
      "no_address",
    ],
    [
      "TASK-185: an erased account (awaiting its purge) — nothing, so nothing is tried per request",
      { email: null, verified: false, status: "active", deleted: true },
      { email: "ann@example.com", emailVerified: true, identityProviders: [] },
      "account_deleted",
    ],
    [
      "TASK-185: an erased account's unverified address is not marked either",
      { ...unverified, status: "active", deleted: true },
      { email: "ann@example.com", emailVerified: true, identityProviders: [] },
      "account_deleted",
    ],
    [
      "TASK-185: two @ signs — nothing recorded",
      { email: null, verified: false },
      { email: "a@b@example.com", emailVerified: true, identityProviders: [] },
      "no_address",
    ],
    [
      "TASK-185: an over-long claim — nothing recorded",
      { email: null, verified: false },
      { email: `${"a".repeat(250)}@x.io`, emailVerified: true, identityProviders: [] },
      "no_address",
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
    expect(
      d.kind === "mark" ? "mark" : d.kind === "record" ? `record:${d.change}` : d.reason
    ).toBe(expected);
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

describe("syncEmailVerification — the address recorded (TASK-185)", () => {
  const claim = { email: "Ann@Example.com", emailVerified: true, identityProviders: [] };
  /** banFollowsAddress: no banned account with it, no erased banned hash. */
  const noBan = () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] });
  };

  it("absent: recorded as stored, verified, naming the value read; audited without the address", async () => {
    noBan();
    query.mockResolvedValueOnce({ rows: [{ id: ID }] });
    await expect(
      syncEmailVerification(ID, { email: null, verified: false }, claim)
    ).resolves.toBe("recorded");
    const [sql, params] = query.mock.calls[2]!;
    expect(sql).toMatch(/set email = \$2, email_verified = true/);
    expect(sql).toMatch(/email is not distinct from \$3/);
    expect(sql).toMatch(/deleted_at is null/);
    expect(params.slice(0, 5)).toEqual([ID, "ann@example.com", null, false, true]);
    const entry = mockAudit.mock.calls[0]![0];
    expect(entry).toMatchObject({
      action: "profile_updated",
      actorId: ID,
      targetId: ID,
      details: { field: "email", change: "absent", verifiedBy: "pool" },
    });
    expect(JSON.stringify(entry)).not.toMatch(/example\.com/i);
  });

  it("changed: only an active account's (the update re-checks the status itself)", async () => {
    noBan();
    query.mockResolvedValueOnce({ rows: [] });
    await expect(
      syncEmailVerification(
        ID,
        { email: "old@example.com", verified: true, status: "active" },
        { ...claim, addressFresh: true }
      )
    ).resolves.toBe("unchanged");
    const [sql, params] = query.mock.calls[2]!;
    expect(sql).toMatch(/\(\$5 or account_status in \('active', 'warned'\)\)/);
    expect(params.slice(0, 5)).toEqual([
      ID,
      "ann@example.com",
      "old@example.com",
      false,
      false,
    ]);
    // Nothing changed (a concurrent request, or the account was banned meanwhile): no record.
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("a banned account's address is never moved: no statement at all", async () => {
    await expect(
      syncEmailVerification(
        ID,
        { email: "old@example.com", verified: true, status: "banned" },
        claim
      )
    ).resolves.toBe("unchanged");
    expect(query).not.toHaveBeenCalled();
  });

  it("a ban on the recorded address follows it to this account (A-11), and is recorded so", async () => {
    query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }); // a banned account has it
    query.mockResolvedValueOnce({ rows: [{ id: ID }] });
    await expect(
      syncEmailVerification(ID, { email: null, verified: false }, claim)
    ).resolves.toBe("recorded");
    const [sql, params] = query.mock.calls[1]!;
    expect(sql).toMatch(/account_status = case when \$4 then 'banned'/);
    expect(params[3]).toBe(true);
    expect(mockAudit.mock.calls[0]![0]).toMatchObject({
      details: { field: "email", banCarriedOver: true },
    });
  });

  it("the database or the audit fails: failed, never thrown", async () => {
    query.mockRejectedValueOnce(new Error("connection terminated"));
    await expect(
      syncEmailVerification(ID, { email: null, verified: false }, claim)
    ).resolves.toBe("failed");
    noBan();
    query.mockResolvedValueOnce({ rows: [{ id: ID }] });
    mockAudit.mockRejectedValueOnce(new Error("audit down"));
    await expect(
      syncEmailVerification(ID, { email: null, verified: false }, claim)
    ).resolves.toBe("failed");
  });

  it("an unverified provider never overwrites a stored address", async () => {
    for (const c of [
      { ...claim, emailVerified: false },
      { ...claim, identityProviders: ["EntraID"] },
      { ...claim, identityProviders: undefined },
    ])
      await expect(
        syncEmailVerification(
          ID,
          { email: "old@example.com", verified: true, status: "active" },
          c
        )
      ).resolves.toBe("unchanged");
    expect(query).not.toHaveBeenCalled();
  });
});
