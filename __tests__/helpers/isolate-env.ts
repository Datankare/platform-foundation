/**
 * __tests__/helpers/isolate-env.ts — tests never inherit the operator's shell (TASK-181)
 *
 * A developer ran the commit script in a terminal that had a deployment's settings exported
 * (DATABASE_SSL_CA, COGNITO_*, UPSTASH_*, CACHE_PROVIDER, …) and 46 tests failed: the pool tests
 * read the CA, the Cognito provider tests reached for the network. Test results must not depend on
 * the shell. Imported first by jest.setup.ts (before any module reads its settings), this removes
 * every setting the platform reads from process.env:
 *
 *   - every name documented in docs/ENV_REFERENCE.md and the app's docs/APP_ENV_REFERENCE.md —
 *     docs-integrity requires every variable the code reads to be documented there, so the list
 *     is complete by construction;
 *   - every setting the deployment environment contract declares, with its aliases (ADR-050 D2).
 *
 * Kept: the test harness's own switches — `TEST_*` (the database URLs) and `REQUIRE_*` (DB and
 * Valkey suites must run) — and the runner's (NODE_ENV, TZ, LOG_LEVEL, PF_TEST_MODULES, CI, PATH,
 * HOME). A test that needs a setting sets it itself.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..");

const KEEP = new Set([
  "NODE_ENV",
  "TZ",
  "LOG_LEVEL",
  "PF_TEST_MODULES",
  "CI",
  "PATH",
  "HOME",
]);
const KEEP_PREFIX = /^(?:TEST_|REQUIRE_)/;

/** The names the environment references document (backticked UPPER_SNAKE names). */
export function documentedEnvNames(root: string = ROOT): string[] {
  const text = ["docs/ENV_REFERENCE.md", "docs/APP_ENV_REFERENCE.md"]
    .map((rel) => join(root, rel))
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  return [...new Set([...text.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]))];
}

/** The environment contract's settings and aliases (loaded apart from the suites' registry). */
export function contractEnvNames(): string[] {
  let names: string[] = [];
  jest.isolateModules(() => {
    const contract = require("@/platform/providers/environment-contract") as {
      ENVIRONMENT_CONTRACT: readonly { name: string; aliases: readonly string[] }[];
      HARNESS_ONLY_SETTINGS: readonly string[];
    };
    names = [
      ...contract.ENVIRONMENT_CONTRACT.flatMap((d) => [d.name, ...d.aliases]),
      ...contract.HARNESS_ONLY_SETTINGS,
    ];
  });
  return names;
}

/** Whether a setting is the harness's or the runner's own, and so kept. */
export function isKept(name: string): boolean {
  return KEEP.has(name) || KEEP_PREFIX.test(name);
}

/** Remove `names` (except the kept ones) from `env`; returns what was removed. */
export function isolateEnv(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  const removed: string[] = [];
  for (const name of new Set(names)) {
    if (isKept(name) || env[name] === undefined) continue;
    delete env[name];
    removed.push(name);
  }
  return removed;
}

/** The names cleared before every test file. */
export function platformEnvNames(): string[] {
  return [...new Set([...documentedEnvNames(), ...contractEnvNames()])];
}

isolateEnv(process.env, platformEnvNames());
