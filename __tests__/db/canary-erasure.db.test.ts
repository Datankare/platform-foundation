/**
 * @jest-environment node
 */
/**
 * __tests__/db/canary-erasure.db.test.ts — after an erasure, nothing of the person is left, in any
 * column of any table, in any tenant (TASK-193, audit A-2, A-3, A-4, A-16)
 *
 * user-data-coverage proves erasure by identity: it writes the account's id (and address) into
 * every claimed column and checks they are gone. Names, the date of birth, the identity's subject,
 * the parent's address, a network address and free text written about the person were never
 * seeded, so the audit's findings could not fail it. Here they are: an account is given a
 * distinctive value in every personal field, then the write paths that copy personal data
 * elsewhere are driven as they run —
 *
 *   - the command bar holding a role change named by the account's address, and running one for a
 *     mistyped address (A-2);
 *   - a feature blocked with a reason that quotes the person (A-4);
 *   - a review resolved with notes that quote them (A-4);
 *   - the operator making the account its tenant's administrator, from the operator's own tenant
 *     (A-3: the record lands in another tenant);
 *   - a sign-in recorded with a network address and browser; a consent given; a device named;
 *
 * — then the account is erased (soft delete, hard purge, and the job's pass over other tenants),
 * and every column of every type of every table, in every tenant, is read for any of the values.
 * The only places allowed to keep one are the erasure's own record (ALLOWED, each with why).
 *
 * Shown failing on the code before TASK-193: the operator's record kept the address in the
 * operator's tenant; the restriction's reason and the reviewer's notes stayed in audit details;
 * the role change's step kept `User "<address>" not found`.
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
  setTrajectoryStore,
  type TrajectoryStore,
} from "@/platform/agents/trajectory-store";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import { setProposalStore, type ProposalStore } from "@/platform/agents/proposal-store";
import { PostgresProposalStore } from "@/platform/agents/postgres-proposal-store";
import {
  PostgresReviewQueueStore,
  setReviewQueueStore,
} from "@/platform/moderation/review-store";
import type { ReviewQueueStore } from "@/platform/moderation/review-types";
import {
  claimItem,
  resolveItem,
  submitForReview,
} from "@/platform/moderation/review-service";
import { withTrajectory } from "@/platform/agents/trajectory-closure";
import { invokeTool } from "@/platform/agents/tool-invoker";
import {
  commandBarActor,
  runCommandBarAction,
  runtimeToolFor,
} from "@/app/api/admin/ai/command-bar";
import { makeTenantAdmin } from "@/platform/tenancy/admin";
import {
  eraseMentionsInOtherTenants,
  hardPurgeUser,
  softDeleteUser,
} from "@/platform/auth/gdpr-deletion";
import { recordAudit } from "@/platform/auth/audit";
import { grantConsent } from "@/platform/auth/consent";
import { registerDevice } from "@/platform/auth/devices";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";

const RUN = randomUUID().slice(0, 8);
const owner = <R extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  withOwnerTx("tenant-lifecycle", (tx) => tx.query<R>(sql, values));

/** The person's values: each distinctive, so finding one anywhere is finding them. */
const S = {
  email: `canary-${RUN}@sentinel.example`,
  typo: `canary-typo-${RUN}@sentinel.example`,
  display: `CanaryDisplay${RUN}`,
  real: `CanaryReal${RUN}`,
  dob: "2013-07-19",
  sub: randomUUID(),
  parent: `canary-parent-${RUN}@sentinel.example`,
  ban: `CanaryBan${RUN}`,
  avatar: `https://sentinel.example/${RUN}.png`,
  ip: "203.0.113.77",
  agent: `CanaryBrowser/${RUN}`,
  device: `CanaryPhone${RUN}`,
  note: `CanaryNote${RUN}`,
  // Round 1, item 10: the locale and last sign-in the soft delete clears.
  timezone: `Canary/Zone${RUN}`,
  language: `xx-canary${RUN}`,
  lastLogin: ":06:07.891234",
};

/** Another person's values: every one must survive the erasure (the over-deletion side). */
const B = {
  display: `BystanderDisplay${RUN}`,
  reason: `BystanderReason${RUN}`,
  device: `BystanderPhone${RUN}`,
};

/** Where a value may stay after the erasure, and why. */
const ALLOWED: Readonly<Record<string, string>> = {
  "user_deletions.cognito_sub":
    "the erasure's record: the closed identity, never provisioned again (TASK-174, migration 054)",
};

let home: TestTenant;
let operatorTenant: TestTenant;
let user: string;
let bystander: string;
let admin: VerifiedAdmin;
let previous: [TrajectoryStore, ProposalStore, ReviewQueueStore];

dbDescribe("canary erasure: nothing of the person is left anywhere (TASK-193)", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    home = await createTestTenant();
    operatorTenant = await createTestTenant();
    previous = [
      setTrajectoryStore(new PostgresTrajectoryStore()),
      setProposalStore(new PostgresProposalStore()),
      setReviewQueueStore(new PostgresReviewQueueStore()),
    ];
    user = await home.user(`canary-${RUN}`);
    await owner(
      `update users set email = $2, display_name = $3, real_name = $4, date_of_birth = $5::date,
              cognito_sub = $6, parental_consent_email = $7, ban_reason = $8, avatar_url = $9,
              email_verified = true, timezone = $10, language_preference = $11,
              last_login_at = '2011-03-04 05:06:07.891234+00'
        where id = $1::uuid`,
      [
        user,
        S.email,
        S.display,
        S.real,
        S.dob,
        S.sub,
        S.parent,
        S.ban,
        S.avatar,
        S.timezone,
        S.language,
      ]
    );
    // Someone else, with their own records — one written by the account erased (it was the
    // actor; the record is about the bystander, so its text is the bystander's and stays).
    bystander = await home.user(`bystander-${RUN}`);
    await owner("update users set display_name = $2 where id = $1::uuid", [
      bystander,
      B.display,
    ]);
    await home.run(() =>
      recordAudit({
        action: "admin_action",
        actorId: user,
        targetId: bystander,
        details: { type: "block_user_feature", feature: "translate", reason: B.reason },
      })
    );
    await home.run(() => registerDevice(bystander, `dev-b-${RUN}`, B.device));
    const adminId = await home.user(`canary-admin-${RUN}`);
    admin = {
      userId: adminId,
      sub: randomUUID(),
      roleName: "super_admin",
      permissions: ["*"],
    };
  });

  afterAll(async () => {
    await dropTestTenants();
    setTrajectoryStore(previous[0]);
    setProposalStore(previous[1]);
    setReviewQueueStore(previous[2]);
    await disconnectTestDatabase();
  });

  it("drives the write paths, erases the account, and finds none of its values in any tenant", async () => {
    // A-2: a role change held for a second admin, the account named by its address; and one run
    // for an address that matches no one (its step is the handler's result).
    await home.run(() =>
      withTrajectory(
        {
          subject: { kind: "agent", id: "command-bar" },
          trigger: "command-bar",
          scopeType: "platform",
        },
        (trajectoryId) =>
          runCommandBarAction({
            tool: "change_user_role",
            input: { user_identifier: S.email, new_role: "moderator" },
            admin,
            trajectoryId,
            stepIndex: 0,
          })
      )
    );
    await home.run(() =>
      withTrajectory(
        {
          subject: { kind: "agent", id: "command-bar" },
          trigger: "command-bar",
          scopeType: "platform",
        },
        (trajectoryId) =>
          invokeTool({
            tool: runtimeToolFor(
              "change_user_role",
              { user_identifier: S.typo, new_role: "moderator" },
              admin,
              false
            ),
            input: { user_identifier: S.typo, new_role: "moderator" },
            actor: commandBarActor(admin),
            sessionId: trajectoryId,
            trajectoryId,
            stepIndex: 0,
          }).catch(() => undefined)
      )
    );
    // A-4: a feature blocked with a reason quoting the person.
    await home.run(() =>
      withTrajectory(
        {
          subject: { kind: "agent", id: "command-bar" },
          trigger: "command-bar",
          scopeType: "platform",
        },
        (trajectoryId) =>
          runCommandBarAction({
            tool: "block_user_feature",
            input: {
              user_id: user,
              feature: "translate",
              reason: `${S.display} (${S.real}) posted ${S.email}; ${S.note}`,
            },
            admin,
            trajectoryId,
            stepIndex: 0,
          })
      )
    );
    // A-4: a review resolved with notes quoting them.
    const submitted = await home.run(() =>
      submitForReview({
        source: "escalation",
        moderationResult: {
          action: "escalate",
          triggeredBy: "classifier",
          categories: [],
          confidence: 0.5,
          severity: "low",
          reasoning: "fixed phrase",
          attributeToUser: true,
          pipelineLatencyMs: 1,
          classifierCostUsd: 0,
          trajectoryId: randomUUID(),
        } as never,
        targetUserId: user,
        requestId: `req-${RUN}`,
      })
    );
    expect(submitted.success).toBe(true);
    const itemId = (submitted as { item?: { id: string } }).item!.id;
    await home.run(() => claimItem(itemId, admin.userId));
    await home.run(() =>
      resolveItem({
        itemId,
        reviewerId: admin.userId,
        decision: "uphold",
        reviewerNotes: `${S.real} lives at ${S.note}, mail ${S.parent}`,
      })
    );
    // A-3: the operator, in its own tenant, makes the account its tenant's administrator.
    const op = await operatorTenant.user(`canary-operator-${RUN}`);
    const promoted = await operatorTenant.run(() =>
      makeTenantAdmin({ userId: op }, home.id, S.email)
    );
    expect(promoted.ok).toBe(true);
    // A sign-in with a network address and browser; a consent; a named device.
    await home.run(() =>
      recordAudit({
        action: "login_success",
        actorId: user,
        targetId: user,
        details: { method: "password" },
        ipAddress: S.ip,
        userAgent: S.agent,
      })
    );
    await home.run(() =>
      grantConsent({
        userId: user,
        consentType: "terms",
        consentVersion: "1",
        ipAddress: S.ip,
        userAgent: S.agent,
      })
    );
    await home.run(() => registerDevice(user, `dev-${RUN}`, S.device));

    // Erased: the soft delete, the purge, and the job's pass over the other tenants.
    expect((await home.run(() => softDeleteUser(user, admin.userId))).success).toBe(true);
    expect((await home.run(() => hardPurgeUser(user))).success).toBe(true);
    await home.run(() => eraseMentionsInOtherTenants(100));

    // Every column of every table, in every tenant.
    const { rows: tables } = await owner<{ table_name: string; column_name: string }>(
      `select c.table_name, c.column_name
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
          and t.table_type = 'BASE TABLE'
        where c.table_schema = 'public'
        order by 1, 2`
    );
    expect(tables.length).toBeGreaterThan(200); // self-test
    const found: string[] = [];
    const needles = Object.values(S);
    for (const { table_name, column_name } of tables) {
      const key = `${table_name}.${column_name}`;
      const { rows } = await owner<{ needle: string }>(
        `select n.needle from unnest($1::text[]) as n(needle)
          where exists (select 1 from public.${quote(table_name)} x
                         where x.${quote(column_name)}::text ilike '%' || n.needle || '%')`,
        [needles]
      );
      for (const r of rows) {
        if (ALLOWED[key] && r.needle === S.sub) continue;
        found.push(`${key} holds ${nameOf(r.needle)}`);
      }
    }
    expect(found).toEqual([]);
  }, 120_000);

  it("takes nothing of anyone else: the bystander's account, device and the record about them stand", async () => {
    const { rows: u } = await owner<{ display_name: string; deleted_at: Date | null }>(
      "select display_name, deleted_at from users where id = $1::uuid",
      [bystander]
    );
    expect(u[0]).toEqual({ display_name: B.display, deleted_at: null });
    const { rows: d } = await owner<{ n: number }>(
      "select count(*)::int as n from user_devices where user_id = $1::uuid and device_name = $2",
      [bystander, B.device]
    );
    expect(d[0].n).toBe(1);
    // The record the erased account wrote about the bystander keeps its text (item 6).
    const { rows: a } = await owner<{ reason: string | null; erased: boolean | null }>(
      `select details->>'reason' as reason, (details->>'textErased')::boolean as erased
         from audit_log where tenant_id = $1 and target_id = $2::uuid
          and details->>'type' = 'block_user_feature'`,
      [home.id, bystander]
    );
    expect(a).toEqual([{ reason: B.reason, erased: null }]);
  });
});

function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier))
    throw new Error(`unexpected name ${identifier}`);
  return `"${identifier}"`;
}

function nameOf(needle: string): string {
  return Object.entries(S).find(([, v]) => v === needle)?.[0] ?? "?";
}
