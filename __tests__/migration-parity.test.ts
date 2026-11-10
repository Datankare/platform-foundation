/**
 * TASK-197 (audit D-11): scripts/migration-parity.mjs compares what each live database applied
 * with the repository — by name, and from 063 by checksum, so a migration edited after it was
 * applied is drift. Run against a local server standing in for the database's REST API.
 * TASK-201: it authenticates with a Supabase secret key (SUPABASE_SECRET_KEY, sb_secret_…), sent
 * only as the apikey header; the legacy service_role JWT is no longer read.
 *
 * @guard a live database whose applied migrations differ from the repository's
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const DIR = join(ROOT, "supabase/migrations");
const files = readdirSync(DIR)
  .filter((f) => /^\d+[a-z]?_.*\.sql$/.test(f))
  .sort();

/** The checksum as the script computes it (its own stamp zeroed, LF line endings). */
function checksum(file: string): string {
  const text = readFileSync(join(DIR, file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/sha256:[0-9a-f]{64}/g, `sha256:${"0".repeat(64)}`);
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

interface Row {
  filename: string;
  confidence: string;
  checksum?: string | null;
}

/** The headers of every request the stand-in database received (TASK-201). */
const seen: Record<string, string | string[] | undefined>[] = [];

/** A well-formed secret key, built at run time: a literal one reads as a leak to the secret scan. */
const SECRET = ["sb", "secret", "TESTONLYabcdefghijklmnop"].join("_");

function db(rows: Row[], withChecksumColumn = true, status = 200): Promise<Server> {
  const server = createServer((req, res) => {
    seen.push(req.headers);
    if (status !== 200) return res.writeHead(status).end("{}");
    const wantsChecksum = (req.url ?? "").includes("checksum");
    if (wantsChecksum && !withChecksumColumn) return res.writeHead(400).end("{}");
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify(
          rows.map((r) =>
            withChecksumColumn ? r : { filename: r.filename, confidence: r.confidence }
          )
        )
      );
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function parity(
  server: Server,
  keys: Record<string, string> = { SUPABASE_SECRET_KEY: SECRET },
  flags: string[] = []
): Promise<{ code: number | null; out: string }> {
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      [join(ROOT, "scripts/migration-parity.mjs"), "test", ...flags],
      {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          SUPABASE_URL: url,
          ...keys,
        } as unknown as NodeJS.ProcessEnv,
      }
    );
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (out += d));
    child.on("close", (code: number | null) => resolve({ code, out }));
  });
}

const stamped = (f: string) => Number(f.match(/^\d+/)![0]) >= 63;
const recordAll = (): Row[] =>
  files.map((f) => ({
    filename: f,
    confidence: "verified",
    checksum: stamped(f) ? checksum(f) : null,
  }));

async function withDb(
  rows: Row[],
  withChecksumColumn = true,
  keys?: Record<string, string>,
  status = 200,
  flags: string[] = []
) {
  const server = await db(rows, withChecksumColumn, status);
  try {
    return await parity(server, keys, flags);
  } finally {
    server.close();
  }
}

describe("migration parity (TASK-197, audit D-11)", () => {
  it("is in parity when every file is recorded with its checksum", async () => {
    const r = await withDb(recordAll());
    expect(r.code).toBe(0);
    expect(r.out).toContain(`all ${files.length} migrations recorded`);
    expect(r.out).toMatch(/recorded without a checksum \(before 063\)/);
  });

  it("[self-test] fails, naming it, when a migration changed after it was applied", async () => {
    const rows = recordAll();
    const target = rows.find((r) => r.filename.startsWith("063_"))!;
    target.checksum = `sha256:${"1".repeat(64)}`;
    const r = await withDb(rows);
    expect(r.code).toBe(1);
    expect(r.out).toContain("changed since they were applied");
    expect(r.out).toContain(target.filename);
  });

  it("cannot check (exit 2), never name-only, when 063 is recorded but the checksums cannot be read (L4)", async () => {
    const r = await withDb(recordAll(), false);
    expect(r.code).toBe(2);
    expect(r.out).toContain(
      "063_applied_migrations_checksum.sql is recorded but the checksums could not be read"
    );
  });

  it("still compares by name on a database without the checksum column (before 063)", async () => {
    const r = await withDb(
      recordAll().filter((x) => !stamped(x.filename)),
      false
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("not recorded");
    expect(r.out).toContain("063_applied_migrations_checksum.sql");
  });
});

describe("a branch behind its shared database: --records-may-lead (TASK-203, N-87)", () => {
  const ahead: Row[] = [
    { filename: "099_from_a_newer_branch.sql", confidence: "verified", checksum: null },
  ];

  it("without the flag, a record with no file is drift (the exact check stays the default)", async () => {
    const r = await withDb([...recordAll(), ...ahead]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("recorded migration(s) with no file");
  });

  it("with it, records ahead of the branch are listed, not drift", async () => {
    const r = await withDb([...recordAll(), ...ahead], true, undefined, 200, [
      "--records-may-lead",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ahead of this branch");
    expect(r.out).toContain("099_from_a_newer_branch.sql");
  });

  it("[self-test] with it, a file of the branch not recorded, or edited after it was applied, is still drift", async () => {
    const missing = recordAll().filter((x) => !x.filename.startsWith("063_"));
    const r = await withDb([...missing, ...ahead], true, undefined, 200, [
      "--records-may-lead",
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("not recorded");
    const edited = recordAll();
    edited.find((x) => x.filename.startsWith("063_"))!.checksum =
      `sha256:${"2".repeat(64)}`;
    const e = await withDb([...edited, ...ahead], true, undefined, 200, [
      "--records-may-lead",
    ]);
    expect(e.code).toBe(1);
    expect(e.out).toContain("changed since they were applied");
  });

  it("refuses an unknown option, checking nothing", async () => {
    const r = await withDb(recordAll(), true, undefined, 200, ["--lenient"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("unknown option --lenient");
  });
});

describe("migration parity's key (TASK-201: Supabase secret keys)", () => {
  // The legacy service_role JWT's form, built at run time (the secret scan).
  const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJyb2xlIjoic2VydmljZV9yb2xlIn0", "c2ln"].join(
    "."
  );

  it("[self-test] sends the secret key as the apikey header only, never as a Bearer token", async () => {
    seen.length = 0;
    const r = await withDb(recordAll());
    expect(r.code).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(headers.apikey).toBe(SECRET);
      expect(headers.authorization).toBeUndefined();
    }
    expect(r.out).not.toContain(SECRET);
  });

  it("stops, naming SUPABASE_SECRET_KEY, when only the legacy variable is set — and asks nothing", async () => {
    seen.length = 0;
    const r = await withDb(recordAll(), true, { SUPABASE_SERVICE_ROLE_KEY: JWT });
    expect(r.code).toBe(2);
    expect(r.out).toContain(
      "SUPABASE_SERVICE_ROLE_KEY (the legacy service_role JWT) is no longer read"
    );
    expect(r.out).toContain("set it as SUPABASE_SECRET_KEY");
    expect(r.out).not.toContain(JWT);
    expect(seen).toEqual([]);
  });

  it.each([
    ["the legacy JWT", JWT],
    ["a publishable key", ["sb", "publishable", "TESTONLYabcdefghijklmnop"].join("_")],
    ["a truncated secret key", ["sb", "secret", "abc"].join("_")],
  ])(
    "refuses %s under SUPABASE_SECRET_KEY without sending it or printing it",
    async (_l, key) => {
      seen.length = 0;
      const r = await withDb(recordAll(), true, { SUPABASE_SECRET_KEY: key });
      expect(r.code).toBe(2);
      expect(r.out).toContain(
        "SUPABASE_SECRET_KEY is not a Supabase secret key (sb_secret_…)"
      );
      expect(r.out).not.toContain(key);
      expect(seen).toEqual([]);
    }
  );

  it("says the key was refused (cannot check, exit 2) on 401 or 403 — never drift", async () => {
    for (const status of [401, 403]) {
      const r = await withDb(recordAll(), true, undefined, status);
      expect(r.code).toBe(2);
      expect(r.out).toContain(`the key was refused (HTTP ${status})`);
      expect(r.out).not.toContain(SECRET);
    }
  });

  it("requires the URL and the key", async () => {
    const r = await withDb(recordAll(), true, {});
    expect(r.code).toBe(2);
    expect(r.out).toContain("SUPABASE_URL and SUPABASE_SECRET_KEY are required");
  });
});
