/**
 * platform/auth/session-vault.ts — a session's provider tokens, sealed (ADR-057 D2)
 *
 * What is stored is unreadable without the application's key, bound to its own session, opened
 * only for a named use, and survives a key rotation. Hostile: a sealed value moved to another
 * session's row, edited ciphertext, a truncated value, another deployment's key, a value sealed
 * under a retired key, production with no key at all.
 */

import {
  SessionVaultError,
  openForProvider,
  openIdentity,
  resealFor,
  resealRenewed,
  sealTokens,
  sealedUnderCurrentKey,
  vaultReady,
  type SealedTokens,
} from "@/platform/auth/session-vault";

const KEY_A = "a".repeat(48);
const KEY_B = "b".repeat(48);
const ID_1 = "1".repeat(64);
const ID_2 = "2".repeat(64);
const USER = {
  kind: "user" as const,
  accessToken: "header.payload.signature",
  refreshToken: "refresh-token-value",
  expiresAt: 1_900_000_000,
};

const saved = { ...process.env };
function setEnv(values: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else
      Object.defineProperty(process.env, k, {
        value: v,
        configurable: true,
        writable: true,
        enumerable: true,
      });
  }
}

beforeEach(() =>
  setEnv({ SESSION_ENCRYPTION_KEY: KEY_A, SESSION_ENCRYPTION_KEY_PREVIOUS: undefined })
);
afterAll(() =>
  setEnv({
    SESSION_ENCRYPTION_KEY: saved.SESSION_ENCRYPTION_KEY,
    SESSION_ENCRYPTION_KEY_PREVIOUS: saved.SESSION_ENCRYPTION_KEY_PREVIOUS,
    NODE_ENV: saved.NODE_ENV,
    DEPLOYMENT_HOST: saved.DEPLOYMENT_HOST,
  })
);

describe("sealing", () => {
  it("the sealed text holds neither token in the clear, nor the key", () => {
    const sealed = sealTokens(USER, ID_1);
    expect(sealed).toMatch(/^v1\.[0-9a-f]{8}\.[\w-]{16}\.[\w-]+$/);
    for (const secret of [USER.accessToken, USER.refreshToken, KEY_A]) {
      expect(sealed).not.toContain(secret);
      expect(
        Buffer.from(sealed.split(".")[3], "base64url").toString("latin1")
      ).not.toContain(secret);
    }
  });

  it("sealing the same tokens twice gives different text (a fresh nonce each time)", () => {
    expect(sealTokens(USER, ID_1)).not.toBe(sealTokens(USER, ID_1));
  });

  it("opens to what was sealed, each use getting only what it needs", () => {
    const sealed = sealTokens(USER, ID_1);
    expect(openIdentity(sealed, ID_1)).toEqual({
      kind: "user",
      token: USER.accessToken,
      expiresAt: USER.expiresAt,
      renewable: true,
    });
    expect(openForProvider(sealed, ID_1, "renewal")).toBe(USER.refreshToken);
    expect(openForProvider(sealed, ID_1, "revocation")).toBe(USER.refreshToken);
    expect(openForProvider(sealed, ID_1, "totp_enrolment")).toBe(USER.accessToken);
  });

  it("a guest's session holds its guest token and nothing a provider call could use", () => {
    const sealed = sealTokens({ kind: "guest", token: "guest.x.y", expiresAt: 5 }, ID_1);
    expect(openIdentity(sealed, ID_1)).toEqual({
      kind: "guest",
      token: "guest.x.y",
      expiresAt: 5,
      renewable: false,
    });
    for (const use of ["renewal", "revocation", "totp_enrolment"] as const) {
      expect(openForProvider(sealed, ID_1, use)).toBeNull();
    }
  });

  it("a user session without a refresh token is not renewable", () => {
    const sealed = sealTokens({ kind: "user", accessToken: "a.b.c", expiresAt: 9 }, ID_1);
    expect(openIdentity(sealed, ID_1).renewable).toBe(false);
    expect(openForProvider(sealed, ID_1, "renewal")).toBeNull();
  });
});

describe("hostile: what does not open", () => {
  const unreadable = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(SessionVaultError);
      return (err as SessionVaultError).reason;
    }
    throw new Error("it opened");
  };

  it("a sealed value copied onto another session's row", () => {
    const sealed = sealTokens(USER, ID_1);
    expect(unreadable(() => openIdentity(sealed, ID_2))).toBe("unreadable");
  });

  it("edited ciphertext, an edited tag, an edited nonce, an edited key id", () => {
    const [v, kid, nonce, body] = sealTokens(USER, ID_1).split(".");
    const flip = (s: string, at: number) =>
      s.slice(0, at) + (s[at] === "A" ? "B" : "A") + s.slice(at + 1);
    for (const tampered of [
      [v, kid, nonce, flip(body, 3)],
      [v, kid, nonce, flip(body, body.length - 2)],
      [v, kid, flip(nonce, 2), body],
      [v, kid === "00000000" ? "11111111" : "00000000", nonce, body],
    ]) {
      expect(
        unreadable(() => openIdentity(tampered.join(".") as SealedTokens, ID_1))
      ).toBe("unreadable");
    }
  });

  it("a truncated value, an empty one, another version, plain JSON", () => {
    const sealed = sealTokens(USER, ID_1);
    for (const bad of [
      sealed.slice(0, sealed.length - 30),
      "",
      sealed.replace(/^v1/, "v2"),
      JSON.stringify(USER),
      "v1.00000000.AAAAAAAAAAAAAAAA.AAAA",
    ]) {
      expect(unreadable(() => openIdentity(bad as SealedTokens, ID_1))).toBe(
        "unreadable"
      );
    }
  });

  it("a value sealed by a deployment holding another key", () => {
    const sealed = sealTokens(USER, ID_1);
    setEnv({ SESSION_ENCRYPTION_KEY: KEY_B });
    expect(unreadable(() => openIdentity(sealed, ID_1))).toBe("unreadable");
  });

  it("sealed JSON that is not a session's tokens", () => {
    // Sealed correctly, but not the shape: built through the same key by sealing a lie.
    const lie = sealTokens(
      { kind: "user", accessToken: "", expiresAt: 1 } as never,
      ID_1
    );
    expect(unreadable(() => openIdentity(lie, ID_1))).toBe("unreadable");
  });
});

describe("key rotation", () => {
  it("a session sealed under the previous key still opens, and is sealed anew under the current one", () => {
    const old = sealTokens(USER, ID_1);
    setEnv({ SESSION_ENCRYPTION_KEY: KEY_B, SESSION_ENCRYPTION_KEY_PREVIOUS: KEY_A });
    expect(sealedUnderCurrentKey(old)).toBe(false);
    expect(openIdentity(old, ID_1).token).toBe(USER.accessToken);

    const renewed = resealRenewed(old, ID_1, {
      accessToken: "new.access.token",
      expiresAt: 7,
    });
    expect(sealedUnderCurrentKey(renewed)).toBe(true);
    expect(openIdentity(renewed, ID_1)).toMatchObject({
      token: "new.access.token",
      expiresAt: 7,
    });
    // The provider returned no new refresh token: the one held stands.
    expect(openForProvider(renewed, ID_1, "renewal")).toBe(USER.refreshToken);

    // The previous key removed: what was sealed anew still opens, what was not does not.
    setEnv({ SESSION_ENCRYPTION_KEY_PREVIOUS: undefined });
    expect(openIdentity(renewed, ID_1).token).toBe("new.access.token");
    expect(() => openIdentity(old, ID_1)).toThrow(SessionVaultError);
  });

  it("nothing is sealed with the previous key", () => {
    setEnv({ SESSION_ENCRYPTION_KEY: KEY_B, SESSION_ENCRYPTION_KEY_PREVIOUS: KEY_A });
    const sealed = sealTokens(USER, ID_1);
    setEnv({ SESSION_ENCRYPTION_KEY_PREVIOUS: undefined });
    expect(openIdentity(sealed, ID_1).token).toBe(USER.accessToken);
  });

  it("a rotated refresh token replaces the one held", () => {
    const renewed = resealRenewed(sealTokens(USER, ID_1), ID_1, {
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: 8,
    });
    expect(openForProvider(renewed, ID_1, "renewal")).toBe("r2");
  });

  it("moving a session to a new id re-binds its tokens to that id", () => {
    const moved = resealFor(sealTokens(USER, ID_1), ID_1, ID_2);
    expect(openIdentity(moved, ID_2).token).toBe(USER.accessToken);
    expect(() => openIdentity(moved, ID_1)).toThrow(SessionVaultError);
  });
});

describe("without a key", () => {
  it("outside production a key is made for the process, so local work needs none", () => {
    setEnv({ SESSION_ENCRYPTION_KEY: undefined, NODE_ENV: "test" });
    expect(vaultReady()).toBe(true);
    const sealed = sealTokens(USER, ID_1);
    expect(openIdentity(sealed, ID_1).token).toBe(USER.accessToken);
  });

  it("in production nothing is sealed or opened without the key", () => {
    setEnv({
      SESSION_ENCRYPTION_KEY: undefined,
      NODE_ENV: "production",
      DEPLOYMENT_HOST: "vercel",
    });
    expect(vaultReady()).toBe(false);
    expect(() => sealTokens(USER, ID_1)).toThrow(/no_key/);
    expect(() =>
      openIdentity(
        "v1.00000000.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA" as SealedTokens,
        ID_1
      )
    ).toThrow(/no_key/);
  });
});
