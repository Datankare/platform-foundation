/**
 * The rate-limiter provider slot (ADR-052): production refuses a per-instance limiter, a shared
 * store without credentials is refused rather than replaced by memory, and the selected store is
 * installed as the shared limiter.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// NODE_ENV is typed read-only; set it via defineProperty in tests that need it.
function setNodeEnv(v: string): void {
  Object.defineProperty(process.env, "NODE_ENV", {
    value: v,
    configurable: true,
    writable: true,
  });
}

const SERVICE_ROLE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln";
const origEnv = { ...process.env };

const realAuth = (): void => {
  process.env.AUTH_PROVIDER = "cognito";
  process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID = "us-east-1_AbC123";
  process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID = "abc123def456";
  process.env.GUEST_TOKEN_SECRET = "g".repeat(64);
  delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
  delete process.env.E2E_TEST_DOUBLE_AUTH;
};

afterEach(() => {
  process.env = { ...origEnv };
});

describe("rate limiter (ADR-052)", () => {
  const boot = async (): Promise<() => void> => {
    const { initProviders, resetProviders } =
      await import("@/platform/providers/registry");
    resetProviders();
    return () => initProviders();
  };
  const otherStoresDurable = (): void => {
    for (const v of [
      "APP_STATE_STORE",
      "TRAJECTORY_STORE",
      "BUDGET_STORE",
      "GUEST_USAGE_STORE",
      "SOCIAL_STORE",
    ]) {
      process.env[v] = "supabase";
    }
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_JWT;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.E2E_IN_MEMORY_STORES;
  };

  it("refuses the in-memory limiter in production", async () => {
    setNodeEnv("production");
    realAuth();
    otherStoresDurable();
    delete process.env.RATE_LIMIT_STORE;
    expect(await boot()).toThrow(/RATE_LIMIT_STORE/);
  });

  it("refuses the Supabase store without credentials instead of falling back to memory", async () => {
    setNodeEnv("test");
    for (const v of [
      "APP_STATE_STORE",
      "TRAJECTORY_STORE",
      "BUDGET_STORE",
      "GUEST_USAGE_STORE",
      "SOCIAL_STORE",
    ]) {
      delete process.env[v];
    }
    process.env.RATE_LIMIT_STORE = "supabase";
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(await boot()).toThrow(/RATE_LIMIT_STORE=supabase but SUPABASE_URL/);
  });

  it("refuses RATE_LIMIT_STORE=upstash without its credentials at the contract (production)", async () => {
    setNodeEnv("production");
    realAuth();
    otherStoresDurable();
    process.env.RATE_LIMIT_STORE = "upstash";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    expect(await boot()).toThrow(
      /UPSTASH_REDIS_REST_URL is required by RATE_LIMIT_STORE=upstash/
    );
  });

  it("installs the Supabase limiter as the shared limiter", async () => {
    setNodeEnv("test");
    process.env.RATE_LIMIT_STORE = "supabase";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_JWT;
    const { initProviders, resetProviders } =
      await import("@/platform/providers/registry");
    resetProviders();
    expect(initProviders().rateLimiter).toBe("supabase");
    const { getRateLimiter } = await import("@/platform/rate-limit");
    expect(getRateLimiter().name).toBe("supabase");
  });
});

// A module, not a script: keeps these helpers out of the global type scope.
export {};
