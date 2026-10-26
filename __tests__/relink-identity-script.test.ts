/**
 * scripts/relink-identity.mjs (TASK-174): the operator command starts as an operator starts it —
 * `node scripts/relink-identity.mjs …`, no build step — and runs the platform's own TypeScript
 * (it restarts Node with --experimental-transform-types; scripts/ts-paths-hook.mjs resolves the
 * `@/` imports). Proves it loads the command's whole import graph, prints its usage, refuses bad
 * arguments and missing settings by name only (never a value), and refuses a malformed pool id
 * before reaching the pool or the database. The command's behaviour is __tests__/identity-relink
 * (unit) and __tests__/db/identity-relink.db.test.ts (Postgres).
 */
import { execFile, type ExecFileException } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const SCRIPT = join(process.cwd(), "scripts/relink-identity.mjs");
/** A stand-in secret (built, so no scanner mistakes it for one), never to appear in output. */
const FAKE_SECRET = `canary-${"x".repeat(32)}`;
const BASE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  LOG_LEVEL: "error",
};

function run(
  args: string[],
  env: Record<string, string> = {}
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...BASE_ENV, ...env } as NodeJS.ProcessEnv, timeout: 60_000 },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        resolve({
          code: error ? Number(error.code ?? 1) : 0,
          out: String(stdout),
          err: String(stderr),
        });
      }
    );
  });
}

jest.setTimeout(120_000);

describe("scripts/relink-identity.mjs", () => {
  it("the engines floor in package.json is at least the Node the command needs (22.7)", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      engines: { node: string };
    };
    const m = /^>=(\d+)\.(\d+)/.exec(pkg.engines.node);
    expect(m).not.toBeNull();
    const [major, minor] = [Number(m![1]), Number(m![2])];
    expect(major > 22 || (major === 22 && minor >= 7)).toBe(true);
    expect(readFileSync(SCRIPT, "utf8")).toContain("Node ≥ 22.7 is required");
  });

  it("--help: the usage, exit 0 (the command's TypeScript loaded through the hook)", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Re-link existing accounts");
    expect(r.out).toContain("docs/TENANCY_OPERATIONS.md §6");
  });

  it("TASK-177: --subject username is refused (exit 2) — the subject is always the sub", async () => {
    const r = await run([
      "--email",
      "a@b.co",
      "--subject",
      "username",
      "--operator",
      "R",
      "--reason",
      "pool moved",
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--subject is removed");
  });

  it("an unknown argument: exit 2 with the usage", async () => {
    const r = await run(["--email", "a@b.co", "--force"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Unknown argument: --force");
  });

  it("missing settings: exit 2, named — the values that are set are never printed", async () => {
    const r = await run(
      ["--email", "a@b.co", "--operator", "Raman", "--reason", "pool replaced"],
      { DATABASE_OWNER_URL: "postgresql://owner:Sup3rSecretPw@db.example:5432/postgres" }
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain("NEXT_PUBLIC_COGNITO_USER_POOL_ID");
    expect(r.err).toContain("COGNITO_ADMIN_ACCESS_KEY_ID");
    expect(r.err).not.toContain("DATABASE_OWNER_URL;");
    expect(r.out + r.err).not.toContain("Sup3rSecretPw");
  });

  it("a malformed pool id: exit 2 before the pool or the database is reached", async () => {
    const r = await run(
      ["--email", "a@b.co", "--operator", "Raman", "--reason", "pool replaced"],
      {
        DATABASE_OWNER_URL: "postgresql://owner:Sup3rSecretPw@127.0.0.1:1/postgres",
        COGNITO_USER_POOL_ID: "not-a-pool",
        COGNITO_ADMIN_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST",
        COGNITO_ADMIN_SECRET_ACCESS_KEY: FAKE_SECRET,
      }
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain("COGNITO_USER_POOL_ID) has the wrong shape");
    expect(r.out + r.err).not.toContain("canary-");
    expect(r.out + r.err).not.toContain("Sup3rSecretPw");
  });

  it("the database unreachable: exit 3, nothing changed, no setting's value printed", async () => {
    const r = await run(
      [
        "--all-staff",
        "--subject",
        "sub",
        "--created-before",
        "2026-10-20T14:00:00Z",
        "--operator",
        "Raman",
        "--reason",
        "pool replaced",
      ],
      {
        DATABASE_OWNER_URL: "postgresql://owner:Sup3rSecretPw@127.0.0.1:1/postgres",
        DATABASE_SSL: "disable",
        COGNITO_USER_POOL_ID: "us-east-1_TestPool1",
        COGNITO_ADMIN_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST",
        COGNITO_ADMIN_SECRET_ACCESS_KEY: FAKE_SECRET,
      }
    );
    expect(r.code).toBe(3);
    expect(r.err).toContain("Nothing was changed");
    // `--subject sub` still runs one release, with its deprecation note.
    expect(r.err).toContain("--subject is deprecated and ignored");
    expect(r.out + r.err).not.toContain("canary-");
    expect(r.out + r.err).not.toContain("Sup3rSecretPw");
  });
});
