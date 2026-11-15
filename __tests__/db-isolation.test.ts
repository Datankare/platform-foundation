/**
 * __tests__/db-isolation.test.ts — no two database suites share a database while they run (TASK-218)
 *
 * @guard a jest configuration, setup or test through which database suites could share one database again
 *
 * PF run 43633427223 failed once and passed on its rerun: operator-routes.db.test.ts compared the
 * tenant route's settings with `select key from platform_config where tenant_overridable`, read a
 * moment later, while r13.db.test.ts, in another worker on the same database, inserted a
 * tenant-settable row between the two reads. Every suite that asserts on a whole catalogue the
 * platform shares (settings, roles, permissions, feature flags, applied migrations, counts over
 * them) could fail the same way whenever another suite writes there. The fix removes the sharing:
 * each jest worker runs on its own copy of the database (helpers/db-workers.ts). This guard keeps
 * it so, statically:
 *
 *   1. every jest configuration of the repository (package.json's `jest`, and each jest*.config.*
 *      file) has the global setup that makes the copies and the teardown that drops them, and runs
 *      jest.setup.ts;
 *   2. jest.setup.ts and helpers/db.ts select the worker's copy before anything reads
 *      TEST_DATABASE_URL;
 *   3. no test source connects to a database some other way: a `postgres://` URL written in a
 *      `new Client(…)` / `new Pool(…)`, or the copied database's own settings
 *      (TEST_DATABASE_BASE_URL, TEST_DATABASE_BASE_OWNER_URL) outside the files that check the
 *      isolation itself.
 *
 * At run time, helpers/db-workers.ts refuses a configured database with no copies made, and
 * __tests__/db/worker-database.db.test.ts checks that a suite is on its copy and that what it
 * writes no other database sees.
 */
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative, sep } from "path";
import { walkFiles } from "./helpers/repo-files";
import {
  databaseOf,
  selectWorkerDatabase,
  withDatabase,
  workerDatabaseName,
  WORKERS_ENV,
} from "./helpers/db-workers";

const ROOT = join(__dirname, "..");

const SETUP = "<rootDir>/__tests__/helpers/db-global-setup.ts";
const TEARDOWN = "<rootDir>/__tests__/helpers/db-global-teardown.ts";
const JEST_SETUP = "<rootDir>/jest.setup.ts";
const SELF = "__tests__/db-isolation.test.ts";

/** The files that may read the copied database's own settings: the isolation's own. */
const BASE_READERS = new Set([
  "__tests__/helpers/db-workers.ts",
  "__tests__/helpers/db-global-teardown.ts",
  "__tests__/db/worker-database.db.test.ts",
  "__tests__/db-isolation.test.ts",
]);

interface JestConfig {
  globalSetup?: string;
  globalTeardown?: string;
  setupFilesAfterEnv?: string[];
}

/** Each jest configuration of a repository, resolved (a .cjs/.js config is loaded in a child node). */
export function jestConfigs(root: string): { file: string; config: JestConfig | null }[] {
  const out: { file: string; config: JestConfig | null }[] = [];
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    jest?: JestConfig;
  };
  if (pkg.jest) out.push({ file: "package.json (jest)", config: pkg.jest });
  for (const p of walkFiles(root, (n) =>
    /^jest(?:\.[\w-]+)?\.config\.(?:cjs|js|mjs|ts|json)$/.test(n)
  )) {
    const file = relative(root, p).split(sep).join("/");
    if (file.includes("/")) continue; // a configuration at the root, as jest finds them
    if (/\.json$/.test(file)) {
      out.push({ file, config: JSON.parse(readFileSync(p, "utf8")) as JestConfig });
      continue;
    }
    if (!/\.c?js$/.test(file)) {
      out.push({ file, config: null });
      continue;
    }
    const r = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(require(process.argv[1])))", p],
      { cwd: root, encoding: "utf8" }
    );
    out.push({
      file,
      config: r.status === 0 ? (JSON.parse(r.stdout) as JestConfig) : null,
    });
  }
  return out;
}

/** What a configuration lacks for the per-worker databases. */
export function configProblems(file: string, config: JestConfig | null): string[] {
  if (config === null)
    return [
      `${file}: a jest configuration this check cannot read — write it as .cjs or JSON`,
    ];
  const out: string[] = [];
  if (config.globalSetup !== SETUP)
    out.push(`${file}: globalSetup must be ${SETUP} (each worker's own database)`);
  if (config.globalTeardown !== TEARDOWN)
    out.push(`${file}: globalTeardown must be ${TEARDOWN} (the copies dropped)`);
  if (!(config.setupFilesAfterEnv ?? []).includes(JEST_SETUP))
    out.push(
      `${file}: setupFilesAfterEnv must run ${JEST_SETUP} (it selects the worker's copy)`
    );
  return out;
}

/** Whether a module selects the worker's copy before it reads TEST_DATABASE_URL (or reads none). */
export function selectsFirst(file: string, text: string): string[] {
  const call = text.search(/^\s*selectWorkerDatabase\(\);/m);
  const read = text.search(/process\.env\.TEST_DATABASE_(?:OWNER_)?URL/);
  if (call < 0) return [`${file}: does not call selectWorkerDatabase() at load`];
  if (read >= 0 && read < call)
    return [`${file}: reads TEST_DATABASE_URL before selectWorkerDatabase()`];
  return [];
}

/** Ways a test source connects to a database other than its worker's copy. */
export function connectionProblems(file: string, text: string): string[] {
  const out: string[] = [];
  const lineOf = (i: number) => text.slice(0, i).split("\n").length;
  // A written URL to port 1 of the loopback is the tests' unreachable database (a refusal's
  // check), never a database; this file's own fixtures are the violations it plants.
  if (file !== SELF)
    for (const m of text.matchAll(
      /new\s+(?:Client|Pool)\s*\(\s*\{[^}]*?["'`](postgres(?:ql)?:\/\/[^"'`]*)/g
    ))
      if (!/@127\.0\.0\.1:1\//.test(m[1]))
        out.push(
          `${file}:${lineOf(m.index ?? 0)}: a database URL written in the test — connect through TEST_DATABASE_URL / TEST_DATABASE_OWNER_URL (this worker's copy)`
        );
  if (!BASE_READERS.has(file))
    for (const m of text.matchAll(
      /TEST_DATABASE_BASE_(?:OWNER_)?URL|BASE_(?:OWNER_)?URL_ENV/g
    ))
      out.push(
        `${file}:${lineOf(m.index ?? 0)}: reads the copied database's own settings — a suite works on its worker's copy`
      );
  return out;
}

/** Every problem in a repository. */
export function isolationProblems(root: string): string[] {
  const out: string[] = [];
  const configs = jestConfigs(root);
  if (configs.length === 0) out.push("no jest configuration found");
  for (const { file, config } of configs) out.push(...configProblems(file, config));
  for (const f of ["jest.setup.ts", "__tests__/helpers/db.ts"]) {
    const p = join(root, f);
    if (existsSync(p)) out.push(...selectsFirst(f, readFileSync(p, "utf8")));
    else out.push(`${f}: missing`);
  }
  for (const p of walkFiles(join(root, "__tests__"), (n) =>
    /\.(?:ts|tsx|mjs|cjs|js)$/.test(n)
  )) {
    const f = relative(root, p).split(sep).join("/");
    out.push(...connectionProblems(f, readFileSync(p, "utf8")));
  }
  return out;
}

describe("no two database suites share a database while they run (TASK-218)", () => {
  it("finds the repository's jest configurations", () => {
    expect(jestConfigs(ROOT).map((c) => c.file)).toEqual(
      expect.arrayContaining(["package.json (jest)", "jest.core.config.cjs"])
    );
  });

  it("every configuration copies the database per worker, and every suite connects to its copy", () => {
    expect(isolationProblems(ROOT)).toEqual([]);
  });
});

describe("the database isolation's self-tests (TASK-218)", () => {
  it("[self-test] a configuration without the global setup, teardown or jest.setup is refused", () => {
    const good = {
      globalSetup: SETUP,
      globalTeardown: TEARDOWN,
      setupFilesAfterEnv: [JEST_SETUP],
    };
    expect(configProblems("c", good)).toEqual([]);
    expect(configProblems("c", { ...good, globalSetup: undefined })).toEqual([
      expect.stringMatching(/^c: globalSetup must be/),
    ]);
    expect(configProblems("c", { ...good, globalTeardown: undefined })).toEqual([
      expect.stringMatching(/^c: globalTeardown must be/),
    ]);
    expect(configProblems("c", { ...good, setupFilesAfterEnv: [] })).toEqual([
      expect.stringMatching(/^c: setupFilesAfterEnv must run/),
    ]);
    expect(configProblems("c", null)).toEqual([expect.stringMatching(/cannot read/)]);
  });

  it("[self-test] a scratch repository: a second config that drops the setup, and a test with its own URL, are found", () => {
    const dir = mkdtempSync(join(tmpdir(), "db-isolation-"));
    try {
      const jest = {
        globalSetup: SETUP,
        globalTeardown: TEARDOWN,
        setupFilesAfterEnv: [JEST_SETUP],
      };
      writeFileSync(join(dir, "package.json"), JSON.stringify({ jest }));
      writeFileSync(
        join(dir, "jest.other.config.cjs"),
        'const base = require("./package.json").jest;\nmodule.exports = { ...base, globalSetup: undefined };\n'
      );
      writeFileSync(
        join(dir, "jest.setup.ts"),
        'import { selectWorkerDatabase } from "x";\nselectWorkerDatabase();\n'
      );
      mkdirSync(join(dir, "__tests__", "helpers"), { recursive: true });
      writeFileSync(
        join(dir, "__tests__", "helpers", "db.ts"),
        "const URL = process.env.TEST_DATABASE_URL;\nselectWorkerDatabase();\n"
      );
      writeFileSync(
        join(dir, "__tests__", "a.test.ts"),
        'const c = new Client({ connectionString: "postgresql://postgres@localhost/replay" });\nconst b = process.env.TEST_DATABASE_BASE_URL;\n'
      );
      expect(isolationProblems(dir)).toEqual([
        expect.stringMatching(/^jest\.other\.config\.cjs: globalSetup must be/),
        "__tests__/helpers/db.ts: reads TEST_DATABASE_URL before selectWorkerDatabase()",
        expect.stringMatching(
          /^__tests__\/a\.test\.ts:1: a database URL written in the test/
        ),
        expect.stringMatching(
          /^__tests__\/a\.test\.ts:2: reads the copied database's own settings/
        ),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[self-test] each worker is pointed at its own copy; credentials and a session time zone kept", () => {
    const base =
      "postgresql://app_tenant:pw@localhost:5432/replay?options=-c%20TimeZone%3DAmerica%2FNew_York";
    const owner = "postgresql://postgres:postgres@localhost:5432/replay";
    const names = {
      "1": workerDatabaseName("replay", 1, "r1"),
      "2": workerDatabaseName("replay", 2, "r1"),
    };
    expect(names).toEqual({ "1": "replay_w1_r1", "2": "replay_w2_r1" });
    const env = (id: string): Record<string, string | undefined> => ({
      TEST_DATABASE_URL: base,
      TEST_DATABASE_OWNER_URL: owner,
      JEST_WORKER_ID: id,
      [WORKERS_ENV]: JSON.stringify({ base: "replay", names }),
    });
    const w2 = env("2");
    selectWorkerDatabase(w2);
    expect(w2.TEST_DATABASE_URL).toBe(withDatabase(base, "replay_w2_r1"));
    expect(w2.TEST_DATABASE_URL).toContain("app_tenant:pw@");
    expect(w2.TEST_DATABASE_URL).toContain("TimeZone");
    expect(databaseOf(w2.TEST_DATABASE_OWNER_URL!)).toBe("replay_w2_r1");
    // Idempotent: a second selection (helpers/db.ts after jest.setup.ts) changes nothing.
    const again = { ...w2 };
    selectWorkerDatabase(again);
    expect(again).toEqual(w2);
    const w1 = env("1");
    selectWorkerDatabase(w1);
    expect(databaseOf(w1.TEST_DATABASE_URL!)).not.toBe(databaseOf(w2.TEST_DATABASE_URL!));
    // A long base name stays within Postgres's 63 bytes, and stays distinct per worker.
    const long = workerDatabaseName("x".repeat(70), 3, "r1");
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(63);
    expect(long).not.toBe(workerDatabaseName("x".repeat(70), 4, "r1"));
  });

  it("[self-test] a configured database with no copies made, or a worker with none, is refused — never shared", () => {
    expect(() =>
      selectWorkerDatabase({
        TEST_DATABASE_URL: "postgresql://a@h/replay",
        TEST_DATABASE_OWNER_URL: "postgresql://b@h/replay",
      })
    ).toThrow(/made no per-worker databases/);
    expect(() =>
      selectWorkerDatabase({
        TEST_DATABASE_URL: "postgresql://a@h/replay",
        TEST_DATABASE_OWNER_URL: "postgresql://b@h/replay",
        JEST_WORKER_ID: "3",
        [WORKERS_ENV]: JSON.stringify({ base: "replay", names: { "1": "replay_w1_r" } }),
      })
    ).toThrow(/no per-worker database for jest worker 3/);
    expect(() =>
      selectWorkerDatabase({
        TEST_DATABASE_URL: "postgresql://a@h/other",
        TEST_DATABASE_OWNER_URL: "postgresql://b@h/other",
        JEST_WORKER_ID: "1",
        [WORKERS_ENV]: JSON.stringify({ base: "replay", names: { "1": "replay_w1_r" } }),
      })
    ).toThrow(/names other, not replay/);
    const none: Record<string, string | undefined> = {};
    selectWorkerDatabase(none);
    expect(none).toEqual({});
  });
});
