/**
 * e2e/admin-routes.spec.ts — every admin and operator route walked on the production build and
 * the replayed database (TASK-204: N-38, N-39; Playform's copy is the same file)
 *
 * TASK-202's e2e/admin-console.spec.ts walks the fixed flows (a setting held and approved, an agent
 * registered, an erasure's attestation). This walks the rest, as the deployment's own
 * administrators — the test double's admin-a and admin-b, both super_admin, so both operators of
 * a single-tenant deployment (platform_operate) — and records nothing by hand that a screen or a
 * route can do:
 *
 *   1. every console section opens and reads its view (read views first: the S7 order);
 *   2. an erasure: admin-a asks to erase an account (held: dual control), cannot approve its own
 *      request, admin-b approves it, the account is purged and the purge recorded (user_deletions,
 *      read through the owner connection); the operators' open-erasure list and the attestation of
 *      an unverified step (refused: nothing is unverified) read;
 *   3. the jobs console: a schedule turned off and on again, run now (the worker runs it); an
 *      unknown dead job refused by its code;
 *   4. the tenancy operator routes on a single-tenant deployment: a tenant provisioned, renamed,
 *      suspended and resumed, an address mapped, the export streamed, the due purge run; what a
 *      single-tenant deployment refuses refused by its code (the tenant's settings and holds, its
 *      agents, the operators' own tenant suspended or deleted, a super_admin granted outside the
 *      database, an unknown deletion request decided);
 *   5. the remaining reads and governed writes: readiness, the AI planner (refused by its code
 *      without a model key, as in CI) and the config assistant (it answers without one), the
 *      password policy read and written back, the entitlement groups and the users read, and —
 *      last, since it stops every agent — the kill switch, which says what it suspended.
 *
 * Seeded once, through the owner connection: the two administrators (ADR-013's documented
 * first-super-admin bootstrap — dual control needs a second) and the account the erasure journey
 * erases. Runs where the harness gives it a database (E2E_DATABASE_OWNER_URL); skipped, saying
 * so, without one.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";
import { Client } from "pg";
import { sessionFetch, signInPage } from "./helpers/session";

const OWNER_URL = process.env.E2E_DATABASE_OWNER_URL;
const TENANT = "00000000-0000-4000-8000-000000000001";

const ADMIN_A = {
  id: "e2e00000-0000-4000-8000-00000000000a",
  email: "admin-a@e2e.test",
};
const ADMIN_B = {
  id: "e2e00000-0000-4000-8000-00000000000b",
  email: "admin-b@e2e.test",
};
/** The account the erasure journey erases (a plain user, seeded). */
const LEAVER = {
  id: "e2e00000-0000-4000-8000-0000000000c1",
  email: "leaver@e2e.test",
};

// Serial: each step builds on the one before. The admin routes' rate limit (below) is waited out,
// not bypassed, so a test may wait up to a minute for its window: the timeout allows for it.
test.describe.configure({ mode: "serial", timeout: 300_000 });
test.skip(!OWNER_URL, "needs the harness's database (E2E_DATABASE_OWNER_URL)");

test.beforeAll(async () => {
  const db = new Client({ connectionString: OWNER_URL });
  await db.connect();
  try {
    for (const admin of [ADMIN_A, ADMIN_B]) {
      await db.query(
        `insert into users (id, cognito_sub, email, display_name, role_id, tenant_id, email_verified)
         select $1::uuid, $1, $2, $3, r.id, $4::uuid, true from roles r where r.name = 'super_admin'
         on conflict (id) do update set role_id = excluded.role_id, deleted_at = null`,
        [admin.id, admin.email, admin.email.split("@")[0], TENANT]
      );
    }
    await db.query(
      `insert into users (id, cognito_sub, email, display_name, role_id, tenant_id, email_verified)
       select $1::uuid, $1, $2, 'leaver', r.id, $3::uuid, true from roles r where r.is_default
       on conflict (id) do nothing`,
      [LEAVER.id, LEAVER.email, TENANT]
    );
  } finally {
    await db.end();
  }
});

/** A request's answer: its status, its text, and its JSON body (an object; {} when it is not one). */
async function answer(
  res: APIResponse
): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON (the export streams NDJSON): the text is the answer.
  }
  return { status: res.status(), text, body };
}

/**
 * The admin routes share one rate limit per address (DEFAULT_RULES.ADMIN_OPS, 30 a minute), and
 * every request here comes from one address: a 429 is waited out for its Retry-After and the
 * request made again — paced, as the monkey's sequences are, never bypassed.
 */
async function waitOut(retryAfter: string | undefined): Promise<void> {
  const seconds = Math.min(Math.max(Number(retryAfter) || 5, 1), 65);
  await new Promise((r) => setTimeout(r, seconds * 1000));
}

/** A request as `admin` — its own cookie session (e2e/helpers/session.ts), whatever `_api` holds. */
async function apiFetch(
  _api: APIRequestContext,
  admin: typeof ADMIN_A,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  data?: unknown
) {
  for (let attempt = 0; ; attempt++) {
    const res = await sessionFetch(admin, method, path, data);
    if (res.status() !== 429 || attempt >= 3) return answer(res);
    await waitOut(res.headers()["retry-after"]);
  }
}

async function openConsole(page: Page, admin: typeof ADMIN_A): Promise<void> {
  await signInPage(page, admin);
  for (let attempt = 0; ; attempt++) {
    const session = page.waitForResponse((r) => r.url().endsWith("/api/admin/session"));
    await page.goto("/admin");
    const res = await session;
    if (res.status() !== 429 || attempt >= 3) {
      expect(res.status()).toBe(200);
      return;
    }
    await waitOut(res.headers()["retry-after"]);
  }
}

test.use({ viewport: { width: 1280, height: 900 } });

test("1. every console section opens and reads its view (N-38, N-39)", async ({
  page,
}) => {
  await openConsole(page, ADMIN_A);
  // Each section's own read, as the console asks it (app/admin/page.tsx ENDPOINTS; the Users
  // panel reads its own pages).
  const sections: [RegExp, string][] = [
    [/^Roles/, "/api/admin/roles"],
    [/^Entitlements/, "/api/admin/entitlements"],
    [/^Password policy/, "/api/admin/password-policy"],
    [/^Per-account/, "/api/admin/per-account"],
    [/^Approval policy/, "/api/admin/approval-policy"],
    [/^Capabilities$/, "/api/admin/capabilities"],
    [/^Capability map$/, "/api/admin/capability-mapping"],
    [/^Tenant$/, "/api/admin/tenant"],
    [/^Tenants/, "/api/operator/tenants"],
    [/^Jobs/, "/api/operator/jobs"],
    // Last: the console opens on Users, so it is read again only once another section was open.
    [/^Users$/, "/api/admin/users"],
  ];
  for (const [name, path] of sections) {
    let status = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      // A section already open is left first, so a click reads it again.
      if (attempt > 0)
        await page
          .getByRole("navigation")
          .getByRole("button", { name: /^Audit/ })
          .click();
      const read = page.waitForResponse((r) => new URL(r.url()).pathname === path);
      await page.getByRole("navigation").getByRole("button", { name }).click();
      const res = await read;
      status = res.status();
      if (status !== 429) break;
      await waitOut(res.headers()["retry-after"]);
    }
    expect([path, status]).toEqual([path, 200]);
    // The view says something: no "could not be read".
    await expect(page.getByRole("main")).not.toContainText(/could not be read/i);
  }
});

/** A refusal's code: the API's error answers carry one (platform/errors). */
const codeOf = (r: { body: Record<string, unknown> }) => r.body.code;

test("2. an erasure: asked, held, approved by a second administrator, purged and recorded (N-39)", async ({
  request,
}) => {
  const asked = await apiFetch(request, ADMIN_A, "POST", "/api/admin/gdpr", {
    userId: LEAVER.id,
    reason: "user-request",
  });
  expect(asked.status).toBe(202);
  expect(asked.body).toMatchObject({ held: true });
  const holdId = String(asked.body.proposalId ?? "");
  expect(holdId).toMatch(/^[0-9a-f-]{36}$/);

  const pending = await apiFetch(
    request,
    ADMIN_A,
    "GET",
    `/api/admin/gdpr?userId=${LEAVER.id}`
  );
  expect(pending.status).toBe(200);
  expect(pending.body.pending).toMatchObject({ proposalId: holdId });

  // The requester cannot clear its own request; the second administrator can.
  const self = await apiFetch(
    request,
    ADMIN_A,
    "POST",
    `/api/admin/approvals/${holdId}`,
    {
      decision: "approve",
      source: "runtime",
    }
  );
  expect([self.status, codeOf(self)]).toEqual([409, "approvals.self_approval"]);
  const approved = await apiFetch(
    request,
    ADMIN_B,
    "POST",
    `/api/admin/approvals/${holdId}`,
    { decision: "approve", source: "runtime" }
  );
  expect(approved.status).toBe(200);
  expect(approved.body).toMatchObject({ outcome: "approved", applied: true });

  const after = await apiFetch(
    request,
    ADMIN_B,
    "GET",
    `/api/admin/gdpr?userId=${LEAVER.id}`
  );
  expect(after.body.pending).toBeNull();

  // Purged and recorded: the account's row is gone and its deletion record says when.
  const db = new Client({ connectionString: OWNER_URL });
  await db.connect();
  try {
    const user = await db.query("select 1 from users where id = $1::uuid", [LEAVER.id]);
    expect(user.rowCount).toBe(0);
    const record = await db.query(
      "select purged_at from user_deletions where user_id = $1::uuid",
      [LEAVER.id]
    );
    expect(record.rows[0]?.purged_at).toBeTruthy();
  } finally {
    await db.end();
  }

  const open = await apiFetch(request, ADMIN_B, "GET", "/api/operator/erasures");
  expect(open.status).toBe(200);
  expect(Array.isArray(open.body.erasures)).toBe(true);

  // Every step of this erasure was verified: there is nothing for an operator to attest.
  const attest = await apiFetch(
    request,
    ADMIN_B,
    "POST",
    `/api/operator/tenants/${TENANT}/erasures/${LEAVER.id}/attestation`,
    { reason: "pool_decommissioned", note: "e2e" }
  );
  expect([attest.status, codeOf(attest)]).toEqual([409, "tenant.conflict"]);
});

test("3. the jobs console: a schedule turned off and on, run now; an unknown dead job refused (N-39)", async ({
  request,
}) => {
  const jobs = await apiFetch(request, ADMIN_A, "GET", "/api/operator/jobs");
  expect(jobs.status).toBe(200);
  const schedules = (jobs.body.schedules as { kind: string; enabled: boolean }[]) ?? [];
  const kind = "moderation.release-claims";
  expect(schedules.find((s) => s.kind === kind)?.enabled).toBe(true);

  const off = await apiFetch(
    request,
    ADMIN_A,
    "PATCH",
    `/api/operator/jobs/schedules/${kind}`,
    {
      enabled: false,
      changeComment: "e2e: off for the journey",
    }
  );
  expect(off.body).toMatchObject({ success: true, value: false });
  const listed = await apiFetch(request, ADMIN_A, "GET", "/api/operator/jobs");
  const now = (listed.body.schedules as { kind: string; enabled: boolean }[]) ?? [];
  expect(now.find((s) => s.kind === kind)?.enabled).toBe(false);

  const run = await apiFetch(
    request,
    ADMIN_A,
    "POST",
    `/api/operator/jobs/schedules/${kind}/run`,
    {}
  );
  expect(run.status).toBe(200);
  expect(run.body.result).toMatchObject({ enqueued: 1 });

  const on = await apiFetch(
    request,
    ADMIN_A,
    "PATCH",
    `/api/operator/jobs/schedules/${kind}`,
    {
      enabled: true,
      changeComment: "e2e: back on",
    }
  );
  expect(on.body).toMatchObject({ success: true, value: true });

  const dead = await apiFetch(
    request,
    ADMIN_A,
    "POST",
    "/api/operator/jobs/dead/00000000-0000-4000-8000-0000000000ff",
    { action: "replay" }
  );
  expect([dead.status, codeOf(dead)]).toEqual([404, "jobs.not_found"]);
});

test("4. the tenancy operator routes on a single-tenant deployment (N-39)", async ({
  request,
}) => {
  const tenants = await apiFetch(request, ADMIN_A, "GET", "/api/operator/tenants");
  expect(tenants.status).toBe(200);

  const made = await apiFetch(request, ADMIN_A, "POST", "/api/operator/tenants", {
    slug: `e2e-${Date.now().toString(36)}`,
    name: "Two",
  });
  expect(made.status).toBe(201);
  const other = String((made.body.result as { id?: string } | undefined)?.id ?? "");
  expect(other).toMatch(/^[0-9a-f-]{36}$/);

  const renamed = await apiFetch(
    request,
    ADMIN_A,
    "PATCH",
    `/api/operator/tenants/${other}`,
    {
      name: "Two, renamed",
    }
  );
  expect(renamed.body.result).toMatchObject({ name: "Two, renamed" });
  const suspended = await apiFetch(
    request,
    ADMIN_A,
    "POST",
    `/api/operator/tenants/${other}/state`,
    {
      action: "suspend",
      reason: "e2e",
    }
  );
  expect(suspended.body.result).toMatchObject({ status: "suspended" });
  const resumed = await apiFetch(
    request,
    ADMIN_A,
    "POST",
    `/api/operator/tenants/${other}/state`,
    {
      action: "resume",
      reason: "e2e",
    }
  );
  expect(resumed.body.result).toMatchObject({ status: "active" });

  const mapped = await apiFetch(
    request,
    ADMIN_A,
    "POST",
    `/api/operator/tenants/${TENANT}/domains`,
    {
      host: `e2e-${Date.now().toString(36)}.example.test`,
    }
  );
  expect(mapped.status).toBe(201);
  // TASK-206 (N-103): an address just added is removed — it was 404 while the directory was kept
  // in memory and the removal read the database. A second one is mapped first: the operators'
  // own tenant keeps at least one address (tenant.own_tenant).
  const mappedHost = String(
    (mapped.body.result as { host?: string } | undefined)?.host ?? ""
  );
  expect(mappedHost).toMatch(/^e2e-/);
  const kept = await apiFetch(
    request,
    ADMIN_A,
    "POST",
    `/api/operator/tenants/${TENANT}/domains`,
    {
      host: `e2e-kept-${Date.now().toString(36)}.example.test`,
    }
  );
  expect(kept.status).toBe(201);
  const removed = await apiFetch(
    request,
    ADMIN_A,
    "DELETE",
    `/api/operator/tenants/${TENANT}/domains?host=${encodeURIComponent(mappedHost)}`
  );
  expect([removed.status, removed.body.result]).toEqual([200, true]);
  const unmapped = await apiFetch(
    request,
    ADMIN_A,
    "DELETE",
    `/api/operator/tenants/${TENANT}/domains?host=never-mapped.example.test`
  );
  expect([unmapped.status, codeOf(unmapped)]).toEqual([404, "tenant.not_found"]);

  // The export streams NDJSON: its first line is the tenant's header.
  const exported = await apiFetch(
    request,
    ADMIN_A,
    "GET",
    `/api/operator/tenants/${TENANT}/export`
  );
  expect(exported.status).toBe(200);
  const first = JSON.parse(exported.text.split("\n")[0]) as Record<string, unknown>;
  expect(first.export).toMatchObject({ tenant: { id: TENANT } });

  const purge = await apiFetch(request, ADMIN_B, "POST", "/api/operator/purge", {});
  expect(purge.status).toBe(200);
  expect(Array.isArray(purge.body.result)).toBe(true);

  // What a single-tenant deployment, or the rules, refuse — each by its code.
  const refusals: [
    string,
    "GET" | "POST" | "PUT" | "DELETE",
    string,
    unknown,
    number,
    string,
  ][] = [
    [
      "its settings",
      "GET",
      `/api/operator/tenants/${TENANT}/config`,
      undefined,
      409,
      "tenant.not_shared",
    ],
    [
      "a setting",
      "PUT",
      `/api/operator/tenants/${TENANT}/config`,
      { key: "moderation.strike_ban_threshold", value: 3 },
      409,
      "tenant.not_shared",
    ],
    [
      "a setting cleared",
      "DELETE",
      `/api/operator/tenants/${TENANT}/config?key=moderation.strike_ban_threshold`,
      undefined,
      409,
      "tenant.not_shared",
    ],
    [
      "its holds",
      "GET",
      `/api/operator/tenants/${TENANT}/approvals`,
      undefined,
      409,
      "tenant.not_shared",
    ],
    [
      "a hold decided",
      "POST",
      `/api/operator/tenants/${TENANT}/approvals/00000000-0000-4000-8000-0000000000ff`,
      { decision: "reject", source: "runtime" },
      409,
      "tenant.not_shared",
    ],
    [
      "its agents stopped",
      "POST",
      `/api/operator/tenants/${other}/agents/suspend`,
      { reason: "e2e" },
      409,
      "tenant.not_shared",
    ],
    [
      "the operators' own tenant suspended",
      "POST",
      `/api/operator/tenants/${TENANT}/state`,
      { action: "suspend", reason: "e2e" },
      403,
      "tenant.own_tenant",
    ],
    [
      "the operators' own tenant deleted",
      "POST",
      `/api/operator/tenants/${TENANT}/deletion`,
      { reason: "e2e" },
      403,
      "tenant.own_tenant",
    ],
    [
      "a super_admin granted outside the database",
      "POST",
      `/api/operator/tenants/${TENANT}/admins`,
      { email: ADMIN_B.email },
      403,
      "auth.role_database_only",
    ],
    [
      "an unknown deletion request decided",
      "POST",
      "/api/operator/deletions/00000000-0000-4000-8000-0000000000ff",
      { decision: "approve" },
      404,
      "tenant.not_found",
    ],
  ];
  for (const [what, method, path, data, status, code] of refusals) {
    const r = await apiFetch(request, ADMIN_B, method, path, data);
    expect([what, r.status, codeOf(r)]).toEqual([what, status, code]);
  }

  // TASK-206 (N-103): the tenant provisioned above is deleted, asked by one operator and approved
  // by the other — the deletion read the database, where the in-memory directory's tenant was not.
  const asked = await apiFetch(
    request,
    ADMIN_A,
    "POST",
    `/api/operator/tenants/${other}/deletion`,
    {
      reason: "e2e",
    }
  );
  expect([asked.status, asked.body.result]).toEqual([
    202,
    expect.objectContaining({ status: "pending" }),
  ]);
  const requestId = String((asked.body.result as { id?: string } | undefined)?.id ?? "");
  const decided = await apiFetch(
    request,
    ADMIN_B,
    "POST",
    `/api/operator/deletions/${requestId}`,
    {
      decision: "approve",
      note: "e2e",
    }
  );
  expect([decided.status, decided.body.result]).toEqual([
    200,
    expect.objectContaining({ status: "executed" }),
  ]);
});

test("5. the remaining reads and governed writes, and last the kill switch (N-38, N-39)", async ({
  request,
}) => {
  const ready = await apiFetch(request, ADMIN_A, "GET", "/api/operator/readiness");
  expect(ready.status).toBe(200);
  expect(ready.body).toMatchObject({ mode: "single", tenantId: TENANT });

  // Without a model key (CI) the planner refuses by its code; the config assistant answers.
  const planner = await apiFetch(request, ADMIN_A, "POST", "/api/admin/ai", {
    prompt: "list the roles",
    panel: "roles",
  });
  if (process.env.ANTHROPIC_API_KEY) expect(planner.status).toBe(200);
  else expect([planner.status, codeOf(planner)]).toEqual([503, "service.unavailable"]);
  const assistant = await apiFetch(request, ADMIN_A, "POST", "/api/admin/config-ai", {
    message: "what can you do?",
  });
  expect(assistant.status).toBe(200);
  // The reply is the catalog's key (TASK-206, N-102).
  expect(assistant.body.response).toMatchObject({
    key: expect.stringMatching(/^screens\.admin_console\.config_ai\./),
  });

  const policy = await apiFetch(request, ADMIN_A, "GET", "/api/admin/password-policy");
  expect(policy.status).toBe(200);
  const put = await apiFetch(
    request,
    ADMIN_A,
    "PUT",
    "/api/admin/password-policy",
    policy.body.policy
  );
  expect(put.body).toMatchObject({ success: true, policy: policy.body.policy });

  const groups = await apiFetch(request, ADMIN_A, "GET", "/api/admin/entitlements");
  expect(groups.status).toBe(200);
  expect(Array.isArray(groups.body.groups)).toBe(true);

  const users = await apiFetch(request, ADMIN_A, "GET", "/api/admin/users");
  expect(users.status).toBe(200);
  const emails = ((users.body.users as { email: string }[]) ?? []).map((u) => u.email);
  expect(emails).toEqual(expect.arrayContaining([ADMIN_A.email, ADMIN_B.email]));

  const stop = await apiFetch(request, ADMIN_A, "POST", "/api/admin/agents/suspend", {
    reason: "e2e: the kill switch",
  });
  expect(stop.status).toBe(200);
  expect(Array.isArray(stop.body.suspended)).toBe(true);
  expect(Array.isArray(stop.body.withdrawn)).toBe(true);
});
