/**
 * __tests__/contract/session-store-contract.ts — SessionStore conformance (ADR-027, ADR-057 D1)
 * Not a *.test.ts: each store's suite runs it.
 *
 * What every session store must guarantee for a session to mean what it says:
 *   - a session is found by its id hash, as it was recorded; an id hash is recorded once;
 *   - an ended session is still found, and says it ended and why — a replayed id finds a revoked
 *     record, never nothing-then-something;
 *   - touch never moves time back, and does nothing to an ended session;
 *   - renewed tokens are stored only under the token version the caller read: of concurrent
 *     renewals exactly one is stored;
 *   - ending one session leaves the subject's others; ending a subject's sessions ends them all
 *     but the one excepted, returns them as they were, and touches no other subject's.
 */

import type { NewSession, SessionStore } from "@/platform/auth/session-store";
import type { SealedTokens } from "@/platform/auth/session-vault";

export interface SessionStoreContractFixtures {
  /** Fresh, empty store per test. */
  makeStore: () => SessionStore | Promise<SessionStore>;
}

const hash = (c: string) => c.repeat(64);
const sealed = (label: string) => `v1.${label}` as SealedTokens;
const T0 = 1_800_000_000_000;

function session(
  idHash: string,
  subject = "user-a",
  over: Partial<NewSession> = {}
): NewSession {
  return {
    idHash,
    kind: "user",
    subject,
    method: "password",
    csrfToken: "c".repeat(43),
    sealedTokens: sealed("first"),
    createdAt: T0,
    lastSeenAt: T0,
    ...over,
  };
}

export function runSessionStoreContract(fx: SessionStoreContractFixtures): void {
  let store: SessionStore;

  beforeEach(async () => {
    store = await fx.makeStore();
  });

  it("an unknown id hash finds nothing", async () => {
    await expect(store.find(hash("0"))).resolves.toBeNull();
  });

  it("a session is found as it was recorded, at token version 1", async () => {
    await store.open(session(hash("a")));
    await expect(store.find(hash("a"))).resolves.toEqual({
      ...session(hash("a")),
      tokenVersion: 1,
    });
  });

  it("an id hash is recorded once", async () => {
    await store.open(session(hash("a")));
    await expect(store.open(session(hash("a"), "user-b"))).rejects.toThrow();
    expect((await store.find(hash("a")))?.subject).toBe("user-a");
  });

  it("an ended session is still found, with when and why", async () => {
    await store.open(session(hash("a")));
    await expect(store.revoke(hash("a"), "sign_out", T0 + 5000)).resolves.toBe(true);
    const found = await store.find(hash("a"));
    expect(found?.revokedAt).toBe(T0 + 5000);
    expect(found?.revokedReason).toBe("sign_out");
  });

  it("ending a session twice ends it once (the first reason stands)", async () => {
    await store.open(session(hash("a")));
    await store.revoke(hash("a"), "sign_out", T0 + 1000);
    await expect(store.revoke(hash("a"), "idle_timeout", T0 + 2000)).resolves.toBe(false);
    expect((await store.find(hash("a")))?.revokedReason).toBe("sign_out");
    await expect(store.revoke(hash("f"), "sign_out", T0)).resolves.toBe(false);
  });

  it("touch moves last use forward, never back, and not at all once ended", async () => {
    await store.open(session(hash("a")));
    await expect(store.touch(hash("a"), T0 + 60_000)).resolves.toBe(true);
    await expect(store.touch(hash("a"), T0 + 1000)).resolves.toBe(true);
    expect((await store.find(hash("a")))?.lastSeenAt).toBe(T0 + 60_000);
    await store.revoke(hash("a"), "sign_out", T0 + 61_000);
    await expect(store.touch(hash("a"), T0 + 120_000)).resolves.toBe(false);
    expect((await store.find(hash("a")))?.lastSeenAt).toBe(T0 + 60_000);
    await expect(store.touch(hash("f"), T0)).resolves.toBe(false);
  });

  it("renewed tokens are stored only under the version read", async () => {
    await store.open(session(hash("a")));
    await expect(store.replaceTokens(hash("a"), 1, sealed("second"))).resolves.toBe(true);
    await expect(store.replaceTokens(hash("a"), 1, sealed("stale"))).resolves.toBe(false);
    const found = await store.find(hash("a"));
    expect(found?.sealedTokens).toBe(sealed("second"));
    expect(found?.tokenVersion).toBe(2);
  });

  it("of concurrent renewals exactly one is stored", async () => {
    await store.open(session(hash("a")));
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.replaceTokens(hash("a"), 1, sealed(`renewal-${i}`))
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const found = await store.find(hash("a"));
    expect(found?.tokenVersion).toBe(2);
    expect(found?.sealedTokens).toBe(sealed(`renewal-${results.indexOf(true)}`));
  });

  it("an ended session takes no renewed tokens", async () => {
    await store.open(session(hash("a")));
    await store.revoke(hash("a"), "sign_out", T0);
    await expect(store.replaceTokens(hash("a"), 1, sealed("late"))).resolves.toBe(false);
    expect((await store.find(hash("a")))?.sealedTokens).toBe(sealed("first"));
  });

  it("ending one session leaves the subject's others", async () => {
    await store.open(session(hash("a")));
    await store.open(session(hash("b")));
    await store.revoke(hash("a"), "sign_out", T0);
    await expect(store.countLive("user-a")).resolves.toBe(1);
    expect((await store.find(hash("b")))?.revokedAt).toBeUndefined();
  });

  it("ending a subject's sessions ends them all, returns them as they were, and no one else's", async () => {
    await store.open(session(hash("a")));
    await store.open(session(hash("b")));
    await store.open(session(hash("c"), "user-b"));
    await store.revoke(hash("b"), "sign_out", T0);
    const ended = await store.revokeSubject("user-a", "password_changed", T0 + 9000);
    expect(ended.map((s) => s.idHash)).toEqual([hash("a")]);
    expect(ended[0].revokedAt).toBeUndefined();
    expect(ended[0].sealedTokens).toBe(sealed("first"));
    await expect(store.countLive("user-a")).resolves.toBe(0);
    await expect(store.countLive("user-b")).resolves.toBe(1);
    expect((await store.find(hash("a")))?.revokedReason).toBe("password_changed");
    // Already ended by sign-out: its own reason stands.
    expect((await store.find(hash("b")))?.revokedReason).toBe("sign_out");
  });

  it("ending a subject's sessions keeps the one excepted", async () => {
    await store.open(session(hash("a")));
    await store.open(session(hash("b")));
    const ended = await store.revokeSubject("user-a", "factor_changed", T0, hash("b"));
    expect(ended.map((s) => s.idHash)).toEqual([hash("a")]);
    expect((await store.find(hash("b")))?.revokedAt).toBeUndefined();
    await expect(store.countLive("user-a")).resolves.toBe(1);
  });

  it("a subject is matched exactly (no prefix, no pattern)", async () => {
    await store.open(session(hash("a"), "user-a"));
    await store.open(session(hash("b"), "user-ab"));
    await expect(
      store.revokeSubject("user-%", "sign_out_everywhere", T0)
    ).resolves.toEqual([]);
    await store.revokeSubject("user-a", "sign_out_everywhere", T0);
    await expect(store.countLive("user-ab")).resolves.toBe(1);
  });

  it("reset forgets the tenant's sessions", async () => {
    await store.open(session(hash("a")));
    await store.reset();
    await expect(store.find(hash("a"))).resolves.toBeNull();
  });
}
