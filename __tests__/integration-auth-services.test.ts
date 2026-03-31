/**
 * Sprint 7a — Integration tests for profile, devices, consent, coppa
 *
 * Tests with mocked Supabase client.
 */

import { createSequentialMockSupabase } from "./helpers/mock-supabase";

// ── Profile Module ──────────────────────────────────────────────────────

describe("getOwnProfile", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("returns mapped profile for existing player", async () => {
    const mockClient = createSequentialMockSupabase([
      {
        table: "players",
        response: {
          data: {
            id: "p1",
            email: "alice@example.com",
            display_name: "Alice",
            avatar_url: null,
            real_name: null,
            language_preference: "en",
            timezone: "UTC",
            profile_visibility: "public",
            display_name_visibility: "public",
            avatar_visibility: "private",
            language_visibility: "private",
            timezone_visibility: "private",
            email_opt_in: true,
            push_notifications_enabled: false,
            mfa_enabled: false,
            email_verified: true,
            created_at: "2026-01-01T00:00:00Z",
            last_login_at: "2026-03-31T00:00:00Z",
          },
          error: null,
        },
      },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { getOwnProfile } = await import("@/platform/auth/profile");
    const profile = await getOwnProfile("p1");

    expect(profile).not.toBeNull();
    expect(profile!.id).toBe("p1");
    expect(profile!.email).toBe("alice@example.com");
    expect(profile!.displayName).toBe("Alice");
    expect(profile!.profileVisibility).toBe("public");
    expect(profile!.emailVerified).toBe(true);
  });

  it("returns null when player not found", async () => {
    const mockClient = createSequentialMockSupabase([
      {
        table: "players",
        response: { data: null, error: { message: "not found" } },
      },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { getOwnProfile } = await import("@/platform/auth/profile");
    const profile = await getOwnProfile("nonexistent");

    expect(profile).toBeNull();
  });
});

describe("getPublicProfile", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("only returns public visibility fields", async () => {
    const mockClient = createSequentialMockSupabase([
      {
        table: "players",
        response: {
          data: {
            id: "p1",
            email: "alice@example.com",
            display_name: "Alice",
            avatar_url: "https://example.com/avatar.jpg",
            real_name: "Alice Smith",
            language_preference: "en",
            timezone: "US/Eastern",
            profile_visibility: "public",
            display_name_visibility: "public",
            avatar_visibility: "private",
            language_visibility: "public",
            timezone_visibility: "private",
            email_opt_in: false,
            push_notifications_enabled: false,
            mfa_enabled: false,
            email_verified: true,
            created_at: "2026-01-01T00:00:00Z",
            last_login_at: null,
          },
          error: null,
        },
      },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { getPublicProfile } = await import("@/platform/auth/profile");
    const profile = await getPublicProfile("p1");

    expect(profile).not.toBeNull();
    expect(profile!.id).toBe("p1");
    expect(profile!.displayName).toBe("Alice");
    expect(profile!.languagePreference).toBe("en");
    // Private fields should NOT be present
    expect(profile!.avatarUrl).toBeUndefined();
    expect(profile!.timezone).toBeUndefined();
  });

  it("returns only id when profile is private", async () => {
    const mockClient = createSequentialMockSupabase([
      {
        table: "players",
        response: {
          data: {
            id: "p1",
            email: "bob@example.com",
            display_name: "Bob",
            avatar_url: null,
            real_name: null,
            language_preference: "en",
            timezone: "UTC",
            profile_visibility: "private",
            display_name_visibility: "public",
            avatar_visibility: "public",
            language_visibility: "public",
            timezone_visibility: "public",
            email_opt_in: false,
            push_notifications_enabled: false,
            mfa_enabled: false,
            email_verified: false,
            created_at: "2026-01-01T00:00:00Z",
            last_login_at: null,
          },
          error: null,
        },
      },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { getPublicProfile } = await import("@/platform/auth/profile");
    const profile = await getPublicProfile("p1");

    expect(profile).not.toBeNull();
    expect(profile!.id).toBe("p1");
    expect(profile!.displayName).toBeUndefined();
  });
});

describe("updateProfile", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("converts camelCase to snake_case and updates", async () => {
    const mockClient = createSequentialMockSupabase([
      { table: "players", response: { data: null, error: null } },
      { table: "audit_log", response: { data: null, error: null } },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { updateProfile } = await import("@/platform/auth/profile");
    const result = await updateProfile("p1", {
      displayName: "NewName",
      languagePreference: "fr",
    });

    expect(result.success).toBe(true);
    const builder = mockClient._fromCalls[0].builder;
    expect(builder.update).toHaveBeenCalledWith({
      display_name: "NewName",
      language_preference: "fr",
    });
  });

  it("returns error for empty update", async () => {
    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => createSequentialMockSupabase([]),
    }));

    const { updateProfile } = await import("@/platform/auth/profile");
    const result = await updateProfile("p1", {});

    expect(result.success).toBe(false);
    expect(result.error).toBe("No valid fields to update");
  });
});

// ── Devices Module ──────────────────────────────────────────────────────

describe("registerDevice", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("upserts device and writes audit log", async () => {
    const mockClient = createSequentialMockSupabase([
      { table: "player_devices", response: { data: null, error: null } },
      { table: "audit_log", response: { data: null, error: null } },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { registerDevice } = await import("@/platform/auth/devices");
    const result = await registerDevice("p1", "device-123", "iPhone 15");

    expect(result.success).toBe(true);
    expect(mockClient.from).toHaveBeenCalledWith("player_devices");
  });

  it("returns error on upsert failure", async () => {
    const mockClient = createSequentialMockSupabase([
      {
        table: "player_devices",
        response: { data: null, error: { message: "constraint violation" } },
      },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { registerDevice } = await import("@/platform/auth/devices");
    const result = await registerDevice("p1", "device-123");

    expect(result.success).toBe(false);
    expect(result.error).toBe("constraint violation");
  });
});

describe("listPlayerDevices", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("returns mapped device records", async () => {
    const mockClient = createSequentialMockSupabase([
      {
        table: "player_devices",
        response: {
          data: [
            {
              id: "d1",
              player_id: "p1",
              device_id: "dev-1",
              device_name: "iPhone",
              is_trusted: true,
              last_used_at: "2026-03-31T00:00:00Z",
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
          error: null,
        },
      },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { listPlayerDevices } = await import("@/platform/auth/devices");
    const devices = await listPlayerDevices("p1");

    expect(devices).toHaveLength(1);
    expect(devices[0].deviceId).toBe("dev-1");
    expect(devices[0].deviceName).toBe("iPhone");
    expect(devices[0].isTrusted).toBe(true);
  });

  it("returns empty array on error", async () => {
    const mockClient = createSequentialMockSupabase([
      {
        table: "player_devices",
        response: { data: null, error: { message: "query failed" } },
      },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { listPlayerDevices } = await import("@/platform/auth/devices");
    const devices = await listPlayerDevices("p1");

    expect(devices).toEqual([]);
  });
});

// ── Consent Module ──────────────────────────────────────────────────────

describe("grantConsent", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("inserts consent record and writes audit log", async () => {
    const mockClient = createSequentialMockSupabase([
      { table: "consent_records", response: { data: null, error: null } },
      { table: "audit_log", response: { data: null, error: null } },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { grantConsent } = await import("@/platform/auth/consent");
    const result = await grantConsent({
      playerId: "p1",
      consentType: "marketing",
      consentVersion: "1.0",
    });

    expect(result.success).toBe(true);
    expect(mockClient.from).toHaveBeenCalledWith("consent_records");
  });
});

describe("revokeConsent", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("sets revoked_at and writes audit log", async () => {
    const mockClient = createSequentialMockSupabase([
      { table: "consent_records", response: { data: null, error: null } },
      { table: "audit_log", response: { data: null, error: null } },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { revokeConsent } = await import("@/platform/auth/consent");
    const result = await revokeConsent({
      playerId: "p1",
      consentType: "marketing",
    });

    expect(result.success).toBe(true);
    const builder = mockClient._fromCalls[0].builder;
    expect(builder.update).toHaveBeenCalled();
  });
});

// ── COPPA Module (DB operations) ────────────────────────────────────────

describe("recordAgeVerification", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("updates player with age data and writes audit log", async () => {
    const mockClient = createSequentialMockSupabase([
      { table: "players", response: { data: null, error: null } },
      { table: "audit_log", response: { data: null, error: null } },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { recordAgeVerification } = await import("@/platform/auth/coppa");
    const result = await recordAgeVerification("p1", "2000-06-15");

    expect(result.success).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.isMinor).toBe(false);
    expect(result.result!.contentRatingLevel).toBe(3);
  });

  it("returns error on DB failure", async () => {
    const mockClient = createSequentialMockSupabase([
      {
        table: "players",
        response: { data: null, error: { message: "update failed" } },
      },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { recordAgeVerification } = await import("@/platform/auth/coppa");
    const result = await recordAgeVerification("p1", "2020-01-01");

    expect(result.success).toBe(false);
    expect(result.error).toBe("update failed");
  });
});

describe("recordParentalConsent", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("updates player parental consent status", async () => {
    const mockClient = createSequentialMockSupabase([
      { table: "players", response: { data: null, error: null } },
      { table: "audit_log", response: { data: null, error: null } },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { recordParentalConsent } = await import("@/platform/auth/coppa");
    const result = await recordParentalConsent("p1", "granted", "parent@example.com");

    expect(result.success).toBe(true);
    const builder = mockClient._fromCalls[0].builder;
    expect(builder.update).toHaveBeenCalled();
  });
});
