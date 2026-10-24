/**
 * @jest-environment node
 */
/**
 * platform/data/pool.ts — the connection's TLS is verified, or (local and CI only) off; never
 * encrypted-but-unverified, which a man in the middle can read (Semgrep bypass-tls-verification).
 */
import { poolConfig } from "@/platform/data/pool";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function settings(extra: Record<string, string>) {
  process.env.DATABASE_URL = "postgresql://app_tenant:pw@db.example:6543/postgres";
  process.env.DATABASE_OWNER_URL = "postgresql://postgres:pw@db.example:6543/postgres";
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
}

describe("poolConfig TLS", () => {
  it("verifies the server certificate by default", () => {
    settings({});
    delete process.env.DATABASE_SSL;
    expect(poolConfig("request").ssl).toEqual({ rejectUnauthorized: true });
  });

  it("verifies against the given CA", () => {
    const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    settings({ DATABASE_SSL: "verify-full", DATABASE_SSL_CA: ca });
    for (const role of ["request", "owner"] as const) {
      expect(poolConfig(role).ssl).toMatchObject({ rejectUnauthorized: true });
    }
  });

  it("is plaintext only when disabled (refused outside local and CI by the contract)", () => {
    settings({ DATABASE_SSL: "disable" });
    expect(poolConfig("request").ssl).toBe(false);
  });

  it.each(["require", "prefer", "no-verify", "VERIFY-FULL"])(
    "an unknown mode (%s) still verifies — never encrypted-but-unverified",
    (mode) => {
      settings({ DATABASE_SSL: mode });
      expect(poolConfig("request").ssl).toMatchObject({ rejectUnauthorized: true });
    }
  );
});
