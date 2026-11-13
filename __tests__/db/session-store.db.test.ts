/**
 * @jest-environment node
 */
/**
 * PostgresSessionStore against the replayed database (ADR-057 D1, migration 070): the
 * conformance kit inside one tenant, the store isolated between tenants under row-level
 * security, and what the table itself refuses.
 */

import { createHash } from "node:crypto";
import { runSessionStoreContract } from "../contract/session-store-contract";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { PostgresSessionStore, type NewSession } from "@/platform/auth/session-store";
import type { SealedTokens } from "@/platform/auth/session-vault";
import { withOwnerTx } from "@/platform/data";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  inTenant,
} from "../helpers/db";

const idHashFor = (key: string) => createHash("sha256").update(key).digest("hex");
const record = (key: string, over: Partial<NewSession> = {}): NewSession => ({
  idHash: idHashFor(key),
  kind: "user",
  subject: "user-a",
  method: "password",
  csrfToken: "c".repeat(43),
  sealedTokens: "v1.kit" as SealedTokens,
  createdAt: 1_800_000_000_000,
  lastSeenAt: 1_800_000_000_000,
  ...over,
});

dbDescribe("PostgresSessionStore", () => {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  runSessionStoreContract({
    makeStore: async () => inTenant(new PostgresSessionStore(), await createTestTenant()),
  });

  runTenantIsolationContract({
    name: "sign-in sessions",
    makeStore: () => new PostgresSessionStore(),
    createTenant: createTestTenant,
    write: (store, key) => store.open(record(key)),
    read: async (store, key) => {
      const found = await store.find(idHashFor(key));
      return found && found.revokedAt === undefined ? found : null;
    },
    update: async (store, key) => {
      await store.revoke(idHashFor(key), "sign_out", Date.now());
    },
    remove: (store) => store.reset(),
  });

  it("another tenant cannot end a subject's sessions, or count them", async () => {
    const a = await createTestTenant();
    const b = await createTestTenant();
    const store = new PostgresSessionStore();
    await a.run(() => store.open(record("shared-subject")));
    await expect(
      b.run(() => store.revokeSubject("user-a", "sign_out_everywhere", Date.now()))
    ).resolves.toEqual([]);
    await expect(b.run(() => store.countLive("user-a"))).resolves.toBe(0);
    await expect(a.run(() => store.countLive("user-a"))).resolves.toBe(1);
  });

  it("hostile, through the real guard: a session id stolen from tenant A is no session at tenant B's deployment — and is not ended in A", async () => {
    const { NextRequest } = await import("next/server");
    const { requireAuth } = await import("@/platform/auth/middleware");
    const { runRequestScope } = await import("@/platform/tenancy/context");
    const { setSessionStore } = await import("@/platform/auth/session-store");
    const { registerAuthProvider } = await import("@/platform/auth/config");
    const { createMockAuthProvider } = await import("@/platform/auth/mock-provider");
    const { startTestSession, MOCK_SUBJECT } = await import("../helpers/session");
    registerAuthProvider(createMockAuthProvider());
    setSessionStore(new PostgresSessionStore());
    const a = await createTestTenant();
    const b = await createTestTenant();
    const stolen = await startTestSession({ subject: MOCK_SUBJECT, tenantId: a.id });
    const saved = { mode: process.env.TENANCY_MODE, tenant: process.env.TENANT_ID };
    /** One GET with the stolen cookie, at the single-tenant deployment of `tenantId`. */
    const present = async (tenantId: string) => {
      delete process.env.TENANCY_MODE;
      process.env.TENANT_ID = tenantId;
      try {
        return await runRequestScope(() =>
          requireAuth(
            new NextRequest("http://localhost/api/x", {
              headers: { cookie: stolen.cookie },
            })
          )
        );
      } finally {
        if (saved.mode === undefined) delete process.env.TENANCY_MODE;
        else process.env.TENANCY_MODE = saved.mode;
        if (saved.tenant === undefined) delete process.env.TENANT_ID;
        else process.env.TENANT_ID = saved.tenant;
      }
    };
    const atB = await present(b.id);
    expect(atB.error?.status).toBe(401);
    expect(atB.user).toBeUndefined();
    // Not ended in its own tenant by the attempt: its owner is still signed in there.
    const store = new PostgresSessionStore();
    const inA = await a.run(() => store.find(stolen.idHash));
    expect(inA?.subject).toBe(MOCK_SUBJECT);
    expect(inA?.revokedAt).toBeUndefined();
    await expect(b.run(() => store.find(stolen.idHash))).resolves.toBeNull();
    const atA = await present(a.id);
    expect(atA.error).toBeUndefined();
    expect(atA.user?.sub).toBe(MOCK_SUBJECT);
  });

  it("the table stores no raw session id: only a SHA-256 is accepted", async () => {
    const t = await createTestTenant();
    const store = new PostgresSessionStore();
    await expect(
      t.run(() => store.open(record("x", { idHash: "A".repeat(43) })))
    ).rejects.toThrow(/auth_sessions_id_hash_shape/);
  });

  it("the stored row holds the sealed text and no column a browser could present", async () => {
    const t = await createTestTenant();
    const store = new PostgresSessionStore();
    await t.run(() => store.open(record("row")));
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<Record<string, unknown>>(
        "select * from auth_sessions where tenant_id = $1::uuid",
        [t.id]
      )
    );
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([
      "created_at",
      "csrf_token",
      "id_hash",
      "kind",
      "last_seen_at",
      "method",
      "revoked_at",
      "revoked_reason",
      "sealed_tokens",
      "subject",
      "tenant_id",
      "token_version",
    ]);
    expect(rows[0].id_hash).toBe(idHashFor("row"));
  });
});
