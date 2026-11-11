import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// TASK-204 (N-5, N-94): platform-foundation's own E2E layer, as Playform's (its TASK-5001): the
// production build on a database the migration replay builds, in CI.
//
// ADR-050 D4: /api/auth/guest signs guest tokens with GUEST_TOKEN_SECRET, which a production
// build requires. The harness gets a fresh, test-only secret per run. Never a deployment's secret.
const E2E_GUEST_TOKEN_SECRET = randomBytes(48).toString("base64");

// The E2E server runs on a real database: the actor guard reads each caller's feature permission
// — a user's from their role, a guest's from the `guest` role — and refuses with 503 when it
// cannot (fail closed, correct). CI builds the database with the migration replay (ci.yml's e2e
// job) and passes the two connections in; without them the harness would only ever see that 503,
// so a CI run refuses to start without them.
const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL;
const E2E_DATABASE_OWNER_URL = process.env.E2E_DATABASE_OWNER_URL;
if (process.env.CI && (!E2E_DATABASE_URL || !E2E_DATABASE_OWNER_URL)) {
  throw new Error(
    "E2E_DATABASE_URL and E2E_DATABASE_OWNER_URL are required in CI: the E2E server runs on the " +
      "database the migration replay builds (app_tenant, and the owner), never without one"
  );
}

// Every durable store on Postgres, as the container image job runs them (ci.yml).
const E2E_DURABLE_STORES = Object.fromEntries(
  [
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
    "SOCIAL_STORE",
  ].map((store) => [store, "postgres"])
);

export default defineConfig({
  testDir: "./e2e",
  // Records the test double's age through the app's own route, once the server is up (CI only).
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // In CI: start the production server automatically. Locally: run the server separately.
  webServer: process.env.CI
    ? {
        command: "npm run start",
        url: "http://localhost:3000",
        reuseExistingServer: false,
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
          GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? "",
          // The harness switches below are accepted only where DEPLOYMENT_HOST is ci or local,
          // so a deployment can never be put on test doubles (TASK-140).
          DEPLOYMENT_HOST: "ci",
          // ADR-050 D1: a production build refuses the mock auth provider. This harness signs in
          // with the mock token, so it opts in explicitly. Refused off the ci/local hosts.
          E2E_TEST_DOUBLE_AUTH: "true",
          GUEST_TOKEN_SECRET: E2E_GUEST_TOKEN_SECRET,
          // The database, in the one tenant the migrations create. The test double's user gets
          // its row the way every new account does — provisioned on its first guarded request with
          // the default role — and records its age as a user does (e2e/global-setup.ts).
          TENANCY_MODE: "single",
          TENANT_ID: "00000000-0000-4000-8000-000000000001",
          DATABASE_URL: E2E_DATABASE_URL ?? "",
          DATABASE_OWNER_URL: E2E_DATABASE_OWNER_URL ?? "",
          DATABASE_SSL: "disable",
          ...E2E_DURABLE_STORES,
          // The shared cache stays in process memory: a cache, not a durable store.
          CACHE_PROVIDER: "memory",
        },
      }
    : undefined,
});
