/**
 * scripts/test-db.sh runs a fixed number of workers, and says plainly when the server cannot take
 * them (TASK-229)
 *
 * The Mac test pass (16 cores) ran jest's default — cores less one, 15 workers — which needed
 * max_connections raised, and showed an order of per-worker databases no 2–3-worker run could. The
 * script now runs TEST_DB_WORKERS workers (default 4) on every machine, and checks the server's
 * max_connections first. Run here against a stand-in `psql` that answers the two questions the
 * check asks (and refuses to create a database, so nothing past the check runs).
 *
 * @not-guard: drives scripts/test-db.sh with a stand-in psql; reads the script only for its jest lines
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "test-db-script-"));
  try {
    // The stand-in: "select 1" answers; the connections query answers "<free> <max_connections>"
    // (FAKE_FREE, default FAKE_MAX); anything else (CREATE DATABASE) fails with 3.
    writeFileSync(
      join(dir, "psql"),
      [
        "#!/bin/sh",
        'for a in "$@"; do',
        '  if [ "$a" = "select 1" ]; then exit 0; fi',
        '  case "$a" in *superuser_reserved_connections*) echo "${FAKE_FREE:-$FAKE_MAX} $FAKE_MAX"; exit 0 ;; esac',
        "done",
        "exit 3",
        "",
      ].join("\n")
    );
    chmodSync(join(dir, "psql"), 0o755);
    const r = spawnSync("bash", [join(ROOT, "scripts/test-db.sh")], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? "",
        ...env,
      } as unknown as NodeJS.ProcessEnv,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("scripts/test-db.sh: workers and connections (TASK-229)", () => {
  it("defaults to 4 workers, whatever the machine's cores, and goes on when the server can take them", () => {
    const r = run({ FAKE_MAX: "100" });
    expect(r.out).toContain(
      "test:db: 4 jest workers (TEST_DB_WORKERS), 100 of max_connections 100 free"
    );
    // Past the check: the stand-in refuses to create the database.
    expect(r.code).toBe(3);
  });

  it("15 workers on a server allowing 100 connections: refused before anything, in plain words", () => {
    const r = run({ FAKE_MAX: "100", TEST_DB_WORKERS: "15" });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "15 workers need about 190 connections; this server has 100 free (max_connections 100"
    );
    expect(r.out).toContain("TEST_DB_WORKERS=2 npm run test:db");
  });

  it.each([
    ["08", 8],
    ["09", 9],
    ["007", 7],
    ["12", 12],
  ])(
    "TEST_DB_WORKERS=%p is %p workers (leading zeros are not octal: review B, N-4)",
    (value, n) => {
      const r = run({ FAKE_MAX: "500", TEST_DB_WORKERS: value as string });
      expect(r.out).toContain(`test:db: ${n} jest workers`);
      expect(r.code).toBe(3);
    }
  );

  it("the reserved slots and the connections already open count against it (N-4): 4 workers need 58, 57 free is refused", () => {
    const r = run({ FAKE_MAX: "100", FAKE_FREE: "57" });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "4 workers need about 58 connections; this server has 57 free"
    );
  });

  it.each(["abc", "0", "00", "-3", "2.5", ""])("TEST_DB_WORKERS=%p: refused", (value) => {
    const r = run({ FAKE_MAX: "500", TEST_DB_WORKERS: value });
    if (value === "") {
      // Empty is unset: the default.
      expect(r.out).toContain("test:db: 4 jest workers");
      return;
    }
    expect(r.code).toBe(2);
    expect(r.out).toContain("TEST_DB_WORKERS must be a whole number of workers");
  });

  it("passes its worker count to every jest run it starts", () => {
    const src = require("node:fs").readFileSync(
      join(ROOT, "scripts/test-db.sh"),
      "utf8"
    ) as string;
    expect(src).toContain('npm run test:coverage -- --silent --maxWorkers="$workers"');
    expect(src).toContain('npx jest __tests__/db --silent --maxWorkers="$workers"');
  });
});
