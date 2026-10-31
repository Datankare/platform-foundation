/**
 * @jest-environment node
 */
/**
 * Erasure and export cover every table that holds a user's data (audit X-15, E-7, E-8, RR-23),
 * against the replayed database.
 *
 *   - Every table of the schema is classified: in the register (platform/auth/user-data.ts) or in
 *     NO_USER_DATA with its reason. A new table that is neither fails here, so it cannot hold
 *     users' data the erasure does not know about. An app inherits this test unchanged: its own
 *     tables are classified by its own declarations (helpers/user-data-classification.ts — its
 *     deletion modules' tables, its app manifest's noUserData), and an app table it does not
 *     declare fails here too.
 *   - The deletion manifest names the register's tables, and no table that does not exist (E-7).
 *   - A user with rows in every register table is erased: afterwards no row of any table still
 *     names them, the rows kept are anonymised, another user's rows are untouched, and nothing
 *     is left half-done (one transaction).
 *   - An export holds every exported section, and is refused whole when a part cannot be read.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { randomUUID } from "node:crypto";
import { withOwnerTx, withTenantTx } from "@/platform/data";
import {
  NO_USER_DATA,
  NO_USER_DATA_COLUMNS,
  USER_DATA_TABLES,
  eraseUserData,
} from "@/platform/auth/user-data";
import {
  ADDRESS_REPLACEMENTS,
  hardPurgeUser,
  softDeleteUser,
} from "@/platform/auth/gdpr-deletion";
import { exportUserData, registerExportModule } from "@/platform/auth/data-export";
import { exportUserTables } from "@/platform/auth/user-data";
import { createPlatformPurgePipeline } from "@/platform/gdpr";
import { getDeletionModules } from "@/platform/auth/gdpr-deletion";
import {
  appManifestTables,
  declaredButAbsent,
  isAppColumn,
  unclassifiedTables,
  type Declarations,
} from "../helpers/user-data-classification";

const mm = require("../../scripts/module-manifest.cjs");

/** What the platform and the app declare (the app's deletion manifest rows read from the DB). */
async function declarations(t: TestTenant): Promise<Declarations> {
  const rows = (await sql(
    t,
    "select module_name, table_names from deletion_manifest"
  )) as {
    module_name: string;
    table_names: string[];
  }[];
  return {
    platformTables: new Set([
      ...USER_DATA_TABLES.map((e) => e.table),
      ...Object.keys(NO_USER_DATA),
    ]),
    appErased: new Set([
      ...appManifestTables(rows),
      ...getDeletionModules().flatMap((m) => m.tables),
    ]),
    appNoUserData: new Set(Object.keys(mm.loadManifest().noUserData ?? {})),
  };
}
import {
  DB_ENABLED,
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

type Row = Record<string, unknown>;
const SUITE = "user data: erasure and export cover every table (Postgres)";

async function sql(t: TestTenant, text: string, values: unknown[] = []): Promise<Row[]> {
  return t.run(() => withTenantTx(async (tx) => (await tx.query(text, values)).rows));
}

/** Rows naming `user`, per register entry. */
async function remaining(t: TestTenant, user: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const entry of USER_DATA_TABLES) {
    const [r] = await sql(t, entry.count, [user]);
    out[entry.name] = r.n as number;
  }
  return out;
}

/** One row of the user's in every register table the tests may write. */
async function seed(t: TestTenant, user: string, other: string): Promise<void> {
  const g = randomUUID();
  const statements: [string, unknown[]][] = [
    [
      `insert into review_queue (source, moderation_result, target_user_id, request_id)
       values ('escalation', '{}'::jsonb, $1::uuid, 'r1')`,
      [user],
    ],
    // The user reviewed another account's case.
    [
      `insert into review_queue (source, moderation_result, target_user_id, request_id,
                                 status, claimed_by, resolved_by, decision)
       values ('escalation', '{}'::jsonb, $2::uuid, 'r2', 'resolved', $1, $1, 'uphold')`,
      [user, other],
    ],
    [
      `insert into user_strikes (user_id, category, trajectory_id, agent_id, reason)
       values ($1::uuid, 'harassment', 't', 'sentinel', 'x')`,
      [user],
    ],
    [
      `insert into user_feature_restrictions (user_id, feature, created_by)
       values ($1::uuid, 'stream', 'admin')`,
      [user],
    ],
    [
      `insert into user_feature_restrictions (user_id, feature, created_by)
       values ($2::uuid, 'stream', $1)`,
      [user, other],
    ],
    [
      `insert into content_safety_audit (input_hash, trajectory_id, agent_id, request_id, user_id)
       values ('h', 't', 'guardian', 'r', $1)`,
      [user],
    ],
    [`insert into user_ai_context (user_id) values ($1)`, [user]],
    [
      `insert into app_sessions (id, state, version, meta)
       values ('s-own-' || $1::text, '{}'::jsonb, 1,
               jsonb_build_object('participants', jsonb_build_array(jsonb_build_object('actorId', $1::text))))`,
      [user],
    ],
    [
      `insert into app_sessions (id, state, version, meta)
       values ('s-shared-' || $1::text, '{}'::jsonb, 1,
               jsonb_build_object('participants', jsonb_build_array(
                 jsonb_build_object('actorId', $1::text), jsonb_build_object('actorId', $2::text))))`,
      [user, other],
    ],
    [
      `insert into user_interactions (user_id, input, output, feature) values ($1, 'i', 'o', 'f')`,
      [user],
    ],
    [
      `insert into proposals (operation_id, session_id, trajectory_id, label, actor_id,
                              actor_role, effective_risk, actor_identity)
       values ('op1', 's', 't', 'x', 'agent-1', 'agent', 'restricted',
               jsonb_build_object('actorId', 'agent-1', 'onBehalfOf', $1::text))`,
      [user],
    ],
    [
      `insert into proposals (operation_id, session_id, trajectory_id, label, actor_id,
                              actor_role, effective_risk, decided_by, status)
       values ('op2', 's', 't', 'x', $2, 'user', 'restricted', $1, 'approved')`,
      [user, other],
    ],
    [
      `insert into agent_trajectories (trigger, subject_kind, subject_id, scope_type, scope_id)
       values ('x', 'agent', 'a', 'user', $1)`,
      [user],
    ],
    [
      `insert into agent_budgets (agent_id, period, scope_type, scope_id)
       values ('a', 'day', 'user', $1)`,
      [user],
    ],
    [
      `insert into ai_metrics (name, "timestamp", tags)
       values ('m', now(), jsonb_build_object('userId', $1::text))`,
      [user],
    ],
    [
      `insert into document_embeddings (chunk_id, document_id, content, scope_key)
       values ('c', 'd', 'text', 'kb::userId=' || $1::text)`,
      [user],
    ],
    [
      `insert into rate_limit_events (bucket) values ('ai:per-user:actor:' || $1::text)`,
      [user],
    ],
    [
      `insert into groups (id, name, owner_id) values ($2::uuid, 'Test group', $1::uuid)`,
      [user, g],
    ],
    [
      `insert into group_memberships (group_id, user_id) values ($2::uuid, $1::uuid)`,
      [user, g],
    ],
    [
      `insert into group_invites (group_id, inviter_id, invitee_id)
       values ($2::uuid, $1::uuid, $3::uuid)`,
      [user, g, other],
    ],
    [
      `insert into consent_records (user_id, consent_type, consent_version, granted, ip_address)
       values ($1::uuid, 'analytics', '1', true, '192.0.2.1')`,
      [user],
    ],
    [`insert into user_devices (user_id, device_id) values ($1::uuid, 'dev')`, [user]],
    [`insert into password_policy (user_id) values ($1::uuid)`, [user]],
    [
      `insert into audit_log (action, actor_id, target_id, ip_address, user_agent)
       values ('login_success', $1::uuid, $1::uuid, '192.0.2.1', 'jest')`,
      [user],
    ],
    // Review 7 M4: the user, as a moderator, changed another account's standing.
    [`update users set status_changed_by = $1 where id = $2::uuid`, [user, other]],
    // An app session's runs (scope 'user', no scope id): the user's own session's, and the
    // shared one's, naming the user in a step.
    [
      `insert into agent_trajectories (trigger, subject_kind, subject_id, scope_type, steps)
       values ('session-created', 'session', 's-own-' || $1::text, 'user',
               jsonb_build_array(jsonb_build_object('actor', jsonb_build_object('actorId', $1::text)))),
              ('session-created', 'session', 's-shared-' || $1::text, 'user',
               jsonb_build_array(jsonb_build_object('actor', jsonb_build_object('actorId', $1::text)),
                                 jsonb_build_object('actor', jsonb_build_object('actorId', $2::text))))`,
      [user, other],
    ],
    // Review 8 M3: another account's records that mention the user — a case, a remembered
    // context, a session, an audit entry.
    [
      `insert into review_queue (source, moderation_result, target_user_id, request_id, explanation_chain)
       values ('escalation', jsonb_build_object('participant', $1::text), $2::uuid, 'r3',
               jsonb_build_array(jsonb_build_object('note', 'reported by ' || $1::text)))`,
      [user, other],
    ],
    [
      `insert into user_ai_context (user_id, preferences, patterns)
       values ($2, jsonb_build_object('friend', $1::text), array['plays with ' || $1::text])`,
      [user, other],
    ],
    [
      `insert into app_sessions (id, state, version, meta)
       values ('s-mention-' || $1::text, jsonb_build_object('invited', $1::text), 1,
               jsonb_build_object('participants', jsonb_build_array(jsonb_build_object('actorId', $2::text))))`,
      [user, other],
    ],
    [
      `insert into audit_log (action, actor_id, details)
       values ('admin_action', $2::uuid, jsonb_build_object('type', 'x', 'about', $1::text))`,
      [user, other],
    ],
    // Held and decided actions another account proposed about the user.
    [
      `insert into proposals (operation_id, session_id, trajectory_id, label, actor_id,
                              actor_role, effective_risk, payload, status)
       values ('op3', 's', 't', 'change_user_role', 'command-bar', 'agent', 'restricted',
               jsonb_build_object('user_identifier', $1::text), 'proposed'),
              ('op4', 's', 't', 'change_user_role', 'command-bar', 'agent', 'restricted',
               jsonb_build_object('user_identifier', $1::text), 'executed')`,
      [user],
    ],
    // TASK-193: a held action about the user, and the run it holds (heldAboutTrajectories), and
    // staff free text about the user in an audit record (auditText).
    [
      `with run as (
         insert into agent_trajectories (trigger, status, subject_kind, subject_id, scope_type)
         values ('command-bar', 'paused', 'agent', 'command-bar', 'platform') returning id
       )
       insert into proposals (operation_id, session_id, trajectory_id, label, actor_id,
                              actor_role, effective_risk, payload, status)
       select 'op5', 's', run.id::text, 'change_user_role', 'command-bar', 'agent', 'restricted',
              jsonb_build_object('user_identifier', $1::text), 'proposed'
         from run`,
      [user],
    ],
    [
      `insert into audit_log (action, actor_id, target_id, details)
       values ('admin_action', $2::uuid, $1::uuid,
               jsonb_build_object('type', 'block_user_feature', 'feature', 'chat',
                                  'reason', 'posted her home address'))`,
      [user, other],
    ],
  ];
  for (const [text, values] of statements) await sql(t, text, values);
  // The entitlement catalog is platform-owned: a group is made on the owner connection.
  const group = randomUUID();
  await withOwnerTx("tenant-lifecycle", (tx) =>
    tx.query(
      "insert into entitlement_groups (id, code, display_name) values ($1::uuid, $2, 'Test')",
      [group, `test-${group}`]
    )
  );
  catalog.push(group);
  await sql(
    t,
    "insert into user_entitlements (user_id, entitlement_group_id) values ($1::uuid, $2::uuid)",
    [user, group]
  );
  await sql(
    t,
    "insert into user_entitlements (user_id, entitlement_group_id, granted_by, revoked_by) values ($1::uuid, $2::uuid, $3::uuid, $3::uuid)",
    [other, group, user]
  );
}

/**
 * A row of the other account's in every register table, so the hostile scan has a row that is
 * not the user's to write the user's id into (review 8 M3).
 */
async function seedOther(t: TestTenant, other: string): Promise<void> {
  const statements: [string, unknown[]][] = [
    [
      `insert into user_strikes (user_id, category, trajectory_id, agent_id, reason)
       values ($1::uuid, 'harassment', 't', 'sentinel', 'x')`,
      [other],
    ],
    [
      `insert into content_safety_audit (input_hash, trajectory_id, agent_id, request_id, user_id)
       values ('h', 't', 'guardian', 'r', $1)`,
      [other],
    ],
    [
      `insert into user_interactions (user_id, input, output, feature) values ($1, 'i', 'o', 'f')`,
      [other],
    ],
    [
      `insert into agent_budgets (agent_id, period, scope_type, scope_id) values ('a', 'day', 'user', $1)`,
      [other],
    ],
    [
      `insert into ai_metrics (name, "timestamp", tags) values ('m', now(), jsonb_build_object('userId', $1::text))`,
      [other],
    ],
    [
      `insert into document_embeddings (chunk_id, document_id, content, scope_key)
       values ('c2', 'd2', 'text', 'kb::userId=' || $1::text)`,
      [other],
    ],
    [
      `insert into rate_limit_events (bucket) values ('ai:per-user:actor:' || $1::text)`,
      [other],
    ],
    [
      `insert into app_sessions (id, state, version, meta)
       values ('s-other-' || $1::text, '{}'::jsonb, 1,
               jsonb_build_object('participants', jsonb_build_array(jsonb_build_object('actorId', $1::text))))`,
      [other],
    ],
    [
      `insert into groups (id, name, owner_id) values ($2::uuid, 'Other group', $1::uuid)`,
      [other, randomUUID()],
    ],
    [
      `insert into consent_records (user_id, consent_type, consent_version, granted) values ($1::uuid, 'analytics', '1', true)`,
      [other],
    ],
    [`insert into user_devices (user_id, device_id) values ($1::uuid, 'dev2')`, [other]],
    [`insert into password_policy (user_id) values ($1::uuid)`, [other]],
    [
      `insert into audit_log (action, actor_id, target_id) values ('login_success', $1::uuid, $1::uuid)`,
      [other],
    ],
    [
      `insert into agent_trajectories (trigger, subject_kind, subject_id, scope_type, scope_id)
       values ('x', 'agent', 'a', 'user', $1)`,
      [other],
    ],
  ];
  for (const [text, values] of statements) await sql(t, text, values);
  const [g] = await sql(t, "select id from groups where owner_id = $1::uuid", [other]);
  await sql(
    t,
    "insert into group_memberships (group_id, user_id) values ($1::uuid, $2::uuid)",
    [g.id, other]
  );
  await sql(
    t,
    "insert into group_invites (group_id, inviter_id, invitee_id) values ($1::uuid, $2::uuid, $2::uuid)",
    [g.id, other]
  );
}

/** Entitlement groups the tests made (the catalog is not a tenant's: removed by hand). */
const catalog: string[] = [];

/** Register entries the tests cannot seed (none, since review 8 M3). */
const UNSEEDED = new Set<string>();

let t: TestTenant;
let user: string;
let other: string;

if (DB_ENABLED) {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    if (catalog.length > 0)
      await withOwnerTx("tenant-lifecycle", (tx) =>
        tx.query("delete from entitlement_groups where id = any($1::uuid[])", [catalog])
      );
    await disconnectTestDatabase();
  });
  beforeEach(async () => {
    t = await createTestTenant();
    user = await t.user("erased");
    other = await t.user("other");
  });
}

dbDescribe(`${SUITE} classification`, () => {
  it("classifies every table of the schema, and names only tables that exist", async () => {
    const rows = await sql(
      t,
      "select tablename::text as name from pg_tables where schemaname = 'public' order by 1"
    );
    const tables = rows.map((r) => r.name as string);
    const declared = await declarations(t);
    expect(unclassifiedTables(tables, declared)).toEqual([]);
    expect(declaredButAbsent(tables, declared)).toEqual([]);
    for (const reason of Object.values(NO_USER_DATA))
      expect(reason.length).toBeGreaterThan(10);
  });

  it("the deletion manifest names the register's tables and no table that does not exist (E-7)", async () => {
    const rows = await sql(t, "select module_name, table_names from deletion_manifest");
    const all = rows.flatMap((r) => r.table_names as string[]);
    const tables = (
      await sql(
        t,
        "select tablename::text as name from pg_tables where schemaname = 'public'"
      )
    ).map((r) => r.name);
    expect(all.filter((name) => !tables.includes(name))).toEqual([]);
    const platform = rows.find((r) => r.module_name === "platform");
    expect(new Set(platform?.table_names as string[])).toEqual(
      new Set(USER_DATA_TABLES.map((e) => e.table))
    );
  });
});

describe(`${SUITE}: an app inherits the classification unchanged`, () => {
  // An app's tables, as the coverage test sees them in the app's database.
  const d: Declarations = {
    platformTables: new Set(["users", "audit_log"]),
    appErased: new Set(
      appManifestTables([
        { module_name: "platform", table_names: ["users"] },
        { module_name: "auth", table_names: ["players"] },
        {
          module_name: "playform:agent-delegation",
          table_names: ["agent_delegation_grant"],
        },
      ])
    ),
    appNoUserData: new Set(["quiz_catalog"]),
  };

  it("classifies an app table its deletion module names, or its manifest declares", () => {
    expect(
      unclassifiedTables(
        ["users", "audit_log", "agent_delegation_grant", "quiz_catalog"],
        d
      )
    ).toEqual([]);
    expect(isAppColumn("agent_delegation_grant.user_id", d)).toBe(true);
    expect(isAppColumn("users.status_changed_by", d)).toBe(false);
  });

  it("still fails an app table nobody declares", () => {
    expect(unclassifiedTables(["users", "quiz_scores"], d)).toEqual(["quiz_scores"]);
    expect(isAppColumn("quiz_scores.user_id", d)).toBe(false);
  });

  it("a platform-written manifest row declares nothing for an app, and a declaration must exist", () => {
    expect(d.appErased.has("players")).toBe(false);
    expect(
      declaredButAbsent(["users", "audit_log", "agent_delegation_grant"], d)
    ).toEqual(["quiz_catalog"]);
  });

  it("the app manifest refuses a noUserData entry without a reason or with a bad name", () => {
    const platform = mm.loadPlatformManifest();
    expect(() =>
      mm.mergeManifests(platform, {
        app: "playform",
        modules: {},
        noUserData: { quiz_catalog: "x" },
      })
    ).toThrow(/noUserData\.quiz_catalog: say why/);
    expect(() =>
      mm.mergeManifests(platform, {
        app: "playform",
        modules: {},
        noUserData: {
          "Quiz Catalog": "the quiz catalog: questions, no answers by anyone",
        },
      })
    ).toThrow(/not a table name/);
    expect(
      mm.mergeManifests(platform, {
        app: "playform",
        modules: {},
        noUserData: { quiz_catalog: "the quiz catalog: questions, no answers by anyone" },
      }).noUserData
    ).toEqual({ quiz_catalog: "the quiz catalog: questions, no answers by anyone" });
  });
});

/**
 * Every column of a kind that can hold an identity or a text: uuid, the string types (text,
 * varchar, char, name), arrays of them, json and jsonb — of every table in public, plain or
 * partitioned (a partition is its parent's). Review 8 M3: candidates were found by name, on
 * plain tables only.
 */
const CANDIDATE_COLUMNS = `
  select r.relname || '.' || a.attname as name, format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a
    join pg_class r on r.oid = a.attrelid and r.relnamespace = 'public'::regnamespace
                   and r.relkind in ('r', 'p') and not r.relispartition
    join pg_type ty on ty.oid = a.atttypid
    left join pg_type el on el.oid = ty.typelem and ty.typcategory = 'A'
   where a.attnum > 0 and not a.attisdropped and a.attname <> 'tenant_id'
     and (ty.oid in ('uuid'::regtype, 'json'::regtype, 'jsonb'::regtype)
          or ty.typcategory = 'S'
          or el.oid in ('uuid'::regtype, 'json'::regtype, 'jsonb'::regtype)
          or el.typcategory = 'S')
   order by 1`;

dbDescribe(`${SUITE} columns`, () => {
  it("classifies every uuid, text, text[], json and jsonb column, and names only columns that exist", async () => {
    const rows = await sql(t, CANDIDATE_COLUMNS);
    // An app's own tables are its deletion module's to answer for, column by column.
    const declared = await declarations(t);
    const candidates = rows
      .map((r) => r.name as string)
      .filter((c) => !isAppColumn(c, declared));
    const claimed = new Set(USER_DATA_TABLES.flatMap((e) => e.columns));
    const listed = new Set(Object.keys(NO_USER_DATA_COLUMNS));
    expect(candidates.filter((c) => !claimed.has(c) && !listed.has(c))).toEqual([]);
    // A column is claimed or listed, not both: a claim is checked (below), a listing is not.
    expect([...claimed].filter((c) => listed.has(c))).toEqual([]);
    const all = new Set(
      (
        await sql(
          t,
          `select r.relname || '.' || a.attname as name from pg_attribute a
             join pg_class r on r.oid = a.attrelid and r.relnamespace = 'public'::regnamespace
            where a.attnum > 0 and not a.attisdropped`
        )
      ).map((r) => r.name as string)
    );
    expect([...claimed, ...listed].filter((c) => !all.has(c))).toEqual([]);
    for (const reason of Object.values(NO_USER_DATA_COLUMNS))
      expect(reason.length).toBeGreaterThan(10);
    for (const entry of USER_DATA_TABLES)
      for (const c of entry.columns)
        expect([entry.name, c.split(".")[0]]).toEqual([entry.name, entry.table]);
  });

  it("the candidate scan sees partitioned tables, arrays and json (self-test)", async () => {
    // A temporary table, on the owner connection (the tenant role may not create one): the
    // classification query's shape is what is checked.
    const shape = await withOwnerTx("tenant-lifecycle", async (tx) => {
      await tx.query(
        "create temporary table r8_scan_probe (reviewer_id uuid, requester_email text, participant_ids text[], doc json, n int) partition by list (n) "
      );
      await tx.query(
        "create temporary table r8_scan_probe_1 partition of r8_scan_probe for values in (1)"
      );
      return (
        await tx.query<{ name: string }>(
          CANDIDATE_COLUMNS.replace("'public'::regnamespace", "pg_my_temp_schema()")
        )
      ).rows.map((r) => r.name);
    });
    expect(shape).toEqual([
      "r8_scan_probe.doc",
      "r8_scan_probe.participant_ids",
      "r8_scan_probe.requester_email",
      "r8_scan_probe.reviewer_id",
    ]);
  });
});

/** What writes the user's id into a column of `type`, as $1. */
function idAs(type: string): string {
  if (type === "uuid") return "$1::uuid";
  if (type === "uuid[]") return "array[$1::uuid]";
  if (type.endsWith("[]")) return "array[$1::text]";
  if (type === "jsonb") return "jsonb_build_object('mention', $1::text)";
  if (type === "json") return "json_build_object('mention', $1::text)";
  return "$1::text";
}

dbDescribe(`${SUITE} hostile scan`, () => {
  /**
   * Review 8 M3: a claim is proved. Every claimed column of another account's row is given the
   * user's id; after the erasure no row of the table holds it in that column. Before, a claim
   * counted as coverage whatever the erasure did: audit_log.details was never touched, and
   * review_queue's moderation record only on the user's own cases.
   */
  it("every claimed column, given the user's id in another row, holds it nowhere after erasure", async () => {
    await seed(t, user, other);
    await seedOther(t, other);
    const types = new Map(
      (await sql(t, CANDIDATE_COLUMNS)).map((r) => [r.name as string, r.type as string])
    );
    const claimed = [...new Set(USER_DATA_TABLES.flatMap((e) => e.columns))];
    const seeded: string[] = [];
    for (const column of claimed) {
      const [table, name] = column.split(".");
      const type = types.get(column);
      expect([column, type]).not.toEqual([column, undefined]);
      const [row] = await sql(
        t,
        `select ctid::text as k from ${table} where coalesce(${name}::text, '') !~* $1::text limit 1`,
        [user]
      );
      // Every claimed table has a row that is not the user's (seedOther).
      expect([column, row === undefined]).toEqual([column, false]);
      try {
        await sql(
          t,
          `update ${table} set ${name} = ${idAs(type!)} where ctid = $2::tid`,
          [user, row.k]
        );
      } catch (err) {
        // A key: the user already has such a row (seed), which the erasure must clear too.
        if ((err as { code?: string }).code !== "23505") throw err;
      }
      seeded.push(column);
    }
    expect(seeded).toEqual(claimed);

    await expect(t.run(() => softDeleteUser(user, user))).resolves.toEqual({
      success: true,
      errors: [],
    });
    expect(await t.run(() => hardPurgeUser(user))).toMatchObject({ success: true });

    const left: string[] = [];
    for (const column of claimed) {
      const [table, name] = column.split(".");
      const [{ n }] = await sql(
        t,
        `select count(*)::int as n from ${table} where coalesce(${name}::text, '') ~* $1::text`,
        [user]
      );
      if ((n as number) > 0) left.push(`${column}: ${n}`);
    }
    expect(left).toEqual([]);
  });

  /** Where an address stands for the account (ADDRESS_REPLACEMENTS): whole values only. */
  it("every column the address is replaced in holds it, as a whole value, nowhere after erasure", async () => {
    await seed(t, user, other);
    await seedOther(t, other);
    const [{ email }] = await sql(t, "select email from users where id = $1::uuid", [
      user,
    ]);
    const address = String(email);
    const columns = ADDRESS_REPLACEMENTS.flatMap((text) => {
      const table = /^update (\w+) set/.exec(text)![1];
      return [...text.matchAll(/(\w+) = jsonb_replace_text_value\(/g)].map(
        (m) => `${table}.${m[1]}`
      );
    });
    expect(columns.length).toBeGreaterThanOrEqual(7);
    for (const column of columns) {
      const [table, name] = column.split(".");
      const [row] = await sql(t, `select ctid::text as k from ${table} limit 1`);
      expect([column, row === undefined]).toEqual([column, false]);
      await sql(
        t,
        `update ${table} set ${name} = jsonb_build_object('who', upper($1::text), 'near', 'jo' || $1::text) where ctid = $2::tid`,
        [address, row.k]
      );
    }
    await t.run(() => softDeleteUser(user, user));
    await t.run(() => hardPurgeUser(user));
    for (const column of columns) {
      const [table, name] = column.split(".");
      const [{ whole }] = await sql(
        t,
        `select count(*)::int as whole from ${table}
          where strpos(lower(coalesce(${name}::text, '')), lower(to_jsonb($1::text)::text)) > 0`,
        [address]
      );
      // The whole address (in another case) is gone. That a near miss is left as it was is
      // proved where it can stand alone (erasure-address.db).
      expect([column, whole]).toEqual([column, 0]);
    }
  });
});

dbDescribe(`${SUITE} erasure`, () => {
  it("leaves no row naming the user in any table, and keeps others' rows", async () => {
    await seed(t, user, other);
    const before = await remaining(t, user);
    for (const entry of USER_DATA_TABLES) {
      if (!UNSEEDED.has(entry.name))
        expect([entry.name, before[entry.name]]).not.toEqual([entry.name, 0]);
    }
    const otherBefore = await sql(
      t,
      "select (select count(*) from review_queue where target_user_id = $1::uuid)::int as reviews, (select count(*) from user_feature_restrictions where user_id = $1::uuid)::int as restrictions, (select count(*) from proposals where actor_id = $1::text)::int as proposals",
      [other]
    );

    await expect(t.run(() => softDeleteUser(user, user))).resolves.toEqual({
      success: true,
      errors: [],
    });
    const purged = await t.run(() => hardPurgeUser(user));
    expect(purged).toMatchObject({ success: true, errors: [] });

    const after = await remaining(t, user);
    // Every entry: nothing names the user — deleted, or anonymised so it no longer does. The
    // audit log keeps the account's id (it no longer names anyone) without address or browser.
    for (const entry of USER_DATA_TABLES) {
      if (entry.name === "auditLog") continue;
      expect([entry.name, after[entry.name]]).toEqual([entry.name, 0]);
    }
    const audit = await sql(
      t,
      "select ip_address, user_agent from audit_log where actor_id = $1::uuid or target_id = $1::uuid",
      [user]
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((r) => r.ip_address === null && r.user_agent === null)).toBe(true);

    // Decisions about the other account stand, without the erased reviewer or approver.
    expect(
      await sql(
        t,
        "select (select count(*) from review_queue where target_user_id = $1::uuid)::int as reviews, (select count(*) from user_feature_restrictions where user_id = $1::uuid)::int as restrictions, (select count(*) from proposals where actor_id = $1::text)::int as proposals",
        [other]
      )
    ).toEqual(otherBefore);
    const [review] = await sql(
      t,
      "select status, decision, claimed_by, resolved_by from review_queue where target_user_id = $1::uuid",
      [other]
    );
    expect(review).toEqual({
      status: "resolved",
      decision: "uphold",
      claimed_by: null,
      resolved_by: null,
    });
    const [shared] = await sql(t, "select meta from app_sessions where id = $1", [
      `s-shared-${user}`,
    ]);
    expect(shared.meta).toEqual({ participants: [{ actorId: other }] });
    const [restriction] = await sql(
      t,
      "select created_by from user_feature_restrictions where user_id = $1::uuid",
      [other]
    );
    expect(restriction).toEqual({ created_by: "erased" });

    // The erasure is recorded as complete, and the steps say what was done.
    const [record] = await sql(
      t,
      "select purged_at from user_deletions where user_id = $1::uuid",
      [user]
    );
    expect(record.purged_at).toBeInstanceOf(Date);
    expect(purged.steps?.find((s) => s.name === "profile")).toMatchObject({ rows: 1 });
  });

  it("is all or nothing: a step that fails rolls every step back", async () => {
    await seed(t, user, other);
    const before = await remaining(t, user);
    await expect(
      t.run(() =>
        withTenantTx(async (tx) => {
          await eraseUserData(tx, user);
          throw new Error("a later step failed");
        })
      )
    ).rejects.toThrow("a later step failed");
    expect(await remaining(t, user)).toEqual(before);
  });

  it("a dry run counts and changes nothing; the admin purge erases and is logged", async () => {
    await seed(t, user, other);
    const before = await remaining(t, user);
    const admin = await t.user("admin");
    const dry = await t.run(() =>
      createPlatformPurgePipeline(admin).execute({
        userId: user,
        requestedBy: admin,
        reason: "admin-action",
        dryRun: true,
      })
    );
    expect(dry.status).toBe("completed");
    expect(dry.totalDeleted).toBe(Object.values(before).reduce((a, b) => a + b, 0));
    expect(await remaining(t, user)).toEqual(before);

    const run = await t.run(() =>
      createPlatformPurgePipeline(admin).execute({
        userId: user,
        requestedBy: admin,
        reason: "admin-action",
      })
    );
    expect(run.status).toBe("completed");
    expect(await sql(t, "select id from users where id = $1::uuid", [user])).toEqual([]);
    const [log] = await sql(t, "select user_id, requested_by, status from purge_log");
    expect(log).toEqual({ user_id: user, requested_by: admin, status: "completed" });
  });

  it("refuses a crafted id before any statement", async () => {
    for (const id of ["x' or '1'='1", "", "not-a-uuid"]) {
      await expect(
        t.run(() => withTenantTx((tx) => eraseUserData(tx, id)))
      ).rejects.toThrow("invalid user id");
    }
  });
});

dbDescribe(`${SUITE} export`, () => {
  it("holds every exported section of the user's, and none of another user's", async () => {
    await seed(t, user, other);
    const { data, errors } = await t.run(() => exportUserData(user));
    expect(errors).toEqual([]);
    for (const entry of USER_DATA_TABLES) {
      if (!entry.exportSql) continue;
      expect(Array.isArray(data[entry.name])).toBe(true);
      if (!UNSEEDED.has(entry.name)) {
        expect([entry.name, (data[entry.name] as Row[]).length]).not.toEqual([
          entry.name,
          0,
        ]);
      }
    }
    expect(data.profile).toMatchObject({ id: user });
    const theirs = await t.run(() => exportUserData(other));
    expect(theirs.data.strikes).toEqual([]);
    expect(theirs.data.aiInteractions).toEqual([]);
  });

  // Review 8 L2: another account's runs that mention the user are not the user's data. Before,
  // every step naming the user's id was exported, so anyone could fill a victim's export to the
  // size cap (413) by writing runs that name them.
  it("exports only the user's own steps: runs others write naming the user cannot inflate it", async () => {
    await seed(t, user, other);
    for (let i = 0; i < 40; i++)
      await sql(
        t,
        `insert into agent_trajectories (trigger, subject_kind, subject_id, scope_type, scope_id, steps)
         values ('x', 'agent', 'attacker', 'group', 'g', jsonb_build_array(
           jsonb_build_object('actor', jsonb_build_object('actorId', $2::text), 'input', jsonb_build_object('about', $1::text))))`,
        [user, other]
      );
    const data = await t.run(() =>
      withTenantTx((tx) => exportUserTables(tx, user, { maxRows: 30 }))
    );
    const steps = data.trajectorySteps as { steps: { actor: { actorId: string } }[] }[];
    // The shared session's run, with the user's own step only.
    expect(steps).toHaveLength(1);
    expect(steps[0].steps.map((s) => s.actor.actorId)).toEqual([user]);
  });

  it("gives nothing when any part cannot be read (RR-23)", async () => {
    registerExportModule({
      moduleName: "db-coverage-failing",
      description: "x",
      collectData: async () => {
        throw new Error("module store down");
      },
    });
    const { data, errors } = await t.run(() => exportUserData(user));
    expect(data).toEqual({});
    expect(errors).toEqual(["db-coverage-failing: module store down"]);
    registerExportModule({
      moduleName: "db-coverage-failing",
      description: "x",
      collectData: async () => ({ data: {} }),
    });
  });
});
