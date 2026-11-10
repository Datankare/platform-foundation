/**
 * @jest-environment node
 */
/**
 * __tests__/db/erasure-pool-proof.db.test.ts — the identity pool is proven when the identity is
 * erased, from the subject the erasure recorded (N-54, N-55)
 *
 * An erasure records the pool its identity is in only when it proves the identity present there;
 * an identity "not found" counts as erased only in that pool. The proof ran once, at soft-delete
 * time: a lookup throttled or not yet permitted then left the step for two operators' attestation
 * even when a later attempt could have proven the pool (N-54). And the proof read the subject from
 * `users.cognito_sub` while the erase read `user_deletions.cognito_sub`: an account whose subject
 * in `users` was nulled or changed after its first erasure was proven by another subject — its id
 * — than the one erased (N-55). Both against Postgres, with a fake pool behind the provider.
 *
 * Shown failing without the fix: the first test left the step `poolUnverified` with no pool; the
 * second proved the account's id, never the recorded subject.
 */

const mockAlerts: { name: string }[] = [];
jest.mock("@/platform/observability/alert", () => ({
  raiseAlert: (a: { name: string }) => mockAlerts.push(a),
}));

import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";
import { withOwnerTx } from "@/platform/data";
import { retryExternalErasures, softDeleteUser } from "@/platform/auth/gdpr-deletion";
import {
  resetExternalErasures,
  resetIdentityPoolCheck,
} from "@/platform/gdpr/external-erasure";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider, registerAuthProvider } from "@/platform/auth/config";
import type { AuthProvider } from "@/platform/auth/provider";

const owner = <R extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  withOwnerTx("tenant-lifecycle", (tx) => tx.query<R>(sql, values));

dbDescribe(
  "the identity pool is proven at erase time, by the recorded subject (N-54, N-55)",
  () => {
    let t: TestTenant;
    let base: AuthProvider;
    /** How the pool answers a lookup: present, absent, or throttled (undefined). */
    let lookup: (sub: string) => boolean | undefined = () => undefined;
    /** How the pool answers a delete. */
    let del: (sub: string) => {
      success: boolean;
      notFound?: boolean;
      error?: string;
    } = () => ({
      success: false,
      error: "TooManyRequestsException",
    });
    const asked: string[] = [];

    beforeAll(async () => {
      await connectTestDatabase();
      t = await createTestTenant();
      resetExternalErasures();
      initAuth();
      base = getAuthProvider();
      registerAuthProvider(
        Object.assign(Object.create(base) as AuthProvider, {
          async adminDeleteUser(sub: string) {
            return del(sub);
          },
          identityPoolId: () => "pool-current",
          confirmIdentityPool: async () => true,
          async identityInPool(sub: string) {
            asked.push(sub);
            return lookup(sub);
          },
        })
      );
    });

    afterAll(async () => {
      registerAuthProvider(base);
      resetIdentityPoolCheck();
      await dropTestTenants();
      await disconnectTestDatabase();
    });

    beforeEach(() => {
      asked.length = 0;
      mockAlerts.length = 0;
      resetIdentityPoolCheck();
      lookup = () => undefined;
      del = () => ({ success: false, error: "TooManyRequestsException" });
    });

    const record = async (id: string) =>
      (
        await owner<{
          pool: string | null;
          sub: string | null;
          entry: { doneAt?: string; poolUnverified?: boolean };
        }>(
          `select identity_pool as pool, cognito_sub as sub,
                external_erasures->'identity-provider' as entry
           from user_deletions where user_id = $1::uuid`,
          [id]
        )
      ).rows[0];
    const dueNow = (id: string) =>
      owner(
        `update user_deletions
          set external_erasures = jsonb_set(external_erasures, '{identity-provider,retryAt}',
                                            to_jsonb(now() - interval '1 minute'))
        where user_id = $1::uuid`,
        [id]
      );

    it("a lookup throttled at soft-delete time is proven by a later attempt, before its delete (N-54)", async () => {
      const id = await t.user("throttled");
      // Soft delete: the lookup is throttled and the delete too — no pool recorded, step pending.
      expect(await t.run(() => softDeleteUser(id, id))).toMatchObject({
        success: true,
        externalPending: ["identity-provider"],
      });
      expect((await record(id)).pool).toBeNull();

      // The next attempt: the pool now answers the lookup; the delete then finds nothing (an earlier
      // delete took effect and its outcome was lost). Proven before the delete, the pool is recorded,
      // so "not found" in it counts as erased — never left for attestation.
      lookup = () => true;
      del = () => ({ success: true, notFound: true });
      await dueNow(id);
      await t.run(() => retryExternalErasures(100));
      const r = await record(id);
      expect(r.pool).toBe("pool-current");
      expect(r.entry.poolUnverified).toBeUndefined();
      expect(r.entry.doneAt).toBeTruthy();
      expect(mockAlerts.map((a) => a.name)).not.toContain(
        "gdpr.identity_pool_unverified"
      );
    });

    it("an identity not found and never proven present stays unverified at erase time too", async () => {
      const id = await t.user("absent");
      await t.run(() => softDeleteUser(id, id));
      lookup = () => false;
      del = () => ({ success: true, notFound: true });
      await dueNow(id);
      await t.run(() => retryExternalErasures(100));
      const r = await record(id);
      expect(r.pool).toBeNull();
      expect(r.entry).toMatchObject({ poolUnverified: true });
      expect(r.entry.doneAt).toBeUndefined();
    });

    it("the proof reads the subject the erase reads: the erasure record's, not users' (N-55)", async () => {
      const id = await t.user("relinked");
      const recorded = "0b0b0b0b-1111-4111-8111-222222222222";
      await owner("update users set cognito_sub = $2 where id = $1::uuid", [
        id,
        recorded,
      ]);
      await t.run(() => softDeleteUser(id, id));
      expect((await record(id)).sub).toBe(recorded);
      // Something nulls the account's subject in users; the erasure is asked for again.
      await owner("update users set cognito_sub = null where id = $1::uuid", [id]);
      asked.length = 0;
      await t.run(() => softDeleteUser(id, id));
      // Proven by the recorded subject — the one the erase deletes — never the account's id.
      expect(asked.length).toBeGreaterThan(0);
      expect(new Set(asked)).toEqual(new Set([recorded]));
    });
  }
);
