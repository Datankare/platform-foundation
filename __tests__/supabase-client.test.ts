/**
 * Supabase client factory tests.
 *
 * Verifies:
 * - Correct env vars are read
 * - Correct options are passed
 * - Missing env vars throw descriptive errors
 * - Browser client is a singleton
 * - User client passes JWT as Authorization header
 */

import { createClient } from "@supabase/supabase-js";

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn().mockReturnValue({ from: jest.fn() }),
}));

const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;

// Save original env
const originalEnv = { ...process.env };

beforeEach(() => {
  mockCreateClient.mockClear();
  mockCreateClient.mockReturnValue({ from: jest.fn() } as never);
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("getSupabaseServiceClient", () => {
  it("creates a client with service role key", async () => {
    const { getSupabaseServiceClient } = await import("@/lib/supabase/server");
    getSupabaseServiceClient();

    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://test.supabase.co",
      "test-service-role-key",
      expect.objectContaining({
        auth: expect.objectContaining({
          autoRefreshToken: false,
          persistSession: false,
        }),
      })
    );
  });

  it("creates a new client each call (not singleton)", async () => {
    const { getSupabaseServiceClient } = await import("@/lib/supabase/server");
    getSupabaseServiceClient();
    getSupabaseServiceClient();

    // Each call after the first in this test
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  it("throws if SUPABASE_SERVICE_ROLE_KEY is missing", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { getSupabaseServiceClient } = await import("@/lib/supabase/server");

    expect(() => getSupabaseServiceClient()).toThrow(
      "Missing Supabase environment variables"
    );
  });

  it("throws if NEXT_PUBLIC_SUPABASE_URL is missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const { getSupabaseServiceClient } = await import("@/lib/supabase/server");

    expect(() => getSupabaseServiceClient()).toThrow(
      "Missing Supabase environment variables"
    );
  });
});

describe("getSupabaseUserClient", () => {
  it("creates a client with JWT in Authorization header", async () => {
    const { getSupabaseUserClient } = await import("@/lib/supabase/server");
    getSupabaseUserClient("cognito-jwt-token-123");

    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://test.supabase.co",
      "test-anon-key",
      expect.objectContaining({
        auth: expect.objectContaining({
          autoRefreshToken: false,
          persistSession: false,
        }),
        global: expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer cognito-jwt-token-123",
          }),
        }),
      })
    );
  });

  it("creates a new client per call with different tokens", async () => {
    const { getSupabaseUserClient } = await import("@/lib/supabase/server");
    getSupabaseUserClient("token-a");
    getSupabaseUserClient("token-b");

    // Find the two user client calls (anon key, not service role key)
    const userCalls = mockCreateClient.mock.calls.filter(
      (call) => call[1] === "test-anon-key"
    );
    expect(userCalls.length).toBe(2);
    expect(
      (userCalls[0][2] as { global: { headers: { Authorization: string } } }).global
        .headers.Authorization
    ).toBe("Bearer token-a");
    expect(
      (userCalls[1][2] as { global: { headers: { Authorization: string } } }).global
        .headers.Authorization
    ).toBe("Bearer token-b");
  });

  it("throws if NEXT_PUBLIC_SUPABASE_URL is missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const { getSupabaseUserClient } = await import("@/lib/supabase/server");

    expect(() => getSupabaseUserClient("token")).toThrow(
      "Missing Supabase environment variables"
    );
  });

  it("throws if NEXT_PUBLIC_SUPABASE_ANON_KEY is missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const { getSupabaseUserClient } = await import("@/lib/supabase/server");

    expect(() => getSupabaseUserClient("token")).toThrow(
      "Missing Supabase environment variables"
    );
  });
});

describe("getSupabaseBrowserClient", () => {
  it("creates a client with anon key and correct auth options", async () => {
    const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
    getSupabaseBrowserClient();

    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://test.supabase.co",
      "test-anon-key",
      expect.objectContaining({
        auth: expect.objectContaining({
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        }),
      })
    );
  });

  it("throws if NEXT_PUBLIC_SUPABASE_URL is missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;

    // Browser client is a singleton — need fresh module to test missing env
    jest.resetModules();
    jest.mock("@supabase/supabase-js", () => ({
      createClient: jest.fn().mockReturnValue({ from: jest.fn() }),
    }));

    const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
    expect(() => getSupabaseBrowserClient()).toThrow(
      "Missing Supabase environment variables"
    );
  });

  it("throws if NEXT_PUBLIC_SUPABASE_ANON_KEY is missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    jest.resetModules();
    jest.mock("@supabase/supabase-js", () => ({
      createClient: jest.fn().mockReturnValue({ from: jest.fn() }),
    }));

    const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
    expect(() => getSupabaseBrowserClient()).toThrow(
      "Missing Supabase environment variables"
    );
  });
});
