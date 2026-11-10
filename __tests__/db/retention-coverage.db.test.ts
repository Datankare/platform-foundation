/**
 * @jest-environment node
 */
/**
 * __tests__/db/retention-coverage.db.test.ts — every table says how long its rows are kept, and
 * the retention job keeps to it (N-25, TASK-203)
 *
 * @guard a table with no retention rule and no stated reason to keep its rows
 *
 *   - Every table of the schema has an entry: the platform's in RETENTION_REGISTER
 *     (platform/jobs/retention.ts), an app's own in its platform/modules/app-manifest.json
 *     "retention". A new table without one fails here — as the user-data coverage test does for
 *     erasure — and an entry naming a table that does not exist fails too.
 *   - A rule applied by data.retention has its statement (RETENTION_RULES) and the reverse, and each
 *     rule's setting is seeded by a migration with the rule's default and bounds.
 *   - Against Postgres, in one tenant: old rows go (or lose their network identifiers), new rows
 *     stay, a content-safety decision a strike names stays, an unresolved effect stays, another
 *     tenant's old rows are untouched, and a full batch asks for a next part.
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
import {
  RETENTION_REGISTER,
  RETENTION_RULES,
  applyRetention,
} from "@/platform/jobs/retention";
import { listJobDefinitions } from "@/platform/jobs/registry";

const mm = require("../../scripts/module-manifest.cjs");

const owner = <R extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  withOwnerTx("tenant-lifecycle", (tx) => tx.query<R>(sql, values));

/** The tables of the schema nobody gives a retention entry. */
export function unretained(
  tables: readonly string[],
  platform: Readonly<Record<string, unknown>>,
  app: Readonly<Record<string, unknown>>
): string[] {
  return tables.filter((t) => !(t in platform) && !(t in app)).sort();
}

const appRetention = (): Record<string, string> => mm.loadManifest().retention ?? {};

dbDescribe("retention: every table has a rule or a reason (N-25)", () => {
  let tables: string[];

  beforeAll(async () => {
    await connectTestDatabase();
    tables = (
      await owner<{ t: string }>(
        `select c.relname as t from pg_class c
          where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
            and not c.relispartition
          order by 1`
      )
    ).rows.map((r) => r.t);
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it("every table of the schema has a retention entry", () => {
    expect(tables.length).toBeGreaterThan(30);
    expect(unretained(tables, RETENTION_REGISTER, appRetention())).toEqual([]);
  });

  it("every entry names a table that exists, and the platform and the app never both answer", () => {
    const present = new Set(tables);
    const app = appRetention();
    expect(
      [...Object.keys(RETENTION_REGISTER), ...Object.keys(app)].filter(
        (t) => !present.has(t)
      )
    ).toEqual([]);
    expect(Object.keys(app).filter((t) => t in RETENTION_REGISTER)).toEqual([]);
  });

  it("[self-test] a table nobody declares is reported", () => {
    expect(unretained(["users", "quiz_scores"], RETENTION_REGISTER, {})).toEqual([
      "quiz_scores",
    ]);
    expect(unretained(["quiz_scores"], RETENTION_REGISTER, { quiz_scores: "x" })).toEqual(
      []
    );
  });

  it("data.retention's rules and its register entries are the same tables, and the job exists", () => {
    const byJob = Object.entries(RETENTION_REGISTER)
      .filter(([, e]) => e.kind === "rule" && e.by === "data.retention")
      .map(([t]) => t)
      .sort();
    expect([...new Set(RETENTION_RULES.map((r) => r.table))].sort()).toEqual(byJob);
    const job = listJobDefinitions().find((j) => j.kind === "data.retention");
    expect(job?.runsForSuspended).toBe(true);
  });

  it("each rule's setting is seeded with the rule's default and bounds, operator-only", async () => {
    for (const r of RETENTION_RULES) {
      const { rows } = await owner<{
        default_value: unknown;
        min_value: unknown;
        max_value: unknown;
        tenant_overridable: boolean;
      }>(
        "select default_value, min_value, max_value, tenant_overridable from platform_config where key = $1",
        [r.setting]
      );
      expect([r.setting, rows.length]).toEqual([r.setting, 1]);
      expect([r.setting, Number(rows[0].default_value)]).toEqual([
        r.setting,
        r.defaultDays,
      ]);
      expect([r.setting, Number(rows[0].min_value)]).toEqual([r.setting, r.minDays]);
      expect([r.setting, Number(rows[0].max_value)]).toEqual([r.setting, r.maxDays]);
      expect(rows[0].tenant_overridable).toBe(false);
    }
  });
});

dbDescribe("retention: the data.retention job keeps to the rules (N-25)", () => {
  let t: TestTenant;
  let other: TestTenant;
  const OLD = "now() - interval '4000 days'";

  beforeAll(async () => {
    await connectTestDatabase();
    t = await createTestTenant();
    other = await createTestTenant();
  });

  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  /** One old and one new row of every rule's table in `tenant`; returns the ids by label. */
  async function seed(tenant: TestTenant): Promise<Record<string, string>> {
    const user = await tenant.user("retained");
    const ids: Record<string, string> = {};
    const add = async (label: string, sql: string, values: unknown[] = []) => {
      const id = randomUUID();
      await owner(sql, [id, tenant.id, ...values]);
      ids[label] = id;
    };
    // An interaction belongs to the user's AI context (its foreign key).
    await owner(
      "insert into user_ai_context (user_id, tenant_id) values ($1, $2) on conflict do nothing",
      [user, tenant.id]
    );
    for (const age of ["old", "new"] as const) {
      const at = age === "old" ? OLD : "now()";
      await add(
        `audit_${age}`,
        `insert into audit_log (id, tenant_id, action, ip_address, user_agent, created_at)
         values ($1, $2, 'admin_action', '10.0.0.1', 'agent', ${at})`
      );
      await add(
        `consent_${age}`,
        `insert into consent_records (id, tenant_id, user_id, consent_type, consent_version, granted,
                                      granted_at, ip_address, user_agent)
         values ($1, $2, $3::uuid, 'terms', 'v1', true, ${at}, '10.0.0.1', 'agent')`,
        [user]
      );
      await add(
        `interaction_${age}`,
        `insert into user_interactions (id, tenant_id, user_id, input, output, feature, created_at)
         values ($1, $2, $3, 'in', 'out', 'translate', ${at})`,
        [user]
      );
      await add(
        `metric_${age}`,
        `insert into ai_metrics (id, tenant_id, name, timestamp, created_at)
         values ($1, $2, 'ai.call', ${at}, ${at})`
      );
      await add(
        `safety_${age}`,
        `insert into content_safety_audit (id, tenant_id, input_hash, trajectory_id, agent_id, request_id, created_at)
         values ($1, $2, 'h', 't', 'guardian', 'r', ${at})`
      );
      await add(
        `effect_${age}`,
        `insert into effect_ledger (id, tenant_id, operation_id, effect_key, effect_type, idempotency_key,
                                    status, created_at, resolved_at)
         values ($1, $2, gen_random_uuid()::text, 'k', 'externalCall', gen_random_uuid()::text, 'confirmed', ${at}, ${at})`
      );
      await add(
        `guest_${age}`,
        `insert into guest_usage (guest_id, tenant_id, first_used_at, last_used_at)
         values ($1, $2, ${at}, ${at})`
      );
      await add(
        `session_${age}`,
        `insert into app_sessions (id, tenant_id, state, created_at, updated_at)
         values ($1, $2, '{}'::jsonb, ${at}, ${at})`
      );
      await add(
        `budget_${age}`,
        `insert into agent_budgets (id, tenant_id, agent_id, period, scope_type, created_at, updated_at)
         values ($1, $2, 'agent-' || gen_random_uuid()::text, '2016-01-01', 'platform', ${at}, ${at})`
      );
    }
    // Kept whatever its age: a decision a strike names, and an effect still unresolved.
    await add(
      "safety_struck",
      `insert into content_safety_audit (id, tenant_id, input_hash, trajectory_id, agent_id, request_id, created_at)
       values ($1, $2, 'h', 't', 'guardian', 'r', ${OLD})`
    );
    await owner(
      `insert into user_strikes (tenant_id, user_id, category, trajectory_id, agent_id, reason, moderation_audit_id)
       values ($1, $2::uuid, 'harassment', 't', 'sentinel', 'x', $3::uuid)`,
      [tenant.id, user, ids.safety_struck]
    );
    await add(
      "effect_pending",
      `insert into effect_ledger (id, tenant_id, operation_id, effect_key, effect_type, idempotency_key,
                                  status, created_at)
       values ($1, $2, gen_random_uuid()::text, 'k', 'externalCall', gen_random_uuid()::text, 'pending', ${OLD})`
    );
    return ids;
  }

  const exists = async (table: string, key: string, id: string) =>
    (
      await owner<{ n: number }>(
        `select count(*)::int as n from ${table} where ${key} = $1`,
        [id]
      )
    ).rows[0].n === 1;

  it("old rows go or lose their network identifiers; new, struck and unresolved rows stay; another tenant is untouched", async () => {
    const mine = await seed(t);
    const theirs = await seed(other);
    const run = await t.run(() => applyRetention());
    expect(run.more).toBe(false);

    const deleted: [string, string, string][] = [
      ["user_interactions", "id", "interaction"],
      ["ai_metrics", "id", "metric"],
      ["content_safety_audit", "id", "safety"],
      ["effect_ledger", "id", "effect"],
      ["guest_usage", "guest_id", "guest"],
      ["app_sessions", "id", "session"],
      ["agent_budgets", "id", "budget"],
    ];
    for (const [table, key, label] of deleted) {
      expect([table, await exists(table, `${key}::text`, mine[`${label}_old`])]).toEqual([
        table,
        false,
      ]);
      expect([table, await exists(table, `${key}::text`, mine[`${label}_new`])]).toEqual([
        table,
        true,
      ]);
      expect([
        table,
        await exists(table, `${key}::text`, theirs[`${label}_old`]),
      ]).toEqual([table, true]);
    }
    expect(await exists("content_safety_audit", "id::text", mine.safety_struck)).toBe(
      true
    );
    expect(await exists("effect_ledger", "id::text", mine.effect_pending)).toBe(true);

    for (const table of ["audit_log", "consent_records"]) {
      const label = table === "audit_log" ? "audit" : "consent";
      const read = async (id: string) =>
        (
          await owner<{ ip: string | null; ua: string | null }>(
            `select host(ip_address) as ip, user_agent as ua from ${table} where id = $1::uuid`,
            [id]
          )
        ).rows[0];
      // The record stays; only its network identifiers go.
      expect([table, await read(mine[`${label}_old`])]).toEqual([
        table,
        { ip: null, ua: null },
      ]);
      expect([table, (await read(mine[`${label}_new`])).ip]).toEqual([table, "10.0.0.1"]);
      expect([table, (await read(theirs[`${label}_old`])).ip]).toEqual([
        table,
        "10.0.0.1",
      ]);
    }
  });

  it("a full batch asks for a next part", async () => {
    await seed(t);
    const run = await t.run(() => applyRetention(undefined, 1));
    expect(run.more).toBe(true);
  });

  it("stops between rules when its time is up", async () => {
    const c = new AbortController();
    c.abort();
    const run = await t.run(() => applyRetention(c.signal));
    expect(run).toEqual({ changed: {}, more: true });
  });
});
