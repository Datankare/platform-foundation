/**
 * @jest-environment node
 */
/**
 * Review 7 (M1–M4): the rights of access and erasure against hostile data, on Postgres.
 *
 *   - M2 an export holds every row: past the old 1000-a-section and 500-audit-row limits, across
 *     many pages, each row once; one larger than the cap is refused whole, never cut off.
 *   - M1 an audit row about the user written by someone else says what was done and when — not
 *     the staff member's id, network address, browser or notes; the user's own acts keep theirs.
 *   - M3 a shared session's export is the user's part only, not the other participants' state.
 *   - M4 erasure leaves no row naming the user: another account's standing they changed, an app
 *     session's trajectory, a held proposal naming them (by id or by address), a shared session's
 *     state — checked by scanning every table of the tenant for the id.
 */
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { withOwnerTx, withTenantSnapshot, withTenantTx } from "@/platform/data";
import { exportUserData, EXPORT_TOO_LARGE } from "@/platform/auth/data-export";
import { auditRowsForExport } from "@/platform/auth/audit";
import {
  ExportTooLargeError,
  EXPORT_MAX_ROWS,
  exportUserTables,
} from "@/platform/auth/user-data";
import { hardPurgeUser, softDeleteUser } from "@/platform/auth/gdpr-deletion";
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
let t: TestTenant;
const sql = (text: string, values: unknown[] = []): Promise<Row[]> =>
  t.run(() => withTenantTx(async (tx) => (await tx.query<Row>(text, values)).rows));

if (DB_ENABLED) {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
  beforeEach(async () => {
    t = await createTestTenant();
  });
}

/** Every row of every table of this tenant whose text holds `needle`, as "table: n". */
async function rowsNaming(needle: string): Promise<string[]> {
  return withOwnerTx("tenant-lifecycle", async (tx) => {
    const { rows } = await tx.query<{ name: string }>(
      `select c.relname::text as name from pg_class c
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1`
    );
    const found: string[] = [];
    for (const { name } of rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected table ${name}`);
      const { rows: n } = await tx.query<{ n: number }>(
        `select count(*)::int as n from public."${name}" r
          where r.tenant_id = $1::uuid and strpos(to_jsonb(r)::text, $2::text) > 0`,
        [t.id, needle]
      );
      if (n[0].n > 0) found.push(`${name}: ${n[0].n}`);
    }
    return found;
  });
}

dbDescribe("review 7 M2: an export holds every row, or is refused whole", () => {
  it("exports all 1005 AI interactions and all 620 audit rows, and says it is complete", async () => {
    const user = await t.user("u");
    await sql(`insert into user_ai_context (user_id) values ($1)`, [user]);
    await sql(
      `insert into user_interactions (user_id, input, output, feature)
       select $1, 'i'||g, 'o', 'f' from generate_series(1, 1005) g`,
      [user]
    );
    // Same timestamp for all: the audit pages must still be exact (keyed by time and id).
    await sql(
      `insert into audit_log (action, actor_id, target_id, created_at)
       select 'login_success', $1::uuid, $1::uuid, '2026-01-01T00:00:00Z' from generate_series(1, 620)`,
      [user]
    );
    const { data, errors } = await t.run(() => exportUserData(user));
    expect(errors).toEqual([]);
    const interactions = data.aiInteractions as Row[];
    expect(interactions).toHaveLength(1005);
    expect(new Set(interactions.map((r) => r.input)).size).toBe(1005);
    const audit = data.auditLog as Row[];
    expect(audit.filter((r) => r.action === "login_success")).toHaveLength(620);
    expect(new Set(audit.map((r) => r.id)).size).toBe(audit.length);
    expect(data._meta).toMatchObject({
      complete: true,
      maxRows: EXPORT_MAX_ROWS,
      sectionRows: expect.objectContaining({ aiInteractions: 1005 }),
    });
  });

  it("pages exactly at any page size: each row once", async () => {
    const user = await t.user("u");
    await sql(`insert into user_ai_context (user_id) values ($1)`, [user]);
    await sql(
      `insert into user_interactions (user_id, input, output, feature)
       select $1, 'i'||g, 'o', 'f' from generate_series(1, 23) g`,
      [user]
    );
    for (const pageSize of [1, 7, 23, 24]) {
      const tables = await t.run(() =>
        withTenantSnapshot((tx) => exportUserTables(tx, user, { pageSize }))
      );
      const inputs = tables.aiInteractions.map((r) => r.input);
      expect([pageSize, inputs.length, new Set(inputs).size]).toEqual([pageSize, 23, 23]);
      const audit = await t.run(() =>
        withTenantSnapshot((tx) =>
          auditRowsForExport(tx, user, { pageSize, maxRows: 1000 })
        )
      );
      expect(audit).toEqual([]);
    }
  });

  it("refuses an export over the cap with a coded error, never a cut-off copy", async () => {
    const user = await t.user("u");
    await sql(`insert into user_ai_context (user_id) values ($1)`, [user]);
    await sql(
      `insert into user_interactions (user_id, input, output, feature)
       select $1, 'i'||g, 'o', 'f' from generate_series(1, 30) g`,
      [user]
    );
    await sql(
      `insert into audit_log (action, actor_id, target_id)
       select 'login_success', $1::uuid, $1::uuid from generate_series(1, 30)`,
      [user]
    );
    await expect(
      t.run(() =>
        withTenantSnapshot((tx) =>
          exportUserTables(tx, user, { pageSize: 7, maxRows: 29 })
        )
      )
    ).rejects.toBeInstanceOf(ExportTooLargeError);
    await expect(
      t.run(() =>
        withTenantSnapshot((tx) =>
          auditRowsForExport(tx, user, { pageSize: 7, maxRows: 29 })
        )
      )
    ).rejects.toBeInstanceOf(ExportTooLargeError);
    expect(EXPORT_TOO_LARGE).toBe("export.too_large");
  });
});

dbDescribe("review 7 M1: the export holds no staff member's data", () => {
  it("an act on the user by an admin: what and when, not who, from where, or their notes", async () => {
    const user = await t.user("u");
    const admin = await t.user("admin");
    await sql(
      `insert into audit_log (action, actor_id, target_id, ip_address, user_agent, details)
       values ('role_changed', $1::uuid, $2::uuid, '198.51.100.7', 'AdminBrowser/1.0',
               '{"note":"internal","oldRole":"user","newRole":"moderator","reviewerNotes":"x"}'),
              ('login_success', $2::uuid, $2::uuid, '192.0.2.9', 'MyBrowser/2.0', '{"method":"password"}')`,
      [admin, user]
    );
    const { data, errors } = await t.run(() => exportUserData(user));
    expect(errors).toEqual([]);
    const rows = data.auditLog as Row[];
    const text = JSON.stringify(rows);
    expect(text).not.toContain(admin);
    expect(text).not.toContain("198.51.100.7");
    expect(text).not.toContain("AdminBrowser");
    expect(text).not.toContain("internal");
    const byAdmin = rows.find((r) => r.action === "role_changed");
    expect(byAdmin).toEqual({
      id: expect.any(String),
      action: "role_changed",
      created_at: expect.any(String),
      by: "another account",
      target_id: user,
      details: { oldRole: "user", newRole: "moderator" },
    });
    // The user's own act keeps their own address and browser.
    expect(rows.find((r) => r.action === "login_success")).toMatchObject({
      actor_id: user,
      ip_address: "192.0.2.9",
      user_agent: "MyBrowser/2.0",
      details: { method: "password" },
    });
  });

  it("the profile does not say which moderator changed the account's standing", async () => {
    const user = await t.user("u");
    const moderator = await t.user("m");
    await sql(
      `update users set status_changed_by = $1, account_status = 'warned' where id = $2::uuid`,
      [moderator, user]
    );
    const { data } = await t.run(() => exportUserData(user));
    expect(data.profile).toMatchObject({ id: user, account_status: "warned" });
    expect(JSON.stringify(data)).not.toContain(moderator);
  });
});

dbDescribe("review 7 M3: a shared session's export is the user's part only", () => {
  it("gives the user's participation and steps, not the other participant's state", async () => {
    const user = await t.user("u");
    const other = await t.user("o");
    await sql(
      `insert into app_sessions (id, state, version, meta)
       values ('s1', '{"secretOfOther":"x"}'::jsonb, 1,
         jsonb_build_object('participants', jsonb_build_array(
           jsonb_build_object('actorId', $1::text), jsonb_build_object('actorId', $2::text)))),
              ('s2', '{"mine":true}'::jsonb, 1,
         jsonb_build_object('participants', jsonb_build_array(jsonb_build_object('actorId', $1::text))))`,
      [user, other]
    );
    await sql(
      `insert into agent_trajectories (trigger, subject_kind, subject_id, scope_type, steps)
       values ('session-created', 'session', 's1', 'user',
               jsonb_build_array(jsonb_build_object('actor', jsonb_build_object('actorId', $1::text), 'move', 'mine'),
                                 jsonb_build_object('actor', jsonb_build_object('actorId', $2::text), 'move', 'theirs')))`,
      [user, other]
    );
    const { data, errors } = await t.run(() => exportUserData(user));
    expect(errors).toEqual([]);
    const shared = data.sharedAppSessions as Row[];
    expect(shared).toHaveLength(1);
    expect(shared[0]).not.toHaveProperty("state");
    expect(shared[0].participant).toEqual({ actorId: user });
    expect(JSON.stringify(shared)).not.toContain(other);
    const steps = data.trajectorySteps as Row[];
    expect(steps).toHaveLength(1);
    // A step is the user's when they took it (its actor) — review 8 L2.
    expect(steps[0].steps).toEqual([{ actor: { actorId: user }, move: "mine" }]);
    expect(JSON.stringify(data)).not.toContain("secretOfOther");
    expect(JSON.stringify(data)).not.toContain("theirs");
    // The user's own session is theirs, state and all.
    expect(data.appSessions).toEqual([
      expect.objectContaining({ id: "s2", state: { mine: true } }),
    ]);
  });
});

dbDescribe("review 7 M4: erasure leaves no row naming the user", () => {
  it("clears the reviewer's three survivors and every other mention, in any table", async () => {
    const user = await t.user("u");
    const victim = await t.user("v");
    const other = await t.user("o");
    const [{ email }] = await sql(`select email from users where id = $1::uuid`, [user]);
    // An erased moderator/admin who changed another account's standing.
    await sql(`update users set status_changed_by = $1 where id = $2::uuid`, [
      user,
      victim,
    ]);
    // An app session's trajectory (scope 'user', no scope id — session.ts) naming the user, for a
    // shared session and for the user's own.
    await sql(
      `insert into app_sessions (id, state, version, meta)
       values ('shared', jsonb_build_object('scores', jsonb_build_object($1::text, 3, $2::text, 4)), 1,
         jsonb_build_object('participants', jsonb_build_array(
           jsonb_build_object('actorId', $1::text), jsonb_build_object('actorId', $2::text)))),
              ('own', '{}'::jsonb, 1,
         jsonb_build_object('participants', jsonb_build_array(jsonb_build_object('actorId', $1::text))))`,
      [user, other]
    );
    await sql(
      `insert into agent_trajectories (trigger, subject_kind, subject_id, scope_type, steps)
       values ('session-created', 'session', 's1', 'user', jsonb_build_array(jsonb_build_object('actorId', $1::text))),
              ('session-created', 'session', 'shared', 'user',
                 jsonb_build_array(jsonb_build_object('actorId', $1::text), jsonb_build_object('actorId', $2::text))),
              ('session-created', 'session', 'own', 'user', jsonb_build_array(jsonb_build_object('actorId', $1::text)))`,
      [user, other]
    );
    // Held role changes another admin made about the user — by id, and by address — and one
    // already decided.
    await sql(
      `insert into proposals (operation_id, session_id, trajectory_id, label, actor_id, actor_role,
                              effective_risk, payload, status, decided_by)
       values ('opx', 's', 't', 'change_user_role', 'command-bar', 'agent', 'restricted',
               jsonb_build_object('user_identifier', $1::text), 'proposed', null),
              ('opy', 's', 't', 'change_user_role', 'command-bar', 'agent', 'restricted',
               jsonb_build_object('user_identifier', upper($2::text)), 'approved', $3),
              ('opz', 's', 't', 'change_user_role', 'command-bar', 'agent', 'restricted',
               jsonb_build_object('user_identifier', $1::text), 'executed', $3)`,
      [user, email, other]
    );

    await expect(t.run(() => softDeleteUser(user, user))).resolves.toEqual({
      success: true,
      errors: [],
    });
    const purged = await t.run(() => hardPurgeUser(user));
    expect(purged).toMatchObject({ success: true, errors: [] });

    const left = await sql(
      `select (select count(*) from users where status_changed_by = $1)::int as status_by,
              (select count(*) from agent_trajectories where steps::text like '%' || $1 || '%')::int as traj,
              (select count(*) from proposals where payload::text like '%' || $1 || '%')::int as props`,
      [user]
    );
    expect(left[0]).toEqual({ status_by: 0, traj: 0, props: 0 });

    // No table holds the id or the address any more — only the erasure's own record and the
    // audit trail's account id (kept by design, without address or browser).
    expect(await rowsNaming(user)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^user_deletions: /)])
    );
    expect(
      (await rowsNaming(user)).filter(
        (r) => !/^(?:user_deletions|purge_log|audit_log): /.test(r)
      )
    ).toEqual([]);
    expect(await rowsNaming(String(email).toLowerCase())).toEqual([]);

    // What stands for others: the victim's standing, the shared session and run (without the
    // user), the decided proposal; the held ones about the erased account are gone, the own
    // session's run went with it.
    const [victimRow] = await sql(
      `select account_status, status_changed_by from users where id = $1::uuid`,
      [victim]
    );
    expect(victimRow.status_changed_by).toBeNull();
    const [shared] = await sql(
      `select state, meta from app_sessions where id = 'shared'`
    );
    expect(shared).toEqual({
      state: { scores: { erased: 3, [other]: 4 } },
      meta: { participants: [{ actorId: other }] },
    });
    const runs = await sql(
      `select subject_id, steps from agent_trajectories order by subject_id`
    );
    expect(runs).toEqual([
      { subject_id: "s1", steps: [{ actorId: "erased" }] },
      { subject_id: "shared", steps: [{ actorId: "erased" }, { actorId: other }] },
    ]);
    const proposals = await sql(`select operation_id, status, payload from proposals`);
    expect(proposals).toEqual([
      { operation_id: "opz", status: "executed", payload: { user_identifier: "erased" } },
    ]);
  });
});
