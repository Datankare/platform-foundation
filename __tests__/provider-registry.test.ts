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

afterEach(() => {
  for (const v of SAFETY_STORES) delete process.env[v];
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_OWNER_URL;
});

/** ADR-053 D4: a durable store is reached through platform/data, which needs these. */
function database(): void {
  process.env.DATABASE_URL = "postgresql://app_tenant:pw@pooler.example.test:6543/app";
  process.env.DATABASE_OWNER_URL = "postgresql://owner:pw@db.example.test:5432/app";
}
function noDatabase(): void {
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_OWNER_URL;
}

/** Moderation and agent stores that refuse memory in production (audit X-3, X-21). */
const SAFETY_STORES = [
  "MODERATION_STORE",
  "STRIKE_STORE",
  "REVIEW_QUEUE_STORE",
  "PROPOSAL_STORE",
  "EFFECT_LEDGER",
  "APPROVAL_POLICY_STORE",
];

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
    delete process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
    delete process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
    delete process.env.NEXT_PUBLIC_COGNITO_REGION;
    delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
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

  it("refuses CACHE_PROVIDER=upstash without its credentials (TASK-139: no silent fallback)", async () => {
    process.env.CACHE_PROVIDER = "upstash";

    const { initProviders, resetProviders } =
      await import("@/platform/providers/registry");
    resetProviders();

    expect(() => initProviders()).toThrow(/CACHE_PROVIDER=upstash/);
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

// ADR-050 D1: production refuses test-double auth, so every production boot below that is not
// about auth runs on a real (contract-valid) auth configuration.
const realAuth = (): void => {
  process.env.AUTH_PROVIDER = "cognito";
  process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID = "us-east-1_AbC123";
  process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID = "abc123def456";
  process.env.GUEST_TOKEN_SECRET = "g".repeat(64);
  // TASK-139: a deployment declares its cache.
  process.env.CACHE_PROVIDER = "memory";
  process.env.TENANCY_MODE = "single";
  process.env.TENANT_ID = "00000000-0000-4000-8000-000000000001";
  delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
  delete process.env.E2E_TEST_DOUBLE_AUTH;
};

// "auth-init backward compat" is split over two blocks of the same name (test titles unchanged),
// each resetting modules before every test as the single block did.
const AUTH_COMPAT = "auth-init backward compat";

describe(AUTH_COMPAT, () => {
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
      for (const v of SAFETY_STORES) process.env[v] = "supabase";
      process.env.APP_STATE_STORE = "supabase";
      process.env.TRAJECTORY_STORE = "supabase";
      process.env.BUDGET_STORE = "supabase";
      database();
      process.env.GUEST_USAGE_STORE = "supabase";
      process.env.SOCIAL_STORE = "supabase";
      process.env.RATE_LIMIT_STORE = "supabase";
      delete process.env.E2E_IN_MEMORY_STORES;
      realAuth();
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

    it("throws in production when APP_STATE_STORE=supabase but DATABASE_URL is missing (no silent fallback)", async () => {
      setNodeEnv("production");
      allDurable();
      process.env.TRAJECTORY_STORE = "memory";
      process.env.BUDGET_STORE = "memory";
      noDatabase();
      expect(await boot()).toThrow(/APP_STATE_STORE/);
    });

    it("does NOT throw outside production (tests/local keep in-memory)", async () => {
      setNodeEnv("test");
      delete process.env.APP_STATE_STORE;
      delete process.env.TRAJECTORY_STORE;
      delete process.env.BUDGET_STORE;
      delete process.env.GUEST_USAGE_STORE;
      delete process.env.SOCIAL_STORE;
      delete process.env.RATE_LIMIT_STORE;
      expect(await boot()).not.toThrow();
    });

    it("does NOT throw in production when E2E_IN_MEMORY_STORES=true (test-harness opt-out)", async () => {
      setNodeEnv("production");
      delete process.env.APP_STATE_STORE;
      delete process.env.TRAJECTORY_STORE;
      delete process.env.BUDGET_STORE;
      delete process.env.GUEST_USAGE_STORE;
      delete process.env.SOCIAL_STORE;
      delete process.env.RATE_LIMIT_STORE;
      process.env.E2E_IN_MEMORY_STORES = "true";
      process.env.DEPLOYMENT_HOST = "ci";
      realAuth();
      expect(await boot()).not.toThrow();
      delete process.env.DEPLOYMENT_HOST;
    });

    it("THROWS in production when E2E_IN_MEMORY_STORES=true but DEPLOYMENT_HOST is not local or ci (TASK-140)", async () => {
      setNodeEnv("production");
      delete process.env.APP_STATE_STORE;
      delete process.env.TRAJECTORY_STORE;
      delete process.env.BUDGET_STORE;
      delete process.env.GUEST_USAGE_STORE;
      delete process.env.SOCIAL_STORE;
      delete process.env.RATE_LIMIT_STORE;
      process.env.E2E_IN_MEMORY_STORES = "true";
      process.env.DEPLOYMENT_HOST = "container";
      realAuth();
      expect(await boot()).toThrow(/DEPLOYMENT_HOST/);
      delete process.env.DEPLOYMENT_HOST;
    });

    it.each(SAFETY_STORES)(
      "throws in production when %s is memory (audit X-3, X-21)",
      async (store) => {
        setNodeEnv("production");
        allDurable();
        process.env[store] = "memory";
        expect(await boot()).toThrow(new RegExp(store));
      }
    );

    it.each(["MODERATION_STORE", "STRIKE_STORE", "REVIEW_QUEUE_STORE"])(
      "refuses %s=supabase without a database instead of falling back to memory",
      async (store) => {
        setNodeEnv("test");
        process.env[store] = "supabase";
        noDatabase();
        expect(await boot()).toThrow(
          new RegExp(`${store}=supabase but DATABASE_URL is not set`)
        );
      }
    );

    it("does NOT throw in production when every guarded store is durable with a database", async () => {
      setNodeEnv("production");
      allDurable();
      expect(await boot()).not.toThrow();
    });

    it("refuses to boot in production with DATABASE_URL but no DATABASE_OWNER_URL", async () => {
      setNodeEnv("production");
      allDurable();
      delete process.env.DATABASE_OWNER_URL;
      expect(await boot()).toThrow(/DATABASE_OWNER_URL is required/);
    });

    it("refuses to boot in production with durable stores and no DATABASE_URL", async () => {
      setNodeEnv("production");
      allDurable();
      noDatabase();
      expect(await boot()).toThrow(
        /DATABASE_URL is required \(.*MODERATION_STORE=supabase/
      );
    });

    // ADR-053 D4: every durable selection needs the database — "postgres" and "supabase" alike.
    const DURABLE_SELECTIONS = [
      ...SAFETY_STORES,
      "APP_STATE_STORE",
      "TRAJECTORY_STORE",
      "BUDGET_STORE",
      "GUEST_USAGE_STORE",
    ];
    it.each(
      DURABLE_SELECTIONS.flatMap((store) => [
        [store, "postgres"],
        [store, "supabase"],
      ])
    )(
      "refuses %s=%s with no DATABASE_URL, with the database message",
      async (store, type) => {
        setNodeEnv("test");
        for (const v of DURABLE_SELECTIONS) delete process.env[v];
        delete process.env.RATE_LIMIT_STORE;
        noDatabase();
        process.env[store] = type;
        expect(await boot()).toThrow(
          new RegExp(
            `${store}=${type} but DATABASE_URL is not set. Refusing to fall back`
          )
        );
        delete process.env[store];
      }
    );
  });
});

describe(AUTH_COMPAT, () => {
  beforeEach(() => {
    jest.resetModules();
  });

  // The social store (TASK-107) is the social module's durable slot: its refusals are tested
  // with the module (__tests__/modules/social.module.test.ts) and the generic module-slot rules
  // in __tests__/provider-registry-modules.test.ts (ADR-054 D4).

  describe("guest usage store (ADR-050 D4)", () => {
    const boot = async (): Promise<() => void> => {
      const { initProviders, resetProviders } =
        await import("@/platform/providers/registry");
      resetProviders();
      return () => initProviders();
    };

    it("refuses the memory store in production", async () => {
      setNodeEnv("production");
      realAuth();
      for (const v of SAFETY_STORES) process.env[v] = "supabase";
      process.env.APP_STATE_STORE = "supabase";
      process.env.TRAJECTORY_STORE = "supabase";
      process.env.BUDGET_STORE = "supabase";
      database();
      process.env.SOCIAL_STORE = "supabase";
      delete process.env.GUEST_USAGE_STORE;
      delete process.env.E2E_IN_MEMORY_STORES;
      expect(await boot()).toThrow(/GUEST_USAGE_STORE/);
    });

    it("refuses supabase without credentials", async () => {
      setNodeEnv("test");
      for (const v of ["APP_STATE_STORE", "TRAJECTORY_STORE", "BUDGET_STORE"])
        delete process.env[v];
      process.env.GUEST_USAGE_STORE = "supabase";
      process.env.SOCIAL_STORE = "supabase";
      noDatabase();
      expect(await boot()).toThrow(
        /GUEST_USAGE_STORE=supabase but DATABASE_URL is not set/
      );
    });

    it.each(["postgres", "supabase"])(
      "GUEST_USAGE_STORE=%s selects the Postgres store when a database is set",
      async (type) => {
        setNodeEnv("test");
        process.env.GUEST_USAGE_STORE = type;
        process.env.SOCIAL_STORE = "supabase";
        database();
        const { initProviders, resetProviders } =
          await import("@/platform/providers/registry");
        resetProviders();
        expect(initProviders().guestUsageStore).toBe(type);
        const { getGuestUsageStore, PostgresGuestUsageStore } =
          await import("@/platform/auth/guest-allowance");
        expect(getGuestUsageStore()).toBeInstanceOf(PostgresGuestUsageStore);
      }
    );
  });

  describe("environment contract at boot (ADR-050 D1/D2)", () => {
    const boot = async (): Promise<() => void> => {
      const { initProviders, resetProviders } =
        await import("@/platform/providers/registry");
      resetProviders();
      return () => initProviders();
    };
    const durable = (): void => {
      for (const v of SAFETY_STORES) process.env[v] = "supabase";
      process.env.APP_STATE_STORE = "supabase";
      process.env.TRAJECTORY_STORE = "supabase";
      process.env.BUDGET_STORE = "supabase";
      database();
      process.env.GUEST_USAGE_STORE = "supabase";
      process.env.SOCIAL_STORE = "supabase";
      process.env.RATE_LIMIT_STORE = "supabase";
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.E2E_IN_MEMORY_STORES;
    };

    it("refuses to boot in production on the mock auth provider (D1)", async () => {
      setNodeEnv("production");
      durable();
      delete process.env.AUTH_PROVIDER;
      delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
      delete process.env.E2E_TEST_DOUBLE_AUTH;
      expect(await boot()).toThrow(/AUTH_PROVIDER is unset \(defaults to mock\)/);
    });

    it("refuses before any slot initializes — no auth provider is registered", async () => {
      setNodeEnv("production");
      durable();
      process.env.AUTH_PROVIDER = "mock";
      delete process.env.E2E_TEST_DOUBLE_AUTH;
      const run = await boot();
      expect(run).toThrow(/refusing to boot/);
      const { hasAuthProvider } = await import("@/platform/auth/config");
      expect(hasAuthProvider()).toBe(false);
    });

    it("refuses disagreeing Supabase URLs (D2, TASK-103)", async () => {
      setNodeEnv("production");
      durable();
      realAuth();
      process.env.SUPABASE_URL = "https://example.supabase.co";
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://other.supabase.co";
      expect(await boot()).toThrow(
        /SUPABASE_URL and NEXT_PUBLIC_SUPABASE_URL .*disagree/
      );
    });

    it("boots in production on real auth via the canonical Cognito names", async () => {
      setNodeEnv("production");
      durable();
      realAuth();
      const { initProviders, resetProviders } =
        await import("@/platform/providers/registry");
      resetProviders();
      expect(initProviders().auth).toBe("cognito");
    });
  });
});
