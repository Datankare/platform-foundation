/**
 * Review 15 M2: a misconfigured shared cache (CACHE_PROVIDER=upstash without its token) made
 * getCache() throw — and revokeTokenVerification resolved it as a default parameter, outside its
 * own try. Every caller that had already committed a change (the identity re-link, a role change
 * through invalidatePermissions) then saw a throw and reported the change as not made. A
 * revocation that cannot be published is logged (the fresh window bounds it), never thrown.
 */

const logged = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock("@/lib/logger", () => ({ logger: logged, generateRequestId: () => "req" }));
jest.mock("@/platform/cache", () => ({
  getCache: () => {
    throw new Error("UPSTASH_REDIS_REST_TOKEN is not set");
  },
}));

import {
  forgetTokenVerification,
  publishTokenRevocation,
  revokeTokenVerification,
} from "@/platform/auth/token-verification";
import {
  invalidatePermissions,
  publishInvalidation,
} from "@/platform/auth/permissions-cache";

beforeEach(() => jest.clearAllMocks());

describe("revocations with a shared cache that cannot even be made", () => {
  it("revokeTokenVerification resolves and logs — never throws to a caller that committed", async () => {
    await expect(revokeTokenVerification("sub-1")).resolves.toBeUndefined();
    expect(logged.error).toHaveBeenCalledWith(
      "Token revocation not published to other instances",
      expect.objectContaining({ error: "UPSTASH_REDIS_REST_TOKEN is not set" })
    );
  });

  it("forgetTokenVerification resolves", async () => {
    await expect(forgetTokenVerification("tok")).resolves.toBeUndefined();
  });

  it("invalidatePermissions (the re-link's invalidation) resolves, both publications logged", async () => {
    await expect(invalidatePermissions("sub-1")).resolves.toBeUndefined();
    const messages = logged.error.mock.calls.map((c) => c[0]);
    expect(messages).toEqual(
      expect.arrayContaining([
        "Permissions invalidation not published to other instances",
        "Token revocation not published to other instances",
      ])
    );
  });
});

describe("review 16 M2: the strict variants say whether it was published", () => {
  it("publishTokenRevocation answers not published, with why — never throws", async () => {
    await expect(publishTokenRevocation("sub-1")).resolves.toEqual({
      published: false,
      error: "UPSTASH_REDIS_REST_TOKEN is not set",
    });
  });

  it("publishInvalidation answers each stamp's outcome (the re-link command reports it per subject)", async () => {
    await expect(publishInvalidation("sub-1")).resolves.toEqual({
      permissions: { published: false, error: "UPSTASH_REDIS_REST_TOKEN is not set" },
      tokens: { published: false, error: "UPSTASH_REDIS_REST_TOKEN is not set" },
    });
  });

  it("a cache that answers: published", async () => {
    const set = jest.fn(async () => undefined);
    await expect(
      publishTokenRevocation("sub-1", { set } as unknown as Parameters<
        typeof publishTokenRevocation
      >[1])
    ).resolves.toEqual({ published: true });
    expect(set).toHaveBeenCalledWith(
      "auth:token-revoked:sub-1",
      expect.any(String),
      expect.objectContaining({ ttlSeconds: expect.any(Number) })
    );
  });
});
