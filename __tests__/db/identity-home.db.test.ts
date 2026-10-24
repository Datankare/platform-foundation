/**
 * @jest-environment node
 */
/**
 * An existing account keeps its tenant (platform/tenancy/identity.ts, ADR-053 D2) — against the
 * replayed database: the lookup finds the account in whichever tenant holds it.
 */

// The real data layer, with a switch to make one statement fail (the database unreachable).
jest.mock("@/platform/data", () => require("../helpers/data-faults").withFaults());
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { registerAuthProvider } from "@/platform/auth/config";
import { clearConfigCache } from "@/platform/auth/platform-config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import type { AuthProvider } from "@/platform/auth/provider";
import { runWithTenant } from "@/platform/tenancy/context";
import { ensureIdentityTenant, signupsOpen } from "@/platform/tenancy/identity";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";
import { clearFaults, faults } from "../helpers/data-faults";
import { insertUser, seededRoleId } from "../helpers/db-admin";

dbDescribe("an existing account keeps its tenant", () => {
  let a: TestTenant;
  let b: TestTenant;
  let provider: AuthProvider;
  let token: string;
  let sub: string;

  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    b = await createTestTenant();
  });
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  afterEach(() => clearFaults());

  beforeEach(async () => {
    clearConfigCache();
    // Each test a fresh identity (the mock's one subject, made unique per test).
    sub = crypto.randomUUID();
    const base = createMockAuthProvider();
    const tenants = new Map<string, string>();
    provider = {
      ...base,
      verifyToken: async (t: string) => {
        const p = await base.verifyToken(t);
        return p
          ? { ...p, sub, ...(tenants.has(sub) ? { tenantId: tenants.get(sub) } : {}) }
          : null;
      },
      assignTenant: async (u: string, t: string) => {
        tenants.set(u, t);
        return { success: true };
      },
      getUserTenant: async (u: string) => tenants.get(u) ?? null,
    };
    registerAuthProvider(provider);
    token = (await base.signIn("x@y.z", "pw")).accessToken as string;
  });

  const at = (t: TestTenant) => (fn: () => Promise<unknown>) =>
    runWithTenant({ tenantId: t.id, mode: "shared" }, fn);

  it("an account held by A is refused at B, and stays unassigned", async () => {
    await insertUser(a, { roleId: await seededRoleId("free"), cognitoSub: sub });
    await expect(at(b)(() => ensureIdentityTenant(token))).resolves.toEqual({
      ok: false,
      code: "tenant.mismatch",
    });
    await expect(provider.getUserTenant!(sub)).resolves.toBeNull();
  });

  it("an account held by A is assigned A at A's address", async () => {
    await insertUser(a, { roleId: await seededRoleId("free"), cognitoSub: sub });
    await expect(at(a)(() => ensureIdentityTenant(token))).resolves.toEqual({ ok: true });
    await expect(provider.getUserTenant!(sub)).resolves.toBe(a.id);
  });

  it("an identity with no account anywhere joins the address's tenant", async () => {
    await expect(at(b)(() => ensureIdentityTenant(token))).resolves.toEqual({ ok: true });
    await expect(provider.getUserTenant!(sub)).resolves.toBe(b.id);
  });

  it("sign-ups are closed when signups_enabled cannot be read — a new identity is refused", async () => {
    // The stored value is readable: open (the platform default is true).
    await expect(at(b)(() => signupsOpen())).resolves.toBe(true);
    clearConfigCache();
    // The read fails: closed, and the new identity gets no tenant and no session.
    faults.fail = (sql) =>
      /platform_config/.test(sql) ? new Error("connection terminated") : undefined;
    await expect(at(b)(() => signupsOpen())).resolves.toBe(false);
    await expect(at(b)(() => ensureIdentityTenant(token))).resolves.toEqual({
      ok: false,
      code: "auth.signups_closed",
    });
    await expect(provider.getUserTenant!(sub)).resolves.toBeNull();
  });
});
