/**
 * ADR-050 D4 / TASK-098 — signed guest tokens.
 */
import { DEFAULT_TENANT_ID } from "@/platform/providers/environment-contract";
import {
  DEFAULT_GUEST_TTL_SECONDS,
  MAX_GUEST_TTL_SECONDS,
  isGuestId,
  mintGuestToken,
  newGuestId,
  verifyGuestToken,
} from "@/platform/auth/guest-token";

function setNodeEnv(v: string): void {
  Object.defineProperty(process.env, "NODE_ENV", {
    value: v,
    configurable: true,
    writable: true,
  });
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("guest tokens (ADR-050 D4)", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...origEnv };
    process.env.GUEST_TOKEN_SECRET = "s".repeat(64);
  });

  afterEach(() => {
    process.env = { ...origEnv };
    jest.useRealTimers();
  });

  it("mints a namespaced id and a three-part signed token that verifies", async () => {
    const minted = await mintGuestToken();
    expect(isGuestId(minted.guestId)).toBe(true);
    expect(minted.token.split(".")).toHaveLength(3);
    expect(minted.token.startsWith("guest.")).toBe(true);
    const now = Math.floor(Date.now() / 1000);
    expect(minted.expiresAt - now).toBeGreaterThanOrEqual(DEFAULT_GUEST_TTL_SECONDS - 2);

    await expect(verifyGuestToken(minted.token)).resolves.toEqual({
      valid: true,
      guestId: minted.guestId,
      expiresAt: minted.expiresAt,
      tenantId: DEFAULT_TENANT_ID,
    });
  });

  it("guest ids are unique and never look like a user id", () => {
    const a = newGuestId();
    expect(a).not.toBe(newGuestId());
    expect(isGuestId(a)).toBe(true);
    expect(isGuestId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(false);
    expect(isGuestId("guest_short")).toBe(false);
  });

  it("rejects the old unsigned format (TASK-098)", async () => {
    const payload = b64url(
      JSON.stringify({ sub: newGuestId(), type: "guest", iat: 0, exp: 9999999999 })
    );
    await expect(verifyGuestToken(`guest.${payload}`)).resolves.toEqual({ valid: false });
  });

  it("rejects a forged payload under the original signature", async () => {
    const { token } = await mintGuestToken();
    const [, , sig] = token.split(".");
    const now = Math.floor(Date.now() / 1000);
    const forged = b64url(
      JSON.stringify({ v: 1, sub: newGuestId(), typ: "guest", iat: now, exp: now + 3600 })
    );
    await expect(verifyGuestToken(`guest.${forged}.${sig}`)).resolves.toEqual({
      valid: false,
    });
  });

  it("rejects a token signed under another secret", async () => {
    const { token } = await mintGuestToken();
    process.env.GUEST_TOKEN_SECRET = "t".repeat(64);
    await expect(verifyGuestToken(token)).resolves.toEqual({ valid: false });
  });

  it("rejects an expired token", async () => {
    jest.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    const { token } = await mintGuestToken(120);
    jest.setSystemTime(new Date("2026-01-01T00:03:00Z"));
    await expect(verifyGuestToken(token)).resolves.toEqual({ valid: false });
  });

  it("clamps the lifetime to [60 s, 30 days]", async () => {
    const now = Math.floor(Date.now() / 1000);
    const short = await mintGuestToken(1);
    expect(short.expiresAt - now).toBeGreaterThanOrEqual(59);
    expect(short.expiresAt - now).toBeLessThanOrEqual(61);
    const long = await mintGuestToken(10 * MAX_GUEST_TTL_SECONDS);
    expect(long.expiresAt - now).toBeLessThanOrEqual(MAX_GUEST_TTL_SECONDS + 1);
    const nan = await mintGuestToken(Number.NaN);
    expect(nan.expiresAt - now).toBeLessThanOrEqual(61);
  });

  it.each([
    ["not a string", 42],
    ["wrong prefix", "user.abc.def"],
    ["two parts", "guest.abc"],
    ["four parts", "guest.a.b.c"],
    ["non-base64url signature", "guest.abc.!!!"],
    ["empty", ""],
  ])("rejects %s", async (_label, token) => {
    await expect(verifyGuestToken(token)).resolves.toEqual({ valid: false });
  });

  /** A token for `claims`, correctly signed under the test secret. */
  async function signed(claims: unknown): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("s".repeat(64)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const body = "guest." + b64url(JSON.stringify(claims));
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    );
    return `${body}.${b64url(String.fromCharCode(...mac))}`;
  }

  it("rejects a correctly signed payload with the wrong claims", async () => {
    // Signed with the real key, to prove claim checks run after the MAC. Each case is a valid
    // version-2 token but for one claim.
    const now = Math.floor(Date.now() / 1000);
    const tid = DEFAULT_TENANT_ID;
    const cases = [
      { v: 2, sub: newGuestId(), typ: "guest", iat: now, exp: now + 60 },
      { v: 2, sub: newGuestId(), typ: "guest", tid: "acme", iat: now, exp: now + 60 },
      { v: 2, sub: "user-123", typ: "guest", tid, iat: now, exp: now + 60 },
      { v: 2, sub: newGuestId(), typ: "user", tid, iat: now, exp: now + 60 },
      { v: 2, sub: newGuestId(), typ: "guest", tid, iat: now + 3600, exp: now + 7200 },
      {
        v: 2,
        sub: newGuestId(),
        typ: "guest",
        tid,
        iat: now,
        exp: now + MAX_GUEST_TTL_SECONDS + 10,
      },
      { v: 2, sub: newGuestId(), typ: "guest", tid, iat: "x", exp: now + 60 },
      { v: 3, sub: newGuestId(), typ: "guest", tid, iat: now, exp: now + 60 },
    ];
    for (const claims of cases) {
      await expect(verifyGuestToken(await signed(claims))).resolves.toEqual({
        valid: false,
      });
    }
    // The control: the same shape, every claim right, verifies.
    const sub = newGuestId();
    await expect(
      verifyGuestToken(
        await signed({ v: 2, sub, typ: "guest", tid, iat: now, exp: now + 60 })
      )
    ).resolves.toEqual({ valid: true, guestId: sub, expiresAt: now + 60, tenantId: tid });
  });

  it("refuses a version-1 token (no tenant), even correctly signed and in single mode", async () => {
    // Before tenancy a guest token named no tenant, so one minted by any deployment sharing
    // GUEST_TOKEN_SECRET would be read as this deployment's tenant. Its holder gets a new
    // guest session instead.
    process.env.TENANCY_MODE = "single";
    process.env.TENANT_ID = DEFAULT_TENANT_ID;
    const now = Math.floor(Date.now() / 1000);
    const v1 = { v: 1, sub: newGuestId(), typ: "guest", iat: now, exp: now + 3600 };
    await expect(verifyGuestToken(await signed(v1))).resolves.toEqual({ valid: false });
    await expect(
      verifyGuestToken(await signed({ ...v1, tid: DEFAULT_TENANT_ID }))
    ).resolves.toEqual({ valid: false });
  });

  it("outside production, an unset secret falls back to a per-process secret", async () => {
    delete process.env.GUEST_TOKEN_SECRET;
    const { token } = await mintGuestToken();
    await expect(verifyGuestToken(token)).resolves.toMatchObject({ valid: true });
  });

  it("in production, an unset secret refuses to mint and never verifies", async () => {
    delete process.env.GUEST_TOKEN_SECRET;
    const { token } = await mintGuestToken(); // minted under the ephemeral secret
    setNodeEnv("production");
    await expect(mintGuestToken()).rejects.toThrow(/GUEST_TOKEN_SECRET is not set/);
    await expect(verifyGuestToken(token)).resolves.toEqual({ valid: false });
  });
});
