/**
 * __tests__/account-age.test.ts — Age at sign-up and on the account (COPPA, audit X-16)
 *
 * The age gate was never called and no date of birth was collected. Now sign-up requires one,
 * checked on the server before the account exists, and records it on the account at once; an
 * account without one records it once through POST /api/account/age. Hostile cases: a missing,
 * malformed, impossible, future or implausible date; a non-text value; a second declaration (a
 * child re-declaring as an adult); a guest; an audit outage.
 */

import { NextRequest } from "next/server";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

const provider = { signUp: jest.fn() };
jest.mock("@/platform/auth/config", () => ({
  // Sign-up's provider is the fake below; token verification is the mock provider's.
  getAuthProvider: () => ({ ...mockAuth, signUp: provider.signUp }),
  hasAuthProvider: () => true,
  registerAuthProvider: jest.fn(),
}));
jest.mock("@/platform/auth/auth-init", () => ({ initAuth: jest.fn() }));
jest.mock("@/platform/tenancy/identity", () => ({
  ...jest.requireActual("@/platform/tenancy/identity"),
  signupsOpen: jest.fn(async () => true),
  assignCurrentTenant: jest.fn(async () => undefined),
  sessionTenantRefusal: jest.fn(async () => null),
}));
const mockProvision = jest.fn();
jest.mock("@/platform/auth/user-provisioning", () => ({
  ...jest.requireActual("@/platform/auth/user-provisioning"),
  ensureUserProvisioned: (...a: unknown[]) => mockProvision(...a),
}));
const mockRecordAge = jest.fn();
jest.mock("@/platform/auth/coppa", () => ({
  ...jest.requireActual("@/platform/auth/coppa"),
  recordAgeVerification: (...a: unknown[]) => mockRecordAge(...a),
}));
// The real actor guard (no-stubbed-guards): its standing and consent lookups answer here.
const mockStatus = jest.fn();
jest.mock("@/platform/auth/account-status-guard", () => ({
  checkAccountStatus: (...a: unknown[]) => mockStatus(...a),
}));
jest.mock("@/platform/auth/coppa-gate", () => ({
  checkCoppaGate: async () => ({ allowed: true }),
}));

import { resetRateLimiter } from "@/platform/rate-limit";
import { POST as signUp } from "@/app/api/auth/sign-up/route";
import { POST as declareAge } from "@/app/api/account/age/route";
import { parseDeclaredBirthDate } from "@/platform/auth/coppa";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import { mintGuestToken } from "@/platform/auth/guest-token";

const mockAuth = createMockAuthProvider();

// The mock provider's user (its access token is "mock-access-token").
const USER = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const STRONG = "Correct-Horse-Battery-9";

const post = (path: string, body: unknown, token = "mock-access-token") =>
  new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.4",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

const yearsAgo = (years: number) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - 2);
  return d.toISOString().slice(0, 10);
};

beforeEach(() => {
  jest.clearAllMocks();
  resetRateLimiter();
  provider.signUp.mockResolvedValue({
    success: true,
    userId: USER,
    emailVerificationRequired: true,
  });
  mockProvision.mockResolvedValue("created");
  mockRecordAge.mockResolvedValue({ success: true });
  mockStatus.mockResolvedValue({ allowed: true, accountStatus: "active" });
});

const BAD_DATES: [string, unknown][] = [
  ["a malformed date", "15/01/1990"],
  ["an impossible date", "1990-02-30"],
  ["a future date", "2999-01-01"],
  ["an implausible age", "1850-01-01"],
  ["an empty string", ""],
  ["a number", 19900115],
];

describe("POST /api/auth/sign-up — date of birth", () => {
  it.each(BAD_DATES)("refuses %s before the account exists", async (_l, dateOfBirth) => {
    const res = await signUp(
      post("/api/auth/sign-up", { email: "a@b.c", password: STRONG, dateOfBirth })
    );
    expect(res.status).toBe(400);
    expect(provider.signUp).not.toHaveBeenCalled();
  });

  it("refuses a sign-up with no date of birth", async () => {
    const res = await signUp(
      post("/api/auth/sign-up", { email: "a@b.c", password: STRONG })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).params.fields).toContain("dateOfBirth");
    expect(provider.signUp).not.toHaveBeenCalled();
  });

  it("creates the account's row and records the declared age at once", async () => {
    const dob = yearsAgo(30);
    const res = await signUp(
      post("/api/auth/sign-up", { email: "a@b.c", password: STRONG, dateOfBirth: dob })
    );
    expect(res.status).toBe(200);
    expect(mockProvision).toHaveBeenCalledWith(USER, { email: "a@b.c" });
    expect(mockRecordAge).toHaveBeenCalledWith(USER, dob);
  });

  it("records a teen's age too (the account starts with its content rating)", async () => {
    const dob = yearsAgo(15);
    await signUp(
      post("/api/auth/sign-up", { email: "c@b.c", password: STRONG, dateOfBirth: dob })
    );
    expect(mockRecordAge).toHaveBeenCalledWith(USER, dob);
  });

  // TASK-181: parental consent ships in Batch 4; until then no under-13 account is created.
  it("refuses an under-13 date of birth before any account or record exists", async () => {
    const res = await signUp(
      post("/api/auth/sign-up", {
        email: "c@b.c",
        password: STRONG,
        dateOfBirth: yearsAgo(9),
      })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("account.child_accounts_unavailable");
    expect(mockProvision).not.toHaveBeenCalled();
    expect(provider.signUp).not.toHaveBeenCalled();
    expect(mockRecordAge).not.toHaveBeenCalled();
  });

  it("still creates the account when the age cannot be recorded (it stays unverified)", async () => {
    mockRecordAge.mockResolvedValue({ success: false, error: "db down" });
    const res = await signUp(
      post("/api/auth/sign-up", {
        email: "a@b.c",
        password: STRONG,
        dateOfBirth: yearsAgo(30),
      })
    );
    expect(res.status).toBe(200);
  });

  it("records nothing when the row cannot be provisioned", async () => {
    mockProvision.mockResolvedValue("failed");
    await signUp(
      post("/api/auth/sign-up", {
        email: "a@b.c",
        password: STRONG,
        dateOfBirth: yearsAgo(30),
      })
    );
    expect(mockRecordAge).not.toHaveBeenCalled();
  });
});

describe("POST /api/account/age", () => {
  it.each(BAD_DATES)("refuses %s and records nothing", async (_l, dateOfBirth) => {
    const res = await declareAge(post("/api/account/age", { dateOfBirth }));
    expect(res.status).toBe(400);
    expect(mockRecordAge).not.toHaveBeenCalled();
  });

  it("records the age once, and says whether consent is now needed", async () => {
    const res = await declareAge(post("/api/account/age", { dateOfBirth: yearsAgo(15) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      requiresParentalConsent: false,
      contentRatingLevel: 2,
    });
  });

  // TASK-181: an under-13 date is refused and not recorded until consent ships (Batch 4).
  it("refuses an under-13 date of birth and records nothing", async () => {
    const res = await declareAge(post("/api/account/age", { dateOfBirth: yearsAgo(10) }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("account.child_accounts_unavailable");
    expect(mockRecordAge).not.toHaveBeenCalled();
  });

  it("refuses a second declaration — a child cannot re-declare as an adult", async () => {
    mockRecordAge.mockResolvedValue({
      success: false,
      error: "the age is already recorded, or there is no such user",
    });
    const res = await declareAge(post("/api/account/age", { dateOfBirth: yearsAgo(30) }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("account.age_already_recorded");
  });

  it("answers 503 when the record cannot be written", async () => {
    mockRecordAge.mockResolvedValue({ success: false, error: "audit unavailable" });
    const res = await declareAge(post("/api/account/age", { dateOfBirth: yearsAgo(30) }));
    expect(res.status).toBe(503);
  });

  it("is for signed-in users only: a guest is refused and nothing is recorded", async () => {
    const { token } = await mintGuestToken();
    const res = await declareAge(
      post("/api/account/age", { dateOfBirth: yearsAgo(30) }, token)
    );
    expect(res.status).toBe(401);
    expect(mockRecordAge).not.toHaveBeenCalled();
  });

  it("refuses an account not in good standing, under the update_profile feature", async () => {
    mockStatus.mockResolvedValue({ allowed: false, accountStatus: "banned" });
    const res = await declareAge(post("/api/account/age", { dateOfBirth: yearsAgo(30) }));
    expect(res.status).toBe(403);
    expect(mockStatus).toHaveBeenCalledWith(USER, "update_profile", expect.anything());
    expect(mockRecordAge).not.toHaveBeenCalled();
  });

  it("refuses a forged token", async () => {
    const res = await declareAge(
      post("/api/account/age", { dateOfBirth: yearsAgo(30) }, "forged")
    );
    expect(res.status).toBe(401);
  });
});

describe("parseDeclaredBirthDate", () => {
  it("accepts a real past date up to 120 years ago", () => {
    expect(parseDeclaredBirthDate(yearsAgo(119))?.age).toBe(119);
    expect(parseDeclaredBirthDate(yearsAgo(121))).toBeNull();
    expect(parseDeclaredBirthDate(undefined)).toBeNull();
  });
});
