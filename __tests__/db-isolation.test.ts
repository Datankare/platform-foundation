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
 *   4. (TASK-219) a run's copies are dropped only by the process that made them: every place a
 *      test, helper or script drops a database is listed below (DROPS) with whose database it
 *      drops, a new one fails; the global teardown drops only when `roleInRun` says this process
 *      is the run's owner; and the global setup first leaves an enclosing run (a jest run started
 *      by a test makes copies of its own instead of taking, and then dropping, the live run's —
 *      CI run 43722156950 lost every copy that way, to __tests__/env-isolation.test.ts's run).
 *
 * At run time, helpers/db-workers.ts refuses a configured database with no copies made, and a
 * process outside the run that made them, and
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
  leaveEnclosingRun,
  roleInRun,
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

/** Each place that drops a database, with whose (TASK-219). Any other is a finding. */
const DROPS: Readonly<Record<string, string>> = {
  "__tests__/helpers/db-global-teardown.ts":
    "the run's copies, only in the process that made them (roleInRun === owner)",
  "__tests__/helpers/db-global-setup.ts":
    "copies it has just made, when making the rest failed",
  "__tests__/helpers/db-workers.ts":
    "a copy copyDatabase has just made whose own entry differs",
  "__tests__/db/worker-database.db.test.ts":
    "its own scratch databases (<its copy>_src, _dst)",
  "scripts/test-db.sh": "its own database and that database's copies, after its run",
};

/** Files that drop a database but are not listed, and listed files that no longer do. */
export function dropProblems(
  files: readonly { file: string; text: string }[],
  allowed: Readonly<Record<string, string>> = DROPS
): string[] {
  const out: string[] = [];
  const dropping = new Set(
    files.filter((f) => /\bdrop\s+database\b/i.test(f.text)).map((f) => f.file)
  );
  for (const f of [...dropping].sort())
    if (!(f in allowed))
      out.push(
        `${f}: drops a database — only the run that made a copy may drop it: list it in DROPS with whose database it drops, or leave it to the global teardown`
      );
  for (const f of Object.keys(allowed))
    if (!dropping.has(f)) out.push(`DROPS "${f}": drops no database — remove it`);
  return out;
}

/** The teardown drops only as the run's owner; the setup leaves an enclosing run first. */
export function ownershipProblems(teardown: string, setup: string): string[] {
  const out: string[] = [];
  const check = teardown.search(/roleInRun\([^)]*\)\s*!==\s*"owner"/);
  const drop = teardown.search(/\bdrop\s+database\b/i);
  if (check < 0 || (drop >= 0 && drop < check))
    out.push(
      '__tests__/helpers/db-global-teardown.ts: drops before checking roleInRun(…) !== "owner" — a run started inside another would drop the live run\'s copies'
    );
  const leave = setup.search(/^\s*leaveEnclosingRun\(\);/m);
  const read = setup.search(/process\.env\.TEST_DATABASE_(?:OWNER_)?URL/);
  if (leave < 0 || (read >= 0 && read < leave))
    out.push(
      "__tests__/helpers/db-global-setup.ts: reads the settings before leaveEnclosingRun() — a run started inside another would take the live run's copies"
    );
  return out;
}

/** Every problem in a repository. */
export function isolationProblems(
  root: string,
  drops: Readonly<Record<string, string>> = DROPS
): string[] {
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
  const scanned = ["__tests__", "scripts", "e2e", "e2e-live"]
    .flatMap((d) =>
      walkFiles(join(root, d), (n) => /\.(?:ts|tsx|mjs|cjs|js|sh)$/.test(n))
    )
    .map((p) => ({
      file: relative(root, p).split(sep).join("/"),
      text: readFileSync(p, "utf8"),
    }))
    .filter((f) => f.file !== SELF);
  out.push(...dropProblems(scanned, drops));
  const read = (f: string) =>
    existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : "";
  out.push(
    ...ownershipProblems(
      read("__tests__/helpers/db-global-teardown.ts"),
      read("__tests__/helpers/db-global-setup.ts")
    )
  );
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
      // The scratch repository's teardown and setup are the run-owning ones (TASK-219).
      writeFileSync(
        join(dir, "__tests__", "helpers", "db-global-teardown.ts"),
        'if (w === null || roleInRun(w) !== "owner") return;\n'
      );
      writeFileSync(
        join(dir, "__tests__", "helpers", "db-global-setup.ts"),
        "leaveEnclosingRun();\n"
      );
      expect(isolationProblems(dir, {})).toEqual([
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
      [WORKERS_ENV]: JSON.stringify({ base: "replay", names, owner: 4242 }),
    });
    // As a worker of the run's process (4242).
    const asWorker = (e: Record<string, string | undefined>) =>
      selectWorkerDatabase(e, 5001, 4242);
    const w2 = env("2");
    asWorker(w2);
    expect(w2.TEST_DATABASE_URL).toBe(withDatabase(base, "replay_w2_r1"));
    expect(w2.TEST_DATABASE_URL).toContain("app_tenant:pw@");
    expect(w2.TEST_DATABASE_URL).toContain("TimeZone");
    expect(databaseOf(w2.TEST_DATABASE_OWNER_URL!)).toBe("replay_w2_r1");
    // Idempotent: a second selection (helpers/db.ts after jest.setup.ts) changes nothing.
    const again = { ...w2 };
    asWorker(again);
    expect(again).toEqual(w2);
    const w1 = env("1");
    asWorker(w1);
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
      selectWorkerDatabase(
        {
          TEST_DATABASE_URL: "postgresql://a@h/replay",
          TEST_DATABASE_OWNER_URL: "postgresql://b@h/replay",
          JEST_WORKER_ID: "3",
          [WORKERS_ENV]: JSON.stringify({
            base: "replay",
            names: { "1": "replay_w1_r" },
            owner: 7,
          }),
        },
        7,
        1
      )
    ).toThrow(/no per-worker database for jest worker 3/);
    expect(() =>
      selectWorkerDatabase(
        {
          TEST_DATABASE_URL: "postgresql://a@h/other",
          TEST_DATABASE_OWNER_URL: "postgresql://b@h/other",
          JEST_WORKER_ID: "1",
          [WORKERS_ENV]: JSON.stringify({
            base: "replay",
            names: { "1": "replay_w1_r" },
            owner: 7,
          }),
        },
        7,
        1
      )
    ).toThrow(/names other, not replay/);
    const none: Record<string, string | undefined> = {};
    selectWorkerDatabase(none);
    expect(none).toEqual({});
  });
  it("[self-test] a process outside the run is refused a copy; a run started inside another leaves it and starts from its database (TASK-219)", () => {
    const map = {
      base: "replay",
      names: { "1": "replay_w1_r", "2": "replay_w2_r" },
      owner: 100,
      baseUrl: "postgresql://app_tenant:pw@h/replay",
      baseOwnerUrl: "postgresql://postgres:pw@h/replay",
    };
    expect(roleInRun(map, 100, 1)).toBe("owner");
    expect(roleInRun(map, 200, 100)).toBe("worker");
    expect(roleInRun(map, 300, 200)).toBe("outside");
    // A jest run a test started (process 300, under worker 200): it inherits worker 1's copy and the map.
    const inherited = (): Record<string, string | undefined> => ({
      TEST_DATABASE_URL: "postgresql://app_tenant:pw@h/replay_w1_r",
      TEST_DATABASE_OWNER_URL: "postgresql://postgres:pw@h/replay_w1_r",
      TEST_DATABASE_BASE_URL: map.baseUrl,
      TEST_DATABASE_BASE_OWNER_URL: map.baseOwnerUrl,
      JEST_WORKER_ID: "1",
      [WORKERS_ENV]: JSON.stringify(map),
    });
    expect(() => selectWorkerDatabase(inherited(), 300, 200)).toThrow(
      /outside the jest run/
    );
    const env = inherited();
    expect(leaveEnclosingRun(env, 300, 200)).toBe(true);
    expect(env).toEqual({
      TEST_DATABASE_URL: map.baseUrl,
      TEST_DATABASE_OWNER_URL: map.baseOwnerUrl,
      JEST_WORKER_ID: "1",
    });
    // The run's own process keeps its map; any other process leaves it.
    expect(leaveEnclosingRun(inherited(), 100, 1)).toBe(false);
    expect(leaveEnclosingRun(inherited(), 200, 100)).toBe(true);
  });

  it("[self-test] a new place that drops a database, a teardown that drops without the owner check, a setup that does not leave an enclosing run, are found (TASK-219)", () => {
    const allowed = { "a/teardown.ts": "planted" };
    expect(
      dropProblems(
        [
          { file: "a/teardown.ts", text: "drop database x" },
          {
            file: "__tests__/x.test.ts",
            text: 'await c.query("DROP DATABASE replay_w1_r")',
          },
          { file: "__tests__/y.test.ts", text: "select 1" },
        ],
        allowed
      )
    ).toEqual([expect.stringMatching(/^__tests__\/x\.test\.ts: drops a database/)]);
    expect(dropProblems([], allowed)).toEqual([
      'DROPS "a/teardown.ts": drops no database — remove it',
    ]);
    const goodTeardown =
      'const w = runDatabases(); if (w === null || roleInRun(w) !== "owner") return;\nc.query("drop database x");';
    const goodSetup = "leaveEnclosingRun();\nconst url = process.env.TEST_DATABASE_URL;";
    expect(ownershipProblems(goodTeardown, goodSetup)).toEqual([]);
    expect(ownershipProblems('c.query("drop database x");', goodSetup)).toEqual([
      expect.stringMatching(/db-global-teardown\.ts: drops before checking/),
    ]);
    expect(
      ownershipProblems(
        goodTeardown,
        "const url = process.env.TEST_DATABASE_URL;\nleaveEnclosingRun();"
      )
    ).toEqual([expect.stringMatching(/db-global-setup\.ts: reads the settings before/)]);
  });
});
