/**
 * ADR-050 D1/D2 — deployment environment contract.
 */
import {
  ENVIRONMENT_CONTRACT,
  EnvironmentContractError,
  assertEnvironmentContract,
  checkEnvironmentContract,
  getAuthProviderSetting,
  getCognitoSettings,
  getSupabaseUrl,
  isHostedDeployment,
  resolveSetting,
  type EnvSource,
} from "@/platform/providers/environment-contract";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln";
const GUEST_SECRET = "a".repeat(64);

/** A valid production deployment, as playform-dev is configured. */
function valid(extra: Record<string, string | undefined> = {}): EnvSource {
  return {
    NODE_ENV: "production",
    VERCEL: "1",
    AUTH_PROVIDER: "cognito",
    NEXT_PUBLIC_COGNITO_USER_POOL_ID: "us-east-1_AbC123",
    NEXT_PUBLIC_COGNITO_CLIENT_ID: "abc123def456",
    NEXT_PUBLIC_COGNITO_REGION: "us-east-1",
    COGNITO_REGION: "us-east-1",
    SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: JWT,
    GUEST_TOKEN_SECRET: GUEST_SECRET,
    APP_STATE_STORE: "supabase",
    TRAJECTORY_STORE: "supabase",
    BUDGET_STORE: "supabase",
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
      E2E_IN_MEMORY_STORES: "true",
    });
    expect(v.join("\n")).toMatch(/AUTH_PROVIDER/);
  });

  it("an E2E harness (not hosted) may opt in with E2E_TEST_DOUBLE_AUTH=true", () => {
    expect(
      checkEnvironmentContract({
        NODE_ENV: "production",
        E2E_IN_MEMORY_STORES: "true",
        E2E_TEST_DOUBLE_AUTH: "true",
      })
    ).toEqual([]);
  });

  it("the auth opt-out is refused on a hosted deployment", () => {
    const v = checkEnvironmentContract(
      valid({ AUTH_PROVIDER: "mock", E2E_TEST_DOUBLE_AUTH: "true" })
    );
    expect(v).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^E2E_TEST_DOUBLE_AUTH is set on a hosted deployment/),
        expect.stringMatching(/mock provider is a test double/),
      ])
    );
  });

  it.each(["E2E_IN_MEMORY_STORES", "E2E_TEST_DOUBLE_AUTH", "ADMIN_DEV_BYPASS"])(
    "refuses harness switch %s on a hosted deployment",
    (name) => {
      const v = checkEnvironmentContract(valid({ [name]: "true" }));
      expect(v).toEqual([
        `${name} is set on a hosted deployment — it is for local/test only`,
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
    expect(e.violations.length).toBe(2);
    expect(e.message).toMatch(/refusing to boot/);
    expect(e.message).toMatch(/SUPABASE_URL has the wrong shape/);
    expect(e.message).toMatch(/AUTH_PROVIDER/);
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

  it("a supabase selection requires URL and key, naming the selection", () => {
    const v = checkEnvironmentContract(
      valid({ SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined })
    );
    expect(v).toEqual([
      "SUPABASE_URL is required (APP_STATE_STORE=supabase, TRAJECTORY_STORE=supabase, BUDGET_STORE=supabase) but not set",
      "SUPABASE_SERVICE_ROLE_KEY is required (APP_STATE_STORE=supabase, TRAJECTORY_STORE=supabase, BUDGET_STORE=supabase) but not set",
    ]);
  });

  it("no supabase selection, no supabase requirement", () => {
    expect(
      checkEnvironmentContract({
        NODE_ENV: "production",
        AUTH_PROVIDER: "cognito",
        NEXT_PUBLIC_COGNITO_USER_POOL_ID: "eu-west-1_X",
        NEXT_PUBLIC_COGNITO_CLIENT_ID: "c",
        GUEST_TOKEN_SECRET: GUEST_SECRET,
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
      checkEnvironmentContract({ NODE_ENV: "production", E2E_TEST_DOUBLE_AUTH: "true" })
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
    expect(isHostedDeployment({ VERCEL: "1" })).toBe(true);
    expect(isHostedDeployment({})).toBe(false);
  });
});
