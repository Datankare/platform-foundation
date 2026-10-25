/**
 * __tests__/erasure-email-hash.test.ts — the address kept for an account erased while banned
 * (audit A-11, review 7 L4, review 8 L6)
 *
 * Kept as HMAC-SHA256, under the server's ERASURE_HASH_KEY, of the address's SHA-256 — never as
 * the address and no longer as the unsalted SHA-256 itself, which anyone with a list of addresses
 * reverses by hashing the list. The key is required where the environment contract requires it
 * (production with a real auth provider); the hash refuses to run there without it.
 *
 * Review 8 L6: the key had no id and no rotation, and the legacy unsalted rows stayed reversible
 * for ever. Now each hash carries its key's id; ERASURE_HASH_KEY_PREVIOUS still matches what the
 * previous key made (and a match is rehashed under the current one); and a legacy row is
 * upgraded without the address — the current key's HMAC of it is exactly the current form.
 */

import { createHash, createHmac } from "node:crypto";
import {
  emailHash,
  erasureHashCandidates,
  erasureKeyId,
  upgradeLegacyHash,
} from "@/platform/auth/user-provisioning";

const saved = { ...process.env };
const env = process.env as Record<string, string | undefined>;
afterEach(() => {
  for (const k of [
    "ERASURE_HASH_KEY",
    "ERASURE_HASH_KEY_PREVIOUS",
    "NODE_ENV",
    "AUTH_PROVIDER",
  ]) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const K = "k".repeat(64);
const P = "p".repeat(64);

describe("the erased-ban address hash (review 7 L4, review 8 L6)", () => {
  it("is an HMAC under ERASURE_HASH_KEY of the normalised address's SHA-256, with the key's id", () => {
    env.ERASURE_HASH_KEY = K;
    const expected = createHmac("sha256", K).update(sha("gone@x.y")).digest("hex");
    expect(emailHash(" Gone@X.Y ")).toEqual({
      hash: expected,
      keyId: erasureKeyId(K),
      scheme: "hmac-of-sha256",
    });
    expect(emailHash("gone@x.y").hash).toMatch(/^[0-9a-f]{64}$/);
    expect(erasureKeyId(K)).toMatch(/^[0-9a-f]{16}$/);
    expect(erasureKeyId(P)).not.toBe(erasureKeyId(K));
  });

  it("is not the unsalted SHA-256 a list of addresses reverses", () => {
    env.ERASURE_HASH_KEY = K;
    expect(emailHash("gone@x.y").hash).not.toBe(sha("gone@x.y"));
  });

  it("depends on the key: another deployment's key gives another hash", () => {
    env.ERASURE_HASH_KEY = "a".repeat(64);
    const one = emailHash("gone@x.y");
    env.ERASURE_HASH_KEY = "b".repeat(64);
    expect(emailHash("gone@x.y").hash).not.toBe(one.hash);
  });

  it("matches the current key, the previous key and the legacy form — and writes only the current", () => {
    env.ERASURE_HASH_KEY = K;
    env.ERASURE_HASH_KEY_PREVIOUS = P;
    const forms = erasureHashCandidates("Gone@x.y");
    expect(forms.map((f) => [f.keyId, f.scheme])).toEqual([
      [erasureKeyId(K), "hmac-of-sha256"],
      [erasureKeyId(P), "hmac-of-sha256"],
      [null, "sha256"],
      [null, "hmac"],
      [null, "hmac"],
    ]);
    expect(forms[0]).toEqual(emailHash("gone@x.y"));
    expect(forms[1].hash).toBe(
      createHmac("sha256", P).update(sha("gone@x.y")).digest("hex")
    );
    expect(forms[2].hash).toBe(sha("gone@x.y"));
    // Review 9 M6: the pre-release review 7 form, HMAC of the address under either key.
    expect(forms[3].hash).toBe(createHmac("sha256", K).update("gone@x.y").digest("hex"));
    expect(forms[4].hash).toBe(createHmac("sha256", P).update("gone@x.y").digest("hex"));
    delete env.ERASURE_HASH_KEY_PREVIOUS;
    expect(erasureHashCandidates("gone@x.y")).toHaveLength(3);
    // A previous key equal to the current one is not a second form.
    env.ERASURE_HASH_KEY_PREVIOUS = K;
    expect(erasureHashCandidates("gone@x.y")).toHaveLength(3);
  });

  it("upgrades a legacy row without the address: it becomes exactly the current form", () => {
    env.ERASURE_HASH_KEY = K;
    expect(upgradeLegacyHash(sha("gone@x.y"))).toEqual(emailHash("gone@x.y"));
  });

  it("refuses to run in production with a real auth provider and no key", () => {
    delete env.ERASURE_HASH_KEY;
    env.NODE_ENV = "production";
    env.AUTH_PROVIDER = "cognito";
    expect(() => emailHash("gone@x.y")).toThrow(/ERASURE_HASH_KEY is not set/);
    expect(() => upgradeLegacyHash(sha("x"))).toThrow(/ERASURE_HASH_KEY is not set/);
  });

  it("outside a deployment, without a key, is stable across calls (a fixed development key)", () => {
    delete env.ERASURE_HASH_KEY;
    env.NODE_ENV = "test";
    expect(emailHash("gone@x.y")).toEqual(emailHash("GONE@x.y"));
    expect(emailHash("gone@x.y").hash).not.toBe(sha("gone@x.y"));
  });
});
