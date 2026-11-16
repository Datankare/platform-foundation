/**
 * @jest-environment node
 */
/**
 * __tests__/db/worker-database.db.test.ts — a database suite runs on its worker's own copy (TASK-218)
 *
 * @not-guard: checks at run time, on the database, what __tests__/db-isolation.test.ts checks in
 * the configuration: that this suite is connected to its jest worker's copy (helpers/db-workers.ts)
 * as app_tenant and as the owner, and that a catalogue row it writes is seen by no other database —
 * neither the one the copies were made from nor another worker's — and that a jest run started
 * inside this one (as __tests__/env-isolation.test.ts starts one) makes and drops copies of its
 * own and leaves this run's in place (TASK-219: before, its teardown dropped every copy of the
 * live run, CI run 43722156950).
 *
 * TASK-223: and that no copy outlives its run unseen — this run's copies carry its mark; a nested
 * run killed after its setup made its copy (as batch 56d-3's stopped gate was) leaves it behind,
 * and the next setup on the database drops it, while a live run's copy and an unmarked database
 * are left alone; a nested run that leaves a scratch database beside its copy fails at teardown.
 */
import { spawn, spawnSync } from "child_process";
import { hostname } from "os";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "pg";
import { dbDescribe } from "../helpers/db";
import {
  BASE_OWNER_URL_ENV,
  copyDatabase,
  copyMark,
  databaseLevel,
  databaseOf,
  markCopy,
  readCopyMark,
  reclaimKilledCopies,
  remainingCopies,
  runDatabases,
  withDatabase,
  WORKERS_ENV,
  type WorkerDatabases,
} from "../helpers/db-workers";

/** A session on the server's maintenance database, as the owner. */
const admin = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({
    connectionString: withDatabase(process.env[BASE_OWNER_URL_ENV]!, "postgres"),
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};

/**
 * copyDatabase's check: a scratch template with database-level settings, copied, the copy's the
 * same. Its scratch databases are named after this worker's copy (<copy>_src, _dst).
 */
async function copyDatabaseKeepsDatabaseLevel(mine: () => string): Promise<void> {
  const c = new Client({
    connectionString: withDatabase(process.env[BASE_OWNER_URL_ENV]!, "postgres"),
  });
  await c.connect();
  const src = `${mine()}_src`;
  const dst = `${mine()}_dst`;
  try {
    // A worker restarted part-way through this file (jest's idle-memory restart can stop one
    // just after the next file starts) runs it again: what the stopped attempt made goes first.
    for (const name of [dst, src])
      await c.query(`drop database if exists "${name}" with (force)`);
    await c.query(`create database "${src}" template template0`);
    await c.query(`revoke temporary on database "${src}" from public`);
    await c.query(`grant create on database "${src}" to app_tenant with grant option`);
    await c.query(`alter database "${src}" set search_path to public, extensions`);
    await c.query(
      `alter role app_tenant in database "${src}" set statement_timeout to '5s'`
    );
    await copyDatabase(c, src, dst);
    const got = await databaseLevel(c, dst);
    expect(got).toEqual(await databaseLevel(c, src));
    expect(got.settings).toEqual([
      "(all) search_path=public, extensions",
      "app_tenant statement_timeout=5s",
    ]);
    expect(got.privileges).toEqual(
      expect.arrayContaining(["PUBLIC CONNECT", "app_tenant CREATE WITH GRANT OPTION"])
    );
    expect(got.privileges).not.toContain("PUBLIC TEMPORARY");
  } finally {
    await c.query(`drop database if exists "${dst}" with (force)`);
    await c.query(`drop database if exists "${src}" with (force)`);
    await c.end();
  }
}

dbDescribe("each jest worker has a database of its own (TASK-218)", () => {
  const workers = () => JSON.parse(process.env[WORKERS_ENV] ?? "{}") as WorkerDatabases;
  const mine = () => workers().names[process.env.JEST_WORKER_ID ?? "1"];

  const ask = async (url: string, sql: string, params: unknown[] = []) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return (await c.query(sql, params)).rows;
    } finally {
      await c.end();
    }
  };

  it("connects as app_tenant and as the owner to this worker's copy, not the database it copies", async () => {
    expect(mine()).toMatch(/_w\d+_/);
    expect(mine()).not.toBe(workers().base);
    for (const url of [
      process.env.TEST_DATABASE_URL!,
      process.env.TEST_DATABASE_OWNER_URL!,
    ]) {
      expect(databaseOf(url)).toBe(mine());
      const [row] = await ask(url, "select current_database() as db");
      expect(row.db).toBe(mine());
    }
  });

  it("the copy has the database's own owner, privileges and settings (049's TEMPORARY revoked)", async () => {
    const c = new Client({
      connectionString: withDatabase(process.env[BASE_OWNER_URL_ENV]!, "postgres"),
    });
    await c.connect();
    try {
      const base = await databaseLevel(c, workers().base);
      expect(await databaseLevel(c, mine())).toEqual(base);
      expect(
        base.privileges.filter((p) => /^(?:PUBLIC|app_tenant) TEMPORARY/.test(p))
      ).toEqual([]);
    } finally {
      await c.end();
    }
  });

  it("copyDatabase gives a copy its template's owner, privileges and per-database settings, or fails", async () => {
    await copyDatabaseKeepsDatabaseLevel(mine);
  });

  it("an attempt stopped part-way (its scratch databases left) does not fail the file run again", async () => {
    await admin(async (c) => {
      for (const name of [`${mine()}_src`, `${mine()}_dst`])
        await c.query(`create database "${name}" template template0`);
    });
    await copyDatabaseKeepsDatabaseLevel(mine);
  });

  it("a catalogue row written here is in no other database while the suites run", async () => {
    const key = `isolation.${process.pid}.${Date.now()}`;
    const owner = process.env.TEST_DATABASE_OWNER_URL!;
    await ask(
      owner,
      `insert into platform_config (key, value, default_value, description, category, value_type, permission_tier, tenant_overridable)
       values ($1, '1'::jsonb, '1'::jsonb, 'isolation', 'test', 'number', 'standard', true)`,
      [key]
    );
    try {
      const others = [
        workers().base,
        ...Object.values(workers().names).filter((n) => n !== mine()),
      ];
      for (const db of others) {
        const rows = await ask(
          withDatabase(process.env[BASE_OWNER_URL_ENV]!, db),
          "select 1 from platform_config where key = $1",
          [key]
        );
        expect([db, rows.length]).toEqual([db, 0]);
      }
      expect(
        await ask(owner, "select 1 from platform_config where key = $1", [key])
      ).toHaveLength(1);
    } finally {
      await ask(owner, "delete from platform_config where key = $1", [key]);
    }
  });
  it("a jest run started inside this one makes and drops its own copies, and leaves this run's in place (TASK-219)", async () => {
    const run = workers();
    const dir = mkdtempSync(join(tmpdir(), "nested-run-"));
    const out = join(dir, "probe.json");
    try {
      const root = join(__dirname, "..", "..");
      const child = spawnSync(
        process.execPath,
        [
          join(root, "node_modules", "jest", "bin", "jest.js"),
          "--runTestsByPath",
          __filename,
          "-t",
          "probe: the database a nested run is given",
          "--coverage=false",
          "--silent",
        ],
        {
          cwd: root,
          env: { ...process.env, WORKER_DB_PROBE_OUT: out },
          encoding: "utf8",
          timeout: 120_000,
        }
      );
      expect({
        status: child.status,
        err: child.status === 0 ? "" : child.stderr,
      }).toEqual({
        status: 0,
        err: "",
      });
      const probe = JSON.parse(readFileSync(out, "utf8")) as {
        db: string;
        owner: number;
        names: string[];
      };
      // Its own copy, made by its own process — not one of this run's, not the original.
      expect(probe.owner).not.toBe(run.owner);
      expect(Object.values(run.names)).not.toContain(probe.db);
      expect(probe.db).not.toBe(run.base);
      expect(probe.names).toContain(probe.db);
      const c = new Client({
        connectionString: withDatabase(process.env[BASE_OWNER_URL_ENV]!, "postgres"),
      });
      await c.connect();
      try {
        const { rows } = await c.query<{ datname: string }>(
          "select datname from pg_database where datname = any($1)",
          [[...Object.values(run.names), ...probe.names]]
        );
        const present = rows.map((r) => r.datname).sort();
        // This run's copies all stand; the nested run's are gone with it.
        expect(present).toEqual([...Object.values(run.names)].sort());
      } finally {
        await c.end();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);

  it("probe: the database a nested run is given", async () => {
    const out = process.env.WORKER_DB_PROBE_OUT;
    if (!out) return; // only in the nested runs above and below
    const nested = runDatabases()!;
    const [row] = await ask(
      process.env.TEST_DATABASE_URL!,
      "select current_database() as db"
    );
    writeFileSync(
      out,
      JSON.stringify({
        db: row.db,
        owner: nested.owner,
        names: Object.values(nested.names),
      })
    );
    // TASK-223: a run killed mid-way (the test above kills it while it waits here) …
    if (process.env.WORKER_DB_PROBE_HANG === "1")
      await new Promise((r) => setTimeout(r, 120_000));
    // … and a run that leaves a scratch database beside its copy.
    if (process.env.WORKER_DB_PROBE_LEAVE === "1")
      await admin(async (c) => {
        await c.query(`create database "${row.db}_left" template template0`);
      });
  }, 150_000);
});

dbDescribe("no copy outlives its run unseen (TASK-223)", () => {
  const workers = () => JSON.parse(process.env[WORKERS_ENV] ?? "{}") as WorkerDatabases;

  const comment = (c: Client, name: string) =>
    c
      .query<{ mark: string | null }>(
        "select shobj_description(oid, 'pg_database') as mark from pg_database where datname = $1",
        [name]
      )
      .then((r) => r.rows[0]?.mark ?? null);

  it("this run's copies carry its mark: its run, its owning process, this host", async () => {
    const run = workers();
    await admin(async (c) => {
      for (const name of Object.values(run.names)) {
        const mark = readCopyMark(await comment(c, name));
        expect(mark).toEqual({
          run: expect.any(String),
          pid: run.owner,
          host: hostname(),
        });
        expect(name.endsWith(`_${mark!.run}`)).toBe(true);
      }
    });
  });

  it("a killed run's copies are dropped by the next setup; a live run's, another host's and an unmarked database are not", async () => {
    const base = workers().base;
    // A process that has ended: its pid is no longer running.
    const ended = spawnSync(process.execPath, ["-e", "0"]).pid!;
    const plant = (tag: string) => `${base}_w9_${tag}${process.pid}`;
    const killed = plant("killed");
    const live = plant("live");
    const elsewhere = plant("elsewhere");
    const unmarked = plant("unmarked");
    const scratch = `${killed}_src`;
    await admin(async (c) => {
      try {
        for (const name of [killed, live, elsewhere, unmarked, scratch])
          await c.query(`create database "${name}" template template0`);
        await markCopy(c, killed, "killed", ended);
        await markCopy(c, live, "live", process.pid);
        await markCopy(c, elsewhere, "elsewhere", ended, "another-host");
        const dropped = await reclaimKilledCopies(c, base);
        expect(dropped.sort()).toEqual([killed, scratch].sort());
        const { rows } = await c.query<{ name: string }>(
          "select datname as name from pg_database where datname = any($1)",
          [[killed, live, elsewhere, unmarked, scratch]]
        );
        expect(rows.map((r) => r.name).sort()).toEqual(
          [elsewhere, live, unmarked].sort()
        );
      } finally {
        for (const name of [scratch, killed, live, elsewhere, unmarked])
          await c.query(`drop database if exists "${name}" with (force)`);
      }
    });
  });

  it("a copy someone is connected to is not reclaimed, even if its owner is gone", async () => {
    const base = workers().base;
    const ended = spawnSync(process.execPath, ["-e", "0"]).pid!;
    const name = `${base}_w9_inuse${process.pid}`;
    await admin(async (c) => {
      try {
        await c.query(`create database "${name}" template template0`);
        await c.query(
          `comment on database "${name}" is '${copyMark("inuse", ended, hostname())}'`
        );
        const holder = new Client({
          connectionString: withDatabase(process.env[BASE_OWNER_URL_ENV]!, name),
        });
        await holder.connect();
        try {
          expect(await reclaimKilledCopies(c, base)).not.toContain(name);
        } finally {
          await holder.end();
        }
      } finally {
        await c.query(`drop database if exists "${name}" with (force)`);
      }
    });
  });

  it("remainingCopies names a run's copies still there, and a scratch database beside one", async () => {
    const mine = workers().names[process.env.JEST_WORKER_ID ?? "1"];
    await admin(async (c) => {
      const scratch = `${mine}_left`;
      try {
        await c.query(`create database "${scratch}" template template0`);
        expect(await remainingCopies(c, [mine])).toEqual([mine, scratch].sort());
        expect(await remainingCopies(c, [`${mine}_nothing`])).toEqual([]);
        expect(await remainingCopies(c, [])).toEqual([]);
      } finally {
        await c.query(`drop database if exists "${scratch}" with (force)`);
      }
    });
  });

  const nested = (probe: Record<string, string>) =>
    spawn(
      process.execPath,
      [
        join(__dirname, "..", "..", "node_modules", "jest", "bin", "jest.js"),
        "--runTestsByPath",
        __filename,
        "-t",
        "probe: the database a nested run is given",
        "--coverage=false",
        "--silent",
      ],
      { cwd: join(__dirname, "..", ".."), env: { ...process.env, ...probe } }
    );

  it("a run killed after its setup leaves its copy — marked as its own — and the next setup drops it (the 56d-3 leftover)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "killed-run-"));
    const out = join(dir, "probe.json");
    const child = nested({ WORKER_DB_PROBE_OUT: out, WORKER_DB_PROBE_HANG: "1" });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    try {
      // Its setup has made its copy, and its probe is running on it.
      const deadline = Date.now() + 90_000;
      while (!existsSync(out)) {
        if (Date.now() > deadline || child.exitCode !== null)
          throw new Error(`the nested run did not start: ${stderr}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      const probe = JSON.parse(readFileSync(out, "utf8")) as {
        names: string[];
        owner: number;
      };
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
      await admin(async (c) => {
        const left = await remainingCopies(c, probe.names);
        expect(left).toEqual(probe.names);
        expect(readCopyMark(await comment(c, probe.names[0]))?.pid).toBe(probe.owner);
        // The next setup on this database: the killed run's copy is dropped.
        const dropped = await reclaimKilledCopies(c, workers().base);
        expect(dropped).toEqual(expect.arrayContaining(probe.names));
        expect(await remainingCopies(c, probe.names)).toEqual([]);
      });
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);

  it("a run that leaves a scratch database beside its copy fails at its teardown, naming it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leaving-run-"));
    const out = join(dir, "probe.json");
    try {
      const child = spawnSync(
        process.execPath,
        [
          join(__dirname, "..", "..", "node_modules", "jest", "bin", "jest.js"),
          "--runTestsByPath",
          __filename,
          "-t",
          "probe: the database a nested run is given",
          "--coverage=false",
          "--silent",
        ],
        {
          cwd: join(__dirname, "..", ".."),
          env: { ...process.env, WORKER_DB_PROBE_OUT: out, WORKER_DB_PROBE_LEAVE: "1" },
          encoding: "utf8",
          timeout: 120_000,
        }
      );
      const probe = JSON.parse(readFileSync(out, "utf8")) as { db: string };
      expect(child.status).not.toBe(0);
      expect(child.stderr).toMatch(/not all gone after its teardown/);
      expect(child.stderr).toContain(`${probe.db}_left`);
      await admin(async (c) => {
        await c.query(`drop database if exists "${probe.db}_left" with (force)`);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);
});
