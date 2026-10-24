/**
 * __tests__/helpers/production-env.ts — A contract-valid production boot (ADR-050, ADR-048 D3)
 *
 * Sets NODE_ENV=production and the settings a deployment needs, with every core durable store on
 * Postgres (and a database URL), so the only thing a production boot can refuse is what the test
 * leaves out. Restore NODE_ENV with setNodeEnv("test").
 */

/** NODE_ENV is typed read-only; set it the way the provider tests do. */
export function setNodeEnv(v: string): void {
  Object.defineProperty(process.env, "NODE_ENV", {
    value: v,
    configurable: true,
    writable: true,
  });
}

/** The core's durable store selectors (the contract's DATABASE_SELECTORS, minus the directory). */
export const CORE_DURABLE_STORES = [
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
  "JOB_STORE",
] as const;

/** A production deployment with real auth and every core store durable. */
export function productionDeployment(): void {
  setNodeEnv("production");
  Object.assign(process.env, {
    AUTH_PROVIDER: "cognito",
    NEXT_PUBLIC_COGNITO_USER_POOL_ID: "us-east-1_AbC123",
    NEXT_PUBLIC_COGNITO_CLIENT_ID: "abc123def456",
    GUEST_TOKEN_SECRET: "g".repeat(64),
    CRON_SECRET: "c".repeat(64),
    CACHE_PROVIDER: "memory",
    TENANCY_MODE: "single",
    TENANT_ID: "00000000-0000-4000-8000-000000000001",
    DEPLOYMENT_HOST: "container",
    NEXT_MANUAL_SIG_HANDLE: "true",
    DATABASE_URL: "postgresql://app_tenant:pw@pooler.example.test:6543/app",
    DATABASE_OWNER_URL: "postgresql://owner:pw@db.example.test:5432/app",
  });
  for (const store of CORE_DURABLE_STORES) process.env[store] = "postgres";
  delete process.env.E2E_IN_MEMORY_STORES;
  delete process.env.E2E_TEST_DOUBLE_AUTH;
}
