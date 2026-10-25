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
const mockHasDatabase = jest.fn(() => true);

jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: (...args: any[]) => mockGetConfig(...args),
}));

/** What a users read or write answers in this test: rows (an object is one row), or an error. */
function createChainMock(resolvedValue: { data: any; error: any }) {
  return resolvedValue;
}

const mockSupabase = {
  /** The response to the next query (the name is kept from the REST-client version). */
  from: jest.fn(),
};

/** The data layer: each query answers from mockSupabase.from("users"). */
jest.mock("@/platform/data", () => ({
  hasDatabase: () => mockHasDatabase(),
  withTenantTx: (fn: (tx: unknown) => unknown) =>
    fn({
      query: async () => {
        const { data, error } = mockSupabase.from("users");
        if (error) throw new Error(error.message);
        const rows = data == null ? [] : Array.isArray(data) ? data : [data];
        return { rows, rowCount: rows.length };
      },
    }),
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

describe("checkCoppaGate — an account whose age was never recorded (audit X-16)", () => {
  const unverified = (enforced: boolean) =>
    mockSupabase.from.mockReturnValue(
      createChainMock({
        data: {
          age_verified: false,
          coppa_enforcement_active: enforced,
          content_rating_level: 3,
          parental_consent_status: "not_required",
        },
        error: null,
      })
    );

  it.each(["generate", "translate", "upload_file"])(
    "refuses %s, whatever the stored flag says",
    async (feature) => {
      unverified(false);
      const result = await checkCoppaGate(
        "550e8400-e29b-41d4-a716-446655440010",
        feature
      );
      expect(result).toMatchObject({ allowed: false, code: "account.age_unverified" });
    }
  );

  it("allows a feature that needs no consent", async () => {
    unverified(false);
    const result = await checkCoppaGate(
      "550e8400-e29b-41d4-a716-446655440010",
      "update_profile"
    );
    expect(result.allowed).toBe(true);
  });

  it("refuses a child awaiting consent with the consent code", async () => {
    mockSupabase.from.mockReturnValue(
      createChainMock({
        data: {
          age_verified: true,
          coppa_enforcement_active: true,
          content_rating_level: 1,
          parental_consent_status: "pending",
        },
        error: null,
      })
    );
    const result = await checkCoppaGate(
      "550e8400-e29b-41d4-a716-446655440011",
      "generate"
    );
    expect(result).toMatchObject({ allowed: false, code: "account.consent_required" });
  });

  it("blocks stream when the governed list cannot be read (the core's own features)", async () => {
    unverified(false);
    mockGetConfig.mockImplementation((key: string, defaultValue: unknown) =>
      key === "coppa.blocked_features"
        ? Promise.reject(new Error("db down"))
        : Promise.resolve(key === "coppa.enforcement_enabled" ? true : defaultValue)
    );
    const result = await checkCoppaGate("550e8400-e29b-41d4-a716-446655440013", "stream");
    expect(result).toMatchObject({ allowed: false, code: "account.age_unverified" });
  });

  it("enforces nothing without a database (mock and CI runs), like the account-status guard", async () => {
    mockHasDatabase.mockReturnValueOnce(false);
    const result = await checkCoppaGate("550e8400-e29b-41d4-a716-446655440012", "stream");
    expect(result.allowed).toBe(true);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});

describe("checkCoppaGate", () => {
  describe("input validation (S1)", () => {
    it("rejects empty userId", async () => {
      const result = await checkCoppaGate("", "generate");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Invalid user ID");
    });

    it("rejects non-UUID userId", async () => {
      const result = await checkCoppaGate("not-a-uuid", "generate");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Invalid user ID");
    });

    it("accepts valid UUID", async () => {
      const chain = createChainMock({
        data: {
          age_verified: true,
          coppa_enforcement_active: false,
          content_rating_level: 3,
          parental_consent_status: "not_required",
        },
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      const result = await checkCoppaGate(
        "550e8400-e29b-41d4-a716-446655440000",
        "generate"
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
        "generate"
      );

      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("disabled");
    });
  });

  describe("user not under enforcement", () => {
    it("allows adult users", async () => {
      const chain = createChainMock({
        data: {
          age_verified: true,
          coppa_enforcement_active: false,
          content_rating_level: 3,
          parental_consent_status: "not_required",
        },
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      const result = await checkCoppaGate(
        "550e8400-e29b-41d4-a716-446655440001",
        "generate"
      );

      expect(result.allowed).toBe(true);
      expect(result.contentRatingLevel).toBe(3);
    });

    it("allows consented minor", async () => {
      const chain = createChainMock({
        data: {
          age_verified: true,
          coppa_enforcement_active: false,
          content_rating_level: 1,
          parental_consent_status: "granted",
        },
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      const result = await checkCoppaGate(
        "550e8400-e29b-41d4-a716-446655440002",
        "generate"
      );

      expect(result.allowed).toBe(true);
    });
  });

  describe("user under enforcement", () => {
    it("blocks content-generating features", async () => {
      const chain = createChainMock({
        data: {
          age_verified: true,
          coppa_enforcement_active: true,
          content_rating_level: 1,
          parental_consent_status: "pending",
        },
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      const result = await checkCoppaGate(
        "550e8400-e29b-41d4-a716-446655440003",
        "generate"
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Parental consent");
      expect(result.consentStatus).toBe("pending");
    });

    it("blocks all configured features", async () => {
      const chain = createChainMock({
        data: {
          age_verified: true,
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
          age_verified: true,
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
        "generate"
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
        "generate"
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
          age_verified: true,
          coppa_enforcement_active: true,
          content_rating_level: 1,
          parental_consent_status: "pending",
        },
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      // Should still block — the core's fallback list includes generate
      const result = await checkCoppaGate(
        "550e8400-e29b-41d4-a716-446655440003",
        "generate"
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
