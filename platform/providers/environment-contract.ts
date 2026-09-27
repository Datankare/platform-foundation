/**
 * platform/providers/environment-contract.ts — Deployment environment contract (ADR-050 D1/D2)
 *
 * D1 — No test doubles in production. A production context refuses to boot on the mock auth
 *      provider (unset AUTH_PROVIDER included — it defaults to the mock). The only exception is
 *      an E2E harness running the production build, which opts in with E2E_TEST_DOUBLE_AUTH=true;
 *      the store opt-out (E2E_IN_MEMORY_STORES) does not extend to auth. Harness opt-outs and
 *      ADMIN_DEV_BYPASS are refused outright on a hosted deployment (VERCEL=1).
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
];

/** Auth providers that are test doubles (ADR-050 D1). */
export const TEST_DOUBLE_AUTH_PROVIDERS: ReadonlySet<string> = new Set(["mock"]);

/** Selections that make the Supabase settings required. */
export const SUPABASE_SELECTORS: readonly string[] = [
  "MODERATION_STORE",
  "SOCIAL_STORE",
  "APP_STATE_STORE",
  "TRAJECTORY_STORE",
  "BUDGET_STORE",
  "PROPOSAL_STORE",
  "EFFECT_LEDGER",
  "APPROVAL_POLICY_STORE",
  "GUEST_USAGE_STORE",
  "REALTIME_PROVIDER",
];

/** Test-harness switches that must never reach a hosted deployment. */
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

export interface CognitoSettings {
  region: string;
  userPoolId: string;
  clientId: string;
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
  return { region, userPoolId, clientId };
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

/** A hosted deployment (Vercel sets VERCEL=1 at build and runtime). */
export function isHostedDeployment(env: EnvSource = process.env): boolean {
  return env.VERCEL === "1";
}

/**
 * Every contract violation in `env`, as messages naming the setting. Pure — callers decide
 * whether the context is one the contract applies to (see assertEnvironmentContract).
 */
export function checkEnvironmentContract(env: EnvSource): string[] {
  const violations: string[] = [];
  const hosted = isHostedDeployment(env);

  // Harness-only switches on a hosted deployment.
  if (hosted) {
    for (const name of HARNESS_ONLY_SETTINGS) {
      if (raw(env, name) !== undefined) {
        violations.push(
          `${name} is set on a hosted deployment — it is for local/test only`
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
    const harness = raw(env, "E2E_TEST_DOUBLE_AUTH") === "true" && !hosted;
    if (!harness) {
      violations.push(
        `AUTH_PROVIDER is ${raw(env, "AUTH_PROVIDER") ? `"${auth}"` : "unset (defaults to mock)"} — ` +
          `the ${auth} provider is a test double; set AUTH_PROVIDER=cognito`
      );
    }
  }

  // D4: a real auth provider mints guest tokens, which must be signed. (The mock provider's
  // guest tokens are fixed test values; it needs no secret.)
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
    const region = resolveSetting("NEXT_PUBLIC_COGNITO_REGION", env);
    const fromPool = poolRegion(userPoolId);
    if (region !== undefined && fromPool !== undefined && region !== fromPool) {
      violations.push(
        `NEXT_PUBLIC_COGNITO_REGION does not match the region of NEXT_PUBLIC_COGNITO_USER_POOL_ID`
      );
    }
  }

  const selectors = SUPABASE_SELECTORS.filter((s) => raw(env, s) === "supabase");
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
