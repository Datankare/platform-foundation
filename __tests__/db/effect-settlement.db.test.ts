/**
 * @jest-environment node
 */
/**
 * __tests__/db/effect-settlement.db.test.ts — an external call's ledger entry always ends
 * resolved (TASK-215, audit B-12; ADR-031 D7)
 *
 * Against Postgres: a pending entry past effects.pending_timeout_minutes is settled indeterminate
 * (a newer one, and another tenant's, untouched); an indeterminate one is listed for the operator
 * and raises effects.indeterminate; an operator's decision is recorded first and changes it once
 * (a second decision, or one on an unknown entry, is refused); the resolved entry is then the
 * retention rule's.
 */

const mockAlerts: { name: string; count?: number }[] = [];
jest.mock("@/platform/observability/alert", () => ({
  raiseAlert: (a: { name: string; count?: number }) => mockAlerts.push(a),
}));

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
import {
  listUnresolvedEffects,
  resolveIndeterminateEffect,
  settleStaleEffects,
} from "@/platform/agents/effect-settlement";
import { EFFECT_UNRESOLVED } from "@/platform/agents/external-effect";

const owner = <R extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  withOwnerTx("tenant-lifecycle", (tx) => tx.query<R>(sql, values));

dbDescribe("effect settlement (TASK-215, B-12)", () => {
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

  const effect = async (tenant: TestTenant, status: string, age: string) => {
    const id = randomUUID();
    await owner(
      `insert into effect_ledger (id, tenant_id, operation_id, effect_key, effect_type, idempotency_key, status, created_at)
       values ($1::uuid, $2, gen_random_uuid()::text, 'send-' || substr($1::uuid::text, 1, 8), 'sendMessage', gen_random_uuid()::text, $3, ${age})`,
      [id, tenant.id, status]
    );
    return id;
  };
  const statusOf = async (id: string) =>
    (
      await owner<{ status: string; error: string | null }>(
        "select status, error from effect_ledger where id = $1",
        [id]
      )
    ).rows[0];

  it("settles a stale pending entry as of unknown outcome; a new one and another tenant's stay; alerts while one waits", async () => {
    const stale = await effect(t, "pending", "now() - interval '3 hours'");
    const fresh = await effect(t, "pending", "now()");
    const theirs = await effect(other, "pending", "now() - interval '3 hours'");
    mockAlerts.length = 0;
    const r = await t.run(() => settleStaleEffects());
    expect(r.settled).toBe(1);
    expect(r.waiting).toBeGreaterThanOrEqual(1);
    expect(await statusOf(stale)).toEqual({
      status: "indeterminate",
      error: EFFECT_UNRESOLVED,
    });
    expect((await statusOf(fresh)).status).toBe("pending");
    expect((await statusOf(theirs)).status).toBe("pending");
    expect(mockAlerts.map((a) => a.name)).toEqual(["effects.indeterminate"]);
    // Listed for the operator, across tenants, oldest first.
    const listed = await listUnresolvedEffects(1000);
    expect(listed.some((e) => e.id === stale && e.tenantId === t.id)).toBe(true);
    expect(listed.some((e) => e.id === fresh)).toBe(false);
  });

  it("an operator's decision is recorded first and changes the entry once", async () => {
    const id = await effect(t, "indeterminate", "now() - interval '1 day'");
    const operatorId = await t.user("operator");
    const admin = {
      userId: operatorId,
      sub: operatorId,
      roleName: "super_admin",
      permissions: ["platform_operate"],
    };
    expect(
      await t.run(() => resolveIndeterminateEffect(admin, id, "took_effect"))
    ).toEqual({ ok: true, status: "confirmed" });
    expect((await statusOf(id)).status).toBe("confirmed");
    const audit = await owner<{ details: Record<string, unknown> }>(
      "select details from audit_log where action = 'admin_action' and details->>'type' = 'effect_resolved' and details->>'effectId' = $1 order by created_at",
      [id]
    );
    // Recorded before it changed (audited(): no record, no change), naming the call and the
    // decision, with nothing dropped.
    expect(
      audit.rows.map((r) => [
        r.details.decision,
        r.details.outcome,
        r.details.droppedKeys,
      ])
    ).toEqual([["took_effect", "attempted", undefined]]);
    expect(await t.run(() => resolveIndeterminateEffect(admin, id, "no_effect"))).toEqual(
      {
        ok: false,
        code: "effects.not_indeterminate",
      }
    );
    expect(
      await t.run(() => resolveIndeterminateEffect(admin, randomUUID(), "no_effect"))
    ).toEqual({
      ok: false,
      code: "effects.not_found",
    });
    const failed = await effect(t, "indeterminate", "now()");
    expect(
      await t.run(() => resolveIndeterminateEffect(admin, failed, "no_effect"))
    ).toEqual({ ok: true, status: "failed" });
    expect((await statusOf(failed)).status).toBe("failed");
  });
});
