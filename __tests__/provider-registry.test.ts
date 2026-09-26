/**
 * Provider Registry Tests
 *
 * Tests env-driven provider selection, fallback behavior,
 * and idempotent initialization.
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

describe("Provider Registry", () => {
  const origEnv = { ...process.env };

  beforeEach(async () => {
    jest.resetModules();
    // ADR-032: resetProviders() now clears the slots as well as the flag; module
    // re-import stopped being the clearing mechanism.
    const { resetProviders } = await import("@/platform/providers/registry");
    resetProviders();
    process.env = { ...origEnv };
    delete process.env.AUTH_PROVIDER;
    delete process.env.CACHE_PROVIDER;
    delete process.env.AI_PROVIDER;
    delete process.env.ERROR_REPORTER;
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_CLIENT_ID;
    delete process.env.COGNITO_REGION;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("defaults to all mocks when no env vars set", async () => {
    const { initProviders, resetProviders } =
      await import("@/platform/providers/registry");
    resetProviders();

    const selections = initProviders();

    expect(selections.auth).toBe("mock");
    expect(selections.cache).toBe("memory");
    expect(selections.ai).toBe("mock");
    expect(selections.errorReporter).toBe("noop");
  });

  it("selects cognito when AUTH_PROVIDER=cognito and config present", async () => {
    process.env.AUTH_PROVIDER = "cognito";
    process.env.COGNITO_USER_POOL_ID = "us-east-1_TestPool";
    process.env.COGNITO_CLIENT_ID = "test-client";

    const { initProviders, resetProviders } =
      await import("@/platform/providers/registry");
    resetProviders();

    const selections = initProviders();
    expect(selections.auth).toBe("cognito");

    // Verify provider is registered and functional
    const { getAuthProvider } = await import("@/platform/auth/config");
    const provider = getAuthProvider();
    expect(provider).toBeDefined();
  });

  it("falls back to mock when AUTH_PROVIDER=cognito but config missing", async () => {
    process.env.AUTH_PROVIDER = "cognito";
    // No COGNITO_USER_POOL_ID or COGNITO_CLIENT_ID

    const { initProviders, resetProviders } =
      await import("@/platform/providers/registry");
    resetProviders();

    const { logger } = jest.requireMock("@/lib/logger");
    initProviders();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("falling back to mock")
    );
  });

  it("selects upstash when CACHE_PROVIDER=upstash", async () => {
    process.env.CACHE_PROVIDER = "upstash";
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";

    const { initProviders, resetProviders } =
      await import("@/platform/providers/registry");
    resetProviders();

    const selections = initProviders();
    expect(selections.cache).toBe("upstash");
  });

  it("warns when CACHE_PROVIDER=upstash but config missing", async () => {
    process.env.CACHE_PROVIDER = "upstash";

    const { initProviders, resetProviders } =
      await import("@/platform/providers/registry");
    resetProviders();

    const { logger } = jest.requireMock("@/lib/logger");
    initProviders();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("falling back to memory")
    );
  });

  it("warns when AI_PROVIDER=anthropic but key missing", async () => {
    process.env.AI_PROVIDER = "anthropic";

    const { initProviders, resetProviders } =
      await import("@/platform/providers/registry");
    resetProviders();

    const { logger } = jest.requireMock("@/lib/logger");
    initProviders();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ANTHROPIC_API_KEY missing")
    );
  });

  it("warns when ERROR_REPORTER=sentry but DSN missing", async () => {
    process.env.ERROR_REPORTER = "sentry";

    const { initProviders, resetProviders } =
      await import("@/platform/providers/registry");
    resetProviders();

    const { logger } = jest.requireMock("@/lib/logger");
    initProviders();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("SENTRY_DSN missing")
    );
  });

  it("is idempotent — second call returns same selections", async () => {
    const { initProviders, resetProviders } =
      await import("@/platform/providers/registry");
    resetProviders();

    const first = initProviders();
    const second = initProviders();

    expect(first).toEqual(second);
  });

  it("getActiveProviders returns current selections", async () => {
    process.env.AUTH_PROVIDER = "mock";
    process.env.CACHE_PROVIDER = "memory";

    const { getActiveProviders } = await import("@/platform/providers/registry");

    const active = getActiveProviders();
    expect(active.auth).toBe("mock");
    expect(active.cache).toBe("memory");
  });

  it("logs provider selections on init", async () => {
    const { initProviders, resetProviders } =
      await import("@/platform/providers/registry");
    resetProviders();

    const { logger } = jest.requireMock("@/lib/logger");
    initProviders();

    expect(logger.info).toHaveBeenCalledWith(
      "Platform providers initialized",
      expect.objectContaining({
        auth: "mock",
        cache: "memory",
        ai: "mock",
        errorReporter: "noop",
      })
    );
  });
});

describe("auth-init backward compat", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("initAuth delegates to initProviders", async () => {
    const { initAuth } = await import("@/platform/auth/auth-init");
    const { hasAuthProvider } = await import("@/platform/auth/config");

    initAuth();
    expect(hasAuthProvider()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // ADR-048 D3 + ADR-049 D1: durable stores are required in production
  // -------------------------------------------------------------------------
  describe("durable stores \u2014 production fail-closed (ADR-048 D3, ADR-049 D1)", () => {
    // Every guarded store durable, so each test can flip exactly one to memory and assert
    // that the named store (not whichever is initialized first) is what refuses to boot.
    const allDurable = (): void => {
      process.env.APP_STATE_STORE = "supabase";
      process.env.TRAJECTORY_STORE = "supabase";
      process.env.BUDGET_STORE = "supabase";
      process.env.SUPABASE_URL = "https://example.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
      delete process.env.E2E_IN_MEMORY_STORES;
    };
    const boot = async (): Promise<() => void> => {
      const { initProviders, resetProviders } =
        await import("@/platform/providers/registry");
      resetProviders();
      return () => initProviders();
    };

    it("throws in production when APP_STATE_STORE is unset (defaults to memory)", async () => {
      setNodeEnv("production");
      allDurable();
      delete process.env.APP_STATE_STORE;
      expect(await boot()).toThrow(/APP_STATE_STORE/);
    });

    it("throws in production when TRAJECTORY_STORE is unset (defaults to memory)", async () => {
      setNodeEnv("production");
      allDurable();
      delete process.env.TRAJECTORY_STORE;
      expect(await boot()).toThrow(/TRAJECTORY_STORE/);
    });

    it("throws in production when BUDGET_STORE is memory", async () => {
      setNodeEnv("production");
      allDurable();
      process.env.BUDGET_STORE = "memory";
      expect(await boot()).toThrow(/BUDGET_STORE/);
    });

    it("throws in production when APP_STATE_STORE=supabase but creds are missing (no silent fallback)", async () => {
      setNodeEnv("production");
      allDurable();
      process.env.TRAJECTORY_STORE = "memory";
      process.env.BUDGET_STORE = "memory";
      delete process.env.SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      expect(await boot()).toThrow(/APP_STATE_STORE/);
    });

    it("does NOT throw outside production (tests/local keep in-memory)", async () => {
      setNodeEnv("test");
      delete process.env.APP_STATE_STORE;
      delete process.env.TRAJECTORY_STORE;
      delete process.env.BUDGET_STORE;
      expect(await boot()).not.toThrow();
    });

    it("does NOT throw in production when E2E_IN_MEMORY_STORES=true (test-harness opt-out)", async () => {
      setNodeEnv("production");
      delete process.env.APP_STATE_STORE;
      delete process.env.TRAJECTORY_STORE;
      delete process.env.BUDGET_STORE;
      process.env.E2E_IN_MEMORY_STORES = "true";
      expect(await boot()).not.toThrow();
    });

    it("does NOT throw in production when every guarded store is supabase with creds", async () => {
      setNodeEnv("production");
      allDurable();
      expect(await boot()).not.toThrow();
    });
  });
});
