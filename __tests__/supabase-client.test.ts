/**
 * Supabase client factory tests.
 *
 * Mocks @supabase/supabase-js createClient to verify:
 * - Correct env vars are read
 * - Correct options are passed
 * - Missing env vars throw descriptive errors
 * - Browser client is a singleton
 * - Player client passes JWT as Authorization header
 */

const mockCreateClient = jest.fn().mockReturnValue({ from: jest.fn() });

jest.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

// Save original env
const originalEnv = { ...process.env };

beforeEach(() => {
  jest.resetModules();
  mockCreateClient.mockClear();
  mockCreateClient.mockReturnValue({ from: jest.fn() });
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("getSupabaseBrowserClient", () => {
  it("creates a client with anon key and correct options", () => {
    const { getSupabaseBrowserClient } = require("@/lib/supabase/client");
    const client = getSupabaseBrowserClient();

    expect(client).toBeDefined();
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

  it("returns the same singleton instance on second call", () => {
    const { getSupabaseBrowserClient } = require("@/lib/supabase/client");
    const client1 = getSupabaseBrowserClient();
    const client2 = getSupabaseBrowserClient();

    expect(client1).toBe(client2);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it("throws if NEXT_PUBLIC_SUPABASE_URL is missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    jest.resetModules();
    const { getSupabaseBrowserClient } = require("@/lib/supabase/client");

    expect(() => getSupabaseBrowserClient()).toThrow(
      "Missing Supabase environment variables"
    );
  });

  it("throws if NEXT_PUBLIC_SUPABASE_ANON_KEY is missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    jest.resetModules();
    const { getSupabaseBrowserClient } = require("@/lib/supabase/client");

    expect(() => getSupabaseBrowserClient()).toThrow(
      "Missing Supabase environment variables"
    );
  });
});

describe("getSupabaseServiceClient", () => {
  it("creates a client with service role key", () => {
    const { getSupabaseServiceClient } = require("@/lib/supabase/server");
    const client = getSupabaseServiceClient();

    expect(client).toBeDefined();
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

  it("creates a new client each call (not singleton)", () => {
    const { getSupabaseServiceClient } = require("@/lib/supabase/server");
    getSupabaseServiceClient();
    getSupabaseServiceClient();

    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  it("throws if SUPABASE_SERVICE_ROLE_KEY is missing", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { getSupabaseServiceClient } = require("@/lib/supabase/server");

    expect(() => getSupabaseServiceClient()).toThrow(
      "Missing Supabase environment variables"
    );
  });
});

describe("getSupabasePlayerClient", () => {
  it("creates a client with JWT in Authorization header", () => {
    const { getSupabasePlayerClient } = require("@/lib/supabase/server");
    const client = getSupabasePlayerClient("cognito-jwt-token-123");

    expect(client).toBeDefined();
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

  it("creates a new client per call with different tokens", () => {
    const { getSupabasePlayerClient } = require("@/lib/supabase/server");
    getSupabasePlayerClient("token-a");
    getSupabasePlayerClient("token-b");

    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    expect(mockCreateClient.mock.calls[0][2].global.headers.Authorization).toBe(
      "Bearer token-a"
    );
    expect(mockCreateClient.mock.calls[1][2].global.headers.Authorization).toBe(
      "Bearer token-b"
    );
  });

  it("throws if NEXT_PUBLIC_SUPABASE_URL is missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const { getSupabasePlayerClient } = require("@/lib/supabase/server");

    expect(() => getSupabasePlayerClient("token")).toThrow(
      "Missing Supabase environment variables"
    );
  });
});
