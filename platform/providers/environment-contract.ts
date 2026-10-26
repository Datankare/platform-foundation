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
 * Imports only the module registry (itself a leaf over the singleton carrier), so lib/ and
 * platform/ readers can use it without an import cycle. A registered module's durable provider
 * slots are checked like the core's (ADR-054 D4): their selectors require DATABASE_URL.
 * Error messages name settings, never values: some of them are secrets.
 *
 * @module platform/providers
 */

import { getModules } from "@/platform/modules/registry";
import { parseValkeyUrl, ValkeyUrlError } from "@/platform/cache/valkey-url";

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

/** A Cognito user pool id, `<region>_<id>` — any region, GovCloud's (`us-gov-west-1_…`) included. */
export const COGNITO_POOL_ID = new RegExp(`^${REGION}_[A-Za-z0-9]+$`);

/** The tenant every existing record belongs to (ADR-053, migration 049). */
export const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000001";

const TENANT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A tenant id is a lower-case UUID — anything else is refused before it reaches a key or a query. */
export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_UUID.test(value);
}

/**
 * What a deployment sets for its shared cache (review 9 M5): said in full in every cache
 * violation, so the boot error is the instruction.
 */
const SHARED_CACHE_CHOICES =
  "set CACHE_PROVIDER=upstash with UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (Vercel, or any host), or CACHE_PROVIDER=valkey with VALKEY_URL=rediss://… (a container host's own Valkey or Redis); memory is for local and CI runs only (DEPLOYMENT_HOST=local or ci)";

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
    shape: COGNITO_POOL_ID,
    shapeHint: "<region>_<id>, e.g. us-east-1_AbC123",
  },
  {
    name: "NEXT_PUBLIC_COGNITO_CLIENT_ID",
    aliases: ["COGNITO_CLIENT_ID"],
    shape: /^[\w+]{1,128}$/,
    shapeHint: "the app client id (letters and digits)",
  },
  {
    name: "COGNITO_CLIENT_SECRET",
    aliases: [],
    shape: /^[a-z\d+/=]{32,128}$/i,
    shapeHint:
      "the app client's secret (a confidential client): direct calls to the pool without it are refused, so sign-up, sign-in and password reset go through the platform's routes (audit A-7)",
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
    name: "AUTH_TRUSTED_EMAIL_IDPS",
    aliases: [],
    // Review 17 L3: spaces around the commas are allowed, and names match case-insensitively.
    shape: /^ *[\w.-]{1,32} *(?:, *[\w.-]{1,32} *)*$/,
    shapeHint:
      "a comma-separated list of the pool's identity provider names whose email_verified claim is trusted, matched case-insensitively (spaces around commas allowed), e.g. Google or Google, SignInWithApple — never a provider whose address the user can change unverified (Microsoft Entra ID: mutable email, nOAuth)",
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
    // No "encrypted but unverified" mode: it is open to a man in the middle, and every supported
    // host publishes its CA certificate (DATABASE_SSL_CA), so verification is always possible.
    shape: /^(verify-full|disable)$/,
    shapeHint:
      "verify-full (default: encrypted, server certificate checked — give DATABASE_SSL_CA for a provider CA not in the system store) or disable (local and CI only)",
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
    shape: /^(upstash|valkey|memory)$/,
    shapeHint:
      "one of: upstash, valkey, memory — required in production; memory keeps the cache per instance and is for local and CI runs only (TASK-139, review 8 L3)",
  },
  {
    name: "VALKEY_URL",
    aliases: [],
    shape: /^rediss?:\/\/\S+$/,
    shapeHint:
      "rediss://[user:password@]host:port of a Valkey or Redis server (TLS; redis:// only for a local or CI run) — a secret: paste it into the host's secret store",
  },
  {
    name: "VALKEY_CA_CERT",
    aliases: [],
    shape: /-----BEGIN CERTIFICATE-----/,
    shapeHint:
      "a PEM bundle (-----BEGIN CERTIFICATE-----…) of the CA that signed the Valkey server's certificate — only for a private CA",
  },
  {
    name: "DEPLOYMENT_HOST",
    aliases: [],
    shape: /^[a-z][a-z0-9-]{1,31}$/,
    shapeHint:
      'a lower-case host name, e.g. vercel, container, aws; "local" or "ci" only for runs that are not deployments',
  },
  {
    name: "GIT_COMMIT_SHA",
    aliases: [],
    shape: /^[0-9a-f]{7,40}$/i,
    shapeHint:
      "the commit the image was built from, 7–40 hex characters (the image's GIT_COMMIT_SHA build argument)",
  },
  {
    name: "NEXT_MANUAL_SIG_HANDLE",
    aliases: [],
    shape: /^true$/,
    shapeHint:
      'true, or unset — Next.js treats any value as set, so "false" would still hand the signals to the app',
  },
  {
    name: "SHUTDOWN_DRAIN_SECONDS",
    aliases: [],
    shape: /^(?:\d|[1-9]\d|[12]\d\d|300)$/,
    shapeHint:
      "whole seconds, 0–300, that a stopping instance stays up answering not ready (default 5)",
  },
  {
    name: "SHUTDOWN_TIMEOUT_SECONDS",
    aliases: [],
    shape: /^(?:[1-9]|[1-9]\d|[1-5]\d\d|600)$/,
    shapeHint:
      "whole seconds, 1–600, that bound the whole stop, inside the host's grace period (default 9)",
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
  {
    name: "CRON_SECRET",
    aliases: [],
    shape: /^[\w+/=.~-]{32,512}$/,
    shapeHint:
      "at least 32 random characters (letters, digits, + / = . ~ _ -), e.g. openssl rand -hex 32 — the job tick's bearer secret (ADR-056 D2)",
  },
  {
    name: "ERASURE_HASH_KEY",
    aliases: [],
    shape: /^[\w+/=.~-]{32,512}$/,
    shapeHint:
      "at least 32 random characters, e.g. openssl rand -hex 32 — the key of the HMAC an erased banned account's address is kept as (audit A-11, review 7 L4); to rotate it, move the old value to ERASURE_HASH_KEY_PREVIOUS (review 8 L6)",
  },
  {
    name: "ERASURE_HASH_KEY_PREVIOUS",
    aliases: [],
    shape: /^[\w+/=.~-]{32,512}$/,
    shapeHint:
      "the erasure-hash key before the current one (rotation, review 8 L6): bans it hashed still match, and each is rehashed under the current key when it matches; nothing new is hashed with it",
  },
  {
    name: "REFRESH_COOKIE_KEY",
    aliases: [],
    shape: /^[\w+/=.~-]{32,512}$/,
    shapeHint:
      "at least 32 random characters, e.g. openssl rand -hex 32 — the key of the HMAC that makes the refresh cookie tamper-evident (review 17 M1); to rotate it, move the old value to REFRESH_COOKIE_KEY_PREVIOUS",
  },
  {
    name: "REFRESH_COOKIE_KEY_PREVIOUS",
    aliases: [],
    shape: /^[\w+/=.~-]{32,512}$/,
    shapeHint:
      "the refresh-cookie key before the current one (rotation, review 17 M1): cookies it signed are still accepted; nothing new is signed with it — remove it once the refresh-token lifetime (30 days) has passed",
  },
  {
    name: "PROVENANCE_SIGNING_KEY",
    aliases: [],
    shape: /^[\w+/=.~-]{32,512}$/,
    shapeHint:
      "at least 32 random characters, e.g. openssl rand -hex 32 — signs the provenance credential on generated images (ADR-047, audit X-18); without it credentials are unsigned and never verify",
  },
  {
    name: "PROVENANCE_SIGNING_KEY_PREVIOUS",
    aliases: [],
    shape: /^[\w+/=.~-]{32,512}$/,
    shapeHint:
      "the provenance key before the current one (rotation, review 7 L6): credentials it signed still verify; nothing new is signed with it — remove it once those no longer matter",
  },
];

/** Auth providers that are test doubles (ADR-050 D1). */
export const TEST_DOUBLE_AUTH_PROVIDERS: ReadonlySet<string> = new Set(["mock"]);

/** Selections that make the Supabase settings required: Realtime is the one Supabase service left. */
export const SUPABASE_SELECTORS: readonly string[] = ["REALTIME_PROVIDER"];

/**
 * The core's selections that make DATABASE_URL required (ADR-053 D4): every durable store is on
 * Postgres, selected with "postgres" (or "supabase", the same store on a Supabase project).
 * A registered module's durable slots are added by databaseSelectors().
 */
export const DATABASE_SELECTORS: readonly string[] = [
  "MODERATION_STORE",
  "STRIKE_STORE",
  "REVIEW_QUEUE_STORE",
  "APP_STATE_STORE",
  "TRAJECTORY_STORE",
  "BUDGET_STORE",
  "PROPOSAL_STORE",
  "EFFECT_LEDGER",
  "APPROVAL_POLICY_STORE",
  "GUEST_USAGE_STORE",
  "RATE_LIMIT_STORE",
  "TENANT_DIRECTORY_STORE",
  "JOB_STORE",
];

/** A selector and the selections of it that are a durable store. */
interface DurableSelector {
  readonly name: string;
  readonly durable: readonly string[];
}

const CORE_DURABLE_SELECTIONS: readonly string[] = ["postgres", "supabase"];

/** The core's durable selectors, then each registered module's durable provider slots. */
function durableSelectors(): readonly DurableSelector[] {
  return [
    ...DATABASE_SELECTORS.map((name) => ({ name, durable: CORE_DURABLE_SELECTIONS })),
    ...getModules().flatMap((m) =>
      m.providers.flatMap((slot) =>
        slot.durable ? [{ name: slot.envVar, durable: slot.durable.selections }] : []
      )
    ),
  ];
}

/** Every selector that requires DATABASE_URL: the core's, then the registered modules'. */
export function databaseSelectors(): readonly string[] {
  return durableSelectors().map((s) => s.name);
}

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

/** The key of the address hash kept for an account erased while banned (review 7 L4). */
export function getErasureHashKey(env: EnvSource = process.env): string | undefined {
  return resolveSetting("ERASURE_HASH_KEY", env);
}

/** The erasure-hash key before the current one (rotation, review 8 L6); undefined when not set. */
export function getPreviousErasureHashKey(
  env: EnvSource = process.env
): string | undefined {
  return resolveSetting("ERASURE_HASH_KEY_PREVIOUS", env);
}

/** Review 17 M1: the key of the refresh cookie's HMAC; undefined when not set. */
export function getRefreshCookieKey(env: EnvSource = process.env): string | undefined {
  return resolveSetting("REFRESH_COOKIE_KEY", env);
}

/** The refresh-cookie key before the current one (rotation): verifies, never signs. */
export function getPreviousRefreshCookieKey(
  env: EnvSource = process.env
): string | undefined {
  return resolveSetting("REFRESH_COOKIE_KEY_PREVIOUS", env);
}

/** ADR-050 D4: the guest-token signing secret. */
export function getGuestTokenSecret(env: EnvSource = process.env): string | undefined {
  return resolveSetting("GUEST_TOKEN_SECRET", env);
}

/**
 * ADR-056 D2: the secret the job tick is called with (Vercel Cron sends it as
 * `Authorization: Bearer $CRON_SECRET`; the CLI worker does the same). Unset: the tick refuses.
 */
export function getCronSecret(env: EnvSource = process.env): string | undefined {
  return resolveSetting("CRON_SECRET", env);
}

/** The provenance key before the current one: verifies, never signs (review 7 L6). */
export function getPreviousProvenanceSigningKey(
  env: EnvSource = process.env
): string | undefined {
  return resolveSetting("PROVENANCE_SIGNING_KEY_PREVIOUS", env);
}

/** The key that signs provenance credentials (audit X-18); undefined when not set. */
export function getProvenanceSigningKey(
  env: EnvSource = process.env
): string | undefined {
  return resolveSetting("PROVENANCE_SIGNING_KEY", env);
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

/** How a stopping instance drains and how long the stop may take (ADR-055 D5). */
export interface ShutdownSettings {
  readonly drainMs: number;
  readonly timeoutMs: number;
}

/** Defaults: 5 s of draining inside a 9 s bound — within Docker's default 10 s grace period. */
export const DEFAULT_SHUTDOWN_DRAIN_SECONDS = 5;
export const DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 9;

/**
 * ADR-055 D5: the stop's drain period and bound. A malformed value (refused at boot in
 * production) falls back to the default; a bound not past the drain is raised to drain + 1 s, so
 * the drain always ends before the hard stop.
 */
export function getShutdownSettings(env: EnvSource = process.env): ShutdownSettings {
  const drain =
    wellShapedSeconds("SHUTDOWN_DRAIN_SECONDS", env) ?? DEFAULT_SHUTDOWN_DRAIN_SECONDS;
  const timeout =
    wellShapedSeconds("SHUTDOWN_TIMEOUT_SECONDS", env) ??
    DEFAULT_SHUTDOWN_TIMEOUT_SECONDS;
  return { drainMs: drain * 1000, timeoutMs: Math.max(timeout, drain + 1) * 1000 };
}

/** A declared whole-seconds setting when it is set and well shaped; undefined otherwise. */
function wellShapedSeconds(name: string, env: EnvSource): number | undefined {
  const v = resolveSetting(name, env);
  return v !== undefined && declaration(name).shape.test(v) ? Number(v) : undefined;
}

/** ADR-055 D2: the commit a container image was built from, as set (unchecked), or undefined. */
export function getGitCommitSha(env: EnvSource = process.env): string | undefined {
  return resolveSetting("GIT_COMMIT_SHA", env);
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
  readonly ssl: "verify-full" | "disable";
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
    ssl: ssl === "disable" ? "disable" : "verify-full",
    sslCa: ca?.replace(/\\n/g, "\n"),
  };
}

/** Whether a database URL names this machine (localhost, 127.0.0.1): a connection that never leaves it. */
function isLocalDatabaseHost(url: string): boolean {
  const host = /^postgres(?:ql)?:\/\/[^@/]*@([^:/?]+)/i.exec(url)?.[1]?.toLowerCase();
  return host === "localhost" || host === "127.0.0.1";
}

/**
 * The contract's checks of one database connection (ADR-053 D4) — the boot check's, and an
 * operator command's that connects from a workstation (scripts/relink-identity.mjs, review 15 L2):
 *
 *   - `shapes` (default true): the URL setting, DATABASE_SSL and DATABASE_SSL_CA have their
 *     declared shapes (an unknown DATABASE_SSL is never read as verify-full);
 *   - no TLS option in the URL: node-postgres lets the URL's `sslmode` override the `ssl` the
 *     platform passes, so `?sslmode=disable` (or `no-verify`) would silently undo DATABASE_SSL;
 *   - `sslDisable` (default true): DATABASE_SSL=disable only for a database on this machine — an
 *     operator's connection to a remote database is never plaintext;
 *   - `requireCa` (default false): verify-full needs DATABASE_SSL_CA (an operator's machine does
 *     not hold the provider's CA in its store).
 *
 * The boot check passes `shapes: false` (its own loop reports shapes) and judges DATABASE_SSL=disable
 * by DEPLOYMENT_HOST instead.
 */
export function databaseConnectionViolations(
  env: EnvSource,
  name: "DATABASE_URL" | "DATABASE_OWNER_URL",
  options: {
    readonly shapes?: boolean;
    readonly sslDisable?: boolean;
    readonly requireCa?: boolean;
  } = {}
): string[] {
  const violations: string[] = [];
  const url = resolveSetting(name, env);
  const ssl = resolveSetting("DATABASE_SSL", env);
  const ca = resolveSetting("DATABASE_SSL_CA", env);
  if (options.shapes !== false) {
    for (const [setting, value] of [
      [name, url],
      ["DATABASE_SSL", ssl],
      ["DATABASE_SSL_CA", ca],
    ] as const) {
      const d = declaration(setting);
      if (value !== undefined && !d.shape.test(value))
        violations.push(`${setting} has the wrong shape — expected ${d.shapeHint}`);
    }
  }
  if (url !== undefined && /[?&](?:ssl|sslmode|sslcert|sslkey|sslrootcert)=/i.test(url)) {
    violations.push(
      `${name} carries TLS options — set DATABASE_SSL (and DATABASE_SSL_CA) instead`
    );
  }
  if (
    options.sslDisable !== false &&
    ssl === "disable" &&
    url !== undefined &&
    !isLocalDatabaseHost(url)
  ) {
    violations.push(
      `DATABASE_SSL=disable is for a database on this machine only — ${name} names another host: set DATABASE_SSL=verify-full and DATABASE_SSL_CA`
    );
  }
  if (options.requireCa === true && ssl !== "disable" && ca === undefined) {
    violations.push(
      "DATABASE_SSL_CA is required with DATABASE_SSL=verify-full (the database's CA certificate, PEM)"
    );
  }
  return violations;
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
  /** The app client's secret (a confidential client, audit A-7); undefined when not set. */
  clientSecret?: string;
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
  const clientSecret = resolveSetting("COGNITO_CLIENT_SECRET", env);
  return {
    region,
    userPoolId,
    clientId,
    hostedUiDomain,
    ...(clientSecret ? { clientSecret } : {}),
  };
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

/** The federated identity providers trusted by default for `email_verified` (review 16 L8). */
export const DEFAULT_TRUSTED_EMAIL_IDPS: readonly string[] = ["Google"];

/**
 * The identity providers (the pool's provider names, as `identities` names them) whose
 * `email_verified` claim is trusted (review 16 L8): AUTH_TRUSTED_EMAIL_IDPS, default Google only.
 * A malformed value trusts none — fail closed (boot refuses it in production, by its shape).
 * Cognito's own verification (a native user's code) is always trusted; a federated user from any
 * provider not listed never counts as verified — not by the re-link, not by the TASK-176 sync.
 */
export function getTrustedEmailIdps(env: EnvSource = process.env): ReadonlySet<string> {
  const value = resolveSetting("AUTH_TRUSTED_EMAIL_IDPS", env);
  if (value === undefined) return new Set(DEFAULT_TRUSTED_EMAIL_IDPS);
  if (!declaration("AUTH_TRUSTED_EMAIL_IDPS").shape.test(value)) return new Set();
  // Review 17 L3: trimmed; matched case-insensitively (identity-directory emailClaimTrusted).
  return new Set(value.split(",").map((name) => name.trim()));
}

/** Review 17 L3: what is wrong with AUTH_TRUSTED_EMAIL_IDPS, or undefined when it is usable. */
export function trustedEmailIdpsViolation(
  env: EnvSource = process.env
): string | undefined {
  const value = resolveSetting("AUTH_TRUSTED_EMAIL_IDPS", env);
  if (value === undefined || declaration("AUTH_TRUSTED_EMAIL_IDPS").shape.test(value))
    return undefined;
  return `AUTH_TRUSTED_EMAIL_IDPS has the wrong shape — expected ${declaration("AUTH_TRUSTED_EMAIL_IDPS").shapeHint}`;
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

  // Audit G-13: the mock AI provider echoes every prompt — the safety classifier's included, so
  // every screening would fail closed — and is for local and CI runs only.
  const ai = raw(env, "AI_PROVIDER");
  if (ai !== undefined && ai !== "anthropic" && ai !== "mock") {
    violations.push(`AI_PROVIDER has the wrong shape — expected anthropic or mock`);
  }
  if (ai === "mock" && !harnessAllowed) {
    violations.push(
      'AI_PROVIDER is "mock" — the mock provider is a test double (local and CI runs only); set AI_PROVIDER=anthropic'
    );
  }
  // A server secret under a NEXT_PUBLIC_ name is inlined into any browser bundle that names it
  // (audit G-13). The Google key is read as GOOGLE_API_KEY only.
  if (raw(env, "NEXT_PUBLIC_GOOGLE_API_KEY") !== undefined) {
    violations.push(
      "NEXT_PUBLIC_GOOGLE_API_KEY is set — a NEXT_PUBLIC_ value is shipped to browsers; set GOOGLE_API_KEY (server-side) instead"
    );
  }

  // D4: guest tokens are signed by the platform (/api/auth/guest) under this secret. Required
  // with a real auth provider; a production-build test harness on the mock provider sets it
  // only if it exercises guests (without it, starting a guest session is refused).
  if (!TEST_DOUBLE_AUTH_PROVIDERS.has(auth) && getGuestTokenSecret(env) === undefined) {
    violations.push(
      `GUEST_TOKEN_SECRET is required by AUTH_PROVIDER=${auth} (signed guest tokens)`
    );
  }
  // Review 7 L4: an erased banned account's address is kept as an HMAC under this key, so the
  // ban follows the address without the address being recoverable by a dictionary of addresses
  // (an unsalted SHA-256 was). Required with a real auth provider, as the guest secret is.
  if (!TEST_DOUBLE_AUTH_PROVIDERS.has(auth) && getErasureHashKey(env) === undefined) {
    violations.push(
      `ERASURE_HASH_KEY is required by AUTH_PROVIDER=${auth} (the erased-ban address hash)`
    );
  }

  // Review 17 M1: the refresh cookie (`<user id>.<mac>.<refresh token>`) is an HMAC under this
  // key, so a cookie naming another user than the one it was issued to is refused. Required with
  // a real auth provider, as the guest secret is.
  if (!TEST_DOUBLE_AUTH_PROVIDERS.has(auth) && getRefreshCookieKey(env) === undefined) {
    violations.push(
      `REFRESH_COOKIE_KEY is required by AUTH_PROVIDER=${auth} (the refresh cookie's HMAC)`
    );
  }
  const cookieKey = getRefreshCookieKey(env);
  if (cookieKey !== undefined && cookieKey === getPreviousRefreshCookieKey(env)) {
    violations.push(
      "REFRESH_COOKIE_KEY_PREVIOUS is the same as REFRESH_COOKIE_KEY — set it to the key before the current one, or unset it"
    );
  }
  if (getPreviousRefreshCookieKey(env) !== undefined && cookieKey === undefined) {
    violations.push(
      "REFRESH_COOKIE_KEY_PREVIOUS is set without REFRESH_COOKIE_KEY — rotation keeps the old key beside a new one"
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
    // Audit A-7: a public app client lets anyone call the pool directly (sign-up, sign-in,
    // password reset) around the platform's password policy, rate limits and audit. With a
    // secret, every such call needs it, and only the server has it.
    if (resolveSetting("COGNITO_CLIENT_SECRET", env) === undefined) {
      violations.push(
        "COGNITO_CLIENT_SECRET is required by AUTH_PROVIDER=cognito (a confidential app client)"
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
  violations.push(
    ...(["DATABASE_URL", "DATABASE_OWNER_URL"] as const).flatMap((name) =>
      databaseConnectionViolations(env, name, { shapes: false, sslDisable: false })
    )
  );
  if (resolveSetting("DATABASE_SSL", env) === "disable" && !harnessAllowed) {
    violations.push(
      'DATABASE_SSL=disable is for local and CI runs only (DEPLOYMENT_HOST "local" or "ci")'
    );
  }
  const durable = durableSelectors().filter((s) => {
    const v = raw(env, s.name);
    return v !== undefined && s.durable.includes(v);
  });
  if (durable.length > 0 && db.url === undefined) {
    violations.push(
      `DATABASE_URL is required (${durable.map((s) => `${s.name}=${raw(env, s.name)}`).join(", ")}) but not set`
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
    violations.push(`CACHE_PROVIDER is required — ${SHARED_CACHE_CHOICES}`);
  }
  // Review 8 L3: the cache is no longer only hits. Token revocation (sign-out, an account
  // disabled or deleted, a role or MFA change) and permission invalidation are published through
  // it to every instance; a per-instance cache publishes them to one, and the others serve a
  // revoked token for up to auth.token_cache_seconds. Every deployment host can run more than one
  // instance (Vercel always does; a container platform scales out), so a deployment must share
  // its cache. Only a local or CI run (DEPLOYMENT_HOST local/ci) may use memory.
  if (cache === "memory" && !harnessAllowed) {
    violations.push(
      `CACHE_PROVIDER=memory in a deployment — sign-outs, role and MFA changes would reach only the instance that made them. ${SHARED_CACHE_CHOICES}`
    );
  }
  if (cache === "upstash") {
    for (const name of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) {
      if (raw(env, name) === undefined) {
        violations.push(
          `${name} is required by CACHE_PROVIDER=upstash but not set — copy it from the Upstash database's REST API panel into the host's secret store (docs/MIGRATION_v5_to_v6.md, "The shared cache")`
        );
      }
    }
  }
  // Review 9 M5: a container host's own Valkey or Redis, over TLS.
  if (cache === "valkey") {
    const url = raw(env, "VALKEY_URL");
    if (url === undefined) {
      violations.push(
        "VALKEY_URL is required by CACHE_PROVIDER=valkey but not set — rediss://[user:password@]host:port of the Valkey or Redis server, in the host's secret store (docs/DEPLOY_CONTAINER.md §3)"
      );
    } else if (!url.startsWith("rediss://") && !harnessAllowed) {
      violations.push(
        "VALKEY_URL must use rediss:// (TLS, certificate verified) in a deployment — redis:// sends the cache, revocations included, in clear text; it is for local and CI runs only"
      );
    }
    // Review 10 M6: the client read a URL's query parameters as options overriding TLS and the
    // command timeout; the provider refuses them, and so does the contract, at start. Review 11
    // L-6: every rule the provider applies is applied here — a malformed percent-escape, a user
    // without a password — so a URL the provider would refuse never boots.
    if (url !== undefined && /[?#]/.test(url)) {
      violations.push(
        "VALKEY_URL must not carry a query string or fragment — connection options (TLS, timeouts) are the platform's, never the URL's (rediss://[user:password@]host:port[/db])"
      );
    } else if (url !== undefined && (url.startsWith("rediss://") || harnessAllowed)) {
      try {
        parseValkeyUrl(url, harnessAllowed);
      } catch (err) {
        if (!(err instanceof ValkeyUrlError)) throw err;
        violations.push(`${err.message} (${err.code})`);
      }
    }
  }

  // ADR-055 D5: a container stops gracefully only when the app owns its signals — without
  // NEXT_MANUAL_SIG_HANDLE the standalone server exits at once on SIGTERM, before readiness flips
  // or buffered metrics are written. The image sets it; this catches an override.
  if (
    raw(env, "DEPLOYMENT_HOST") === "container" &&
    raw(env, "NEXT_MANUAL_SIG_HANDLE") === undefined
  ) {
    violations.push(
      "NEXT_MANUAL_SIG_HANDLE=true is required by DEPLOYMENT_HOST=container (graceful shutdown — the image sets it)"
    );
  }
  const drainSeconds = wellShapedSeconds("SHUTDOWN_DRAIN_SECONDS", env);
  const timeoutSeconds = wellShapedSeconds("SHUTDOWN_TIMEOUT_SECONDS", env);
  if (
    (drainSeconds !== undefined || timeoutSeconds !== undefined) &&
    (timeoutSeconds ?? DEFAULT_SHUTDOWN_TIMEOUT_SECONDS) <=
      (drainSeconds ?? DEFAULT_SHUTDOWN_DRAIN_SECONDS)
  ) {
    violations.push(
      `SHUTDOWN_TIMEOUT_SECONDS must be greater than SHUTDOWN_DRAIN_SECONDS (the bound includes the drain)`
    );
  }

  // ADR-056 D2: every timed duty runs only when the host's tick is admitted, and the tick is
  // admitted only with CRON_SECRET — on every host (Vercel Cron and the container's worker call
  // the same route). Without it a deployment would boot, report ready and run no duty at all, so
  // a deployment must set it. A local or CI run (DEPLOYMENT_HOST local/ci) need not.
  if (getCronSecret(env) === undefined && !harnessAllowed) {
    violations.push(
      "CRON_SECRET is required: the job tick (/api/internal/jobs/tick) refuses every call without it, so no timed duty — the escalation reaper, the GDPR purge, the tenant purge — would ever run (at least 32 random characters: openssl rand -hex 32)"
    );
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
