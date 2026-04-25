/**
 * platform/auth/__tests__/coppa-gate.test.ts
 *
 * Tests for the COPPA consent enforcement gate.
 * Covers: gate logic, fail-closed behavior, feature blocking,
 * enforcement toggle, updateCoppaEnforcement.
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
    update: jest.fn().mockReturnThis(),
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

import { checkCoppaGate, updateCoppaEnforcement } from "../coppa-gate";

// ── Setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: enforcement enabled
  mockGetConfig.mockImplementation((key: string, defaultValue: any) => {
    if (key === "coppa.enforcement_enabled") return Promise.resolve(true);
    if (key === "coppa.blocked_features")
      return Promise.resolve([
        "translate",
        "transcribe",
        "identify_song",
        "generate",
        "upload_file",
      ]);
    return Promise.resolve(defaultValue);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// checkCoppaGate
// ═══════════════════════════════════════════════════════════════════════

describe("checkCoppaGate", () => {
  describe("enforcement disabled", () => {
    it("allows all features when enforcement is disabled", async () => {
      mockGetConfig.mockResolvedValue(false);
      mockSupabase.from.mockReturnValue(createChainMock({ data: null, error: null }));

      const result = await checkCoppaGate("user-1", "translate");

      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("disabled");
    });
  });

  describe("user not under enforcement", () => {
    it("allows adult users", async () => {
      const chain = createChainMock({
        data: {
          coppa_enforcement_active: false,
          content_rating_level: 3,
          parental_consent_status: "not_required",
        },
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      const result = await checkCoppaGate("adult-user", "translate");

      expect(result.allowed).toBe(true);
      expect(result.contentRatingLevel).toBe(3);
    });

    it("allows consented minor", async () => {
      const chain = createChainMock({
        data: {
          coppa_enforcement_active: false,
          content_rating_level: 1,
          parental_consent_status: "granted",
        },
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      const result = await checkCoppaGate("consented-minor", "translate");

      expect(result.allowed).toBe(true);
    });
  });

  describe("user under enforcement", () => {
    it("blocks content-generating features", async () => {
      const chain = createChainMock({
        data: {
          coppa_enforcement_active: true,
          content_rating_level: 1,
          parental_consent_status: "pending",
        },
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      const result = await checkCoppaGate("minor-user", "translate");

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Parental consent");
      expect(result.consentStatus).toBe("pending");
    });

    it("blocks all configured features", async () => {
      const chain = createChainMock({
        data: {
          coppa_enforcement_active: true,
          content_rating_level: 1,
          parental_consent_status: "denied",
        },
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      for (const feature of [
        "translate",
        "transcribe",
        "identify_song",
        "generate",
        "upload_file",
      ]) {
        const result = await checkCoppaGate("minor-user", feature);
        expect(result.allowed).toBe(false);
      }
    });

    it("allows features not in the blocked list", async () => {
      const chain = createChainMock({
        data: {
          coppa_enforcement_active: true,
          content_rating_level: 1,
          parental_consent_status: "pending",
        },
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      const result = await checkCoppaGate("minor-user", "view_profile");

      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("not restricted");
    });
  });

  describe("fail-closed (P11)", () => {
    it("blocks on DB error (unknown user)", async () => {
      const chain = createChainMock({
        data: null,
        error: { message: "not found" },
      });
      mockSupabase.from.mockReturnValue(chain);

      const result = await checkCoppaGate("unknown-user", "translate");

      expect(result.allowed).toBe(false);
      expect(result.consentStatus).toBe("pending");
    });

    it("blocks on supabase exception", async () => {
      mockSupabase.from.mockImplementation(() => {
        throw new Error("connection refused");
      });

      const result = await checkCoppaGate("user-1", "translate");

      expect(result.allowed).toBe(false);
    });

    it("uses fallback blocked features on config error", async () => {
      mockGetConfig.mockImplementation((key: string) => {
        if (key === "coppa.enforcement_enabled") return Promise.resolve(true);
        if (key === "coppa.blocked_features") throw new Error("config error");
        return Promise.resolve(null);
      });

      const chain = createChainMock({
        data: {
          coppa_enforcement_active: true,
          content_rating_level: 1,
          parental_consent_status: "pending",
        },
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      // Should still block — fallback list includes translate
      const result = await checkCoppaGate("minor-user", "translate");
      expect(result.allowed).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// updateCoppaEnforcement
// ═══════════════════════════════════════════════════════════════════════

describe("updateCoppaEnforcement", () => {
  it("updates the enforcement flag", async () => {
    const chain = createChainMock({ data: null, error: null });
    mockSupabase.from.mockReturnValue(chain);

    const result = await updateCoppaEnforcement("user-1", true);

    expect(result.success).toBe(true);
  });

  it("returns error on DB failure", async () => {
    const chain = createChainMock({
      data: null,
      error: { message: "update failed" },
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await updateCoppaEnforcement("user-1", true);

    expect(result.success).toBe(false);
    expect(result.error).toContain("update failed");
  });

  it("returns error on exception", async () => {
    mockSupabase.from.mockImplementation(() => {
      throw new Error("crash");
    });

    const result = await updateCoppaEnforcement("user-1", true);

    expect(result.success).toBe(false);
    expect(result.error).toContain("crash");
  });
});
