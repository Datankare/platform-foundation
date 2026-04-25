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
  describe("input validation (S1)", () => {
    it("rejects empty userId", async () => {
      const result = await checkCoppaGate("", "translate");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Invalid user ID");
    });

    it("rejects non-UUID userId", async () => {
      const result = await checkCoppaGate("not-a-uuid", "translate");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Invalid user ID");
    });

    it("accepts valid UUID", async () => {
      const chain = createChainMock({
        data: {
          coppa_enforcement_active: false,
          content_rating_level: 3,
          parental_consent_status: "not_required",
        },
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      const result = await checkCoppaGate(
        "550e8400-e29b-41d4-a716-446655440000",
        "translate"
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("enforcement disabled", () => {
    it("allows all features when enforcement is disabled", async () => {
      mockGetConfig.mockResolvedValue(false);
      mockSupabase.from.mockReturnValue(createChainMock({ data: null, error: null }));

      const result = await checkCoppaGate(
        "550e8400-e29b-41d4-a716-446655440000",
        "translate"
      );

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

      const result = await checkCoppaGate(
        "550e8400-e29b-41d4-a716-446655440001",
        "translate"
      );

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

      const result = await checkCoppaGate(
        "550e8400-e29b-41d4-a716-446655440002",
        "translate"
      );

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

      const result = await checkCoppaGate(
        "550e8400-e29b-41d4-a716-446655440003",
        "translate"
      );

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
        const result = await checkCoppaGate(
          "550e8400-e29b-41d4-a716-446655440003",
          feature
        );
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

      const result = await checkCoppaGate(
        "550e8400-e29b-41d4-a716-446655440003",
        "view_profile"
      );

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

      const result = await checkCoppaGate(
        "550e8400-e29b-41d4-a716-446655440004",
        "translate"
      );

      expect(result.allowed).toBe(false);
      expect(result.consentStatus).toBe("pending");
    });

    it("blocks on supabase exception", async () => {
      mockSupabase.from.mockImplementation(() => {
        throw new Error("connection refused");
      });

      const result = await checkCoppaGate(
        "550e8400-e29b-41d4-a716-446655440000",
        "translate"
      );

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
      const result = await checkCoppaGate(
        "550e8400-e29b-41d4-a716-446655440003",
        "translate"
      );
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

    const result = await updateCoppaEnforcement(
      "550e8400-e29b-41d4-a716-446655440000",
      true
    );

    expect(result.success).toBe(true);
  });

  it("returns error on DB failure", async () => {
    const chain = createChainMock({
      data: null,
      error: { message: "update failed" },
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await updateCoppaEnforcement(
      "550e8400-e29b-41d4-a716-446655440000",
      true
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("update failed");
  });

  it("returns error on exception", async () => {
    mockSupabase.from.mockImplementation(() => {
      throw new Error("crash");
    });

    const result = await updateCoppaEnforcement(
      "550e8400-e29b-41d4-a716-446655440000",
      true
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("crash");
  });
});
