/**
 * Provider Registry Tests
 *
 * Tests env-driven provider selection, fallback behavior,
 * and idempotent initialization.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe("Provider Registry", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
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
});
