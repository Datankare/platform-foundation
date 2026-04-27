/**
 * platform/auth/__tests__/account-status-guard.test.ts
 *
 * Tests for the account status enforcement gate.
 * Covers: all statuses, auto-expiry, feature restrictions,
 * fail-closed behavior, config-driven lists, input validation.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Mocks ───────────────────────────────────────────────────────────────

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

const mockGetConfig = jest.fn();

jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: (...args: any[]) => mockGetConfig(...args),
}));

function createChainMock(resolvedValue: { data: any; error: any }) {
  const chain: any = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(resolvedValue),
    then: (resolve: any) => resolve(resolvedValue),
  };
  return chain;
}

const mockSupabase = {
  from: jest.fn(),
};

jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: jest.fn(() => mockSupabase),
}));

// ── Imports ─────────────────────────────────────────────────────────────

import { checkAccountStatus } from "../account-status-guard";

// ── Helpers ─────────────────────────────────────────────────────────────

const VALID_USER_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function setupDefaultConfig() {
  mockGetConfig.mockImplementation((key: string, defaultValue: any) => {
    if (key === "account_status.restricted_features") {
      return Promise.resolve([
        "translate",
        "transcribe",
        "identify_song",
        "generate",
        "upload_file",
        "update_profile",
      ]);
    }
    if (key === "account_status.suspended_features") {
      return Promise.resolve(["*"]);
    }
    return Promise.resolve(defaultValue);
  });
}

function setupUserState(
  overrides: Partial<{
    account_status: string;
    restricted_until: string | null;
    suspended_until: string | null;
    banned_at: string | null;
  }> = {}
) {
  const state = {
    account_status: "active",
    restricted_until: null,
    suspended_until: null,
    banned_at: null,
    ...overrides,
  };
  mockSupabase.from.mockReturnValue(createChainMock({ data: state, error: null }));
}

/** Returns an ISO timestamp N hours in the future */
function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

/** Returns an ISO timestamp N hours in the past */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("checkAccountStatus", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultConfig();
    setupUserState();
  });

  // ── Active users ────────────────────────────────────────────────────

  it("allows active user for any feature", async () => {
    const result = await checkAccountStatus(VALID_USER_ID, "translate");
    expect(result.allowed).toBe(true);
    expect(result.accountStatus).toBe("active");
  });

  it("allows active user for update_profile", async () => {
    const result = await checkAccountStatus(VALID_USER_ID, "update_profile");
    expect(result.allowed).toBe(true);
  });

  // ── Warned users ────────────────────────────────────────────────────

  it("allows warned user for any feature", async () => {
    setupUserState({ account_status: "warned" });
    const result = await checkAccountStatus(VALID_USER_ID, "translate");
    expect(result.allowed).toBe(true);
    expect(result.accountStatus).toBe("warned");
  });

  // ── Restricted users ────────────────────────────────────────────────

  it("blocks restricted user for restricted feature", async () => {
    setupUserState({
      account_status: "restricted",
      restricted_until: hoursFromNow(12),
    });
    const result = await checkAccountStatus(VALID_USER_ID, "translate");
    expect(result.allowed).toBe(false);
    expect(result.accountStatus).toBe("restricted");
    expect(result.reason).toMatch(/restricted/i);
  });

  it("allows restricted user for non-restricted feature", async () => {
    setupUserState({
      account_status: "restricted",
      restricted_until: hoursFromNow(12),
    });
    const result = await checkAccountStatus(VALID_USER_ID, "view_dashboard");
    expect(result.allowed).toBe(true);
    expect(result.accountStatus).toBe("restricted");
  });

  it("allows restricted user when restriction has expired", async () => {
    setupUserState({
      account_status: "restricted",
      restricted_until: hoursAgo(1),
    });
    const result = await checkAccountStatus(VALID_USER_ID, "translate");
    expect(result.allowed).toBe(true);
    expect(result.reason).toMatch(/expired/i);
  });

  it("blocks restricted user with null restricted_until", async () => {
    setupUserState({
      account_status: "restricted",
      restricted_until: null,
    });
    const result = await checkAccountStatus(VALID_USER_ID, "translate");
    expect(result.allowed).toBe(false);
  });

  // ── Suspended users ─────────────────────────────────────────────────

  it("blocks suspended user for any feature (wildcard)", async () => {
    setupUserState({
      account_status: "suspended",
      suspended_until: hoursFromNow(24),
    });
    const result = await checkAccountStatus(VALID_USER_ID, "translate");
    expect(result.allowed).toBe(false);
    expect(result.accountStatus).toBe("suspended");
    expect(result.reason).toMatch(/suspended/i);
  });

  it("allows suspended user when suspension has expired", async () => {
    setupUserState({
      account_status: "suspended",
      suspended_until: hoursAgo(1),
    });
    const result = await checkAccountStatus(VALID_USER_ID, "translate");
    expect(result.allowed).toBe(true);
    expect(result.reason).toMatch(/expired/i);
  });

  it("blocks suspended user with null suspended_until", async () => {
    setupUserState({
      account_status: "suspended",
      suspended_until: null,
    });
    const result = await checkAccountStatus(VALID_USER_ID, "translate");
    expect(result.allowed).toBe(false);
  });

  // ── Banned users ────────────────────────────────────────────────────

  it("blocks banned user for any feature", async () => {
    setupUserState({
      account_status: "banned",
      banned_at: hoursAgo(48),
    });
    const result = await checkAccountStatus(VALID_USER_ID, "translate");
    expect(result.allowed).toBe(false);
    expect(result.accountStatus).toBe("banned");
    expect(result.reason).toMatch(/permanently suspended/i);
  });

  // ── Fail-closed ─────────────────────────────────────────────────────

  it("fails closed when DB returns error", async () => {
    mockSupabase.from.mockReturnValue(
      createChainMock({ data: null, error: { message: "DB down" } })
    );
    const result = await checkAccountStatus(VALID_USER_ID, "translate");
    expect(result.allowed).toBe(false);
    expect(result.accountStatus).toBe("banned");
  });

  it("fails closed when user not found", async () => {
    mockSupabase.from.mockReturnValue(createChainMock({ data: null, error: null }));
    const result = await checkAccountStatus(VALID_USER_ID, "translate");
    expect(result.allowed).toBe(false);
    expect(result.accountStatus).toBe("banned");
  });

  it("fails closed when DB throws exception", async () => {
    mockSupabase.from.mockImplementation(() => {
      throw new Error("Connection refused");
    });
    const result = await checkAccountStatus(VALID_USER_ID, "translate");
    expect(result.allowed).toBe(false);
    expect(result.accountStatus).toBe("banned");
  });

  it("fails closed when account_status is unknown value", async () => {
    setupUserState({ account_status: "hacked" });
    const result = await checkAccountStatus(VALID_USER_ID, "translate");
    expect(result.allowed).toBe(false);
    expect(result.accountStatus).toBe("banned");
  });

  it("fails closed when config unavailable (uses fallback)", async () => {
    setupUserState({
      account_status: "restricted",
      restricted_until: hoursFromNow(12),
    });
    mockGetConfig.mockRejectedValue(new Error("Config DB down"));
    const result = await checkAccountStatus(VALID_USER_ID, "translate");
    expect(result.allowed).toBe(false);
  });

  // ── Input validation ────────────────────────────────────────────────

  it("rejects invalid userId format", async () => {
    const result = await checkAccountStatus("not-a-uuid", "translate");
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Invalid user ID/);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it("rejects empty userId", async () => {
    const result = await checkAccountStatus("", "translate");
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Invalid user ID/);
  });
});
