/**
 * TASK-181 — the operator's shell cannot change test results. jest.setup.ts clears every setting
 * the platform reads (__tests__/helpers/isolate-env.ts) before a suite loads. Proved two ways: the
 * pieces on their own, and a jest run started with a deployment's settings exported (the shell
 * that once failed 46 tests) whose probe sees none of them.
 */
import { spawnSync } from "child_process";
import { join } from "path";

// Loaded inside the tests, not imported: importing it clears the environment again, which would
// make the probe below pass whatever jest.setup.ts does.
type Helper = typeof import("@/__tests__/helpers/isolate-env");
const helper = (): Helper => require("@/__tests__/helpers/isolate-env") as Helper;

const POLLUTION: Record<string, string> = {
  DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----\nnot-a-cert\n-----END CERTIFICATE-----",
  DATABASE_URL: "postgresql://someone:secret@db.example.com:5432/prod",
  COGNITO_USER_POOL_ID: "us-east-1_Polluted1",
  COGNITO_CLIENT_ID: "polluted-client",
  COGNITO_REGION: "us-east-1",
  AUTH_PROVIDER: "cognito",
  UPSTASH_REDIS_REST_URL: "https://polluted.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "polluted",
  CACHE_PROVIDER: "upstash",
  POOL_MOVED_AT: "2026-10-20T14:00:00Z",
};

describe("test isolation from the operator's shell (TASK-181)", () => {
  it("clears every documented and contract-declared setting", () => {
    const { contractEnvNames, documentedEnvNames, isKept, platformEnvNames } = helper();
    const names = platformEnvNames();
    for (const n of [
      "DATABASE_SSL_CA",
      "COGNITO_USER_POOL_ID",
      "UPSTASH_REDIS_REST_URL",
    ]) {
      expect(names).toContain(n);
    }
    expect(documentedEnvNames().length).toBeGreaterThan(50);
    expect(contractEnvNames().length).toBeGreaterThan(10);
    const leaked = names.filter((n) => !isKept(n) && process.env[n] !== undefined);
    // A suite may set settings for itself; at the start of this file none survives the shell.
    expect(leaked).toEqual([]);
  });

  it("keeps the harness's own switches and the runner's", () => {
    const { isolateEnv } = helper();
    const env: NodeJS.ProcessEnv = {
      TEST_DATABASE_URL: "postgresql://t",
      REQUIRE_DB_TESTS: "1",
      REQUIRE_VALKEY_TESTS: "1",
      TZ: "America/New_York",
      NODE_ENV: "test",
      CACHE_PROVIDER: "valkey",
    };
    expect(
      isolateEnv(env, ["TEST_DATABASE_URL", "REQUIRE_DB_TESTS", "TZ", "CACHE_PROVIDER"])
    ).toEqual(["CACHE_PROVIDER"]);
    expect(env).toEqual({
      TEST_DATABASE_URL: "postgresql://t",
      REQUIRE_DB_TESTS: "1",
      REQUIRE_VALKEY_TESTS: "1",
      TZ: "America/New_York",
      NODE_ENV: "test",
    });
  });

  it("a polluted shell does not leak into a suite (a real jest run)", () => {
    if (process.env.ENV_ISOLATION_PROBE === "1") return; // the probe itself: see below
    const root = join(__dirname, "..");
    const run = spawnSync(
      process.execPath,
      [
        join(root, "node_modules", "jest", "bin", "jest.js"),
        "--runTestsByPath",
        join(__dirname, "env-isolation.test.ts"),
        "-t",
        "probe",
        "--coverage=false",
        "--silent",
      ],
      {
        cwd: root,
        env: { ...process.env, ...POLLUTION, ENV_ISOLATION_PROBE: "1" },
        encoding: "utf8",
        timeout: 120_000,
      }
    );
    expect({ status: run.status, out: run.status === 0 ? "" : run.stderr }).toEqual({
      status: 0,
      out: "",
    });
    expect(run.stderr).toMatch(/1 passed/);
  }, 150_000);

  it("probe: the settings exported for this run are not visible", () => {
    if (process.env.ENV_ISOLATION_PROBE !== "1") return;
    const visible = Object.keys(POLLUTION).filter(
      (n) => n !== "POOL_MOVED_AT" && process.env[n] !== undefined
    );
    expect(visible).toEqual([]);
  });
});
