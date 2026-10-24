/**
 * @jest-environment node
 */
/**
 * Config impact reports against the replayed database (platform/admin/config-impact.ts): the
 * counts Postgres aggregates — per action, per window, per content rating level — and only the
 * current tenant's screenings.
 */

import { generateImpactReport } from "@/platform/admin/config-impact";
import type { ConfigHistoryRecord } from "@/platform/admin/types";
import { withTenantTx } from "@/platform/data";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

const CHANGED_AT = "2026-04-20T12:00:00.000Z";
const NOW = "2026-04-22T12:00:00.000Z";

function change(configKey: string): ConfigHistoryRecord {
  return {
    id: "hist-1",
    configKey,
    previousValue: "medium",
    newValue: "high",
    changedBy: "admin-1",
    changeComment: "c",
    changeSource: "admin_ui",
    createdAt: CHANGED_AT,
    scope: "tenant",
  };
}

/** Screenings at `at`, `n` of each action given, at a rating level. */
async function screen(
  tenant: TestTenant,
  at: string,
  level: number,
  actions: Partial<Record<"allow" | "block" | "warn" | "escalate", number>>
): Promise<void> {
  await tenant.run(() =>
    withTenantTx(async (tx) => {
      for (const [action, n] of Object.entries(actions)) {
        await tx.query(
          `insert into content_safety_audit
             (input_hash, content_rating_level, action_taken, trajectory_id, agent_id, request_id, created_at)
           select md5(random()::text), $1, $2::moderation_action, 't', 'a', 'r', $3::timestamptz
             from generate_series(1, $4::int)`,
          [level, action, at, n]
        );
      }
    })
  );
}

dbDescribe("config impact reports", () => {
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    b = await createTestTenant();
    // Before the change (inside the 7-day window), level 2: 20 screenings, 5 blocked, 2 warned.
    await screen(a, "2026-04-19T12:00:00Z", 2, { allow: 13, block: 5, warn: 2 });
    // Before, level 1 — counted only for keys that are not level-specific.
    await screen(a, "2026-04-19T13:00:00Z", 1, { allow: 10, escalate: 3 });
    // Older than the 7-day baseline: never counted.
    await screen(a, "2026-04-01T00:00:00Z", 2, { block: 50 });
    // After, level 2: 20 screenings, 1 blocked.
    await screen(a, "2026-04-21T12:00:00Z", 2, { allow: 19, block: 1 });
    // Exactly at the change: the after window (created_at >= change).
    await screen(a, CHANGED_AT, 2, { allow: 1 });
    // Another tenant's screenings in the same windows: never counted for a.
    await screen(b, "2026-04-19T12:00:00Z", 2, { block: 100 });
    await screen(b, "2026-04-21T12:00:00Z", 2, { block: 100 });
  });

  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  it("counts each action per window, for the key's level, exactly", async () => {
    const report = await a.run(() =>
      generateImpactReport(change("moderation.level2.block_severity"), NOW)
    );
    expect(report.before).toEqual({
      totalScreenings: 20,
      blockCount: 5,
      warnCount: 2,
      allowCount: 13,
      escalateCount: 0,
      blockRate: 0.25,
      warnRate: 0.1,
      truncated: false,
    });
    expect(report.after).toMatchObject({
      totalScreenings: 21,
      blockCount: 1,
      allowCount: 20,
    });
    expect(report.summary).toContain("decreased");
  });

  it("counts every level for a key that is not level-specific", async () => {
    const report = await a.run(() =>
      generateImpactReport(change("moderation.strike_warn_threshold"), NOW)
    );
    expect(report.before).toMatchObject({ totalScreenings: 33, escalateCount: 3 });
  });

  it("counts only the current tenant's screenings", async () => {
    const report = await b.run(() =>
      generateImpactReport(change("moderation.level2.block_severity"), NOW)
    );
    expect(report.before).toMatchObject({ totalScreenings: 100, blockCount: 100 });
    expect(report.after).toMatchObject({ totalScreenings: 100, blockCount: 100 });
  });

  it("an empty window is empty, not an error", async () => {
    const report = await a.run(() =>
      generateImpactReport(change("moderation.level3.block_severity"), NOW)
    );
    expect(report.before.totalScreenings).toBe(0);
    expect(report.summary).toContain("Insufficient data");
  });

  it("without a tenant it reads nothing (and reports no data rather than failing)", async () => {
    const report = await generateImpactReport(
      change("moderation.level2.block_severity"),
      NOW
    );
    expect(report.before.totalScreenings).toBe(0);
    expect(report.after.totalScreenings).toBe(0);
  });
});
