/**
 * platform/providers/environment-contract.ts — Deployment environment contract (ADR-050 D1/D2)
 *
 * D1 — No test doubles in production. A production context refuses to boot on the mock auth
 *      provider (unset AUTH_PROVIDER included — it defaults to the mock). The only exception is
 *      an E2E harness running the production build, which opts in with E2E_TEST_DOUBLE_AUTH=true;
 *      the store opt-out (E2E_IN_MEMORY_STORES) does not extend to auth. Harness switches are
 *      accepted in production only where DEPLOYMENT_HOST positively says the run is not a
 *      deployment ("local" or "ci"); a deployment that sets anything else, or forgets the setting,
 *      refuses them (ADR-055 D2, TASK-140). Host detection never depends on one vendor's variable.
 *      Guest tokens are signed under GUEST_TOKEN_SECRET (D4), required with a real auth provider.
 * D2 — Each setting is declared once: one canonical name, its accepted aliases, and its shape.
 *      Boot validates presence and shape and fails closed naming the setting. An alias set on
 *      its own, or disagreeing with the canonical name, is a violation — one setting, one source.
 *
 * All readers of these settings go through the resolvers below, so the value the contract
 * checks is the value the platform uses (TASK-103: two readers of one variable can disagree).
 *
 * Leaf module — no imports — so lib/ and platform/ readers can use it without an import cycle.
 * Error messages name settings, never values: some of them are secrets.
 *
 * @module platform/providers
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface SettingDeclaration {
  /** The single source of the setting. */
  readonly name: string;
  /** Other names historically read for it. Accepted only when equal to `name`. */
  readonly aliases: readonly string[];
  /** Accepted shape of the value. */
  readonly shape: RegExp;
  /** Human description of the shape, used in the violation message. */
  readonly shapeHint: string;
}

const REGION = "[a-z]{2}(?:-[a-z]+)+-\\d";

/** The tenant every existing record belongs to (ADR-053, migration 049). */
export const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000001";

const TENANT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A tenant id is a lower-case UUID — anything else is refused before it reaches a key or a query. */
export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_UUID.test(value);
}

/** ADR-050 D2: the declared settings. Order is the order violations are reported in. */
export const ENVIRONMENT_CONTRACT: readonly SettingDeclaration[] = [
  {
    name: "AUTH_PROVIDER",
    aliases: ["NEXT_PUBLIC_AUTH_PROVIDER"],
    shape: /^(cognito|mock)$/,
    shapeHint: "one of: cognito, mock",
  },
  {
    name: "NEXT_PUBLIC_COGNITO_USER_POOL_ID",
    aliases: ["COGNITO_USER_POOL_ID"],
    shape: new RegExp(`^${REGION}_[A-Za-z0-9]+$`),
    shapeHint: "<region>_<id>, e.g. us-east-1_AbC123",
  },
  {
    name: "NEXT_PUBLIC_COGNITO_CLIENT_ID",
    aliases: ["COGNITO_CLIENT_ID"],
    shape: /^[\w+]{1,128}$/,
    shapeHint: "the app client id (letters and digits)",
  },
  {
    name: "NEXT_PUBLIC_COGNITO_REGION",
    aliases: ["COGNITO_REGION"],
    shape: new RegExp(`^${REGION}$`),
    shapeHint: "an AWS region, e.g. us-east-1",
  },
  {
    name: "NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN",
    aliases: [],
    shape: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
    shapeHint:
      "the hosted sign-in host name only — no https://, no path — e.g. <prefix>.auth.us-east-1.amazoncognito.com",
  },
  {
    name: "SSO_PROVIDERS",
    aliases: [],
    shape: /^(?:google|apple|microsoft)(?:,(?:google|apple|microsoft))*$/,
    shapeHint: "a comma-separated list of: google, apple, microsoft (no spaces)",
  },
  {
    name: "SUPABASE_URL",
    aliases: ["NEXT_PUBLIC_SUPABASE_URL"],
    shape: /^https:\/\/[a-z0-9]+\.supabase\.co$/,
    shapeHint: "https://<ref>.supabase.co — no path, no trailing slash",
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    aliases: [],
    shape: /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/,
    shapeHint:
      "the legacy service_role JWT (eyJ…), not an sb_secret_/sb_publishable_ key",
  },
  {
    name: "GUEST_TOKEN_SECRET",
    aliases: [],
    shape: /^[\w+/=-]{43,}$/,
    shapeHint: "at least 32 random bytes, base64 (e.g. openssl rand -base64 48)",
  },
  {
    name: "RATE_LIMIT_STORE",
    aliases: [],
    shape: /^(postgres|supabase|upstash|memory)$/,
    shapeHint:
      "one of: postgres (or supabase — the same store), upstash, memory (memory is refused in production — ADR-052)",
  },
  {
    name: "TENANCY_MODE",
    aliases: [],
    shape: /^(single|shared)$/,
    shapeHint:
      "single (one tenant: TENANT_ID) or shared (tenant from the verified identity or host) — ADR-053 D1",
  },
  {
    name: "TENANT_ID",
    aliases: [],
    shape: TENANT_UUID,
    shapeHint:
      "the tenant's id, a lower-case UUID (the default tenant: " +
      DEFAULT_TENANT_ID +
      ")",
  },
  {
    name: "DATABASE_URL",
    aliases: [],
    shape:
      /^postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@]+@[^\s/:]+(?::\d{1,5})?\/[\w-]+(?:\?\S*)?$/,
    shapeHint:
      "postgresql://app_tenant…:<password>@<pooler host>:<port>/<database> — the request connection, through a transaction-mode pooler (ADR-053 D4)",
  },
  {
    name: "DATABASE_OWNER_URL",
    aliases: [],
    shape:
      /^postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@]+@[^\s/:]+(?::\d{1,5})?\/[\w-]+(?:\?\S*)?$/,
    shapeHint:
      "postgresql://<owner>:<password>@<host>:<port>/<database> — operator paths only, never request paths (ADR-053 D4)",
  },
  {
    name: "DATABASE_POOL_MAX",
    aliases: [],
    shape: /^(?:[1-9]|[1-4]\d|50)$/,
    shapeHint:
      "connections each instance may hold, 1–50 (serverless: 1–3; a container: up to the pooler's share)",
  },
  {
    name: "DATABASE_STATEMENT_TIMEOUT_MS",
    aliases: [],
    shape: /^(?:[1-9]\d{2,4}|[1-5]\d{5}|600000)$/,
    shapeHint: "milliseconds a statement (and an idle transaction) may take, 100–600000",
  },
  {
    name: "DATABASE_SSL",
    aliases: [],
    shape: /^(verify-full|require|disable)$/,
    shapeHint:
      "verify-full (default: encrypted, server certificate checked), require (encrypted, not checked), disable (local and CI only)",
  },
  {
    name: "DATABASE_SSL_CA",
    aliases: [],
    shape:
      /^-----BEGIN CERTIFICATE-----(?:\\n|\n)[\s\S]+-----END CERTIFICATE-----(?:\\n|\n)?$/,
    shapeHint:
      "the database's CA certificate, PEM (newlines may be written as \\n) — for verify-full with a provider CA not in the system store",
  },
  {
    name: "TENANT_DIRECTORY_STORE",
    aliases: [],
    shape: /^(postgres|memory)$/,
    shapeHint:
      "one of: postgres, memory — where tenants and their domains are kept (memory is refused in production — ADR-053)",
  },
  {
    name: "COGNITO_ADMIN_ACCESS_KEY_ID",
    aliases: [],
    shape: /^(AKIA|ASIA)[A-Z0-9]{12,124}$/,
    shapeHint:
      "an AWS access key id (AKIA… or ASIA…) allowed only cognito-idp:AdminUpdateUserAttributes, AdminGetUser, DescribeUserPool, ListUserPoolClients, DescribeUserPoolClient and DescribeIdentityProvider on the pool",
  },
  {
    name: "COGNITO_ADMIN_SECRET_ACCESS_KEY",
    aliases: [],
    shape: /^[a-z0-9/+=]{40}$/i,
    shapeHint:
      "the AWS secret access key that pairs with COGNITO_ADMIN_ACCESS_KEY_ID (40 characters)",
  },
  {
    name: "COGNITO_ADMIN_SESSION_TOKEN",
    aliases: [],
    shape: /^[a-z0-9/+=]{16,4096}$/i,
    shapeHint: "an AWS session token, only with temporary (ASIA…) credentials",
  },
  {
    name: "CACHE_PROVIDER",
    aliases: [],
    shape: /^(upstash|memory)$/,
    shapeHint:
      "one of: upstash, memory — required in production; memory keeps the cache per instance (TASK-139)",
  },
  {
    name: "DEPLOYMENT_HOST",
    aliases: [],
    shape: /^[a-z][a-z0-9-]{1,31}$/,
    shapeHint:
      'a lower-case host name, e.g. vercel, container, aws; "local" or "ci" only for runs that are not deployments',
  },
  {
    name: "TRUSTED_PROXY_HOPS",
    aliases: [],
    shape: /^[1-5]$/,
    shapeHint:
      "how many proxies in front of the app append to X-Forwarded-For, 1–5 (Vercel: 1)",
  },
  {
    name: "TENANT_HOST_HEADER",
    aliases: [],
    shape: /^(x-forwarded-host|host)$/,
    shapeHint:
      "where a request's address is read in a shared deployment: x-forwarded-host (a proxy that sets it, e.g. Vercel) or host (a load balancer that does not, e.g. AWS ALB — X-Forwarded-Host is then ignored)",
  },
];

/** Auth providers that are test doubles (ADR-050 D1). */
export const TEST_DOUBLE_AUTH_PROVIDERS: ReadonlySet<string> = new Set(["mock"]);

/** Selections that make the Supabase settings required: Realtime is the one Supabase service left. */
export const SUPABASE_SELECTORS: readonly string[] = ["REALTIME_PROVIDER"];

/**
 * Selections that make DATABASE_URL required (ADR-053 D4): every durable store is on Postgres,
 * selected with "postgres" (or "supabase", the same store on a Supabase project).
 */
export const DATABASE_SELECTORS: readonly string[] = [
  "MODERATION_STORE",
  "STRIKE_STORE",
  "REVIEW_QUEUE_STORE",
  "SOCIAL_STORE",
  "APP_STATE_STORE",
  "TRAJECTORY_STORE",
  "BUDGET_STORE",
  "PROPOSAL_STORE",
  "EFFECT_LEDGER",
  "APPROVAL_POLICY_STORE",
  "GUEST_USAGE_STORE",
  "RATE_LIMIT_STORE",
  "TENANT_DIRECTORY_STORE",
];

/** Test-harness switches that must never reach a deployment. */
export const HARNESS_ONLY_SETTINGS: readonly string[] = [
  "E2E_IN_MEMORY_STORES",
  "E2E_TEST_DOUBLE_AUTH",
  "ADMIN_DEV_BYPASS",
];

export class EnvironmentContractError extends Error {
  readonly violations: readonly string[];
  constructor(violations: readonly string[]) {
    super(
      `Deployment environment contract violated (ADR-050) — refusing to boot:\n` +
        violations.map((v) => `  - ${v}`).join("\n")
    );
    this.name = "EnvironmentContractError";
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// Resolvers — the only readers of the declared settings
// ---------------------------------------------------------------------------

function raw(env: EnvSource, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

function declaration(name: string): SettingDeclaration {
  const d = ENVIRONMENT_CONTRACT.find((s) => s.name === name);
  /* istanbul ignore next -- programming error guard */
  if (!d) throw new Error(`Undeclared setting: ${name}`);
  return d;
}

/** Value of a declared setting: the canonical name, else the first alias that is set. */
export function resolveSetting(
  name: string,
  env: EnvSource = process.env
): string | undefined {
  const d = declaration(name);
  const canonical = raw(env, d.name);
  if (canonical !== undefined) return canonical;
  for (const alias of d.aliases) {
    const v = raw(env, alias);
    if (v !== undefined) return v;
  }
  return undefined;
}

export function getSupabaseUrl(env: EnvSource = process.env): string | undefined {
  return resolveSetting("SUPABASE_URL", env);
}

export function getAuthProviderSetting(env: EnvSource = process.env): string | undefined {
  return resolveSetting("AUTH_PROVIDER", env);
}

/** ADR-050 D4: the guest-token signing secret. */
export function getGuestTokenSecret(env: EnvSource = process.env): string | undefined {
  return resolveSetting("GUEST_TOKEN_SECRET", env);
}

/** ADR-052: the rate-limit store selection (default "memory"; refused in production). */
/** Single mode names its one tenant; in shared mode each request resolves its own. */
export type TenancySettings =
  | { readonly mode: "single"; readonly tenantId: string }
  | { readonly mode: "shared"; readonly tenantId: undefined };

/**
 * The tenancy shape (ADR-053 D1). Unset outside production means single with the default tenant,
 * so tests and local runs need nothing; a deployment declares it (the contract refuses otherwise).
 */
export function getTenancySettings(env: EnvSource = process.env): TenancySettings {
  if (resolveSetting("TENANCY_MODE", env) === "shared") {
    return { mode: "shared", tenantId: undefined };
  }
  return {
    mode: "single",
    tenantId: resolveSetting("TENANT_ID", env) ?? DEFAULT_TENANT_ID,
  };
}

/**
 * The cache selection (TASK-139). Read here so the cache, the registry and the contract use one
 * value; undefined when unset (outside production that means the in-memory cache).
 */
export function getCacheProviderSetting(
  env: EnvSource = process.env
): string | undefined {
  return resolveSetting("CACHE_PROVIDER", env);
}

export function getRateLimitStoreSetting(
  env: EnvSource = process.env
): string | undefined {
  return resolveSetting("RATE_LIMIT_STORE", env);
}

/**
 * ADR-052: how many proxies in front of the app append to X-Forwarded-For. The client address
 * is the entry that many places from the right; entries to its left are caller-supplied and
 * never trusted. Default 1 (Vercel, or one load balancer).
 */
export function getTrustedProxyHops(env: EnvSource = process.env): number {
  const v = resolveSetting("TRUSTED_PROXY_HOPS", env);
  const n = v === undefined ? 1 : Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
}

/** Where a shared deployment reads the address a request was sent to (ADR-053 D2). */
export type TenantHostHeader = "x-forwarded-host" | "host";

/**
 * ADR-053 D2: the header that carries the request's address — chosen by the deployment, never
 * inferred. `x-forwarded-host`: the entry our outermost proxy added (TRUSTED_PROXY_HOPS from the
 * right), falling back to Host when absent; right behind a proxy that always sets it (Vercel).
 * `host`: the Host header only, X-Forwarded-Host ignored; right behind a load balancer that
 * forwards Host and does not set X-Forwarded-Host (AWS ALB), where that header is the caller's.
 * Undefined when unset (single mode does not read it; shared mode refuses to run without it).
 */
export function getTenantHostHeader(
  env: EnvSource = process.env
): TenantHostHeader | undefined {
  const v = resolveSetting("TENANT_HOST_HEADER", env);
  return v === "x-forwarded-host" || v === "host" ? v : undefined;
}

export interface DatabaseSettings {
  readonly url: string | undefined;
  readonly ownerUrl: string | undefined;
  readonly poolMax: number;
  readonly statementTimeoutMs: number;
  readonly ssl: "verify-full" | "require" | "disable";
  /** PEM with real newlines; undefined when not set (the system's CA store is used). */
  readonly sslCa: string | undefined;
}

/** ADR-053 D4: the direct Postgres connections and their limits. */
export function getDatabaseSettings(env: EnvSource = process.env): DatabaseSettings {
  const poolMax = Number(resolveSetting("DATABASE_POOL_MAX", env) ?? "3");
  const timeout = Number(resolveSetting("DATABASE_STATEMENT_TIMEOUT_MS", env) ?? "10000");
  const ssl = resolveSetting("DATABASE_SSL", env);
  const ca = resolveSetting("DATABASE_SSL_CA", env);
  return {
    url: resolveSetting("DATABASE_URL", env),
    ownerUrl: resolveSetting("DATABASE_OWNER_URL", env),
    poolMax: Number.isInteger(poolMax) && poolMax >= 1 && poolMax <= 50 ? poolMax : 3,
    statementTimeoutMs:
      Number.isInteger(timeout) && timeout >= 100 && timeout <= 600_000
        ? timeout
        : 10_000,
    ssl: ssl === "require" || ssl === "disable" ? ssl : "verify-full",
    sslCa: ca?.replace(/\\n/g, "\n"),
  };
}

/** Where the tenant directory is kept; undefined when unset (memory outside production). */
export function getTenantDirectoryStoreSetting(
  env: EnvSource = process.env
): string | undefined {
  return resolveSetting("TENANT_DIRECTORY_STORE", env);
}

export interface CognitoAdminCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/**
 * ADR-053 D2: the credentials the platform uses to set a user's tenant in Cognito — the one
 * administrative call it makes. Undefined when not configured (single mode never needs them).
 */
export function getCognitoAdminCredentials(
  env: EnvSource = process.env
): CognitoAdminCredentials | undefined {
  const accessKeyId = resolveSetting("COGNITO_ADMIN_ACCESS_KEY_ID", env);
  const secretAccessKey = resolveSetting("COGNITO_ADMIN_SECRET_ACCESS_KEY", env);
  if (!accessKeyId || !secretAccessKey) return undefined;
  const sessionToken = resolveSetting("COGNITO_ADMIN_SESSION_TOKEN", env);
  return sessionToken
    ? { accessKeyId, secretAccessKey, sessionToken }
    : { accessKeyId, secretAccessKey };
}

export interface CognitoSettings {
  region: string;
  userPoolId: string;
  clientId: string;
  /** Hosted sign-in host name (SSO); undefined when not configured. */
  hostedUiDomain?: string;
}

/**
 * Cognito settings. Region falls back to the pool id's own region prefix, then us-east-1 —
 * never to AWS_REGION, which hosts set to the function's region, not the pool's.
 */
export function getCognitoSettings(env: EnvSource = process.env): CognitoSettings {
  const userPoolId = resolveSetting("NEXT_PUBLIC_COGNITO_USER_POOL_ID", env) ?? "";
  const clientId = resolveSetting("NEXT_PUBLIC_COGNITO_CLIENT_ID", env) ?? "";
  const region =
    resolveSetting("NEXT_PUBLIC_COGNITO_REGION", env) ??
    poolRegion(userPoolId) ??
    "us-east-1";
  const hostedUiDomain = resolveSetting("NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN", env);
  return { region, userPoolId, clientId, hostedUiDomain };
}

/** SSO identity providers this deployment declares (TASK-101, ADR-050 D3). */
export type SsoProviderId = "google" | "apple" | "microsoft";

/**
 * The declared SSO providers, in declared order, duplicates removed. A malformed value
 * yields none — boot refuses it in production (shape), and nothing is offered meanwhile.
 */
export function getSsoProviders(env: EnvSource = process.env): SsoProviderId[] {
  const value = resolveSetting("SSO_PROVIDERS", env);
  if (value === undefined || !declaration("SSO_PROVIDERS").shape.test(value)) return [];
  return [...new Set(value.split(",") as SsoProviderId[])];
}

function poolRegion(userPoolId: string): string | undefined {
  const i = userPoolId.indexOf("_");
  return i > 0 ? userPoolId.slice(0, i) : undefined;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export function isProductionContext(env: EnvSource = process.env): boolean {
  return env.NODE_ENV === "production";
}

/** DEPLOYMENT_HOST values that mark a run as not a deployment: local work and CI. */
export const NON_DEPLOYMENT_HOSTS: ReadonlySet<string> = new Set(["local", "ci"]);

/**
 * Whether the test-harness switches may be honoured (ADR-055 D2, TASK-140). True only when
 * DEPLOYMENT_HOST positively marks the run as local or CI — never by the absence of a host's own
 * variable — so a deployment that forgets the setting refuses them.
 */
export function allowsHarnessSwitches(env: EnvSource = process.env): boolean {
  const host = raw(env, "DEPLOYMENT_HOST");
  return host !== undefined && NON_DEPLOYMENT_HOSTS.has(host);
}

/**
 * Every contract violation in `env`, as messages naming the setting. Pure — callers decide
 * whether the context is one the contract applies to (see assertEnvironmentContract).
 */
export function checkEnvironmentContract(env: EnvSource): string[] {
  const violations: string[] = [];
  const harnessAllowed = allowsHarnessSwitches(env);

  // Harness-only switches outside a local or CI run.
  if (!harnessAllowed) {
    for (const name of HARNESS_ONLY_SETTINGS) {
      if (raw(env, name) !== undefined) {
        violations.push(
          `${name} is set but DEPLOYMENT_HOST is not "local" or "ci" — it is for local and CI runs only`
        );
      }
    }
  }

  // D2: one source per setting; shape of whatever is used.
  for (const d of ENVIRONMENT_CONTRACT) {
    const canonical = raw(env, d.name);
    for (const alias of d.aliases) {
      const v = raw(env, alias);
      if (v === undefined) continue;
      if (canonical === undefined) {
        violations.push(
          `${alias} is set but ${d.name} is not — ${d.name} is the single source`
        );
      } else if (v !== canonical) {
        violations.push(
          `${d.name} and ${alias} are both set and disagree — set ${d.name} only`
        );
      }
    }
    const value = resolveSetting(d.name, env);
    if (value !== undefined && !d.shape.test(value)) {
      violations.push(`${d.name} has the wrong shape — expected ${d.shapeHint}`);
    }
  }

  // D1: no test-double auth.
  const auth = getAuthProviderSetting(env) ?? "mock";
  if (TEST_DOUBLE_AUTH_PROVIDERS.has(auth)) {
    const harness = raw(env, "E2E_TEST_DOUBLE_AUTH") === "true" && harnessAllowed;
    if (!harness) {
      violations.push(
        `AUTH_PROVIDER is ${raw(env, "AUTH_PROVIDER") ? `"${auth}"` : "unset (defaults to mock)"} — ` +
          `the ${auth} provider is a test double; set AUTH_PROVIDER=cognito`
      );
    }
  }

  // D4: guest tokens are signed by the platform (/api/auth/guest) under this secret. Required
  // with a real auth provider; a production-build test harness on the mock provider sets it
  // only if it exercises guests (without it, starting a guest session is refused).
  if (!TEST_DOUBLE_AUTH_PROVIDERS.has(auth) && getGuestTokenSecret(env) === undefined) {
    violations.push(
      `GUEST_TOKEN_SECRET is required by AUTH_PROVIDER=${auth} (signed guest tokens)`
    );
  }

  // Provider-specific requirements.
  if (auth === "cognito") {
    const { userPoolId, clientId } = getCognitoSettings(env);
    if (!userPoolId) {
      violations.push(
        `NEXT_PUBLIC_COGNITO_USER_POOL_ID is required by AUTH_PROVIDER=cognito`
      );
    }
    if (!clientId) {
      violations.push(
        `NEXT_PUBLIC_COGNITO_CLIENT_ID is required by AUTH_PROVIDER=cognito`
      );
    }
    if (
      getSsoProviders(env).length > 0 &&
      resolveSetting("NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN", env) === undefined
    ) {
      violations.push(
        `NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN is required by SSO_PROVIDERS with AUTH_PROVIDER=cognito`
      );
    }
    const region = resolveSetting("NEXT_PUBLIC_COGNITO_REGION", env);
    const fromPool = poolRegion(userPoolId);
    if (region !== undefined && fromPool !== undefined && region !== fromPool) {
      violations.push(
        `NEXT_PUBLIC_COGNITO_REGION does not match the region of NEXT_PUBLIC_COGNITO_USER_POOL_ID`
      );
    }
  }

  // ADR-053 D1: a deployment declares its tenancy. single needs the one tenant it serves; shared
  // takes each request's tenant from its verified identity or host, so a fixed TENANT_ID there
  // would be a second, contradicting source.
  const tenancyMode = resolveSetting("TENANCY_MODE", env);
  const tenantId = resolveSetting("TENANT_ID", env);
  if (tenancyMode === undefined && !harnessAllowed) {
    violations.push("TENANCY_MODE is required: single (with TENANT_ID) or shared");
  }
  if (tenancyMode === "single" && tenantId === undefined) {
    violations.push("TENANT_ID is required by TENANCY_MODE=single");
  }
  if (tenancyMode === "shared" && tenantId !== undefined) {
    violations.push(
      "TENANT_ID is set but TENANCY_MODE=shared — a shared deployment resolves each request's tenant; unset TENANT_ID"
    );
  }
  // Before sign-in the address decides the tenant, so where it is read is declared: a proxy
  // that does not set X-Forwarded-Host passes on the caller's.
  if (
    tenancyMode === "shared" &&
    resolveSetting("TENANT_HOST_HEADER", env) === undefined
  ) {
    violations.push(
      "TENANT_HOST_HEADER is required by TENANCY_MODE=shared: x-forwarded-host (behind a proxy that sets it, e.g. Vercel) or host (behind one that does not, e.g. AWS ALB)"
    );
  }

  // ADR-053 D2/D7: a shared deployment assigns each new user's tenant in Cognito (the attribute
  // is read-only to users), so it needs the administrative credentials; and it keeps its
  // tenants durably. Credentials come as a pair; a session token only with temporary ones.
  const adminKey = resolveSetting("COGNITO_ADMIN_ACCESS_KEY_ID", env);
  const adminSecret = resolveSetting("COGNITO_ADMIN_SECRET_ACCESS_KEY", env);
  const adminToken = resolveSetting("COGNITO_ADMIN_SESSION_TOKEN", env);
  if ((adminKey === undefined) !== (adminSecret === undefined)) {
    violations.push(
      "COGNITO_ADMIN_ACCESS_KEY_ID and COGNITO_ADMIN_SECRET_ACCESS_KEY are set together or not at all"
    );
  }
  if (adminToken !== undefined && !adminKey?.startsWith("ASIA")) {
    violations.push(
      "COGNITO_ADMIN_SESSION_TOKEN is set without temporary credentials (COGNITO_ADMIN_ACCESS_KEY_ID ASIA…)"
    );
  }
  if (adminKey?.startsWith("ASIA") && adminToken === undefined) {
    violations.push(
      "COGNITO_ADMIN_SESSION_TOKEN is required by temporary credentials (COGNITO_ADMIN_ACCESS_KEY_ID ASIA…)"
    );
  }
  if (tenancyMode === "shared" && auth === "cognito" && adminKey === undefined) {
    violations.push(
      "COGNITO_ADMIN_ACCESS_KEY_ID and COGNITO_ADMIN_SECRET_ACCESS_KEY are required by TENANCY_MODE=shared with AUTH_PROVIDER=cognito (assigning tenants)"
    );
  }
  // ADR-053 D4: the request connection and the owner connection are different roles, and the
  // request one never bypasses row-level security. The contract cannot see roles, but it can
  // refuse the same credentials for both, plaintext connections in a deployment, and a store
  // that needs Postgres without it.
  const db = getDatabaseSettings(env);
  if (db.url !== undefined && db.ownerUrl !== undefined) {
    const user = (u: string) => /^postgres(?:ql)?:\/\/([^:@/]+):/.exec(u)?.[1];
    if (user(db.url) === user(db.ownerUrl)) {
      violations.push(
        "DATABASE_URL and DATABASE_OWNER_URL use the same database user — the request connection must be the app_tenant role"
      );
    }
  }
  for (const [name, url] of [
    ["DATABASE_URL", db.url],
    ["DATABASE_OWNER_URL", db.ownerUrl],
  ] as const) {
    if (
      url !== undefined &&
      /[?&](?:ssl|sslmode|sslcert|sslkey|sslrootcert)=/i.test(url)
    ) {
      violations.push(
        `${name} carries TLS options — set DATABASE_SSL (and DATABASE_SSL_CA) instead`
      );
    }
  }
  if (resolveSetting("DATABASE_SSL", env) === "disable" && !harnessAllowed) {
    violations.push(
      'DATABASE_SSL=disable is for local and CI runs only (DEPLOYMENT_HOST "local" or "ci")'
    );
  }
  const durable = DATABASE_SELECTORS.filter((n) => {
    const v = raw(env, n);
    return v === "postgres" || v === "supabase";
  });
  if (durable.length > 0 && db.url === undefined) {
    violations.push(
      `DATABASE_URL is required (${durable.map((n) => `${n}=${raw(env, n)}`).join(", ")}) but not set`
    );
  }
  // Operator paths — platform defaults, tenant lifecycle — run on the owner connection.
  if (db.url !== undefined && db.ownerUrl === undefined && !harnessAllowed) {
    violations.push(
      "DATABASE_OWNER_URL is required with DATABASE_URL (operator paths: platform configuration and tenant lifecycle)"
    );
  }

  const directoryStore = getTenantDirectoryStoreSetting(env);
  // An unknown value is already refused by its shape; only the two real choices are judged here.
  if (tenancyMode === "shared" && !harnessAllowed) {
    if (directoryStore === undefined) {
      violations.push(
        "TENANT_DIRECTORY_STORE is required by TENANCY_MODE=shared: postgres"
      );
    } else if (directoryStore === "memory") {
      violations.push(
        "TENANT_DIRECTORY_STORE=memory with TENANCY_MODE=shared — tenants would differ per instance; set postgres"
      );
    }
  }

  // TASK-139: the cache is chosen, never inferred. Before, the cache used Redis when its URL
  // happened to be set and fell back to a per-instance memory cache otherwise, silently, in
  // production too. A deployment now declares it; memory is allowed when declared (the cache
  // holds nothing authoritative — losing it costs hits, not correctness), and upstash needs its
  // credentials. A local or CI run (DEPLOYMENT_HOST local/ci) is not a deployment and may leave
  // it unset.
  const cache = getCacheProviderSetting(env);
  if (cache === undefined && !harnessAllowed) {
    violations.push(
      "CACHE_PROVIDER is required: upstash (shared), or memory (per instance, declared on purpose)"
    );
  }
  if (cache === "upstash") {
    for (const name of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) {
      if (raw(env, name) === undefined) {
        violations.push(`${name} is required by CACHE_PROVIDER=upstash but not set`);
      }
    }
  }

  // ADR-052: the Upstash rate-limit store needs its credentials.
  if (getRateLimitStoreSetting(env) === "upstash") {
    for (const name of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) {
      if (raw(env, name) === undefined) {
        violations.push(`${name} is required by RATE_LIMIT_STORE=upstash but not set`);
      }
    }
  }

  const selectors = SUPABASE_SELECTORS.filter((s) => raw(env, s) === "supabase");
  // Realtime only: the data paths no longer use the REST API or the service-role key.
  if (selectors.length > 0) {
    const by = selectors.map((s) => `${s}=supabase`).join(", ");
    if (getSupabaseUrl(env) === undefined) {
      violations.push(`SUPABASE_URL is required (${by}) but not set`);
    }
    if (raw(env, "SUPABASE_SERVICE_ROLE_KEY") === undefined) {
      violations.push(`SUPABASE_SERVICE_ROLE_KEY is required (${by}) but not set`);
    }
  }

  return violations;
}

/**
 * ADR-050 D1/D2 at boot: in a production context, throw one error listing every violation.
 * Outside production (tests, local development) this is a no-op.
 */
export function assertEnvironmentContract(env: EnvSource = process.env): void {
  if (!isProductionContext(env)) return;
  const violations = checkEnvironmentContract(env);
  if (violations.length > 0) throw new EnvironmentContractError(violations);
}
