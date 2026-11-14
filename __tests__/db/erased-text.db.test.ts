/**
 * @jest-environment node
 */
/**
 * __tests__/db/erased-text.db.test.ts — once an account is erased, nothing confirms what it wrote
 * (TASK-215, audit A-5, A-6)
 *
 * Hostile: a person's screened text is known to whoever guesses it. Before, the decision kept the
 * text's unkeyed SHA-256 after the erasure (hash a guess, compare) and the classifier model's own
 * words, which can quote the text. Here a decision is recorded through the real moderation store,
 * with an older row of the account carrying the model's words and an unkeyed hash; the account is
 * erased; then no row of content_safety_audit may hold the text, its unkeyed hash, its keyed hash
 * under the current or the previous key, or any model words. And in a session the account shared
 * with another participant, its own moves keep nothing of what it typed or what that produced,
 * while the other participant's moves stand (sessionMoveText).
 */

import { createHash, randomUUID } from "node:crypto";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";
import { withOwnerTx, withTenantTx } from "@/platform/data";
import { eraseUserData } from "@/platform/auth/user-data";
import { buildAuditRecord } from "@/platform/moderation/audit";
import { PostgresModerationStore } from "@/platform/moderation/store";
import { RECORD_HASH, recordHashCandidates } from "@/platform/auth/record-hash";
import type { ModerationResult } from "@/platform/moderation/types";

const owner = <R extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  withOwnerTx("tenant-lifecycle", (tx) => tx.query<R>(sql, values));

dbDescribe("an erased account's text is not confirmable (TASK-215, A-5, A-6)", () => {
  let t: TestTenant;

  beforeAll(async () => {
    await connectTestDatabase();
    t = await createTestTenant();
  });

  afterAll(async () => {
    delete process.env.RECORD_HASH_KEY_PREVIOUS;
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  it("keeps only a keyed hash while the account lives, and nothing of its text once erased", async () => {
    process.env.RECORD_HASH_KEY_PREVIOUS = "p".repeat(40);
    const user = await t.user("writer");
    const text = `my secret plan ${randomUUID()}`;
    const result = {
      action: "block",
      triggeredBy: "classifier",
      direction: "input",
      contentType: "translation",
      contentRatingLevel: 1,
      blocklistMatches: [],
      classifierOutput: {
        safe: false,
        categories: ["harassment"],
        confidence: 0.9,
        severity: "high",
      },
      reasoning: [],
      severityAdjustment: 0,
      contextFactors: [],
      attributeToUser: true,
      pipelineLatencyMs: 1,
      classifierCostUsd: 0,
      trajectoryId: randomUUID(),
      agentId: "guardian",
    } as unknown as ModerationResult;
    const record = await buildAuditRecord(text, result, "req-a6", user);
    expect(record.inputHash).toMatch(RECORD_HASH);
    await t.run(() => new PostgresModerationStore().logAudit(record));
    // A row written before TASK-215: the unkeyed hash, and the model's own words quoting the text.
    const sha = createHash("sha256").update(text).digest("hex");
    await owner(
      `insert into content_safety_audit (tenant_id, input_hash, user_id, classifier_output, trajectory_id, agent_id, request_id)
       values ($1, $2, $3, $4::jsonb, 't', 'guardian', 'old')`,
      [
        t.id,
        sha,
        user,
        JSON.stringify({ safe: false, rawReason: `quotes "${text}"`, reason: text }),
      ]
    );

    // While the account lives, the hash is keyed: the unkeyed hash of the text is nowhere.
    const before = await owner<{ input_hash: string | null }>(
      "select input_hash from content_safety_audit where tenant_id = $1 and request_id = 'req-a6'",
      [t.id]
    );
    expect(before.rows[0].input_hash).toMatch(RECORD_HASH);
    expect(before.rows[0].input_hash).not.toContain(sha);

    await t.run(() => withTenantTx((tx) => eraseUserData(tx, user)));

    const guesses = [text, sha, ...recordHashCandidates("screened-text", text)];
    const { rows } = await owner<{ n: number }>(
      `select count(*)::int as n from content_safety_audit
        where tenant_id = $1
          and (input_hash = any($2::text[]) or classifier_output::text like '%' || $3 || '%'
               or classifier_output ?| array['rawReason', 'reason'])`,
      [t.id, guesses, text]
    );
    expect(rows[0].n).toBe(0);
    // The decisions stand, unattributed, for the statistics.
    const kept = await owner<{ n: number }>(
      "select count(*)::int as n from content_safety_audit where tenant_id = $1 and request_id in ('req-a6', 'old') and user_id is null and input_hash is null",
      [t.id]
    );
    expect(kept.rows[0].n).toBe(2);
  });

  it("[hostile] a shared session keeps nothing the erased account typed in its own moves", async () => {
    const user = await t.user("player");
    const otherId = randomUUID();
    const mine = `my move ${randomUUID()}`;
    const theirs = `their move ${randomUUID()}`;
    const sessionId = `s-${randomUUID()}`;
    await owner(
      `insert into app_sessions (id, tenant_id, state, meta)
       values ($1, $2, '{}'::jsonb, $3::jsonb)`,
      [
        sessionId,
        t.id,
        JSON.stringify({ participants: [{ actorId: user }, { actorId: otherId }] }),
      ]
    );
    const steps = [
      {
        action: "say",
        actor: { actorId: user },
        input: { text: mine },
        output: { echo: mine },
      },
      {
        action: "say",
        actor: { actorId: otherId },
        input: { text: theirs },
        output: { echo: theirs },
      },
    ];
    const runId = randomUUID();
    await owner(
      `insert into agent_trajectories (id, tenant_id, trigger, subject_kind, subject_id, scope_type, steps, status)
       values ($1::uuid, $2, 'session', 'session', $3, 'user', $4::jsonb, 'running')`,
      [runId, t.id, sessionId, JSON.stringify(steps)]
    );

    await t.run(() => withTenantTx((tx) => eraseUserData(tx, user)));

    const { rows } = await owner<{
      steps: { action: string; input: unknown; output: unknown }[];
    }>("select steps from agent_trajectories where id = $1::uuid", [runId]);
    const text = JSON.stringify(rows[0].steps);
    expect(text).not.toContain(mine);
    expect(text).not.toContain(user);
    expect(text).toContain(theirs);
    expect(rows[0].steps.map((x) => [x.action, x.input])).toEqual([
      ["say", {}],
      ["say", { text: theirs }],
    ]);
  });
});
