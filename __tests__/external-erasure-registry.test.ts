/**
 * @jest-environment node
 */
/**
 * __tests__/external-erasure-registry.test.ts — every store outside the database that holds an
 * erased person is erased, its outcome recorded, and retried until done (TASK-193, audit B-8, D-9)
 *
 * The register is platform/gdpr/external-erasure.ts. Before, the sign-in identity was deleted
 * only by the self-service route, with the user's own token, once: an admin or retention erasure
 * never deleted it, and a failed call was logged and forgotten. Here:
 *
 *   - the platform registers the identity provider, first, and an app's store is added beside it;
 *   - the identity provider's step deletes the identity with the administrative credentials
 *     (adminDeleteUser, by the subject): deleted or already gone is done; refused, unavailable,
 *     or a provider without the administrative delete is pending, with its error;
 *   - each run records every store's outcome — done, or its attempts, error and when it is tried
 *     again (a growing interval) — and never runs a store already done again;
 *   - the erasure pipeline runs the register: the soft delete (every erasure: self-service, admin,
 *     consent expiry), the hard purge (which is not complete while one is pending), and the
 *     gdpr.retention-purge job's retry (read from the code, so a path cannot skip it);
 *   - the self-service route no longer deletes the identity itself.
 *
 * The behaviour on Postgres, with faults, is __tests__/db/erasure-reconciliation.db.test.ts.
 */

const mockProvider: {
  adminDeleteUser?: jest.Mock;
  identityPoolId?: () => string;
  confirmIdentityPool?: jest.Mock;
  identityInPool?: jest.Mock;
} = {};
jest.mock("@/platform/auth/auth-init", () => ({ initAuth: jest.fn() }));
jest.mock("@/platform/auth/config", () => ({
  getAuthProvider: () => mockProvider,
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  externalRetryAt,
  IDENTITY_ERASURE,
  listExternalErasures,
  pendingExternalErasures,
  provenIdentityPool,
  registerExternalErasure,
  resetExternalErasures,
  resetIdentityPoolCheck,
  runExternalErasures,
} from "@/platform/gdpr/external-erasure";

const SUB = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const POOL = "eu-west-2_current";

beforeEach(() => {
  mockProvider.identityPoolId = () => POOL;
  mockProvider.confirmIdentityPool = jest.fn(async () => true);
  resetIdentityPoolCheck();
});

afterEach(() => {
  resetExternalErasures();
  delete mockProvider.adminDeleteUser;
});

describe("the external-erasure register (TASK-193)", () => {
  it("holds the identity provider first; an app's store is added beside it", () => {
    expect(listExternalErasures().map((e) => e.name)).toEqual(["identity-provider"]);
    registerExternalErasure({
      name: "app-files",
      holds: "uploaded files",
      erase: async () => ({ done: true }),
    });
    expect(listExternalErasures().map((e) => e.name)).toEqual([
      "identity-provider",
      "app-files",
    ]);
  });

  it("deletes the identity with the administrative credentials, by its subject", async () => {
    mockProvider.adminDeleteUser = jest.fn(async () => ({ success: true }));
    await expect(IDENTITY_ERASURE.erase({ userId: "u", sub: SUB })).resolves.toEqual({
      done: true,
    });
    expect(mockProvider.adminDeleteUser).toHaveBeenCalledWith(SUB);
  });

  it("an identity already gone, in the pool recorded, is done; an account that never had one has nothing to delete", async () => {
    mockProvider.adminDeleteUser = jest.fn(async () => ({
      success: true,
      notFound: true,
    }));
    await expect(
      IDENTITY_ERASURE.erase({ userId: "u", sub: SUB, pool: POOL })
    ).resolves.toEqual({ done: true });
    mockProvider.adminDeleteUser.mockClear();
    await expect(IDENTITY_ERASURE.erase({ userId: "u", sub: null })).resolves.toEqual({
      done: true,
    });
    expect(mockProvider.adminDeleteUser).not.toHaveBeenCalled();
  });

  // Owner decision (TASK-193), bounded in review round 1 (item 3): an identity the pool does not
  // have counts as erased — when the erasure's recorded pool is the current one, confirmed.
  it("an identity not in the recorded, confirmed pool is recorded erased, and never pending", async () => {
    mockProvider.adminDeleteUser = jest.fn(async () => ({
      success: true,
      notFound: true,
    }));
    const run = await runExternalErasures({ userId: "u", sub: SUB, pool: POOL }, {});
    expect(run.pending).toEqual([]);
    expect(run.outcomes["identity-provider"].doneAt).toBeTruthy();
    expect(pendingExternalErasures(run.outcomes)).toEqual([]);
    const again = await runExternalErasures(
      { userId: "u", sub: SUB, pool: POOL },
      run.outcomes
    );
    expect(mockProvider.adminDeleteUser).toHaveBeenCalledTimes(1);
    expect(again.pending).toEqual([]);
    expect(mockProvider.confirmIdentityPool).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another pool recorded", "eu-west-2_old", true],
    ["no pool recorded (an erasure from before 060)", null, true],
    ["the pool not confirmed", POOL, false],
  ])(
    "not found, with %s: pending and marked pool-unverified, never done (round 1, item 3)",
    async (_how, recorded, confirmed) => {
      mockProvider.adminDeleteUser = jest.fn(async () => ({
        success: true,
        notFound: true,
      }));
      mockProvider.confirmIdentityPool = jest.fn(async () => confirmed);
      const run = await runExternalErasures(
        { userId: "u", sub: SUB, pool: recorded },
        {}
      );
      expect(run.pending).toEqual(["identity-provider"]);
      expect(run.outcomes["identity-provider"]).toMatchObject({ poolUnverified: true });
      expect(run.outcomes["identity-provider"].doneAt).toBeUndefined();
    }
  );

  it("records a pool only when the identity is proven present in it (S2 round 2)", async () => {
    mockProvider.identityInPool = jest.fn(async (sub: string) =>
      sub === SUB ? true : sub === OTHER ? false : undefined
    );
    await expect(provenIdentityPool({ userId: "u", sub: SUB })).resolves.toBe(POOL);
    // Not there (an old pool's account never re-linked), or could not tell: none recorded.
    await expect(provenIdentityPool({ userId: "u", sub: OTHER })).resolves.toBeNull();
    await expect(
      provenIdentityPool({ userId: "u", sub: "0f0f0f0f-0000-4000-8000-000000000000" })
    ).resolves.toBeNull();
    await expect(provenIdentityPool({ userId: "u", sub: null })).resolves.toBeNull();
    delete mockProvider.identityInPool;
    await expect(provenIdentityPool({ userId: "u", sub: SUB })).resolves.toBeNull();
  });

  it("an account bound by its id (no subject recorded) is deleted by its id (round 1, item 2)", async () => {
    const id = "0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9";
    mockProvider.adminDeleteUser = jest.fn(async () => ({ success: true }));
    await expect(
      IDENTITY_ERASURE.erase({ userId: id, sub: null, pool: POOL })
    ).resolves.toEqual({
      done: true,
    });
    expect(mockProvider.adminDeleteUser).toHaveBeenCalledWith(id);
  });

  it.each([
    ["refused", async () => ({ success: false, error: "AccessDeniedException" })],
    [
      "unavailable",
      async () => {
        throw new Error("network down");
      },
    ],
  ])("is pending, with its error, when the provider %s", async (_how, impl) => {
    mockProvider.adminDeleteUser = jest.fn(impl);
    const r = await IDENTITY_ERASURE.erase({ userId: "u", sub: SUB });
    expect(r.done).toBe(false);
    expect((r as { error: string }).error.length).toBeGreaterThan(0);
  });

  it("is pending when the provider has no administrative delete", async () => {
    const r = await IDENTITY_ERASURE.erase({ userId: "u", sub: SUB });
    expect(r).toMatchObject({
      done: false,
      error: expect.stringMatching(/adminDeleteUser/),
    });
  });

  it("records each outcome, never runs a store already done again, and retries later and later", async () => {
    const files = jest.fn(async () => ({ done: false as const, error: "store down" }));
    registerExternalErasure({ name: "app-files", holds: "files", erase: files });
    mockProvider.adminDeleteUser = jest.fn(async () => ({ success: true }));
    const now = Date.parse("2026-10-29T00:00:00.000Z");
    const first = await runExternalErasures({ userId: "u", sub: SUB }, {}, () => now);
    expect(first.pending).toEqual(["app-files"]);
    expect(first.outcomes["identity-provider"]).toMatchObject({ attempts: 1 });
    expect(first.outcomes["identity-provider"].doneAt).toBeTruthy();
    expect(first.outcomes["app-files"]).toMatchObject({
      attempts: 1,
      error: "store down",
    });
    const second = await runExternalErasures(
      { userId: "u", sub: SUB },
      first.outcomes,
      () => now
    );
    expect(mockProvider.adminDeleteUser).toHaveBeenCalledTimes(1);
    expect(second.outcomes["app-files"].attempts).toBe(2);
    expect(pendingExternalErasures(second.outcomes)).toEqual(["app-files"]);
    // 15 min, doubling, at most a day.
    const at = (n: number) => (Date.parse(externalRetryAt(n, now)) - now) / 60_000;
    expect([at(1), at(2), at(3), at(20)]).toEqual([15, 30, 60, 1440]);
  });

  it("the erasure pipeline runs the register on every path (read from the code)", () => {
    const deletion = read("platform/auth/gdpr-deletion.ts");
    const body = (name: string) => {
      const at = deletion.indexOf(`export async function ${name}(`);
      expect([name, at >= 0]).toEqual([name, true]);
      const next = deletion.indexOf("\nexport ", at + 10);
      return deletion.slice(at, next < 0 ? undefined : next);
    };
    expect(body("softDeleteUser")).toMatch(/eraseExternalStores\(/);
    expect(body("hardPurgeUser")).toMatch(/eraseExternalStores\(/);
    // The purge is not complete while a store is pending.
    expect(body("hardPurgeUser")).toMatch(/external\.pending\.length > 0/);
    expect(body("retryExternalErasures")).toMatch(/eraseExternalStores\(/);
    const duties = read("platform/jobs/duties.ts");
    expect(duties).toMatch(/retryExternalErasures\(/);
    // The self-service route goes through the same pipeline: no identity call of its own.
    const route = read("app/api/account/delete/route.ts");
    expect(route).not.toMatch(/deleteUser\(/);
    expect(route).toMatch(/softDeleteUser\(/);
  });
});
