/**
 * @jest-environment node
 */
/**
 * __tests__/db/session-run-orphans.db.test.ts — an app session's runs end with it, even one opened
 * while it was being deleted (TASK-215, audit B-5)
 *
 * Against Postgres: deleting a session deletes its runs (migration 073's trigger); data.retention's
 * own rule, run on a session idle past retention.app_sessions_days, ends the session and its runs
 * together, never a session still in use; a run of a session that no longer exists — a race's, committed after the trigger ran — is deleted by
 * data.retention once it is an hour old (deleteOrphanedSessionRuns), never a younger one, never a
 * run whose session exists, never another tenant's.
 */

import { randomUUID } from "node:crypto";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";
import { withOwnerTx } from "@/platform/data";
import { applyRetention, deleteOrphanedSessionRuns } from "@/platform/jobs/retention";

const owner = <R extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  withOwnerTx("tenant-lifecycle", (tx) => tx.query<R>(sql, values));

dbDescribe("an app session's runs end with it (TASK-215, B-5)", () => {
  let t: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    await connectTestDatabase();
    t = await createTestTenant();
    other = await createTestTenant();
  });

  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  const session = async (tenant: TestTenant, idle = "now()"): Promise<string> => {
    const id = `s-${randomUUID()}`;
    await owner(
      `insert into app_sessions (id, tenant_id, state, created_at, updated_at)
       values ($1, $2, '{}'::jsonb, ${idle}, ${idle})`,
      [id, tenant.id]
    );
    return id;
  };
  const run = async (
    tenant: TestTenant,
    sessionId: string,
    age: string
  ): Promise<string> => {
    const id = randomUUID();
    await owner(
      `insert into agent_trajectories (id, tenant_id, trigger, subject_kind, subject_id, scope_type, steps, status, created_at, updated_at)
       values ($1::uuid, $2, 'session', 'session', $3, 'user', '[]'::jsonb, 'running', ${age}, ${age})`,
      [id, tenant.id, sessionId]
    );
    return id;
  };
  const exists = async (id: string): Promise<boolean> =>
    (await owner("select 1 from agent_trajectories where id = $1::uuid", [id])).rows
      .length === 1;

  it("deleting a session deletes its runs, whatever deletes it", async () => {
    const s = await session(t);
    const r = await run(t, s, "now()");
    await owner("delete from app_sessions where id = $1", [s]);
    expect(await exists(r)).toBe(false);
  });

  it("data.retention ends a session idle past its bound together with its runs; one in use stays with its runs", async () => {
    const idle = await session(t, "now() - interval '400 days'");
    const idleRun = await run(t, idle, "now() - interval '400 days'");
    const used = await session(t);
    const usedRun = await run(t, used, "now() - interval '400 days'");

    await t.run(() => applyRetention());

    const left = await owner<{ id: string }>(
      "select id from app_sessions where id = any($1::text[])",
      [[idle, used]]
    );
    expect(left.rows.map((r) => r.id)).toEqual([used]);
    expect(await exists(idleRun)).toBe(false);
    expect(await exists(usedRun)).toBe(true);
  });

  it("[hostile] a run left by a race with its session's delete goes an hour on; nothing else does", async () => {
    const live = await session(t);
    const kept = await run(t, live, "now() - interval '2 hours'");
    const orphanOld = await run(t, `gone-${randomUUID()}`, "now() - interval '2 hours'");
    const orphanNew = await run(
      t,
      `gone-${randomUUID()}`,
      "now() - interval '5 minutes'"
    );
    const othersOrphan = await run(
      other,
      `gone-${randomUUID()}`,
      "now() - interval '2 hours'"
    );

    const r = await t.run(() => deleteOrphanedSessionRuns());
    expect(r).toEqual({ deleted: 1, more: false });
    expect(await exists(orphanOld)).toBe(false);
    expect(await exists(kept)).toBe(true);
    expect(await exists(orphanNew)).toBe(true);
    expect(await exists(othersOrphan)).toBe(true);
  });

  it("a full batch says there is more", async () => {
    await run(t, `gone-${randomUUID()}`, "now() - interval '3 hours'");
    await run(t, `gone-${randomUUID()}`, "now() - interval '3 hours'");
    expect(await t.run(() => deleteOrphanedSessionRuns(1))).toEqual({
      deleted: 1,
      more: true,
    });
  });
});
