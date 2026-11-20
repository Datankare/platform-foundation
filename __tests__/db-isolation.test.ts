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
 *   5. (TASK-223) no copy outlives its run unseen: the global setup marks each copy it makes with
 *      its run and process (markCopy) and first drops the copies a killed run on this host left
 *      (reclaimKilledCopies); the teardown, after dropping, checks the run's copies are gone
 *      (remainingCopies) and fails the run if not; CI's Layer 1 ends with
 *      scripts/check-test-database-copies.mjs, whose names are this file's (copyPrefixes).
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
  copyMark,
  copyPrefixes,
  databaseOf,
  leaveEnclosingRun,
  readCopyMark,
  reclaimable,
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
  // A written URL to a released loopback port (helpers/closed-port.ts: `${CLOSED}`; TASK-229 — it
  // was port 1, which a macOS process may listen on) is the tests' unreachable database (a
  // refusal's check), never a database; this file's own fixtures are the violations it plants.
  if (file !== SELF)
    for (const m of text.matchAll(
      /new\s+(?:Client|Pool)\s*\(\s*\{[^}]*?["'`](postgres(?:ql)?:\/\/[^"'`]*)/g
    ))
      if (!/@127\.0\.0\.1:\$\{CLOSED\}\//.test(m[1]))
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
    "a copy copyDatabase has just made whose own entry differs; and the marked copies of a killed run on this host, their owner no longer running and nobody connected (reclaimKilledCopies, TASK-223)",
  "__tests__/db/worker-database.db.test.ts":
    "its own scratch databases (<its copy>_src, _dst, _left) and the copies it plants to prove a killed run's are reclaimed (TASK-223)",
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

/**
 * TASK-223: the setup reclaims a killed run's copies before making its own and marks each it
 * makes; the teardown checks, after dropping, that none of the run's is left, and fails if one is.
 */
export function leftoverProblems(teardown: string, setup: string): string[] {
  const out: string[] = [];
  const drop = teardown.search(/\bdrop\s+database\b/i);
  const check = teardown.search(/remainingCopies\(/);
  if (check < 0 || check < drop || !/throw new Error\(/.test(teardown.slice(check)))
    out.push(
      "__tests__/helpers/db-global-teardown.ts: does not check, after dropping, that the run's copies are gone (remainingCopies) and fail if one is left"
    );
  const reclaim = setup.search(/reclaimKilledCopies\(/);
  const copy = setup.search(/copyDatabase\(/);
  const mark = setup.search(/markCopy\(/);
  if (reclaim < 0 || copy < 0 || reclaim > copy)
    out.push(
      "__tests__/helpers/db-global-setup.ts: does not drop a killed run's copies (reclaimKilledCopies) before making its own"
    );
  if (mark < 0 || mark < copy)
    out.push(
      "__tests__/helpers/db-global-setup.ts: does not mark each copy it makes (markCopy)"
    );
  return out;
}

/**
 * TASK-223: CI's Layer 1 and scripts/test-db.sh each end with the leftover check
 * (scripts/check-test-database-copies.mjs) after their last database pass.
 */
export function leftoverCheckProblems(ci: string, testDb: string): string[] {
  const out: string[] = [];
  const CHECK = "node scripts/check-test-database-copies.mjs";
  const lastPass = (text: string) =>
    Math.max(
      ...[
        "npm run test:coverage",
        "npm run test:core",
        "npm run test:db-serial",
        "npx jest",
      ].map((cmd) => text.lastIndexOf(cmd))
    );
  if (!ci.includes(CHECK) || ci.lastIndexOf(CHECK) < lastPass(ci))
    out.push(
      ".github/workflows/ci.yml: Layer 1 does not end with the leftover check (node scripts/check-test-database-copies.mjs after its last pass)"
    );
  if (!testDb.includes(CHECK) || testDb.lastIndexOf(CHECK) < lastPass(testDb))
    out.push(
      "scripts/test-db.sh: does not run the leftover check (node scripts/check-test-database-copies.mjs) after its passes"
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
    ),
    ...leftoverProblems(
      read("__tests__/helpers/db-global-teardown.ts"),
      read("__tests__/helpers/db-global-setup.ts")
    ),
    ...leftoverCheckProblems(read(".github/workflows/ci.yml"), read("scripts/test-db.sh"))
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
        'if (w === null || roleInRun(w) !== "owner") return;\nconst left = await remainingCopies(c, n);\nif (left.length) throw new Error("left");\n'
      );
      writeFileSync(
        join(dir, "__tests__", "helpers", "db-global-setup.ts"),
        "leaveEnclosingRun();\nawait reclaimKilledCopies(c, base);\nawait copyDatabase(c, base, n);\nawait markCopy(c, n, run);\n"
      );
      // … and CI and test:db end with the leftover check (TASK-223).
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      mkdirSync(join(dir, "scripts"), { recursive: true });
      const check = "node scripts/check-test-database-copies.mjs";
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        `npm run test:db-serial\n${check}\n`
      );
      writeFileSync(join(dir, "scripts", "test-db.sh"), `npx jest\n${check}\n`);
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

describe("no copy outlives its run unseen (TASK-223)", () => {
  it("[self-test] a teardown that does not check its copies are gone, a setup that does not reclaim or mark, are found", () => {
    const teardown =
      'c.query("drop database x");\nconst left = await remainingCopies(c, names);\nif (left.length) throw new Error("left");';
    const setup =
      "await reclaimKilledCopies(c, base);\nawait copyDatabase(c, base, n);\nawait markCopy(c, n, run);";
    expect(leftoverProblems(teardown, setup)).toEqual([]);
    expect(leftoverProblems('c.query("drop database x");', setup)).toEqual([
      expect.stringMatching(/does not check, after dropping/),
    ]);
    expect(
      leftoverProblems(
        'const left = await remainingCopies(c, names);\nc.query("drop database x");\nthrow new Error("x");',
        setup
      )
    ).toEqual([expect.stringMatching(/does not check, after dropping/)]);
    expect(
      leftoverProblems(
        teardown,
        "await copyDatabase(c, base, n);\nawait markCopy(c, n, run);"
      )
    ).toEqual([expect.stringMatching(/does not drop a killed run's copies/)]);
    expect(
      leftoverProblems(
        teardown,
        "await reclaimKilledCopies(c, base);\nawait copyDatabase(c, base, n);"
      )
    ).toEqual([expect.stringMatching(/does not mark each copy/)]);
  });

  it("[self-test] CI or test:db without the leftover check after its last pass is found", () => {
    const check = "node scripts/check-test-database-copies.mjs";
    expect(
      leftoverCheckProblems(`npm run test:db-serial\n${check}`, `npx jest\n${check}`)
    ).toEqual([]);
    expect(leftoverCheckProblems("npm run test:db-serial", `npx jest\n${check}`)).toEqual(
      [expect.stringMatching(/ci\.yml: Layer 1 does not end with the leftover check/)]
    );
    expect(leftoverCheckProblems(`${check}\nnpm run test:db-serial`, `npx jest`)).toEqual(
      [expect.stringMatching(/ci\.yml/), expect.stringMatching(/test-db\.sh/)]
    );
  });

  it("[self-test] a copy's mark names its run, its process and its host, and reads back", () => {
    const mark = copyMark("mwjcq74j002ae0", 4242, "ci-runner-7");
    expect(mark).toBe("pf test copy run=mwjcq74j002ae0 owner=4242@ci-runner-7");
    expect(readCopyMark(mark)).toEqual({
      run: "mwjcq74j002ae0",
      pid: 4242,
      host: "ci-runner-7",
    });
    for (const other of [
      null,
      "",
      "a comment",
      "pf test copy run=X owner=1@h",
      "pf test copy run=r owner=x@h",
    ])
      expect(readCopyMark(other)).toBeNull();
  });

  it("[self-test] a reclaim takes only a killed run's copies on this host that nobody is connected to, and their scratch databases", () => {
    const alive = (pid: number) => pid !== 4242; // 4242 has ended
    const mark = (pid: number, host = "here") => copyMark("r1", pid, host);
    const rows = [
      { name: "replay_w1_r1", comment: mark(4242), sessions: 0 },
      { name: "replay_w1_r1_src", comment: null, sessions: 0 },
      { name: "replay_w2_r1", comment: mark(4242), sessions: 1 },
      { name: "replay_w2_r1_dst", comment: null, sessions: 0 },
      { name: "replay_w3_r2", comment: mark(77), sessions: 0 },
      { name: "replay_w4_r1", comment: mark(4242, "elsewhere"), sessions: 0 },
      { name: "replay_w5_r9", comment: null, sessions: 0 },
      { name: "replay_w1_r1_left", comment: null, sessions: 2 },
    ];
    expect(reclaimable(rows, alive, "here")).toEqual([
      "replay_w1_r1_src",
      "replay_w1_r1",
    ]);
  });

  it("[self-test] every copy's name, and a scratch database beside one, begins with a copy prefix", () => {
    for (const base of ["replay", "b56e1_pa_r1", "x".repeat(70), "Mixed-Case"]) {
      const name = workerDatabaseName(base, 3, "r1");
      expect(copyPrefixes(base).some((p) => name.startsWith(p))).toBe(true);
      expect(copyPrefixes(base).some((p) => `${name}_src`.startsWith(p))).toBe(true);
    }
    // The database itself is never taken for one of its copies.
    expect(copyPrefixes("replay").some((p) => "replay".startsWith(p))).toBe(false);
  });

  it("CI's check names exactly the copies this file names (scripts/check-test-database-copies.mjs)", () => {
    const bases = ["replay", "b56e1_pa_r1", "x".repeat(70), "Mixed-Case", "pf_test_1_2"];
    const r = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { copyPrefixes } from ${JSON.stringify(join(ROOT, "scripts", "check-test-database-copies.mjs"))};
         process.stdout.write(JSON.stringify(${JSON.stringify(bases)}.map(copyPrefixes)));`,
      ],
      { encoding: "utf8" }
    );
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual(bases.map(copyPrefixes));
  });
});

/**
 * TASK-229 (the Mac test pass): a run's copies are named in worker order (_w1 … _wN), and the
 * database answers in name order (`order by datname`; a `name` sorts by collation C). With fewer
 * than ten workers the two orders coincide; with ten or more they do not — the Mac (16 cores, 15
 * workers) failed worker-database.db.test.ts on `expect(left).toEqual(probe.names)` while every CI
 * run (2–3 workers) passed. Checked here without a database, with 16 synthetic workers, so it holds
 * on any machine; and every nested jest run a test starts names its worker count, so what it makes
 * does not depend on the machine's cores (the killed-run probe runs 12, past the trap, everywhere).
 */
describe("worker copies: nothing depends on how many workers a machine has (TASK-229)", () => {
  const names = Array.from({ length: 16 }, (_, i) =>
    workerDatabaseName("replay", i + 1, "run1")
  );
  const collationC = (a: string, b: string) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b));

  it("with 16 workers, name order is not worker order (the trap)", () => {
    expect([...names].sort(collationC)).not.toEqual(names);
    expect([...names].sort(collationC).slice(0, 3)).toEqual([
      "replay_w10_run1",
      "replay_w11_run1",
      "replay_w12_run1",
    ]);
  });

  it("sorting both sides with .sort() is the database's own order (collation C) for these names", () => {
    expect([...names].sort()).toEqual([...names].sort(collationC));
  });

  /** A worker-ordered list (`x.names`, `Object.values(x.names)`) compared in order. */
  const ORDERED_NAMES =
    /toEqual\(\s*(?:Object\.values\(\s*[\w.]+\.names\s*\)|[\w.]+\.names)\s*\)/;

  it("[self-test] the scan finds an in-order comparison and spares a sorted one", () => {
    expect(ORDERED_NAMES.test("expect(left).toEqual(probe.names);")).toBe(true);
    expect(ORDERED_NAMES.test("expect(x).toEqual(Object.values(run.names));")).toBe(true);
    expect(
      ORDERED_NAMES.test("expect([...left].sort()).toEqual([...probe.names].sort());")
    ).toBe(false);
    expect(
      ORDERED_NAMES.test("expect(present).toEqual([...Object.values(run.names)].sort());")
    ).toBe(false);
  });

  it("no test compares a run's copy names in worker order", () => {
    const offenders: string[] = [];
    for (const f of walkFiles(__dirname, (n) => /\.tsx?$/.test(n))) {
      if (f.endsWith("db-isolation.test.ts")) continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (ORDERED_NAMES.test(line)) offenders.push(`${relative(ROOT, f)}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  /** A nested jest run: the jest binary spawned with its own argument list. */
  const NESTED = /jest[\\/]bin[\\/]jest\.js"?\)?\s*,([\s\S]*?)\]/g;

  it("[self-test] a nested run without a worker count is found; one with it is not", () => {
    const without =
      'spawn(node, [join(root, "node_modules", "jest", "bin", "jest.js"), "-t", "x"], {})';
    const withIt =
      'spawn(node, [join(root, "node_modules", "jest", "bin", "jest.js"), "-t", "x", "--maxWorkers=2"], {})';
    const count = (src: string) =>
      [...src.replace(/", "/g, "/").matchAll(NESTED)].filter(
        (m) => !/--maxWorkers=\d+|--runInBand|"-i"/.test(m[1])
      ).length;
    expect(count(without)).toBe(1);
    expect(count(withIt)).toBe(0);
  });

  it("every nested jest run a test starts names its worker count", () => {
    const offenders: string[] = [];
    for (const f of walkFiles(__dirname, (n) => /\.tsx?$/.test(n))) {
      if (f.endsWith("db-isolation.test.ts")) continue;
      const src = readFileSync(f, "utf8").replace(/", "/g, "/");
      for (const m of src.matchAll(NESTED))
        if (!/--maxWorkers=\d+|--runInBand|"-i"/.test(m[1]))
          offenders.push(`${relative(ROOT, f)}: ${m[0].slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });
});
