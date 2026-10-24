/**
 * ADR-050 D1/D2 — deployment environment contract.
 */
import {
  ENVIRONMENT_CONTRACT,
  EnvironmentContractError,
  assertEnvironmentContract,
  checkEnvironmentContract,
  getAuthProviderSetting,
  getCognitoAdminCredentials,
  getCognitoSettings,
  getTenancySettings,
  getTenantHostHeader,
  getSsoProviders,
  getSupabaseUrl,
  getGitCommitSha,
  getShutdownSettings,
  allowsHarnessSwitches,
  resolveSetting,
  type EnvSource,
} from "@/platform/providers/environment-contract";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln";
const GUEST_SECRET = "a".repeat(64);
const REQUEST_DB =
  "postgresql://app_tenant.abcdefghijklmnop:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
const OWNER_DB =
  "postgresql://postgres.abcdefghijklmnop:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";

/** A valid production deployment, as playform-dev is configured. */
function valid(extra: Record<string, string | undefined> = {}): EnvSource {
  return {
    NODE_ENV: "production",
    DEPLOYMENT_HOST: "vercel",
    AUTH_PROVIDER: "cognito",
    NEXT_PUBLIC_COGNITO_USER_POOL_ID: "us-east-1_AbC123",
    NEXT_PUBLIC_COGNITO_CLIENT_ID: "abc123def456",
    NEXT_PUBLIC_COGNITO_REGION: "us-east-1",
    COGNITO_REGION: "us-east-1",
    SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: JWT,
    GUEST_TOKEN_SECRET: GUEST_SECRET,
    CRON_SECRET: "c".repeat(64),
    APP_STATE_STORE: "supabase",
    TRAJECTORY_STORE: "supabase",
    BUDGET_STORE: "supabase",
    CACHE_PROVIDER: "memory",
    TENANCY_MODE: "single",
    TENANT_ID: "00000000-0000-4000-8000-000000000001",
    DATABASE_URL: REQUEST_DB,
    DATABASE_OWNER_URL: OWNER_DB,
    ...extra,
  };
}

describe("environment contract — a valid deployment", () => {
  it("has no violations", () => {
    expect(checkEnvironmentContract(valid())).toEqual([]);
  });

  it("assert is a no-op outside production, whatever the settings", () => {
    expect(() => assertEnvironmentContract({ NODE_ENV: "test" })).not.toThrow();
    expect(() => assertEnvironmentContract({})).not.toThrow();
  });

  it("assert passes in production when valid", () => {
    expect(() => assertEnvironmentContract(valid())).not.toThrow();
  });

  it("assert reads process.env by default", () => {
    // jest runs with NODE_ENV=test — a no-op, but exercises the default argument.
    expect(() => assertEnvironmentContract()).not.toThrow();
  });
});

// Review finding 2: a deployment without CRON_SECRET booted and reported ready while its tick
// refused every call, so no timed duty ever ran. It is now refused at boot on every host (Vercel
// Cron and the container's worker call the same route); a local or CI run may leave it unset.
describe("ADR-056 D2 — the job tick's secret", () => {
  it.each(["vercel", "container", "aws"])(
    "refuses a %s deployment without CRON_SECRET, naming what would not run",
    (host) => {
      const v = checkEnvironmentContract(
        valid({ DEPLOYMENT_HOST: host, CRON_SECRET: undefined })
      ).join("\n");
      expect(v).toMatch(/CRON_SECRET is required/);
      expect(v).toMatch(/no timed duty/);
      expect(() =>
        assertEnvironmentContract(
          valid({ DEPLOYMENT_HOST: host, CRON_SECRET: undefined })
        )
      ).toThrow(EnvironmentContractError);
    }
  );

  it("refuses a production context with no DEPLOYMENT_HOST and no CRON_SECRET", () => {
    expect(
      checkEnvironmentContract(
        valid({ DEPLOYMENT_HOST: undefined, CRON_SECRET: undefined })
      ).join("\n")
    ).toMatch(/CRON_SECRET is required/);
  });

  it("refuses a short secret by its shape", () => {
    expect(checkEnvironmentContract(valid({ CRON_SECRET: "short" })).join("\n")).toMatch(
      /CRON_SECRET has the wrong shape/
    );
  });

  it.each(["local", "ci"])("lets a %s run leave it unset", (host) => {
    expect(
      checkEnvironmentContract(
        valid({ DEPLOYMENT_HOST: host, CRON_SECRET: undefined })
      ).filter((m) => m.startsWith("CRON_SECRET"))
    ).toEqual([]);
  });
});

describe("D1 — no test-double auth in production", () => {
  it("refuses AUTH_PROVIDER unset (defaults to mock)", () => {
    const v = checkEnvironmentContract(valid({ AUTH_PROVIDER: undefined }));
    expect(v.join("\n")).toMatch(/AUTH_PROVIDER is unset \(defaults to mock\)/);
  });

  it("refuses AUTH_PROVIDER=mock", () => {
    const v = checkEnvironmentContract(valid({ AUTH_PROVIDER: "mock" }));
    expect(v.join("\n")).toMatch(
      /AUTH_PROVIDER is "mock" — the mock provider is a test double/
    );
  });

  it("the store opt-out does not extend to auth", () => {
    const v = checkEnvironmentContract({
      NODE_ENV: "production",
      DEPLOYMENT_HOST: "ci",
      E2E_IN_MEMORY_STORES: "true",
    });
    expect(v.join("\n")).toMatch(/AUTH_PROVIDER/);
  });

  it.each(["local", "ci"])(
    "an E2E harness may opt in with E2E_TEST_DOUBLE_AUTH=true where DEPLOYMENT_HOST=%s",
    (host) => {
      expect(
        checkEnvironmentContract({
          NODE_ENV: "production",
          DEPLOYMENT_HOST: host,
          E2E_IN_MEMORY_STORES: "true",
          E2E_TEST_DOUBLE_AUTH: "true",
        })
      ).toEqual([]);
    }
  );

  it("the auth opt-out is refused on a deployment", () => {
    const v = checkEnvironmentContract(
      valid({ AUTH_PROVIDER: "mock", E2E_TEST_DOUBLE_AUTH: "true" })
    );
    expect(v).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^E2E_TEST_DOUBLE_AUTH is set but DEPLOYMENT_HOST is not/),
        expect.stringMatching(/mock provider is a test double/),
      ])
    );
  });

  it.each([
    ["DEPLOYMENT_HOST unset — a deployment that forgot the marker", undefined],
    ["a container", "container"],
    ["Vercel", "vercel"],
    ["AWS", "aws"],
  ])("refuses the harness switches with %s (TASK-140)", (_label, host) => {
    const v = checkEnvironmentContract({
      NODE_ENV: "production",
      DEPLOYMENT_HOST: host,
      E2E_IN_MEMORY_STORES: "true",
      E2E_TEST_DOUBLE_AUTH: "true",
    });
    expect(v).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^E2E_IN_MEMORY_STORES is set but DEPLOYMENT_HOST/),
        expect.stringMatching(/^E2E_TEST_DOUBLE_AUTH is set but DEPLOYMENT_HOST/),
        expect.stringMatching(/mock provider is a test double/),
      ])
    );
  });

  it("refuses a malformed DEPLOYMENT_HOST", () => {
    expect(checkEnvironmentContract(valid({ DEPLOYMENT_HOST: "Vercel Prod" }))).toEqual([
      expect.stringMatching(/^DEPLOYMENT_HOST has the wrong shape/),
    ]);
  });

  it.each(["E2E_IN_MEMORY_STORES", "E2E_TEST_DOUBLE_AUTH", "ADMIN_DEV_BYPASS"])(
    "refuses harness switch %s on a deployment",
    (name) => {
      const v = checkEnvironmentContract(valid({ [name]: "true" }));
      expect(v).toEqual([
        `${name} is set but DEPLOYMENT_HOST is not "local" or "ci" — it is for local and CI runs only`,
      ]);
    }
  );

  it("assert throws one error naming every violation", () => {
    let err: unknown;
    try {
      assertEnvironmentContract({ NODE_ENV: "production", SUPABASE_URL: "http://x" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnvironmentContractError);
    const e = err as EnvironmentContractError;
    expect(e.violations.length).toBe(5);
    expect(e.message).toMatch(/refusing to boot/);
    expect(e.message).toMatch(/CRON_SECRET is required/);
    expect(e.message).toMatch(/SUPABASE_URL has the wrong shape/);
    expect(e.message).toMatch(/AUTH_PROVIDER/);
    expect(e.message).toMatch(/CACHE_PROVIDER is required/);
    expect(e.message).toMatch(/TENANCY_MODE is required/);
  });
});

describe("the cache is chosen, never inferred (TASK-139)", () => {
  it("a deployment must declare CACHE_PROVIDER — even with the Redis URL set", () => {
    expect(
      checkEnvironmentContract(
        valid({
          CACHE_PROVIDER: undefined,
          UPSTASH_REDIS_REST_URL: "https://r.upstash.io",
        })
      )
    ).toEqual([
      "CACHE_PROVIDER is required: upstash (shared), or memory (per instance, declared on purpose)",
    ]);
  });

  it("accepts memory when declared, and upstash with its credentials", () => {
    expect(checkEnvironmentContract(valid({ CACHE_PROVIDER: "memory" }))).toEqual([]);
    expect(
      checkEnvironmentContract(
        valid({
          CACHE_PROVIDER: "upstash",
          UPSTASH_REDIS_REST_URL: "https://r.upstash.io",
          UPSTASH_REDIS_REST_TOKEN: "t",
        })
      )
    ).toEqual([]);
  });

  it("upstash without its credentials is refused, naming each", () => {
    expect(checkEnvironmentContract(valid({ CACHE_PROVIDER: "upstash" }))).toEqual([
      "UPSTASH_REDIS_REST_URL is required by CACHE_PROVIDER=upstash but not set",
      "UPSTASH_REDIS_REST_TOKEN is required by CACHE_PROVIDER=upstash but not set",
    ]);
  });

  it.each(["redis", "Memory", "upstash ", "none"])("refuses the value %p", (v) => {
    expect(checkEnvironmentContract(valid({ CACHE_PROVIDER: v }))).toEqual([
      expect.stringMatching(/^CACHE_PROVIDER has the wrong shape/),
    ]);
  });

  it("a local or CI run may leave it unset; a deployment claiming to be one may not hide behind it", () => {
    expect(
      checkEnvironmentContract(
        valid({ CACHE_PROVIDER: undefined, DEPLOYMENT_HOST: "ci" })
      )
    ).toEqual([]);
    expect(
      checkEnvironmentContract(
        valid({
          CACHE_PROVIDER: undefined,
          DEPLOYMENT_HOST: "container",
          NEXT_MANUAL_SIG_HANDLE: "true",
        })
      )
    ).toEqual([
      "CACHE_PROVIDER is required: upstash (shared), or memory (per instance, declared on purpose)",
    ]);
  });
});

describe("D2 — one source, declared shape", () => {
  it("refuses an alias set on its own", () => {
    const v = checkEnvironmentContract(
      valid({
        SUPABASE_URL: undefined,
        NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
      })
    );
    expect(v).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL is set but SUPABASE_URL is not — SUPABASE_URL is the single source",
    ]);
  });

  it("refuses canonical and alias that disagree (TASK-103)", () => {
    const v = checkEnvironmentContract(
      valid({ NEXT_PUBLIC_SUPABASE_URL: "https://other.supabase.co" })
    );
    expect(v).toEqual([
      "SUPABASE_URL and NEXT_PUBLIC_SUPABASE_URL are both set and disagree — set SUPABASE_URL only",
    ]);
  });

  it("accepts canonical and alias that agree", () => {
    expect(
      checkEnvironmentContract(
        valid({ NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co" })
      )
    ).toEqual([]);
  });

  it.each([
    ["with a path", "https://abc.supabase.co/rest/v1"],
    ["with a trailing slash", "https://abc.supabase.co/"],
    ["over http", "http://abc.supabase.co"],
    ["with trailing whitespace", "https://abc.supabase.co\n"],
  ])("refuses SUPABASE_URL %s", (_label, url) => {
    expect(checkEnvironmentContract(valid({ SUPABASE_URL: url }))).toEqual([
      "SUPABASE_URL has the wrong shape — expected https://<ref>.supabase.co — no path, no trailing slash",
    ]);
  });

  it.each(["sb_secret_abc123", "sb_publishable_abc123", "not-a-key"])(
    "refuses a service-role key that is not the legacy JWT (%s)",
    (key) => {
      const v = checkEnvironmentContract(valid({ SUPABASE_SERVICE_ROLE_KEY: key }));
      expect(v).toEqual([
        expect.stringMatching(/^SUPABASE_SERVICE_ROLE_KEY has the wrong shape/),
      ]);
      expect(v[0]).not.toContain(key);
    }
  );

  it("refuses an unknown AUTH_PROVIDER value", () => {
    const v = checkEnvironmentContract(valid({ AUTH_PROVIDER: "Cognito" }));
    expect(v).toEqual([
      "AUTH_PROVIDER has the wrong shape — expected one of: cognito, mock",
    ]);
  });

  it("never puts a value in a message", () => {
    const v = checkEnvironmentContract(
      valid({
        SUPABASE_SERVICE_ROLE_KEY: "sb_secret_TOPSECRET",
        NEXT_PUBLIC_SUPABASE_URL: "x",
      })
    );
    expect(v.join("\n")).not.toMatch(/TOPSECRET/);
  });

  it("declares each name once, across canonical names and aliases", () => {
    const names = ENVIRONMENT_CONTRACT.flatMap((d) => [d.name, ...d.aliases]);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("required settings", () => {
  it("cognito requires the pool and client ids", () => {
    const v = checkEnvironmentContract(
      valid({
        NEXT_PUBLIC_COGNITO_USER_POOL_ID: undefined,
        NEXT_PUBLIC_COGNITO_CLIENT_ID: undefined,
      })
    );
    expect(v).toEqual([
      "NEXT_PUBLIC_COGNITO_USER_POOL_ID is required by AUTH_PROVIDER=cognito",
      "NEXT_PUBLIC_COGNITO_CLIENT_ID is required by AUTH_PROVIDER=cognito",
    ]);
  });

  it("cognito region must match the pool id's region", () => {
    const v = checkEnvironmentContract(
      valid({ NEXT_PUBLIC_COGNITO_REGION: "us-west-2", COGNITO_REGION: undefined })
    );
    expect(v).toEqual([
      "NEXT_PUBLIC_COGNITO_REGION does not match the region of NEXT_PUBLIC_COGNITO_USER_POOL_ID",
    ]);
  });

  it("Realtime on Supabase requires URL and key, naming the selection", () => {
    const v = checkEnvironmentContract(
      valid({
        REALTIME_PROVIDER: "supabase",
        SUPABASE_URL: undefined,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
      })
    );
    expect(v).toEqual([
      "SUPABASE_URL is required (REALTIME_PROVIDER=supabase) but not set",
      "SUPABASE_SERVICE_ROLE_KEY is required (REALTIME_PROVIDER=supabase) but not set",
    ]);
  });

  it("a store on Supabase no longer needs the Supabase REST settings (ADR-053 D4)", () => {
    expect(
      checkEnvironmentContract(
        valid({ SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined })
      )
    ).toEqual([]);
  });

  it("no supabase selection, no supabase requirement", () => {
    expect(
      checkEnvironmentContract({
        NODE_ENV: "production",
        AUTH_PROVIDER: "cognito",
        NEXT_PUBLIC_COGNITO_USER_POOL_ID: "eu-west-1_X",
        NEXT_PUBLIC_COGNITO_CLIENT_ID: "c",
        GUEST_TOKEN_SECRET: GUEST_SECRET,
        CRON_SECRET: "c".repeat(64),
        CACHE_PROVIDER: "memory",
        TENANCY_MODE: "single",
        TENANT_ID: "00000000-0000-4000-8000-000000000001",
      })
    ).toEqual([]);
  });

  it("a real auth provider requires GUEST_TOKEN_SECRET (D4)", () => {
    expect(checkEnvironmentContract(valid({ GUEST_TOKEN_SECRET: undefined }))).toEqual([
      "GUEST_TOKEN_SECRET is required by AUTH_PROVIDER=cognito (signed guest tokens)",
    ]);
  });

  it("refuses a short GUEST_TOKEN_SECRET", () => {
    expect(checkEnvironmentContract(valid({ GUEST_TOKEN_SECRET: "short" }))).toEqual([
      "GUEST_TOKEN_SECRET has the wrong shape — expected at least 32 random bytes, base64 (e.g. openssl rand -base64 48)",
    ]);
  });

  it("the harness mock needs no guest secret", () => {
    expect(
      checkEnvironmentContract({
        NODE_ENV: "production",
        DEPLOYMENT_HOST: "ci",
        E2E_TEST_DOUBLE_AUTH: "true",
      })
    ).toEqual([]);
  });
});

describe("resolvers", () => {
  it("canonical wins; alias is the fallback; empty counts as unset", () => {
    expect(getSupabaseUrl({ SUPABASE_URL: "a", NEXT_PUBLIC_SUPABASE_URL: "b" })).toBe(
      "a"
    );
    expect(getSupabaseUrl({ NEXT_PUBLIC_SUPABASE_URL: "b" })).toBe("b");
    expect(getSupabaseUrl({ SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_URL: "b" })).toBe("b");
    expect(getSupabaseUrl({})).toBeUndefined();
    expect(getAuthProviderSetting({ NEXT_PUBLIC_AUTH_PROVIDER: "cognito" })).toBe(
      "cognito"
    );
  });

  it("cognito region: setting, else the pool's region, else us-east-1 — never AWS_REGION", () => {
    expect(
      getCognitoSettings({
        COGNITO_REGION: "eu-west-1",
        COGNITO_USER_POOL_ID: "us-east-1_X",
      })
    ).toEqual({ region: "eu-west-1", userPoolId: "us-east-1_X", clientId: "" });
    expect(
      getCognitoSettings({
        AWS_REGION: "us-west-2",
        NEXT_PUBLIC_COGNITO_USER_POOL_ID: "ap-south-1_X",
      }).region
    ).toBe("ap-south-1");
    expect(getCognitoSettings({ AWS_REGION: "us-west-2" }).region).toBe("us-east-1");
  });

  it("resolveSetting and helpers default to process.env", () => {
    expect(() => resolveSetting("SUPABASE_URL")).not.toThrow();
    expect(() => getCognitoSettings()).not.toThrow();
    expect(allowsHarnessSwitches({ DEPLOYMENT_HOST: "ci" })).toBe(true);
    expect(allowsHarnessSwitches({ DEPLOYMENT_HOST: "local" })).toBe(true);
    expect(allowsHarnessSwitches({ DEPLOYMENT_HOST: "vercel" })).toBe(false);
    expect(allowsHarnessSwitches({ VERCEL: "1" })).toBe(false);
    expect(allowsHarnessSwitches({})).toBe(false);
    expect(() => allowsHarnessSwitches()).not.toThrow();
  });
});

describe("SSO settings (TASK-101)", () => {
  const DOMAIN = "us-east-19prbnscbe.auth.us-east-1.amazoncognito.com";

  it("accepts the hosted domain as a host name and a provider list", () => {
    expect(
      checkEnvironmentContract(
        valid({ NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN: DOMAIN, SSO_PROVIDERS: "google" })
      )
    ).toEqual([]);
  });

  it("refuses a hosted domain with a scheme or path", () => {
    for (const bad of [`https://${DOMAIN}`, `${DOMAIN}/`, `${DOMAIN}/login`]) {
      expect(
        checkEnvironmentContract(valid({ NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN: bad }))
      ).toEqual([
        expect.stringMatching(
          /^NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN has the wrong shape/
        ),
      ]);
    }
  });

  it("refuses a malformed provider list", () => {
    for (const bad of ["google, apple", "Google", "facebook", "google,"]) {
      expect(
        checkEnvironmentContract(
          valid({ NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN: DOMAIN, SSO_PROVIDERS: bad })
        )
      ).toEqual([expect.stringMatching(/^SSO_PROVIDERS has the wrong shape/)]);
    }
  });

  it("requires the hosted domain when providers are listed", () => {
    expect(checkEnvironmentContract(valid({ SSO_PROVIDERS: "google" }))).toEqual([
      expect.stringMatching(
        /NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN is required by SSO_PROVIDERS/
      ),
    ]);
  });

  it("resolves the hosted domain and the provider list, deduplicated", () => {
    const env = {
      NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN: DOMAIN,
      SSO_PROVIDERS: "google,apple,google",
    };
    expect(getCognitoSettings(env).hostedUiDomain).toBe(DOMAIN);
    expect(getSsoProviders(env)).toEqual(["google", "apple"]);
    expect(getSsoProviders({})).toEqual([]);
    expect(getSsoProviders({ SSO_PROVIDERS: "bad" })).toEqual([]);
    expect(getSsoProviders()).toEqual(expect.any(Array));
  });
});

describe("tenancy is declared (ADR-053 D1)", () => {
  const T = "00000000-0000-4000-8000-000000000001";
  const A1 = "11111111-1111-4111-8111-111111111111";
  it("a deployment must declare TENANCY_MODE", () => {
    expect(
      checkEnvironmentContract(valid({ TENANCY_MODE: undefined, TENANT_ID: undefined }))
    ).toEqual(["TENANCY_MODE is required: single (with TENANT_ID) or shared"]);
  });

  it("single needs the tenant it serves", () => {
    expect(checkEnvironmentContract(valid({ TENANT_ID: undefined }))).toEqual([
      "TENANT_ID is required by TENANCY_MODE=single",
    ]);
  });

  // Access key shapes from AWS's documentation examples — not real credentials.
  const ADMIN = {
    COGNITO_ADMIN_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    COGNITO_ADMIN_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };
  const SHARED = {
    TENANCY_MODE: "shared",
    TENANT_ID: undefined,
    TENANT_DIRECTORY_STORE: "postgres",
    TENANT_HOST_HEADER: "x-forwarded-host",
    ...ADMIN,
  };

  it("shared declares where the request's address is read — never inferred", () => {
    expect(
      checkEnvironmentContract(valid({ ...SHARED, TENANT_HOST_HEADER: undefined }))
    ).toEqual([
      expect.stringMatching(/^TENANT_HOST_HEADER is required by TENANCY_MODE=shared/),
    ]);
    // Even a local or CI run in shared mode states it: it decides which tenant a request is.
    expect(
      checkEnvironmentContract(
        valid({ ...SHARED, TENANT_HOST_HEADER: undefined, DEPLOYMENT_HOST: "ci" })
      )
    ).toContainEqual(
      expect.stringMatching(/^TENANT_HOST_HEADER is required by TENANCY_MODE=shared/)
    );
    expect(
      checkEnvironmentContract(valid({ ...SHARED, TENANT_HOST_HEADER: "host" }))
    ).toEqual([]);
    for (const bad of [
      "X-Forwarded-Host",
      "forwarded",
      "x-real-host",
      "host,x-forwarded-host",
    ]) {
      expect(
        checkEnvironmentContract(valid({ ...SHARED, TENANT_HOST_HEADER: bad }))
      ).toEqual([expect.stringMatching(/^TENANT_HOST_HEADER has the wrong shape/)]);
    }
    // Single mode does not read it.
    expect(checkEnvironmentContract(valid({ TENANT_HOST_HEADER: undefined }))).toEqual(
      []
    );
  });

  it("getTenantHostHeader reads only the two declared choices", () => {
    expect(getTenantHostHeader({ TENANT_HOST_HEADER: "host" })).toBe("host");
    expect(getTenantHostHeader({ TENANT_HOST_HEADER: "x-forwarded-host" })).toBe(
      "x-forwarded-host"
    );
    expect(getTenantHostHeader({})).toBeUndefined();
    expect(getTenantHostHeader({ TENANT_HOST_HEADER: "HOST" })).toBeUndefined();
  });

  it("shared refuses a fixed TENANT_ID — one source of tenancy", () => {
    expect(checkEnvironmentContract(valid({ ...SHARED, TENANT_ID: T }))).toEqual([
      "TENANT_ID is set but TENANCY_MODE=shared — a shared deployment resolves each request's tenant; unset TENANT_ID",
    ]);
    expect(checkEnvironmentContract(valid(SHARED))).toEqual([]);
  });

  it("shared with Cognito needs the credentials that assign tenants", () => {
    expect(
      checkEnvironmentContract(
        valid({
          ...SHARED,
          COGNITO_ADMIN_ACCESS_KEY_ID: undefined,
          COGNITO_ADMIN_SECRET_ACCESS_KEY: undefined,
        })
      )
    ).toEqual([
      expect.stringMatching(
        /^COGNITO_ADMIN_ACCESS_KEY_ID and .* are required by TENANCY_MODE=shared/
      ),
    ]);
  });

  it("shared keeps its tenants durably", () => {
    expect(
      checkEnvironmentContract(valid({ ...SHARED, TENANT_DIRECTORY_STORE: undefined }))
    ).toEqual(["TENANT_DIRECTORY_STORE is required by TENANCY_MODE=shared: postgres"]);
    expect(
      checkEnvironmentContract(valid({ ...SHARED, TENANT_DIRECTORY_STORE: "redis" }))
    ).toEqual([expect.stringMatching(/^TENANT_DIRECTORY_STORE has the wrong shape/)]);
  });

  it("admin credentials come as a pair", () => {
    for (const missing of [
      "COGNITO_ADMIN_ACCESS_KEY_ID",
      "COGNITO_ADMIN_SECRET_ACCESS_KEY",
    ]) {
      expect(checkEnvironmentContract(valid({ ...ADMIN, [missing]: undefined }))).toEqual(
        [
          "COGNITO_ADMIN_ACCESS_KEY_ID and COGNITO_ADMIN_SECRET_ACCESS_KEY are set together or not at all",
        ]
      );
    }
  });

  it("a session token goes with temporary credentials, and only with them", () => {
    expect(
      checkEnvironmentContract(
        valid({ ...ADMIN, COGNITO_ADMIN_SESSION_TOKEN: "FwoGZXIvYXdzEXAMPLE" })
      )
    ).toEqual([
      expect.stringMatching(/^COGNITO_ADMIN_SESSION_TOKEN is set without temporary/),
    ]);
    expect(
      checkEnvironmentContract(
        valid({ ...ADMIN, COGNITO_ADMIN_ACCESS_KEY_ID: "ASIAIOSFODNN7EXAMPLE" })
      )
    ).toEqual([
      expect.stringMatching(/^COGNITO_ADMIN_SESSION_TOKEN is required by temporary/),
    ]);
    expect(
      checkEnvironmentContract(
        valid({
          ...ADMIN,
          COGNITO_ADMIN_ACCESS_KEY_ID: "ASIAIOSFODNN7EXAMPLE",
          COGNITO_ADMIN_SESSION_TOKEN: "FwoGZXIvYXdzEXAMPLE",
        })
      )
    ).toEqual([]);
  });

  it.each([
    ["COGNITO_ADMIN_ACCESS_KEY_ID", "akiaiosfodnn7example"],
    ["COGNITO_ADMIN_ACCESS_KEY_ID", "XYZAIOSFODNN7EXAMPLE"],
    ["COGNITO_ADMIN_SECRET_ACCESS_KEY", "too-short"],
  ])("refuses a malformed %s", (name, value) => {
    expect(checkEnvironmentContract(valid({ ...ADMIN, [name]: value }))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^${name} has the wrong shape`)),
      ])
    );
  });

  it("resolves the admin credentials only as a complete pair, never one half", () => {
    expect(getCognitoAdminCredentials(ADMIN)).toEqual({
      accessKeyId: ADMIN.COGNITO_ADMIN_ACCESS_KEY_ID,
      secretAccessKey: ADMIN.COGNITO_ADMIN_SECRET_ACCESS_KEY,
    });
    expect(
      getCognitoAdminCredentials({ COGNITO_ADMIN_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE" })
    ).toBeUndefined();
    expect(getCognitoAdminCredentials({})).toBeUndefined();
  });

  it("names settings in violations, never their values (secrets)", () => {
    const v = checkEnvironmentContract(
      valid({ ...ADMIN, COGNITO_ADMIN_SECRET_ACCESS_KEY: "s3cr3t-value-that-is-wrong" })
    ).join("\n");
    expect(v).not.toContain("s3cr3t-value-that-is-wrong");
  });

  it.each([
    ["an upper-case id", "0A1B2C3D-0000-4000-8000-000000000001"],
    ["not a UUID", "default"],
    ["a UUID with braces", `{${T}}`],
    ["an empty-looking id", "00000000-0000-0000-0000-000000000000"],
  ])("refuses %s as TENANT_ID", (_label, id) => {
    expect(checkEnvironmentContract(valid({ TENANT_ID: id }))).toEqual([
      expect.stringMatching(/^TENANT_ID has the wrong shape/),
    ]);
  });

  it.each(["multi", "Single", "SHARED", ""])("refuses TENANCY_MODE %p", (mode) => {
    const v = checkEnvironmentContract(valid({ TENANCY_MODE: mode }));
    expect(v.length).toBeGreaterThan(0);
  });

  it("reads single as its one tenant and shared as none fixed", () => {
    expect(getTenancySettings({ TENANCY_MODE: "single", TENANT_ID: A1 })).toEqual({
      mode: "single",
      tenantId: A1,
    });
    expect(getTenancySettings({})).toEqual({ mode: "single", tenantId: T });
    expect(getTenancySettings({ TENANCY_MODE: "shared" })).toEqual({
      mode: "shared",
      tenantId: undefined,
    });
  });

  it("a local or CI run may leave tenancy unset (single, the default tenant)", () => {
    expect(
      checkEnvironmentContract(
        valid({ TENANCY_MODE: undefined, TENANT_ID: undefined, DEPLOYMENT_HOST: "ci" })
      )
    ).toEqual([]);
  });
});

describe("the database connections (ADR-053 D4)", () => {
  it("a durable store requires DATABASE_URL, naming each selection", () => {
    expect(
      checkEnvironmentContract(
        valid({
          DATABASE_URL: undefined,
          DATABASE_OWNER_URL: undefined,
          MODERATION_STORE: "postgres",
        })
      )
    ).toEqual([
      // A module's durable selectors follow the core's: __tests__/provider-registry-modules.test.ts.
      "DATABASE_URL is required (MODERATION_STORE=postgres, APP_STATE_STORE=supabase, TRAJECTORY_STORE=supabase, BUDGET_STORE=supabase) but not set",
    ]);
  });

  it("a deployment needs the owner connection with the request one", () => {
    expect(checkEnvironmentContract(valid({ DATABASE_OWNER_URL: undefined }))).toEqual([
      "DATABASE_OWNER_URL is required with DATABASE_URL (operator paths: platform configuration and tenant lifecycle)",
    ]);
    expect(
      checkEnvironmentContract(
        valid({
          DEPLOYMENT_HOST: "ci",
          DATABASE_OWNER_URL: undefined,
          DATABASE_SSL: "disable",
        })
      )
    ).toEqual([]);
  });

  it("refuses the same user for both connections", () => {
    expect(checkEnvironmentContract(valid({ DATABASE_OWNER_URL: REQUEST_DB }))).toEqual([
      "DATABASE_URL and DATABASE_OWNER_URL use the same database user — the request connection must be the app_tenant role",
    ]);
  });

  it.each(["sslmode=require", "ssl=true", "sslrootcert=/x", "SSLMODE=disable"])(
    "refuses TLS options in a URL (%s)",
    (opt) => {
      expect(
        checkEnvironmentContract(valid({ DATABASE_URL: `${REQUEST_DB}?${opt}` }))
      ).toEqual([
        "DATABASE_URL carries TLS options — set DATABASE_SSL (and DATABASE_SSL_CA) instead",
      ]);
      expect(
        checkEnvironmentContract(
          valid({ DATABASE_OWNER_URL: `${OWNER_DB}?application_name=x&${opt}` })
        )
      ).toEqual([
        "DATABASE_OWNER_URL carries TLS options — set DATABASE_SSL (and DATABASE_SSL_CA) instead",
      ]);
    }
  );

  it("plaintext is for local and CI runs only", () => {
    expect(checkEnvironmentContract(valid({ DATABASE_SSL: "disable" }))).toEqual([
      'DATABASE_SSL=disable is for local and CI runs only (DEPLOYMENT_HOST "local" or "ci")',
    ]);
    expect(checkEnvironmentContract(valid({ DATABASE_SSL: "verify-full" }))).toEqual([]);
  });

  it("refuses encrypted-but-unverified TLS: there is no 'require' mode", () => {
    expect(checkEnvironmentContract(valid({ DATABASE_SSL: "require" }))).toEqual([
      expect.stringMatching(/^DATABASE_SSL has the wrong shape/),
    ]);
  });

  it.each([
    ["DATABASE_URL", "mysql://u:p@h:1/d"],
    ["DATABASE_URL", "postgresql://u@h:5432/d"],
    ["DATABASE_URL", "postgresql://u:p@h:5432/"],
    ["DATABASE_POOL_MAX", "0"],
    ["DATABASE_POOL_MAX", "51"],
    ["DATABASE_STATEMENT_TIMEOUT_MS", "99"],
    ["DATABASE_STATEMENT_TIMEOUT_MS", "600001"],
    ["DATABASE_SSL", "verify-ca"],
    ["DATABASE_SSL_CA", "not a certificate"],
  ])("refuses %s with the wrong shape, never echoing it", (name, value) => {
    const v = checkEnvironmentContract(valid({ [name]: value }));
    expect(v).toEqual([
      expect.stringMatching(new RegExp(`^${name} has the wrong shape`)),
    ]);
    // Short numbers can occur in the hint itself (1–50); the rest must never be echoed.
    if (value.length > 3) expect(v.join("\n")).not.toContain(value);
  });

  it("accepts the optional settings at their bounds", () => {
    expect(
      checkEnvironmentContract(
        valid({
          DATABASE_POOL_MAX: "50",
          DATABASE_STATEMENT_TIMEOUT_MS: "600000",
          DATABASE_SSL_CA:
            "-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----\\n",
        })
      )
    ).toEqual([]);
    expect(
      checkEnvironmentContract(
        valid({ DATABASE_POOL_MAX: "1", DATABASE_STATEMENT_TIMEOUT_MS: "100" })
      )
    ).toEqual([]);
  });
});

describe("ADR-055 — the container image's settings", () => {
  const container = (extra: Record<string, string | undefined> = {}) =>
    valid({ DEPLOYMENT_HOST: "container", NEXT_MANUAL_SIG_HANDLE: "true", ...extra });

  it("a container deployment as the image runs it has no violations", () => {
    expect(
      checkEnvironmentContract(
        container({
          GIT_COMMIT_SHA: "e3c3fe4a1b2c3d4e5f60718293a4b5c6d7e8f901",
          SHUTDOWN_DRAIN_SECONDS: "10",
          SHUTDOWN_TIMEOUT_SECONDS: "25",
        })
      )
    ).toEqual([]);
  });

  it("D5: a container must own its signals, or SIGTERM ends it before it drains", () => {
    expect(
      checkEnvironmentContract(container({ NEXT_MANUAL_SIG_HANDLE: undefined }))
    ).toEqual([
      "NEXT_MANUAL_SIG_HANDLE=true is required by DEPLOYMENT_HOST=container (graceful shutdown — the image sets it)",
    ]);
    // Another host (Vercel) keeps Next.js's own handling.
    expect(checkEnvironmentContract(valid())).toEqual([]);
  });

  it.each(["false", "1", "TRUE"])(
    "refuses NEXT_MANUAL_SIG_HANDLE=%p — Next.js treats any value as set",
    (v) => {
      expect(checkEnvironmentContract(container({ NEXT_MANUAL_SIG_HANDLE: v }))).toEqual([
        expect.stringMatching(/^NEXT_MANUAL_SIG_HANDLE has the wrong shape/),
      ]);
    }
  );

  it.each(["main", "unknown", "abc12", "g".repeat(40), "a".repeat(41)])(
    "D2: refuses GIT_COMMIT_SHA=%p — the commit is what the smoke test proves",
    (v) => {
      expect(checkEnvironmentContract(valid({ GIT_COMMIT_SHA: v }))).toEqual([
        expect.stringMatching(/^GIT_COMMIT_SHA has the wrong shape/),
      ]);
    }
  );

  it("D2: reads the commit through the contract", () => {
    expect(getGitCommitSha({ GIT_COMMIT_SHA: "abc1234" })).toBe("abc1234");
    expect(getGitCommitSha({ GIT_COMMIT_SHA: "" })).toBeUndefined();
  });

  it.each([
    ["SHUTDOWN_DRAIN_SECONDS", "-1"],
    ["SHUTDOWN_DRAIN_SECONDS", "301"],
    ["SHUTDOWN_DRAIN_SECONDS", "5s"],
    ["SHUTDOWN_TIMEOUT_SECONDS", "0"],
    ["SHUTDOWN_TIMEOUT_SECONDS", "601"],
    ["SHUTDOWN_TIMEOUT_SECONDS", "1.5"],
  ])("refuses %s=%p", (name, value) => {
    expect(checkEnvironmentContract(container({ [name]: value }))).toEqual([
      expect.stringMatching(new RegExp(`^${name} has the wrong shape`)),
    ]);
  });

  it.each([
    [{ SHUTDOWN_DRAIN_SECONDS: "9" }],
    [{ SHUTDOWN_DRAIN_SECONDS: "30", SHUTDOWN_TIMEOUT_SECONDS: "30" }],
    [{ SHUTDOWN_TIMEOUT_SECONDS: "5" }],
  ])("refuses a bound that does not include the drain: %p", (extra) => {
    expect(checkEnvironmentContract(container(extra))).toEqual([
      "SHUTDOWN_TIMEOUT_SECONDS must be greater than SHUTDOWN_DRAIN_SECONDS (the bound includes the drain)",
    ]);
  });

  it("accepts the shutdown settings at their bounds", () => {
    expect(
      checkEnvironmentContract(
        container({ SHUTDOWN_DRAIN_SECONDS: "0", SHUTDOWN_TIMEOUT_SECONDS: "1" })
      )
    ).toEqual([]);
    expect(
      checkEnvironmentContract(
        container({ SHUTDOWN_DRAIN_SECONDS: "300", SHUTDOWN_TIMEOUT_SECONDS: "600" })
      )
    ).toEqual([]);
  });

  it("D5: shutdown settings — defaults fit Docker's 10 s grace; malformed falls back; the bound always outlasts the drain", () => {
    expect(getShutdownSettings({})).toEqual({ drainMs: 5_000, timeoutMs: 9_000 });
    expect(
      getShutdownSettings({
        SHUTDOWN_DRAIN_SECONDS: "20",
        SHUTDOWN_TIMEOUT_SECONDS: "28",
      })
    ).toEqual({ drainMs: 20_000, timeoutMs: 28_000 });
    expect(
      getShutdownSettings({
        SHUTDOWN_DRAIN_SECONDS: "abc",
        SHUTDOWN_TIMEOUT_SECONDS: "-3",
      })
    ).toEqual({ drainMs: 5_000, timeoutMs: 9_000 });
    expect(getShutdownSettings({ SHUTDOWN_DRAIN_SECONDS: "30" })).toEqual({
      drainMs: 30_000,
      timeoutMs: 31_000,
    });
  });
});
